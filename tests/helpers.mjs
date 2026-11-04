import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConfig } from '../src/config.mjs';
import { createRuntime } from '../src/app.mjs';

export function fixture(t, options = {}) {
  const dataDir = resolve('.tmp', randomUUID());
  mkdirSync(dataDir, { recursive: true });
  const config = createConfig({ dataDir, masterKey: Buffer.alloc(32, 9).toString('base64'), adminKey: 'test-key', logLevel: 'silent', leaseMs: options.leaseMs || 200, model: options.model, developmentPackages: true, hostAllowedRoots: options.hostAllowedRoots || [], hostRoots: options.hostRoots || [], hostScanIntervalMs: options.hostScanIntervalMs || 5000 });
  const runtime = createRuntime(config);
  t.after(async () => {
    for (const client of runtime.hostClients.values()) await client.stop();
    await runtime.orchestrator.shutdown();
    if (runtime.server.listening) await new Promise((resolveClose) => runtime.server.close(resolveClose));
    runtime.store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return runtime;
}

export async function install(runtime, agentSlug, options = {}) {
  const quote = runtime.billing.quote({ tenantId: 'tenant_default', agentSlug, trialDays: 0, monthlyMinor: options.monthlyMinor, unitPriceMinor: options.unitPriceMinor, actor: 'user_admin' });
  const approved = await runtime.orchestrator.approve({ tenantId: 'tenant_default', approvalId: quote.approvalId, expectedDigest: quote.digest, actor: 'user_admin' });
  return approved.result;
}

export async function startApi(t, runtime) {
  await new Promise((resolveListen) => runtime.server.listen(0, '127.0.0.1', resolveListen));
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
  return async function api(method, path, body, key = 'test-key') {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
  };
}

export function manifest(overrides = {}) {
  return {
    schemaVersion: '2aos.agent/v1', slug: `custom-${randomUUID().slice(0, 8)}`, version: '1.0.0', name: 'Custom test', description: 'Test declarative agent', permissions: [],
    inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1 } } },
    outputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
    runtime: { kind: 'declarative', steps: [{ id: 'format', type: 'template', value: { text: '{{input.text}}' } }], output: { text: '{{steps.format.output.text}}' } },
    pricing: { currency: 'RUB', monthlyMinor: 100000 }, developerBps: 7000,
    ...overrides
  };
}
