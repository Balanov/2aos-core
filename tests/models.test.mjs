import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { knowledgeRag, translator } from '../src/agents/documents.mjs';
import { constructionBim } from '../src/agents/vision.mjs';

test('RAG answers from local excerpts with citations and no internet', async (t) => {
  const runtime = fixture(t);
  await knowledgeRag({ ingest: { title: 'Security', sourceUri: 'local://security-v1', text: 'Доступ в CRM выдаётся только владельцем тенанта. Все внешние действия требуют подтверждения.' } }, { tenantId: 'tenant_default', knowledge: runtime.knowledge, actor: 'user_admin', model: runtime.model });
  const answer = await knowledgeRag({ query: 'Кто выдаёт доступ в CRM?' }, { tenantId: 'tenant_default', knowledge: runtime.knowledge, actor: 'user_admin', model: runtime.model });
  assert.match(answer.output.answer, /владельцем тенанта/);
  assert.equal(answer.output.citations.length > 0, true);
  assert.equal(answer.output.mode, 'extractive');
});

test('RAG returns explicit no-evidence response for unknown topic', async (t) => {
  const runtime = fixture(t);
  const answer = await knowledgeRag({ query: 'Какой банк выдал кредит?' }, { tenantId: 'tenant_default', knowledge: runtime.knowledge, actor: 'user_admin', model: runtime.model });
  assert.match(answer.output.answer, /нет подтверждающего/);
  assert.equal(answer.output.citations.length, 0);
});

test('translator protects glossary placeholders', async () => {
  const model = { complete: async ({ prompt }) => { const placeholder = prompt.match(/\d+/)[0]; return { translation: `${placeholder} works offline` }; } };
  const result = await translator({ text: '2AOS локально', targetLanguage: 'English', glossary: { '2AOS': '2AOS Platform' } }, { model });
  assert.equal(result.output.translation, '2AOS Platform works offline');
});

test('construction VLM result remains draft for specialist', async () => {
  const model = { complete: async () => ({ findings: [{ type: 'geometry', severity: 'high', description: 'Visible shift', confidence: 0.7 }], summary: 'Needs review', insufficientImageQuality: false }) };
  const result = await constructionBim({ images: ['Zm9v'], bimReference: { objectId: 'wall-1' } }, { model });
  assert.equal(result.output.humanVerificationRequired, true);
  assert.equal(result.output.certification, null);
});

test('language agent fails closed if model is disabled', async (t) => {
  const runtime = fixture(t);
  await assert.rejects(() => translator({ text: 'Hello', targetLanguage: 'Russian' }, runtime), /model is not enabled/);
});
