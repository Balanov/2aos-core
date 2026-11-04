import { EventEmitter } from 'node:events';
import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile, stat, watch as nativeWatch } from 'node:fs/promises';
import { resolve, extname, relative, sep } from 'node:path';
import { id, nowIso, require, sha256 } from '../util.mjs';
import { extractDocument } from '../documents.mjs';

export const DEFAULT_POLICY = {
  maxFiles: 100000, maxDepth: 32, maxContentFiles: 5000, maxFileBytes: 10_000_000,
  followSymlinks: false, contentConcurrency: 8,
  ignoredNames: new Set(['.git', 'node_modules', '.2aos', '.tmp', '$Recycle.Bin', 'System Volume Information', '.Trash', '__pycache__']),
  contentExtensions: new Set(['.txt', '.md', '.csv', '.json', '.xml', '.html', '.log', '.docx']),
  secretExtensions: new Set(['.pem', '.key', '.p12', '.pfx', '.kdb', '.keystore', '.jks']),
  secretNames: new Set(['.env', 'id_rsa', 'id_ed25519', 'credentials.json', 'secrets.json', 'shadow', 'passwd'])
};

const CLASSIFIERS = [
  [/invoice|сч[её]т|наклад|акт[-_ ]|bill/i, ['invoice', 'invoice-manual']],
  [/contract|договор|соглашен/i, ['contract', 'contract-review']],
  [/bank|finance|бухгал|выписк|плат[её]ж|pnl|balance/i, ['financial', 'accounting-manual']],
  [/stock|inventory|warehouse|склад|остат/i, ['inventory', 'warehouse-stock']],
  [/resume|cv|candidate|резюме|кандидат/i, ['resume', 'recruiting-resume']],
  [/review|отзыв|reputation/i, ['review', 'customer-reviews']],
  [/regulation|policy|instruction|регламент|инструкц|справоч|knowledge/i, ['regulation', 'knowledge-regulation']],
  [/crm|lead|client|customer|продаж|заказ/i, ['crm', 'sales-crm']],
  [/security|auth|login|audit|безопас|доступ/i, ['security-log', 'security-logs']],
  [/sensor|telemetry|temperature|vibration|датчик|телеметр/i, ['sensor', 'machine-sensors']],
  [/presentation|deck|презентац/i, ['presentation', 'content-presentation']],
  [/email|mail|letter|message|переписк|письм/i, ['communication', 'knowledge-communication']],
  [/image|photo|scan|фото|скан/i, ['image', 'machine-vision']],
  [/route|logistic|маршрут|достав|путев/i, ['logistics', 'route-logistics']],
  [/\.(mjs|cjs|js|ts|py|go|java|cs|cpp|h|sql)$/i, ['code', 'development-tasks']]
];

export function classifyFile(path) {
  const name = path.toLowerCase();
  for (const [pattern, [kind, processCode]] of CLASSIFIERS) if (pattern.test(name)) return { kind, processCode };
  return { kind: extname(name).slice(1) || 'other', processCode: null };
}

function normalizePolicy(policy = {}) {
  const normalized = { ...DEFAULT_POLICY, ...policy };
  for (const key of ['ignoredNames', 'contentExtensions', 'secretExtensions', 'secretNames']) normalized[key] = new Set([...DEFAULT_POLICY[key], ...(policy[key] || [])]);
  for (const key of ['maxFiles', 'maxDepth', 'maxContentFiles', 'maxFileBytes', 'contentConcurrency']) require(Number.isSafeInteger(normalized[key]) && normalized[key] > 0, 422, 'invalid_scan_policy', `${key} must be positive integer`);
  return normalized;
}

export function assertRootsAllowed(roots, allowedRoots) {
  require(Array.isArray(roots) && roots.length > 0, 422, 'scan_roots_required', 'At least one scan root is required');
  require(Array.isArray(allowedRoots) && allowedRoots.length > 0, 403, 'host_scan_disabled', 'Host scanning is disabled until A2OS_HOST_ALLOWED_ROOTS is configured');
  const canonical = (root) => {
    require(existsSync(root), 422, 'scan_root_missing', `Scan root does not exist: ${root}`);
    const actual = realpathSync(root);
    return { actual, comparable: process.platform === 'win32' ? actual.toLowerCase() : actual };
  };
  const allowed = allowedRoots.map(canonical);
  return roots.map((root) => {
    const { actual, comparable } = canonical(root);
    require(allowed.some(({ comparable: base }) => comparable === base || comparable.startsWith(base.endsWith(sep) ? base : base + sep)), 403, 'scan_root_not_allowed', `Scan root is outside configured allowlist: ${actual}`);
    return actual;
  });
}

