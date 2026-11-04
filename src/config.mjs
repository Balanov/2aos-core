import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function masterKey(dataDir, supplied) {
  const value = supplied || process.env.A2OS_MASTER_KEY;
  if (value) {
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) throw new Error('A2OS_MASTER_KEY must be base64-encoded 32 bytes');
    return key;
  }
  const path = resolve(dataDir, '.master-key');
  if (existsSync(path)) return readFileSync(path);
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

export function createConfig(overrides = {}) {
  const dataDir = resolve(overrides.dataDir || process.env.A2OS_DATA_DIR || '.2aos');
  mkdirSync(dataDir, { recursive: true });
  for (const dir of ['uploads', 'packages', 'artifacts', 'tmp']) mkdirSync(resolve(dataDir, dir), { recursive: true });
  const allowedEndpoints = new Set((overrides.allowedEndpoints || process.env.A2OS_ALLOWED_ENDPOINTS || 'http://127.0.0.1:11434,http://localhost:11434')
    .split(',').map((x) => x.trim()).filter(Boolean));
  return {
    dataDir,
    host: overrides.host || process.env.A2OS_HOST || '127.0.0.1',
    port: Number(overrides.port ?? process.env.A2OS_PORT ?? 8787),
    bodyLimit: Number(overrides.bodyLimit ?? process.env.A2OS_BODY_LIMIT ?? 30_000_000),
    workerConcurrency: Number(overrides.workerConcurrency ?? process.env.A2OS_WORKERS ?? 4),
    leaseMs: Number(overrides.leaseMs ?? 60_000),
    exportMinTenants: Number(overrides.exportMinTenants ?? process.env.A2OS_EXPORT_MIN_TENANTS ?? 5),
    developmentPackages: overrides.developmentPackages ?? bool(process.env.A2OS_DEVELOPMENT_PACKAGES, true),
    telemetry: false,
    model: {
      kind: overrides.model?.kind || process.env.A2OS_MODEL_KIND || 'ollama',
      baseUrl: overrides.model?.baseUrl || process.env.A2OS_MODEL_URL || 'http://127.0.0.1:11434',
      name: overrides.model?.name || process.env.A2OS_MODEL_NAME || 'qwen3:4b',
      visionName: overrides.model?.visionName || process.env.A2OS_VISION_MODEL || '',
      timeoutMs: Number(overrides.model?.timeoutMs ?? 120_000),
      enabled: overrides.model?.enabled ?? bool(process.env.A2OS_MODEL_ENABLED, false)
    },
    registryPublicKey: overrides.registryPublicKey || process.env.A2OS_REGISTRY_PUBLIC_KEY || '',
    adminKey: overrides.adminKey || process.env.A2OS_ADMIN_KEY || '',
    masterKey: masterKey(dataDir, overrides.masterKey),
    allowedEndpoints,
    publicBaseUrl: overrides.publicBaseUrl || process.env.A2OS_PUBLIC_BASE_URL || '',
    logLevel: overrides.logLevel || process.env.A2OS_LOG_LEVEL || 'info'
  };
}
