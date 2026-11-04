import { extractDocument } from '../documents.mjs';
import { digest, round } from '../util.mjs';
import { array, modelSchema, number, result, text } from './helpers.mjs';

export function validInn(inn) {
  if (!/^\d{10}(?:\d{2})?$/.test(inn)) return false;
  const digits = [...inn].map(Number);
  const checksum = (weights) => weights.reduce((sum, weight, index) => sum + weight * digits[index], 0) % 11 % 10;
  if (digits.length === 10) return checksum([2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[9];
  return checksum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[10] && checksum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[11];
}
function amount(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/\s|₽/g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}
function field(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

export function parseInvoice(source) {
  const normalized = source.replace(/\r/g, '').replace(/[\t ]+/g, ' ');
  const invoiceNumber = field(normalized, [/(?:сч[её]т(?:\s+на\s+оплату)?|invoice)\s*(?:№|#|n)?\s*([A-ZА-Я0-9/_-]+)/i]);
  const date = field(normalized, [/(?:от|дата)\s*(\d{2}[./-]\d{2}[./-]\d{4})/i, /\b(\d{2}[./-]\d{2}[./-]\d{4})\b/]);
  const innCandidates = [...normalized.matchAll(/ИНН\s*(?:[:№#]\s*)?(\d{10}(?:\d{2})?)/gi)].map((match) => match[1]);
  const totalMinor = amount(field(normalized, [/(?:итого\s+к\s+оплате|всего\s+к\s+оплате|итого|сумма\s+итого)\s*:?[ \n]*([\d\s]+[.,]\d{2})/i]));
  const netMinor = amount(field(normalized, [/(?:без\s+ндс|сумма\s+без\s+ндс|подытог)\s*:?[ \n]*([\d\s]+[.,]\d{2})/i]));
  const vatMinor = amount(field(normalized, [/(?:^|\n)\s*(?:ндс(?:\s+\d+%)?|в\s+т\.ч\.\s+ндс)\s*:?[ \n]*([\d\s]+[.,]\d{2})/i]));
  const anomalies = [];
  for (const inn of innCandidates) if (!validInn(inn)) anomalies.push({ code: 'invalid_inn_checksum', value: inn });
  if (netMinor !== null && vatMinor !== null && totalMinor !== null && netMinor + vatMinor !== totalMinor) anomalies.push({ code: 'total_mismatch', expectedMinor: netMinor + vatMinor, actualMinor: totalMinor });
  if (!invoiceNumber) anomalies.push({ code: 'invoice_number_missing' });
  if (totalMinor === null) anomalies.push({ code: 'total_missing' });
  if (!innCandidates.length) anomalies.push({ code: 'inn_missing' });
  const found = [invoiceNumber, date, totalMinor, innCandidates.length].filter(Boolean).length;
  return {
    fields: { invoiceNumber, date, innCandidates: [...new Set(innCandidates)], netMinor, vatMinor, totalMinor, currency: 'RUB' },
    anomalies, needsReview: anomalies.length > 0,
    extractionConfidence: round(found / 4, 2),
    contentDigest: digest(source),
    method: 'deterministic_text_extraction'
  };
}

export async function invoiceOcr(input, context) {
  let source = input.text, extraction = null;
  if (!source && input.document) {
    extraction = await extractDocument({ filename: input.document.filename, buffer: Buffer.from(input.document.base64, 'base64'), model: context.model, vision: input.useVision });
    source = extraction.text;
  }
  text(source, 'text or document');
  const parsed = parseInvoice(source);
  const output = { ...parsed, ...(extraction ? { ocr: { method: extraction.method, contentType: extraction.contentType } } : {}) };
  return result(output, { artifacts: [{ kind: 'invoice.normalized', content: output, metadata: { sourceDigest: parsed.contentDigest } }], usage: { unit: 'document', quantity: 1 } });
}

export function accounting(input) {
  const transactions = array(input.transactions, 'transactions', 100000);
  const seen = new Map(), duplicates = [], suspicious = [];
  for (const [index, transaction] of transactions.entries()) {
    number(transaction.amountMinor, `transactions[${index}].amountMinor`);
    const key = [transaction.date, transaction.amountMinor, transaction.counterparty || '', transaction.purpose || ''].join('|');
    if (seen.has(key)) duplicates.push({ firstIndex: seen.get(key), duplicateIndex: index, key });
    else seen.set(key, index);
    if (/налич|обнал|крипт|срочно.*перевод/i.test(transaction.purpose || '') || (Math.abs(transaction.amountMinor) >= 10_000_000_000 && transaction.amountMinor % 1_000_000_000 === 0)) suspicious.push({ index, reason: 'rule_review', transaction });
  }
  const proposedEntries = transactions.map((transaction, index) => ({ index, debit: transaction.debitAccount || (transaction.amountMinor >= 0 ? '51' : '60'), credit: transaction.creditAccount || (transaction.amountMinor >= 0 ? '62' : '51'), amountMinor: Math.abs(transaction.amountMinor), status: duplicates.some((d) => d.duplicateIndex === index) ? 'duplicate_review' : 'draft' }));
  return result({ count: transactions.length, totalMinor: transactions.reduce((sum, t) => sum + t.amountMinor, 0), duplicates, suspicious, proposedEntries, humanReviewRequired: suspicious.length > 0 || duplicates.length > 0 }, { artifacts: [{ kind: 'accounting.reconciliation', content: { duplicates, suspicious, proposedEntries } }], usage: { unit: 'transaction', quantity: Math.max(1, transactions.length) } });
}

export function rpa(input) {
  const left = array(input.left, 'left'), right = array(input.right, 'right');
  text(input.key, 'key', 100);
  const index = new Map(right.map((row, i) => [String(row[input.key]), i]));
  const matched = [], missingRight = [], conflicts = [];
  for (const [i, row] of left.entries()) {
    const key = String(row[input.key]);
    if (!index.has(key)) { missingRight.push({ leftIndex: i, key }); continue; }
    const other = right[index.get(key)];
    const differences = Object.keys(row).filter((field) => JSON.stringify(row[field]) !== JSON.stringify(other[field])).map((field) => ({ field, left: row[field], right: other[field] }));
    if (differences.length) conflicts.push({ key, differences }); else matched.push(key);
  }
  const matchedKeys = new Set(matched);
  const missingLeft = right.filter((row) => !matchedKeys.has(String(row[input.key])) && !conflicts.some((c) => c.key === String(row[input.key]))).map((row) => String(row[input.key]));
  const effects = input.paymentDraft ? [{ type: 'bank.payment_draft', integration: input.integration || 'bank', payload: input.paymentDraft, consequential: true }] : [];
  return result({ matched: matched.length, missingRight, missingLeft, conflicts, balancesEqual: !missingRight.length && !missingLeft.length && !conflicts.length }, { effects, usage: { unit: 'operation', quantity: Math.max(left.length, right.length, 1) } });
}

export async function knowledgeRag(input, context) {
  if (input.ingest) return context.knowledge.ingest({ tenantId: context.tenantId, title: input.ingest.title || 'Document', sourceUri: input.ingest.sourceUri, text: text(input.ingest.text, 'ingest.text', 10000000), actor: context.actor });
  const answer = await context.knowledge.answer({ tenantId: context.tenantId, query: text(input.query, 'query', 100000), useModel: input.useModel === true });
  return result(answer, { usage: { unit: 'query', quantity: 1 } });
}

export async function translator(input, context) {
  const source = text(input.text, 'text', 2000000);
  const targetLanguage = text(input.targetLanguage, 'targetLanguage', 80);
  const glossary = input.glossary || {};
  const protectedItems = [];
  let protectedText = source;
  for (const [term, translation] of Object.entries(glossary).sort((a, b) => b[0].length - a[0].length)) {
    protectedText = protectedText.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), () => {
      const placeholder = `${protectedItems.length}`;
      protectedItems.push({ placeholder, translation });
      return placeholder;
    });
  }
  const translated = await context.model.complete({ system: 'Translate faithfully. Preserve markup, placeholders, numbers and meaning. Do not add explanations.', prompt: `Target language: ${targetLanguage}\n\n${protectedText}`, schema: modelSchema({ translation: { type: 'string', minLength: 1 } }) });
  let translation = translated.translation;
  for (const item of protectedItems) translation = translation.replaceAll(item.placeholder, item.translation);
  return result({ sourceLanguage: input.sourceLanguage || 'auto', targetLanguage, translation, glossaryApplied: protectedItems.length, requiresReview: input.requiresReview !== false }, { usage: { unit: 'character', quantity: source.length } });
}

const LEGAL_RULES = [
  { code: 'unilateral_change', severity: 'high', pattern: /в\s+одностороннем\s+порядке[^\n.]{0,160}(?:измен|расторг|повыш|отказ)/giu, recommendation: 'Ограничить односторонние изменения существенных условий и предусмотреть срок уведомления.' },
  { code: 'unlimited_liability', severity: 'high', pattern: /(?:полную\s+ответственность|все\s+убытки[^\n.]{0,100}(?:в\s+том\s+числе)?[^\n.]{0,100}упущенн)/giu, recommendation: 'Согласовать предел ответственности и исключения для умысла/нарушения закона.' },
  { code: 'penalty', severity: 'medium', pattern: /(?:неустойк|штраф|пен[яи])[^\n.]{0,160}/giu, recommendation: 'Проверить базу, ставку, потолок неустойки и соотношение с убытками.' },
  { code: 'personal_data', severity: 'high', pattern: /(?:персональн\w*\s+данн|трансграничн\w*\s+передач)[^\n.]{0,200}/giu, recommendation: 'Проверить цели, сроки, согласия, локализацию и обязанности обработчика.' },
  { code: 'automatic_renewal', severity: 'medium', pattern: /(?:автоматически\s+продлева|автопродлен|пролонгац)[^\n.]{0,160}/giu, recommendation: 'Добавить срок и порядок отказа от продления.' }
];
export function legal(input) {
  const source = text(input.text, 'text', 5000000);
  const findings = [];
  for (const rule of LEGAL_RULES) for (const match of source.matchAll(rule.pattern)) findings.push({ code: rule.code, severity: rule.severity, excerpt: match[0], offset: match.index, recommendation: rule.recommendation });
  const output = { findings, riskCount: findings.length, highestSeverity: findings.some((f) => f.severity === 'high') ? 'high' : findings.length ? 'medium' : 'unknown', humanReviewRequired: true, disclaimer: 'Предварительный анализ правил, а не юридическое заключение. Проверка юристом обязательна.' };
  return result(output, { artifacts: [{ kind: 'legal.review', content: output }], usage: { unit: 'document', quantity: 1 } });
}