export async function scanFilesystem({ roots, policy = {}, includeContent = true }) {
  const settings = normalizePolicy(policy), files = [], errors = [];
  let truncated = false, contentCount = 0;
  for (const root of roots) {
    const queue = [{ path: root, depth: 0 }];
    while (queue.length && files.length < settings.maxFiles) {
      const current = queue.shift();
      let entries;
      try { entries = await readdir(current.path, { withFileTypes: true }); }
      catch (error) { errors.push({ path: current.path, code: error.code }); continue; }
      for (const entry of entries) {
        if (settings.ignoredNames.has(entry.name)) continue;
        const path = resolve(current.path, entry.name);
        if (entry.isSymbolicLink() && !settings.followSymlinks) continue;
        let info;
        try { info = await stat(path); }
        catch (error) { errors.push({ path, code: error.code }); continue; }
        if (info.isDirectory()) {
          if (current.depth < settings.maxDepth) queue.push({ path, depth: current.depth + 1 });
          continue;
        }
        if (!info.isFile()) continue;
        const extension = extname(entry.name).toLowerCase(), lowerName = entry.name.toLowerCase();
        const secret = settings.secretExtensions.has(extension) || settings.secretNames.has(lowerName) || lowerName.startsWith('.env.');
        const classification = classifyFile(path);
        const record = { path, root, relativePath: relative(root, path), extension, size: info.size, mtimeMs: Math.floor(info.mtimeMs), ...classification, secret, contentIncluded: false };
        files.push(record);
        if (includeContent && !secret && contentCount < settings.maxContentFiles && info.size <= settings.maxFileBytes && settings.contentExtensions.has(extension)) {
          try {
            if (extension === '.docx') {
              const extracted = await extractDocument({ filename: path, buffer: await readFile(path) });
              record.content = extracted.text;
              record.extractionMethod = extracted.method;
            } else {
              record.content = await readFile(path, 'utf8');
              record.extractionMethod = 'utf8';
            }
            record.contentHash = sha256(record.content);
            record.contentIncluded = true;
            contentCount++;
          } catch (error) { errors.push({ path, code: error.code, stage: 'content' }); }
        }
        if (!secret && !record.contentIncluded && info.size <= 1_000_000) {
          try { record.contentHash = sha256(await readFile(path)); }
          catch (error) { errors.push({ path, code: error.code, stage: 'hash' }); }
        }
        if (files.length >= settings.maxFiles) { truncated = true; break; }
      }
    }
  }
  if (contentCount >= settings.maxContentFiles) truncated = true;
  return { snapshotId: id('snapshot'), createdAt: nowIso(), files, errors, truncated, summary: { roots: roots.length, files: files.length, contentFiles: contentCount, errors: errors.length } };
}

export function observationsFromSnapshot(snapshot) {
  const groups = new Map();
  for (const file of snapshot.files) {
    if (!file.processCode || file.secret) continue;
    const group = groups.get(file.processCode) || { processCode: file.processCode, fileCount: 0, contentFiles: 0, examples: [] };
    group.fileCount++;
    if (file.contentIncluded) group.contentFiles++;
    if (group.examples.length < 10) group.examples.push(file.relativePath);
    groups.set(file.processCode, group);
  }
  return [...groups.values()].map((group) => ({
    processCode: group.processCode,
    description: `Обнаружены материалы процесса: ${group.fileCount} файлов`,
    metrics: { fileCount: group.fileCount, indexedContentFiles: group.contentFiles },
    evidence: { source: `host-snapshot:${snapshot.snapshotId}`, observedAt: snapshot.createdAt, examples: group.examples }
  }));
}

export function diffSnapshots(previous, current) {
  const before = new Map((previous?.files || []).map((file) => [file.path, file]));
  const after = new Map(current.files.map((file) => [file.path, file]));
  const added = [], changed = [], removed = [];
  for (const [path, file] of after) {
    if (!before.has(path)) added.push(file);
    else {
      const old = before.get(path);
      if (old.size !== file.size || old.mtimeMs !== file.mtimeMs || old.contentHash !== file.contentHash) changed.push(file);
    }
  }
  for (const [path, file] of before) if (!after.has(path)) removed.push(file);
  return { added, changed, removed, hasChanges: added.length + changed.length + removed.length > 0 };
}

export class FilesystemWatcher extends EventEmitter {
  constructor({ roots, policy = {}, intervalMs = 5000, debounceMs = 250, includeContent = true }) {
    super();
    this.roots = roots; this.policy = policy; this.intervalMs = intervalMs; this.debounceMs = debounceMs; this.includeContent = includeContent;
    this.snapshot = null; this.timer = null; this.debounce = null; this.native = []; this.running = false; this.pending = false;
  }

  async tick() {
    if (this.pending) return this.snapshot;
    this.pending = true;
    try {
      const current = await scanFilesystem({ roots: this.roots, policy: this.policy, includeContent: this.includeContent });
      const changes = this.snapshot ? diffSnapshots(this.snapshot, current) : { added: current.files, changed: [], removed: [], hasChanges: current.files.length > 0 };
      this.snapshot = current;
      if (changes.hasChanges) this.emit('changes', { snapshot: current, changes });
      return { snapshot: current, changes };
    } finally { this.pending = false; }
  }

  schedule() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.tick().catch((error) => this.emit('error', error)), this.debounceMs);
    this.debounce.unref();
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.tick();
    for (const root of this.roots) {
      try {
        const watcher = nativeWatch(root, { recursive: true, persistent: false }, () => this.schedule());
        watcher.on('error', (error) => this.emit('warning', { root, code: error.code }));
        watcher.unref();
        this.native.push(watcher);
      } catch (error) { this.emit('warning', { root, code: error.code, fallback: 'polling' }); }
    }
    this.timer = setInterval(() => this.tick().catch((error) => this.emit('error', error)), this.intervalMs);
    this.timer.unref();
  }

  async stop() {
    this.running = false;
    clearInterval(this.timer); clearTimeout(this.debounce);
    for (const watcher of this.native) watcher.close();
    this.native = [];
    for (let attempt = 0; attempt < 500 && this.pending; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
