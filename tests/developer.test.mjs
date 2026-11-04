import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, startApi } from './helpers.mjs';
import { zip } from '../src/agents/pptx.mjs';
import { canonicalJson } from '../src/util.mjs';

async function prepareMarket(runtime) {
  for (let i = 0; i < 5; i++) {
    const tenantId = `tenant_market_${i}`;
    runtime.store.run('INSERT INTO tenants(id,name,privacy_opt_in,created_at) VALUES (?,?,1,?)', tenantId, `Company ${i}`, new Date().toISOString());
    runtime.privacy.createSignal({ tenantId, niche: 'invoice', payload: { processCode: 'invoice', observationCount: 4, monthlyCostMinor: 18500000 + i * 100000, urgency: 4, complexity: 3, agentCount: 1 }, actor: 'admin' });
  }
  assert.equal(runtime.privacy.buildExport('invoice').exported, true);
}

test('well-known capabilities and scaffold are machine-readable and valid', async (t) => {
  const runtime = fixture(t), api = await startApi(t, runtime);
  const card = await api('GET', '/.well-known/2aos.json', undefined, null);
  assert.equal(card.status, 200);
  assert.ok(card.data.commands.some((item) => item.command === 'agent.submit'));
  const scaffold = await api('GET', '/v1/developer/scaffold/invoice');
  assert.equal(scaffold.status, 200);
  const parsed = runtime.developerExchange.scaffold('invoice');
  assert.deepEqual(scaffold.data.manifest, parsed);
  assert.equal(parsed.runtime.kind, 'declarative');
});

test('business demand → developer package → director accept → execution → paid revenue', async (t) => {
  const runtime = fixture(t), api = await startApi(t, runtime);
  await prepareMarket(runtime);
  const opportunities = await api('GET', '/v1/developer/opportunities');
  assert.equal(opportunities.status, 200);
  assert.equal(opportunities.data.opportunities[0].companyCount, 5);
  assert.ok(!JSON.stringify(opportunities.data).includes('tenant_market_'));
  const brief = await api('GET', '/v1/developer/briefs/invoice');
  assert.equal(brief.status, 200);
  assert.equal(brief.data.task.inputSchema.type, 'object');
  assert.ok(brief.data.task.acceptance.length >= 5);
  const manifest = runtime.developerExchange.scaffold('invoice');
  const submission = await api('POST', '/v1/packages/upload', { zipBase64: zip({ 'manifest.json': canonicalJson(manifest) }).toString('base64') });
  assert.equal(submission.status, 201);
  assert.equal(submission.data.status, 'moderation');
  const accepted = await api('POST', `/v1/director/submissions/${submission.data.id}/accept`, { trialDays: 0 });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.action, 'agent.install');
  const installed = await api('POST', `/v1/approvals/${accepted.data.approvalId}/approve`, { digest: accepted.data.digest });
  assert.equal(installed.status, 200);
  const job = await api('POST', '/v1/jobs', { agentSlug: 'invoice-solution', idempotencyKey: 'developer-e2e-job', payload: { observation: { processCode: 'invoice', description: 'Manual entry', evidence: { source: 'erp', observedAt: '2026-11-01' } } } });
  assert.equal(job.status, 202);
  await api('POST', '/v1/jobs/drain', {});
  const completed = await api('GET', `/v1/jobs/${job.data.id}`);
  assert.equal(completed.data.status, 'succeeded');
  assert.equal(completed.data.result.status, 'draft');
  assert.equal(completed.data.result.findings.processCode, 'invoice');
  const invoice = await api('POST', '/v1/invoices/invoice-solution', {});
  assert.equal(invoice.status, 201);
  await api('POST', `/v1/invoices/${invoice.data.id}/paid`, { externalReceipt: 'developer-e2e-payment' });
  const dashboard = await api('GET', '/v1/developer/dashboard');
  assert.equal(dashboard.data.revenueMinor, 70000);
  assert.equal(dashboard.data.paidConnections, 1);
});
