#!/usr/bin/env node
import { createConfig } from '../src/config.mjs';
import { createRuntime } from '../src/app.mjs';
import { zip } from '../src/agents/pptx.mjs';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { canonicalJson, sha256Prefixed } from '../src/util.mjs';
import { createPrivateKey, sign } from 'node:crypto';

const envFile = process.env.A2OS_ENV_FILE || '.env';
if (existsSync(envFile)) process.loadEnvFile(envFile);
const [command = 'start', ...args] = process.argv.slice(2);
if (command === 'start') {
  const config = createConfig(), runtime = createRuntime(config);
  runtime.orchestrator.start();
  runtime.server.listen(config.port, config.host, () => {
    console.log(`2AOS Core listening on http://${config.host}:${config.port}`);
    console.log(`OpenAPI: http://${config.host}:${config.port}/openapi.json`);
    if (runtime.store.bootstrapCredentials?.apiKey) console.log(`Bootstrap owner API key (shown once): ${runtime.store.bootstrapCredentials.apiKey}`);
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.orchestrator.shutdown();
    runtime.server.close(() => { runtime.store.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
} else if (command === 'verify') {
  const runtime = createRuntime(createConfig());
  console.log(JSON.stringify(runtime.store.verifyAudit('tenant_default'), null, 2));
  runtime.store.close();
} else if (command === 'catalog') {
  const runtime = createRuntime(createConfig());
  console.log(JSON.stringify(runtime.catalog.map((agent) => ({ slug: agent.slug, name: agent.name, price: agent.pricing })), null, 2));
  runtime.store.close();
} else if (command === 'pack') {
  const directory = resolve(args[0] || '.');
  const entries = {};
  for (const file of walk(directory)) entries[relative(directory, file).replaceAll('\\', '/')] = readFileSync(file);
  if (!entries['manifest.json']) throw new Error('manifest.json is required at package root');
  const output = resolve(args[1] || `${JSON.parse(entries['manifest.json'].toString()).slug || 'agent'}.zip`);
  writeFileSync(output, zip(entries));
  console.log(output);
} else if (command === 'sign') {
  const [privateKeyPath, manifestPath] = args;
  if (!privateKeyPath || !manifestPath) throw new Error('Usage: 2aos sign <private-key.pem> <manifest.json>');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.signature;
  const digest = sha256Prefixed(canonicalJson(manifest));
  const keyText = readFileSync(privateKeyPath);
  const key = privateKeyPath.endsWith('.der') ? createPrivateKey({ key: keyText, format: 'der', type: 'pkcs8' }) : createPrivateKey(keyText);
  manifest.signature = sign(null, Buffer.from(digest), key).toString('base64');
  writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`);
  console.log(digest);
} else {
  console.log('Usage: 2aos [start|verify|catalog|pack <dir> [output.zip]|sign <private-key.pem> <manifest.json>]');
}
function* walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name), stat = statSync(path);
    if (stat.isDirectory()) yield* walk(path);
    else if (stat.isFile()) yield path;
  }
}
