import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, startApi } from './helpers.mjs';

const invoiceText = 'Счет № 42 от 04.11.2026\nИНН 7707083893\nБез НДС: 100,00\nНДС: 20,00\nИтого: 120,00';

test('HTTP full cycle: analyze → quote → approve → job → artifact → invoice', async (t) => {
  const runtime = fixture(t), api = await startApi(t, runtime);
  assert.equal((await api('GET', '/health/ready', undefined, null)).status, 200);
  assert.equal((await api('GET', '/v1/catalog/public', undefined, null)).data.agents.length, 26);
  assert.equal((await api('GET', '/v1/me', undefined, null)).status, 401);
  const analysis = await api('POST', '/v1/director/analyze', { observations: [{ processCode: 'invoice-manual', evidence: { source: 'erp', observedAt: '2026-11-01' }, monthlyCostMinor: 18500000, errorRate: 0.03 }] });
  assert.equal(analysis.status, 200);
  assert.ok(analysis.data.recommendations.some((r) => r.agentSlug === 'invoice-ocr'));
  const quote = await api('POST', '/v1/installations/quote', { agentSlug: 'invoice-ocr', trialDays: 0 });
  assert.equal(quote.status, 201);
  assert.equal((await api('POST', `/v1/approvals/${quote.data.approvalId}/approve`, { digest: 'bad' })).status, 409);
  const installed = await api('POST', `/v1/approvals/${quote.data.approvalId}/approve`, { digest: quote.data.digest });
  assert.equal(installed.status, 200);
  const job = await api('POST', '/v1/jobs', { agentSlug: 'invoice-ocr', payload: { text: invoiceText }, idempotencyKey: 'api-invoice-1' });
  assert.equal(job.status, 202);
  const duplicate = await api('POST', '/v1/jobs', { agentSlug: 'invoice-ocr', payload: { text: invoiceText }, idempotencyKey: 'api-invoice-1' });
  assert.equal(duplicate.data.id, job.data.id);
  const drained = await api('POST', '/v1/jobs/drain', {});
  assert.equal(drained.status, 200);
  const fetched = await api('GET', `/v1/jobs/${job.data.id}`);
  assert.equal(fetched.data.status, 'succeeded');
  assert.equal(fetched.data.result.fields.totalMinor, 12000);
  assert.ok((await api('GET', '/v1/artifacts')).data.artifacts.length >= 1);
  const invoice = await api('POST', '/v1/invoices/invoice-ocr', {});
  assert.equal(invoice.status, 201);
  const partner = await api('POST', '/v1/partners', { name: 'Partner', code: 'P1', referredTenantId: 'tenant_default' });
  assert.equal(partner.status, 201);
  assert.equal((await api('POST', `/v1/invoices/${invoice.data.id}/paid`, { externalReceipt: 'receipt-1' })).status, 200);
  const dashboard = await api('GET', `/v1/partners/${partner.data.partnerId}/dashboard`);
  assert.equal(dashboard.data.accruedMinor, Math.round(invoice.data.amount_minor * 0.3));
  assert.equal((await api('GET', '/v1/audit/verify')).data.valid, true);
});

test('HTTP pool conversation and tenant isolation', async (t) => {
  const runtime = fixture(t), api = await startApi(t, runtime);
  for (const slug of ['invoice-ocr', 'accounting']) {
    const quote = await api('POST', '/v1/installations/quote', { agentSlug: slug, trialDays: 0 });
    await api('POST', `/v1/approvals/${quote.data.approvalId}/approve`, { digest: quote.data.digest });
  }
  const pool = await api('POST', '/v1/pools', { name: 'Finance', members: [{ agentSlug: 'invoice-ocr' }, { agentSlug: 'accounting' }] });
  const message = await api('POST', `/v1/pools/${pool.data.poolId}/messages`, { body: 'Close books', eventId: 'evt-1', inputs: { 'invoice-ocr': { text: invoiceText }, accounting: { transactions: [] } } });
  assert.equal(message.status, 202);
  await api('POST', '/v1/jobs/drain', {});
  const conversation = await api('GET', `/v1/conversations/${message.data.conversationId}/messages`);
  assert.equal(conversation.data.messages.length, 3);
  const second = await api('POST', '/v1/tenants', { name: 'Other', email: 'other@example.com', adminName: 'Other' });
  assert.equal(second.status, 201);
  const otherApiJob = await api('GET', `/v1/jobs/${message.data.jobs[0].id}`, undefined, second.data.apiKey);
  assert.equal(otherApiJob.status, 404);
});

test('Public lead endpoint stores real lead without bearer key', async (t) => {
  const runtime = fixture(t), api = await startApi(t, runtime);
  const response = await api('POST', '/v1/leads', { form_type: 'Заявка партнера', name: 'Test', contact: '@test', company: 'Example' }, null);
  assert.equal(response.status, 201);
  assert.equal(response.data.success, true);
  assert.equal(runtime.store.get('SELECT COUNT(*) count FROM leads').count, 1);
});
