import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUILTINS, runDeclarative } from '../src/agents/index.mjs';
import { parseInvoice, accounting, rpa, legal, validInn } from '../src/agents/documents.mjs';
import { chatVoice, reputation, applicationScoring, contentGeneration, emailMarketing, recruiting, tutoring, clinic, presentation } from '../src/agents/commerce.mjs';
import { driverLogistics, forecasting, reporting, security, financialMonitoring, compliance, moderation, predictiveMaintenance, warehouse } from '../src/agents/analytics.mjs';
import { visionQuality } from '../src/agents/vision.mjs';
import { unzipSafe } from '../src/packages.mjs';
import { manifest } from './helpers.mjs';

const invoice = 'Счет № 42 от 04.11.2026\nИНН 7707083893\nБез НДС: 100,00\nНДС: 20,00\nИтого: 120,00';

test('catalog has 26 executable builtin agents', () => {
  const agents = JSON.parse(readFileSync('catalog/agents.json', 'utf8'));
  assert.equal(agents.length, 26);
  for (const agent of agents) assert.equal(typeof BUILTINS[agent.slug], 'function', agent.slug);
});

test('INN checksum and invoice totals are verified', () => {
  assert.equal(validInn('7707083893'), true);
  assert.equal(validInn('7707083894'), false);
  const parsed = parseInvoice(invoice);
  assert.equal(parsed.fields.totalMinor, 12000);
  assert.equal(parsed.anomalies.length, 0);
  assert.equal(parseInvoice(invoice.replace('Итого: 120,00', 'Итого: 121,00')).anomalies[0].code, 'total_mismatch');
});

test('accounting detects duplicates and suspicious entries', () => {
  const transaction = { date: '2026-11-01', amountMinor: -10000, counterparty: 'A', purpose: 'оплата' };
  const result = accounting({ transactions: [transaction, transaction] }).output;
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.proposedEntries[1].status, 'duplicate_review');
});

test('RPA reports both missing rows and conflicts', () => {
  const result = rpa({ key: 'id', left: [{ id: '1', sum: 10 }, { id: '2', sum: 20 }], right: [{ id: '1', sum: 11 }, { id: '3', sum: 30 }] }).output;
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.missingRight.length, 1);
  assert.equal(result.missingLeft.length, 1);
});

test('legal review includes exact excerpt and mandatory review', () => {
  const result = legal({ text: 'Поставщик вправе в одностороннем порядке изменить цену. Неустойка 1% в день.' }).output;
  assert.ok(result.findings.length >= 2);
  assert.equal(result.humanReviewRequired, true);
});

test('chat hands off to human with history flag', () => {
  const result = chatVoice({ message: 'Позовите директора, у меня жалоба' }).output;
  assert.equal(result.handoff, true);
  assert.equal(result.historyPreserved, true);
});

test('reputation computes sentiment and creates only approved publication effects', () => {
  const preview = reputation({ reviews: [{ id: 'r1', text: 'Ужасная доставка, очень долго', rating: 1 }] }).output;
  assert.equal(preview.summary.negative, 1);
  const publish = reputation({ publish: true, reviews: [{ id: 'r1', text: 'Плохо', platform: 'memory', rating: 1 }] });
  assert.equal(publish.effects[0].consequential, true);
});

test('scoring fail-closes on hard stops and missing evidence', () => {
  assert.equal(applicationScoring({ inn: '7707083894', registry: {} }).output.decision, 'reject');
  assert.equal(applicationScoring({ inn: '7707083893', registry: { evidence: { source: 'test' } } }).output.decision, 'approve_draft');
});

test('content templates work without a model', async () => {
  const result = await contentGeneration({ topic: 'Локальный запуск', channels: ['telegram'], template: 'Новость: {topic}' }, {});
  assert.match(result.output.items[0].text, /Локальный запуск/);
});

test('email marketing excludes opt-outs and creates idempotent effects', () => {
  const contacts = [{ email: 'a@example.com', consentAt: '2026-01-01', tags: ['client'] }, { email: 'b@example.com', consentAt: '2026-01-01', optedOutAt: '2026-02-01' }];
  const result = emailMarketing({ contacts, template: 'Здравствуйте, {{name}}', campaignId: 'c1', enqueue: true });
  assert.equal(result.output.selected, 1);
  assert.equal(result.output.excluded, 1);
  assert.equal(result.effects[0].idempotencyKey, 'email:c1:a@example.com');
});

