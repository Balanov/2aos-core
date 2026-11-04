import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FilesystemWatcher, assertRootsAllowed, observationsFromSnapshot } from './filesystem.mjs';
import { canonicalJson, nowIso, sha256 } from '../util.mjs';

export class HostClient extends EventEmitter {
  constructor(runtime, { roots, policy = {}, intervalMs = 5000, tenantId = 'tenant_default' } = {}) {
    super();
    this.runtime = runtime;
    this.tenantId = tenantId;
    this.roots = assertRootsAllowed(roots, runtime.store.config.hostAllowedRoots);
    this.policy = policy;
    this.intervalMs = intervalMs;
    this.watcher = null;
    this.recentChanges = [];
    this.directory = resolve(runtime.store.config.dataDir, 'host', tenantId);
    mkdirSync(this.directory, { recursive: true });
  }

  async discover() {
    const watcher = new FilesystemWatcher({ roots: this.roots, policy: this.policy, includeContent: true });
    const { snapshot } = await watcher.tick();
    const analysis = await this.indexSnapshot(snapshot);
    this.persist(snapshot, analysis);
    return { snapshot: this.publicSnapshot(snapshot), analysis };
  }

  async indexSnapshot(snapshot, changes = null) {
    const selected = changes ? [...changes.added, ...changes.changed] : snapshot.files;
    const indexed = [];
    for (const file of selected) {
      if (!file.contentIncluded || file.secret) continue;
      const sourceUri = `file://${file.path}`;
      const document = this.runtime.knowledge.ingest({ tenantId: this.tenantId, title: file.relativePath, sourceUri, text: file.content, actor: 'host-client' });
      this.runtime.director.upsertObject({ tenantId: this.tenantId, kind: 'host-file', externalId: sha256(file.path), data: { extension: file.extension, size: file.size, mtimeMs: file.mtimeMs, contentHash: file.contentHash, processCode: file.processCode }, provenance: { source: sourceUri, observedAt: snapshot.createdAt, contentHash: file.contentHash }, actor: 'host-client' });
      indexed.push({ path: file.path, documentId: document.documentId, version: document.version });
    }
    for (const file of changes?.removed || []) {
      this.runtime.knowledge.removeSource({ tenantId: this.tenantId, sourceUri: `file://${file.path}`, actor: 'host-client' });
      this.runtime.director.upsertObject({ tenantId: this.tenantId, kind: 'host-file-deleted', externalId: sha256(file.path), data: { deletedAt: snapshot.createdAt }, provenance: { source: `file://${file.path}`, observedAt: snapshot.createdAt }, actor: 'host-client' });
    }
    const observations = observationsFromSnapshot(snapshot);
    const analysis = observations.length ? this.runtime.director.analyze({ tenantId: this.tenantId, observations, actor: 'host-client' }) : { findings: [], recommendations: [], privacyRequest: null };
    return { analysisId: analysis.analysisId, indexed, observations: observations.length, recommendations: analysis.recommendations, privacyRequest: analysis.privacyRequest };
  }

  persist(snapshot, analysis) {
    const publicSnapshot = this.publicSnapshot(snapshot);
    const payload = { ...publicSnapshot, analysis, updatedAt: nowIso() };
    writeFileSync(resolve(this.directory, 'latest.json'), canonicalJson(payload), { mode: 0o600 });
    return payload;
  }

  publicSnapshot(snapshot) {
    return {
      snapshotId: snapshot.snapshotId, createdAt: snapshot.createdAt, truncated: snapshot.truncated, summary: snapshot.summary,
      files: snapshot.files.map(({ content, ...file }) => file),
      errors: snapshot.errors
    };
  }

  latest() {
    const path = resolve(this.directory, 'latest.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { snapshotId: null, files: [], summary: { files: 0 }, analysis: null };
  }

  async start() {
    if (this.watcher) return;
    this.processing = null;
    this.watcher = new FilesystemWatcher({ roots: this.roots, policy: this.policy, intervalMs: this.intervalMs, includeContent: true });
    this.watcher.on('changes', async ({ snapshot, changes }) => {
      const work = this.indexSnapshot(snapshot, this.watcher.snapshot ? changes : null);
      this.processing = work;
      try {
        const analysis = await work;
        const change = { at: nowIso(), added: changes.added.length, changed: changes.changed.length, removed: changes.removed.length };
        this.recentChanges.unshift(change);
        this.recentChanges = this.recentChanges.slice(0, 100);
        this.persist(snapshot, analysis);
        this.emit('analysis', { change, analysis, snapshot: this.publicSnapshot(snapshot) });
      } catch (error) { this.emit('error', error); }
      finally { if (this.processing === work) this.processing = null; }
    });
    this.watcher.on('warning', (warning) => this.emit('warning', warning));
    await this.watcher.start();
  }

  async stop() {
    if (this.watcher) await this.watcher.stop();
    if (this.processing) await this.processing;
    this.watcher = null;
  }

  changes() { return this.recentChanges; }
}
