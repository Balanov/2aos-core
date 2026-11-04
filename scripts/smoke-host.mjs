import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConfig } from '../src/config.mjs';
import { createRuntime } from '../src/app.mjs';
import { HostClient } from '../src/host/client.mjs';

const businessDir = resolve('.tmp', 'smoke-host-business'), dataDir = resolve('.tmp', 'smoke-host-db');
rmSync(businessDir, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(businessDir, { recursive: true });
writeFileSync(resolve(businessDir, 'invoice-smoke.txt'), 'Счет № 42 от 04.11.2026\nИНН 7707083893\nИтого: 120,00');
writeFileSync(resolve(businessDir, 'contract.txt'), 'Поставщик вправе в одностороннем порядке изменить цену.');
const runtime = createRuntime(createConfig({ dataDir, masterKey: Buffer.alloc(32, 11).toString('base64'), adminKey: 'smoke-host', logLevel: 'silent', hostAllowedRoots: [businessDir], hostRoots: [businessDir] }));
try {
  const client = new HostClient(runtime, { roots: [businessDir] });
  const result = await client.discover();
  if (!result.analysis.recommendations.some((item) => item.agentSlug === 'invoice-ocr')) throw new Error('Missing invoice-ocr recommendation');
  if (!result.analysis.recommendations.some((item) => item.agentSlug === 'legal')) throw new Error('Missing legal recommendation');
  if (result.snapshot.files.some((file) => file.content !== undefined)) throw new Error('Public snapshot leaks file content');
  const answer = await runtime.knowledge.answer({ tenantId: 'tenant_default', query: '42 ИНН' });
  if (!answer.citations.length) throw new Error('RAG citation missing');
  if (!runtime.store.verifyAudit('tenant_default').valid) throw new Error('Audit invalid');
  console.log(JSON.stringify({ hostSmoke: 'ok', files: result.snapshot.summary.files, indexed: result.analysis.indexed.length, recommendations: result.analysis.recommendations.map((item) => item.agentSlug) }));
} finally {
  for (const client of runtime.hostClients.values()) await client.stop();
  await runtime.orchestrator.shutdown();
  runtime.store.close();
  rmSync(businessDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}