test('logistics enforces capacity and produces a route', () => {
  const result = driverLogistics({ depot: { x: 0, y: 0 }, stops: [{ id: 'a', x: 1, y: 0, demand: 2 }, { id: 'b', x: 2, y: 0, demand: 1 }], vehicleCapacity: 2 }).output;
  assert.deepEqual(result.stopIds, ['a', 'b']);
  assert.equal(result.feasible, false);
  assert.equal(result.violations[0].type, 'capacity');
});

test('forecast returns backtest and sensible linear continuation', () => {
  const result = forecasting({ values: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19], horizon: 3 }).output;
  assert.equal(result.forecast.length, 3);
  assert.ok(result.forecast[0] >= 19);
  assert.ok(result.backtest.mae <= result.backtest.seasonalNaiveMae);
});

test('management report uses actual rows', () => {
  const result = reporting({ rows: [{ category: 'A', revenueMinor: 100, quantity: 2 }, { category: 'B', revenueMinor: 50, quantity: 1 }], previousPeriodRevenueMinor: 100 }).output;
  assert.equal(result.totalRevenueMinor, 150);
  assert.equal(result.growthRate, 0.5);
  assert.equal(result.top[0].name, 'A');
});

test('security, compliance and moderation return evidence', () => {
  const sec = security({ events: [{ actor: 'u', device: 'new', bytes: 1000 }], baselines: { u: { devices: ['old'], maxBytes: 100 } } }).output;
  assert.equal(sec.incidents[0].severity, 'high');
  const comp = compliance({ messages: [{ text: 'Пришлите пароль', observedAt: '2026-01-01' }], policies: [{ name: 'Secrets', forbidden: ['пароль'] }] }).output;
  assert.match(comp.violations[0].excerpt, /пароль/);
  const mod = moderation({ messages: [{ id: 1, text: 'https://a https://b https://c' }] }).output;
  assert.equal(mod.items[0].reasons.includes('spam'), true);
});

test('financial monitoring rejects invalid counterparty', () => {
  assert.equal(financialMonitoring({ inn: '7707083894', registry: {} }).output.decision, 'block_draft');
});

test('predictive maintenance flags anomaly and warehouse creates draft order', () => {
  const maintenance = predictiveMaintenance({ assets: [{ id: 'motor', readings: [1, 1, 1, 1, 1, 1, 1, 8].map((value) => ({ value })) }] }).output;
  assert.equal(maintenance.assets[0].risk, 'high');
  const stock = warehouse({ items: [{ sku: 'A', stock: 1, dailyDemand: [2, 2, 2], leadTimeDays: 2, safetyStock: 1 }] }).output;
  assert.equal(stock.reorderDrafts.length, 1);
});

test('recruiting ignores protected attributes in score', () => {
  const result = recruiting({ requirements: [{ skill: 'Node.js' }], resumes: [{ text: 'Женщина, Node.js' }, { text: 'Мужчина, Python' }] }).output;
  assert.equal(result.candidates[0].score, 100);
  assert.equal(result.protectedCriteriaUsed, false);
});

test('tutoring follows rubric and clinic never diagnoses', () => {
  const lesson = tutoring({ rubric: [{ name: 'Theory', points: 2, keywords: ['sqlite'] }], answers: [{ learnerId: 'a', text: '' }] }).output;
  assert.equal(lesson.evaluations[0].nextTrack, 'foundations_and_additional_practice');
  const emergency = clinic({ request: 'Не могу дышать', slots: [] }).output;
  assert.equal(emergency.triage, 'emergency');
  assert.equal(emergency.diagnosis, null);
});

test('presentation emits editable PPTX and HTML', async () => {
  const result = await presentation({ title: 'Отчёт', text: 'Первый слайд\nФакт один.\n\nВторой слайд\nФакт два.' });
  const pptx = result.artifacts.find((a) => a.kind === 'presentation.pptx');
  const files = unzipSafe(Buffer.from(pptx.base64, 'base64'));
  assert.ok(files.has('ppt/slides/slide1.xml'));
  assert.match(files.get('ppt/slides/slide1.xml').toString(), /Отчёт/);
});

test('vision handler requires structured model evidence and no fake physical result', async () => {
  const model = { complete: async () => ({ findings: [], summary: 'Дефектов не видно', insufficientImageQuality: false }) };
  const result = await visionQuality({ images: ['Zm9v'] }, { model });
  assert.equal(result.output.physicalCompletionVerified, false);
  assert.equal(result.output.humanVerificationRequired, true);
});

test('declarative runtime preserves arrays and validates schema', async () => {
  const definition = manifest({ outputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } } });
  const result = await runDeclarative(definition, { text: 'hello' }, {});
  assert.equal(result.output.text, 'hello');
  await assert.rejects(() => runDeclarative(definition, { text: 'x', extra: true }, {}), /unexpected property/);
});
