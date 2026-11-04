import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConfig } from '../src/config.mjs';
import { createRuntime } from '../src/app.mjs';

const dataDir = resolve('.tmp', `smoke-${process.pid}`);
mkdirSync(dataDir, { recursive: true });
const runtime = createRuntime(createConfig({ dataDir, masterKey: Buffer.alloc(32, 42).toString('base64'), adminKey: 'smoke-key', logLevel: 'silent' }));
try {
  const quote = runtime.billing.quote({ tenantId: 'tenant_default', agentSlug: 'invoice-ocr', trialDays: 0, actor: 'user_admin' });
  await runtime.orchestrator.approve({ tenantId: 'tenant_default', approvalId: quote.approvalId, expectedDigest: quote.digest, actor: 'user_admin' });
  const job = runtime.orchestrator.enqueue({ tenantId: 'tenant_default', agentSlug: 'invoice-ocr', payload: { text: 'Счет № 1 от 05.11.2026\nИНН 7707083893\nБез НДС: 100,00\nНДС: 20,00\nИтого: 120,00' }, idempotencyKey: 'smoke-invoice', actor: 'user_admin' });
  const [execution] = await runtime.orchestrator.drain();
  if (execution.status !== 'succeeded' || execution.output.fields.totalMinor !== 12000) throw new Error('Smoke invoice failed');
  const audit = runtime.store.verifyAudit('tenant_default');
  if (!audit.valid) throw new Error('Audit chain invalid');
  console.log(JSON.stringify({ smoke: 'ok', jobId: job.id, totalMinor: execution.output.fields.totalMinor, artifacts: execution.artifactIds.length, auditEntries: audit.entries }));
} finally {
  await runtime.orchestrator.shutdown();
  runtime.store.close();
  rmSync(dataDir, { recursive: true, force: true });
}
