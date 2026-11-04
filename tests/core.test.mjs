import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, install, manifest } from './helpers.mjs';
import { parseAgentPackage } from '../src/packages.mjs';
import { zip } from '../src/agents/pptx.mjs';
import { canonicalJson, sleep } from '../src/util.mjs';
import { encryptJson, decryptJson } from '../src/security.mjs';

async function upload(runtime, definition) {
  const buffer = zip({ 'manifest.json': canonicalJson(definition) });
  const parsed = parseAgentPackage(buffer, runtime.store.config);
  const versionId = `agent_version_${definition.slug}`;
  runtime.store.run('INSERT INTO agent_versions(id,tenant_id,slug,version,developer_id,manifest_json,digest,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)', versionId, 'tenant_default', definition.slug, definition.version, 'user_admin', canonicalJson(definition), parsed.digest, 'active', new Date().toISOString());
  return parsed;
}

test('installation quote is exact and idempotent usage has no duplicates', async (t) => {
  const runtime = fixture(t);
  const installed = await install(runtime, 'invoice-ocr');
  assert.equal(installed.status, 'active');
  const first = runtime.billing.recordUsage({ tenantId: 'tenant_default', agentSlug: 'invoice-ocr', unit: 'document', quantity: 2, unitPriceMinor: 500, idempotencyKey: 'u1' });
  const second = runtime.billing.recordUsage({ tenantId: 'tenant_default', agentSlug: 'invoice-ocr', unit: 'document', quantity: 2, unitPriceMinor: 500, idempotencyKey: 'u1' });
  assert.equal(first.amountMinor, 1000);
  assert.equal(second.idempotent, true);
  assert.equal(runtime.store.get('SELECT COUNT(*) count FROM usage_events').count, 1);
});

test('package allocation preserves exact wholesale total', async (t) => {
  const runtime = fixture(t);
  const quote = runtime.billing.packageQuote({ tenantId: 'tenant_default', packageSlug: 'micro', packages: runtime.packages, trialDays: 0, actor: 'user_admin' });
  const result = await runtime.orchestrator.approve({ tenantId: 'tenant_default', approvalId: quote.approvalId, expectedDigest: quote.digest, actor: 'user_admin' });
  assert.equal(result.result.installations.length, 5);
  assert.equal(result.result.allocatedMonthlyMinor, 5725000);
  const sum = runtime.store.get('SELECT SUM(CAST(json_extract(price_json,\'$.monthlyMinor\') AS INTEGER)) total FROM installations').total;
  assert.equal(sum, 5725000);
});

test('DAG job executes, stores artifacts, usage and audit chain', async (t) => {
  const runtime = fixture(t);
  await install(runtime, 'invoice-ocr');
  const job = runtime.orchestrator.enqueue({ tenantId: 'tenant_default', agentSlug: 'invoice-ocr', payload: { text: 'Счет № 42 от 04.11.2026\nИНН 7707083893\nИтого: 120,00' }, idempotencyKey: 'job1', actor: 'user_admin' });
  const results = await runtime.orchestrator.drain();
  assert.equal(results[0].status, 'succeeded');
  assert.equal(runtime.store.get('SELECT status FROM jobs WHERE id=?', job.id).status, 'succeeded');
  assert.ok(runtime.store.get('SELECT COUNT(*) count FROM artifacts').count >= 1);
  assert.equal(runtime.store.verifyAudit('tenant_default').valid, true);
});

test('effect requires approval and exact digest before provider commit', async (t) => {
  const runtime = fixture(t);
  await install(runtime, 'email-marketing');
  runtime.dispatcher.upsertIntegration({ tenantId: 'tenant_default', kind: 'memory', name: 'smtp', config: {}, actor: 'user_admin' });
  const job = runtime.orchestrator.enqueue({ tenantId: 'tenant_default', agentSlug: 'email-marketing', payload: { contacts: [{ email: 'a@example.com', consentAt: '2026-01-01' }], template: 'Hello', campaignId: 'c1', enqueue: true }, idempotencyKey: 'email-job', actor: 'user_admin' });
  const [result] = await runtime.orchestrator.drain();
  const effect = result.effects[0];
  assert.equal(effect.status, 'waiting_approval');
  await assert.rejects(async () => runtime.orchestrator.approve({ tenantId: 'tenant_default', approvalId: effect.approvalId, expectedDigest: 'wrong', actor: 'user_admin' }), /digest/);
  const committed = await runtime.orchestrator.approve({ tenantId: 'tenant_default', approvalId: effect.approvalId, expectedDigest: effect.digest, actor: 'user_admin' });
  assert.equal(committed.status, 'consumed');
  assert.equal(runtime.store.get('SELECT status FROM outbox WHERE approval_id=?', effect.approvalId).status, 'sent');
});

test('custom ZIP agent is moderated, installed and executable', async (t) => {
  const runtime = fixture(t);
  const definition = manifest();
  await upload(runtime, definition);
  await install(runtime, definition.slug);
  runtime.orchestrator.enqueue({ tenantId: 'tenant_default', agentSlug: definition.slug, payload: { text: 'from third party' }, idempotencyKey: 'custom1', actor: 'user_admin' });
  const [result] = await runtime.orchestrator.drain();
  assert.equal(result.output.text, 'from third party');
  const invoice = runtime.billing.issueInvoice({ tenantId: 'tenant_default', agentSlug: definition.slug, actor: 'user_admin' });
  runtime.billing.markPaid({ tenantId: 'tenant_default', invoiceId: invoice.id, externalReceipt: 'test-receipt', actor: 'user_admin' });
  assert.equal(runtime.billing.developerDashboard('tenant_default', 'user_admin').revenueMinor, 70000);
});

