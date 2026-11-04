import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.mjs';
import { scanFilesystem, assertRootsAllowed, diffSnapshots } from '../src/host/filesystem.mjs';
import { HostClient } from '../src/host/client.mjs';
import { sleep } from '../src/util.mjs';

function business(t) {
  const directory = resolve('.tmp', `business-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function waitFor(predicate, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value;
    await sleep(50);
  }
  throw new Error('Timed out waiting for filesystem change');
}

test('filesystem scan classifies business files and excludes secrets from content', async (t) => {
  const directory = business(t);
  mkdirSync(resolve(directory, 'nested'));
  writeFileSync(resolve(directory, 'invoice-42.csv'), 'number,total\n42,120');
  writeFileSync(resolve(directory, 'contract.txt'), 'Договор поставки');
  writeFileSync(resolve(directory, 'nested', 'warehouse-stock.csv'), 'sku,qty\nA,10');
  writeFileSync(resolve(directory, '.env'), 'SECRET=1');
  writeFileSync(resolve(directory, 'id_rsa'), 'private');
  const snapshot = await scanFilesystem({ roots: [directory] });
  assert.ok(snapshot.files.find((file) => file.processCode === 'invoice-manual'));
  assert.ok(snapshot.files.find((file) => file.processCode === 'contract-review'));
  assert.ok(snapshot.files.find((file) => file.processCode === 'warehouse-stock'));
  assert.equal(snapshot.files.find((file) => file.relativePath === '.env').secret, true);
  assert.equal(snapshot.files.find((file) => file.relativePath === '.env').contentIncluded, false);
  assert.equal(snapshot.files.find((file) => file.relativePath === 'id_rsa').contentIncluded, false);
  assert.equal(snapshot.truncated, false);
});

test('host discovery indexes evidence and produces agent recommendations', async (t) => {
  const directory = business(t), runtime = fixture(t, { hostAllowedRoots: [directory], hostRoots: [directory] });
  writeFileSync(resolve(directory, 'invoice-42.txt'), 'Счет № 42 от 04.11.2026\nИНН 7707083893\nИтого: 120,00');
  writeFileSync(resolve(directory, 'contract.txt'), 'Поставщик вправе в одностороннем порядке изменить цену.');
  const client = new HostClient(runtime, { roots: [directory] });
  const result = await client.discover();
  assert.ok(result.analysis.recommendations.some((item) => item.agentSlug === 'invoice-ocr'));
  assert.ok(result.analysis.recommendations.some((item) => item.agentSlug === 'legal'));
  assert.ok(result.analysis.indexed.length >= 2);
  assert.equal(result.files?.length, undefined);
  assert.equal(result.snapshot.files.some((file) => file.content !== undefined), false);
  const answer = await runtime.knowledge.answer({ tenantId: 'tenant_default', query: '42 ИНН' });
  assert.match(answer.answer, /42/);
  assert.match(answer.citations[0].sourceUri, /invoice-42/);
  assert.equal(runtime.store.verifyAudit('tenant_default').valid, true);
});

test('host watcher processes added, changed and removed files including RAG removal', async (t) => {
  const directory = business(t), runtime = fixture(t, { hostAllowedRoots: [directory], hostRoots: [directory], hostScanIntervalMs: 60 });
  const path = resolve(directory, 'invoice-live.txt');
  writeFileSync(path, 'Счет первой версии 111');
  const client = new HostClient(runtime, { roots: [directory], intervalMs: 60 });
  await client.discover();
  const events = [];
  const errors = [];
  client.on('error', (error) => errors.push(error));
  client.on('analysis', (event) => events.push(event));
  await client.start();
  writeFileSync(path, 'Счет второй версии 222 с измененным содержимым');
  await waitFor(() => events.some((event) => event.change.changed >= 1));
  const second = resolve(directory, 'invoice-second.txt');
  writeFileSync(second, 'Счет новый 333');
  await waitFor(() => events.reduce((sum, event) => sum + event.change.added, 0) >= 2);
  unlinkSync(second);
  await waitFor(() => events.some((event) => event.change.removed >= 1));
  await client.stop();
  const remaining = runtime.store.all("SELECT source_uri FROM knowledge_documents WHERE source_uri LIKE '%invoice-second.txt%'");
  assert.equal(remaining.length, 0);
  assert.deepEqual(errors, []);
  assert.ok(events.length >= 3);
});

test('scan root allowlist and snapshot diff are enforced', async (t) => {
  const directory = business(t), other = business(t);
  assert.throws(() => assertRootsAllowed([other], [directory]), /outside configured allowlist/);
  const first = await scanFilesystem({ roots: [directory], includeContent: false });
  const path = resolve(directory, 'new.txt');
  writeFileSync(path, 'one');
  const second = await scanFilesystem({ roots: [directory], includeContent: false });
  const difference = diffSnapshots(first, second);
  assert.equal(difference.added.length, 1);
  writeFileSync(path, 'two');
  const third = await scanFilesystem({ roots: [directory], includeContent: false });
  assert.equal(diffSnapshots(second, third).changed.length, 1);
  unlinkSync(path);
  const fourth = await scanFilesystem({ roots: [directory], includeContent: false });
  assert.equal(diffSnapshots(third, fourth).removed.length, 1);
});

test('mutating host command runs only after exact approval', async (t) => {
  const runtime = fixture(t), output = resolve(runtime.store.config.dataDir, 'mutation-proof.txt');
  const script = resolve(runtime.store.config.dataDir, 'mutation.mjs');
  writeFileSync(script, "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], 'approved');");
  runtime.hostSystem.registerProfile({ name: 'test.write', executable: process.execPath, args: [script, output], mutation: true, timeoutMs: 5000 });
  runtime.dispatcher.upsertIntegration({ tenantId: 'tenant_default', kind: 'host-shell', name: 'host-shell', config: { profile: 'test.write' }, actor: 'user_admin' });
  const effect = await runtime.orchestrator.prepareEffect({ job: { id: null, tenant_id: 'tenant_default', agent_slug: 'host-system', epoch: runtime.store.epoch() }, effect: { type: 'host.command', integration: 'host-shell', payload: { profile: 'test.write', input: '' }, consequential: true, idempotencyKey: 'host-mutation-test' }, autonomous: false, actor: 'user_admin' });
  assert.equal(existsSync(output), false);
  await assert.rejects(async () => runtime.orchestrator.approve({ tenantId: 'tenant_default', approvalId: effect.approvalId, expectedDigest: 'wrong', actor: 'user_admin' }), /digest/);
  assert.equal(existsSync(output), false);
  await runtime.orchestrator.approve({ tenantId: 'tenant_default', approvalId: effect.approvalId, expectedDigest: effect.digest, actor: 'user_admin' });
  assert.equal(existsSync(output), true);
  assert.equal(runtime.store.get("SELECT status FROM outbox WHERE id=?", effect.outboxId).status, 'sent');
});
