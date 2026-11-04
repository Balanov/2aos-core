import { canonicalJson, id, nowIso, require, sha256 } from './util.mjs';

const STOP = new Set(('и в не на что с по это как а но или для из от до за же при через над под между если то они он она оно мы вы я вы are the a an of to in on for with and or').split(' '));
export function terms(text) {
  return String(text).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)?.filter((word) => !STOP.has(word)) || [];
}
function chunks(text, size = 1200, overlap = 150) {
  const result = [];
  for (let start = 0; start < text.length; start += size - overlap) result.push(text.slice(start, start + size));
  return result;
}

export class KnowledgeBase {
  constructor(store, model) { this.store = store; this.model = model; }

  ingest({ tenantId, title, sourceUri, text, actor }) {
    require(typeof text === 'string' && text.trim().length > 0 && text.length <= 10_000_000, 422, 'invalid_document', 'Document text is required and limited to 10 MB');
    require(typeof sourceUri === 'string' && sourceUri.length <= 2000, 422, 'invalid_document', 'sourceUri is required');
    const documentId = id('doc'), hash = sha256(text);
    const previous = this.store.get('SELECT MAX(version) version FROM knowledge_documents WHERE tenant_id=? AND source_uri=?', tenantId, sourceUri);
    const version = (previous?.version || 0) + 1;
    this.store.transaction(() => {
      this.store.run('INSERT INTO knowledge_documents(id,tenant_id,title,source_uri,version,content_hash,created_at) VALUES (?,?,?,?,?,?,?)', documentId, tenantId, title, sourceUri, version, hash, nowIso());
      chunks(text).forEach((content, ordinal) => {
        this.store.run('INSERT INTO knowledge_chunks(id,tenant_id,document_id,ordinal,content,tokens_json) VALUES (?,?,?,?,?,?)', id('chunk'), tenantId, documentId, ordinal, content, canonicalJson(terms(content)));
      });
      this.store.audit({ tenantId, actor, action: 'knowledge.ingested', entityType: 'document', entityId: documentId, payload: { sourceUri, version, contentHash: hash } });
    });
    return { documentId, version, contentHash: hash, chunks: chunks(text).length };
  }

  removeSource({ tenantId, sourceUri, actor }) {
    const documents = this.store.all('SELECT id FROM knowledge_documents WHERE tenant_id=? AND source_uri=?', tenantId, sourceUri);
    this.store.transaction(() => {
      for (const document of documents) this.store.run('DELETE FROM knowledge_documents WHERE id=? AND tenant_id=?', document.id, tenantId);
      this.store.audit({ tenantId, actor, action: 'knowledge.source_removed', entityType: 'document_source', entityId: sourceUri, payload: { versions: documents.length } });
    });
    return { removedVersions: documents.length };
  }

  search(tenantId, query, limit = 5) {
    const queryTerms = [...new Set(terms(query))];
    require(queryTerms.length > 0, 422, 'empty_query', 'Query has no searchable terms');
    const rows = this.store.all(`SELECT c.*,d.title,d.source_uri,d.version FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id JOIN (SELECT source_uri,MAX(version) version FROM knowledge_documents WHERE tenant_id=? GROUP BY source_uri) latest ON latest.source_uri=d.source_uri AND latest.version=d.version WHERE c.tenant_id=?`, tenantId, tenantId);
    const averageLength = rows.reduce((sum, row) => sum + JSON.parse(row.tokens_json).length, 0) / Math.max(rows.length, 1);
    const documentFrequency = new Map();
    for (const term of queryTerms) documentFrequency.set(term, rows.filter((row) => JSON.parse(row.tokens_json).includes(term)).length);
    return rows.map((row) => {
      const tokens = JSON.parse(row.tokens_json), counts = new Map();
      for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
      let score = 0;
      for (const term of queryTerms) {
        const frequency = counts.get(term) || 0, df = documentFrequency.get(term) || 0;
        if (!frequency) continue;
        const inverse = Math.log(1 + (rows.length - df + 0.5) / (df + 0.5));
        score += inverse * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * tokens.length / averageLength));
      }
      return { chunkId: row.id, documentId: row.document_id, title: row.title, sourceUri: row.source_uri, version: row.version, ordinal: row.ordinal, content: row.content, score };
    }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async answer({ tenantId, query, useModel = false }) {
    const citations = this.search(tenantId, query, 5);
    if (!citations.length) return { answer: 'В локальной базе знаний нет подтверждающего фрагмента.', citations: [], grounded: true, mode: 'extractive' };
    if (!useModel) return { answer: citations.map((item) => item.content).join('\n\n'), citations: citations.map(publicCitation), grounded: true, mode: 'extractive' };
    const schema = { type: 'object', additionalProperties: false, required: ['answer', 'chunkIds'], properties: { answer: { type: 'string', minLength: 1, maxLength: 10000 }, chunkIds: { type: 'array', maxItems: 5, items: { type: 'string' } } } };
    const result = await this.model.complete({ system: 'Answer only from supplied excerpts. If evidence is insufficient, say so. Return JSON.', prompt: JSON.stringify({ query, excerpts: citations.map((c) => ({ chunkId: c.chunkId, content: c.content })) }), schema });
    require(result.chunkIds.every((chunkId) => citations.some((c) => c.chunkId === chunkId)), 502, 'invalid_model_citation', 'Model cited an unknown chunk');
    const selected = citations.filter((c) => result.chunkIds.includes(c.chunkId));
    return { answer: result.answer, citations: selected.map(publicCitation), grounded: selected.length > 0, mode: 'local_model_with_citations' };
  }
}

function publicCitation(c) {
  return { chunkId: c.chunkId, documentId: c.documentId, title: c.title, sourceUri: c.sourceUri, version: c.version, ordinal: c.ordinal, content: c.content, score: c.score };
}