test('retry succeeds after transient model failure', async (t) => {
  let attempts = 0;
  const definition = manifest({ permissions: ['model.text'], runtime: { kind: 'declarative', steps: [{ id: 'model', type: 'model', prompt: '{{input.text}}' }], output: { text: '{{steps.model.output.text}}' } } });
  const model = { complete: async () => { attempts++; if (attempts === 1) throw new Error('temporary'); return { text: 'recovered' }; } };
  const runtime = fixture(t);
  await upload(runtime, definition);
  await install(runtime, definition.slug);
  runtime.orchestrator.model = model;
  const job = runtime.orchestrator.enqueue({ tenantId: 'tenant_default', agentSlug: definition.slug, payload: { text: 'try' }, idempotencyKey: 'retry1', maxAttempts: 2, runAt: new Date(Date.now() - 1).toISOString(), actor: 'user_admin' });
  const first = await runtime.orchestrator.drain();
  assert.equal(first[0].status, 'retry');
  runtime.store.run('UPDATE jobs SET run_at=? WHERE id=?', new Date(Date.now() - 1).toISOString(), job.id);
  const second = await runtime.orchestrator.drain();
  assert.equal(second[0].status, 'succeeded');
  assert.equal(second[0].output.text, 'recovered');
});

test('epoch stop rejects late completion', async (t) => {
  const definition = manifest({ permissions: ['model.text'], runtime: { kind: 'declarative', steps: [{ id: 'model', type: 'model', prompt: '{{input.text}}' }], output: { text: '{{steps.model.output.text}}' } } });
  const model = { complete: async () => { await sleep(80); return { text: 'late' }; } };
  const runtime = fixture(t);
  await upload(runtime, definition);
  await install(runtime, definition.slug);
  runtime.orchestrator.model = model;
  const job = runtime.orchestrator.enqueue({ tenantId: 'tenant_default', agentSlug: definition.slug, payload: { text: 'slow' }, idempotencyKey: 'slow1', actor: 'user_admin' });
  const draining = runtime.orchestrator.drain(1);
  await sleep(15);
  runtime.orchestrator.stop('tenant_default', 'test stop', 'user_admin');
  await draining;
  assert.equal(runtime.store.get('SELECT status FROM jobs WHERE id=?', job.id).status, 'cancelled');
  assert.equal(runtime.store.get('SELECT result_json FROM jobs WHERE id=?', job.id).result_json, null);
});

test('privacy gateway blocks raw fields and requires five independent tenants', (t) => {
  const runtime = fixture(t), tenantIds = [];
  for (let i = 0; i < 5; i++) {
    const tenantId = `tenant_${i}`;
    runtime.store.run('INSERT INTO tenants(id,name,privacy_opt_in,created_at) VALUES (?,?,1,?)', tenantId, `Company ${i}`, new Date().toISOString());
    tenantIds.push(tenantId);
  }
  assert.throws(() => runtime.privacy.createSignal({ tenantId: tenantIds[0], niche: 'invoice', payload: { processCode: 'invoice', observationCount: 1, rawText: 'secret' }, actor: 'admin' }), /not exportable/);
  for (let i = 0; i < 4; i++) runtime.privacy.createSignal({ tenantId: tenantIds[i], niche: 'invoice', payload: { processCode: 'invoice', observationCount: 2, monthlyCostMinor: 123456789 }, actor: 'admin' });
  assert.equal(runtime.privacy.buildExport('invoice').exported, false);
  runtime.privacy.createSignal({ tenantId: tenantIds[4], niche: 'invoice', payload: { processCode: 'invoice', observationCount: 2, monthlyCostMinor: 123456789 }, actor: 'admin' });
  const exported = runtime.privacy.buildExport('invoice');
  assert.equal(exported.exported, true);
  assert.equal(exported.payload.companyCount, 5);
  assert.ok(!JSON.stringify(exported.payload).includes('tenant_'));
});

test('pool creates sequential shared conversation and is idempotent by event', async (t) => {
  const runtime = fixture(t);
  await install(runtime, 'invoice-ocr'); await install(runtime, 'accounting');
  const pool = runtime.orchestrator.createPool({ tenantId: 'tenant_default', name: 'Finance', members: [{ agentSlug: 'invoice-ocr' }, { agentSlug: 'accounting' }], actor: 'user_admin' });
  const message = runtime.orchestrator.poolMessage({ tenantId: 'tenant_default', poolId: pool.poolId, body: 'Process', inputs: { 'invoice-ocr': { text: 'Счет № 42\nИНН 7707083893\nИтого: 120,00' }, accounting: { transactions: [] } }, eventId: 'event1', actor: 'user_admin' });
  await runtime.orchestrator.drain();
  const messages = runtime.store.all('SELECT * FROM messages WHERE conversation_id=?', message.conversationId);
  assert.equal(messages.length, 3);
  const duplicate = runtime.orchestrator.poolMessage({ tenantId: 'tenant_default', poolId: pool.poolId, body: 'Process', eventId: 'event1', actor: 'user_admin' });
  assert.equal(duplicate.idempotent, true);
  assert.equal(runtime.store.all('SELECT * FROM messages WHERE conversation_id=?', message.conversationId).length, 3);
});

test('AES-GCM integration configuration round trip and audit tamper detection', (t) => {
  const runtime = fixture(t);
  const encrypted = encryptJson({ token: 'secret' }, runtime.store.config.masterKey);
  assert.deepEqual(decryptJson(encrypted, runtime.store.config.masterKey), { token: 'secret' });
  runtime.store.audit({ tenantId: 'tenant_default', actor: 'a', action: 'test', entityType: 'test', entityId: '1' });
  runtime.store.run('UPDATE audit_log SET payload_json=?', '{"changed":true}');
  assert.equal(runtime.store.verifyAudit('tenant_default').valid, false);
});
