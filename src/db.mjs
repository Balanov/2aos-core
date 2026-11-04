import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { canonicalJson, digest, id, nowIso, token, asRow, asRows } from './util.mjs';
import { hashApiKey } from './security.mjs';

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL DEFAULT '', privacy_opt_in INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','viewer','developer','partner')), created_at TEXT NOT NULL, UNIQUE(tenant_id,email));
CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS agent_versions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), slug TEXT NOT NULL, version TEXT NOT NULL, developer_id TEXT REFERENCES users(id), manifest_json TEXT NOT NULL, digest TEXT NOT NULL, signature TEXT, status TEXT NOT NULL CHECK(status IN ('draft','moderation','active','rejected','disabled')), moderation_reason TEXT, created_at TEXT NOT NULL, moderated_at TEXT, UNIQUE(tenant_id,slug,version));
CREATE TABLE IF NOT EXISTS installations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), agent_slug TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('trial','active','paused','disabled')), config_json TEXT NOT NULL DEFAULT '{}', price_json TEXT NOT NULL, installed_by TEXT NOT NULL REFERENCES users(id), trial_ends_at TEXT, created_at TEXT NOT NULL, disabled_at TEXT, UNIQUE(tenant_id,agent_slug));
CREATE TABLE IF NOT EXISTS pools (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL CHECK(mode IN ('approval','autonomous')), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pool_members (pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE, agent_slug TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'worker', weight REAL NOT NULL DEFAULT 1, PRIMARY KEY(pool_id,agent_slug));
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), pool_id TEXT REFERENCES pools(id), channel TEXT NOT NULL DEFAULT 'api', external_id TEXT, title TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(tenant_id,channel,external_id));
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sender_type TEXT NOT NULL, sender_id TEXT NOT NULL, body TEXT NOT NULL, structured_json TEXT NOT NULL DEFAULT '{}', epoch INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS business_objects (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), kind TEXT NOT NULL, external_id TEXT NOT NULL, version INTEGER NOT NULL, data_json TEXT NOT NULL, provenance_json TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id,kind,external_id));
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), job_id TEXT, kind TEXT NOT NULL, uri TEXT, content_json TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), agent_slug TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, idempotency_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','leased','waiting_dependencies','waiting_approval','succeeded','failed','dead_letter','cancelled')), priority INTEGER NOT NULL DEFAULT 100, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, run_at TEXT NOT NULL, lease_until TEXT, lease_owner TEXT, epoch INTEGER NOT NULL, depends_on_json TEXT NOT NULL DEFAULT '[]', result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id,idempotency_key));
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), job_id TEXT REFERENCES jobs(id), action TEXT NOT NULL, payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','consumed')), requested_by TEXT NOT NULL, decided_by TEXT, reason TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT);
CREATE TABLE IF NOT EXISTS integrations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), kind TEXT NOT NULL, name TEXT NOT NULL, config_encrypted TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE(tenant_id,kind,name));
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), integration_id TEXT REFERENCES integrations(id), operation TEXT NOT NULL, payload_json TEXT NOT NULL, idempotency_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','pending','sent','failed','cancelled')), approval_id TEXT REFERENCES approvals(id), provider_receipt_json TEXT, error TEXT, available_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id,idempotency_key));
CREATE TABLE IF NOT EXISTS audit_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL REFERENCES tenants(id), actor TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), installation_id TEXT NOT NULL REFERENCES installations(id), job_id TEXT, unit TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price_minor INTEGER NOT NULL, amount_minor INTEGER NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(tenant_id,idempotency_key));
CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), installation_id TEXT REFERENCES installations(id), period TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'RUB', status TEXT NOT NULL CHECK(status IN ('draft','issued','paid','void')), external_receipt TEXT, created_at TEXT NOT NULL, paid_at TEXT, UNIQUE(tenant_id,installation_id,period));
CREATE TABLE IF NOT EXISTS partners (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), owner_user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, region TEXT NOT NULL DEFAULT '', commission_bps INTEGER NOT NULL DEFAULT 3000, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS referrals (id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), referred_tenant_id TEXT NOT NULL REFERENCES tenants(id), source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(partner_id,referred_tenant_id));
CREATE TABLE IF NOT EXISTS ledger_entries (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), partner_id TEXT REFERENCES partners(id), developer_id TEXT REFERENCES users(id), invoice_id TEXT REFERENCES invoices(id), kind TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'RUB', status TEXT NOT NULL CHECK(status IN ('pending','available','paid','void')), idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(tenant_id,idempotency_key));
CREATE TABLE IF NOT EXISTS payout_accounts (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), owner_user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, details_encrypted TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS privacy_signals (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), niche TEXT NOT NULL, payload_json TEXT NOT NULL, consent_at TEXT NOT NULL, created_at TEXT NOT NULL, exported_at TEXT, export_id TEXT);
CREATE TABLE IF NOT EXISTS market_exports (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, tenant_count INTEGER NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), kind TEXT NOT NULL, name TEXT NOT NULL, contact TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL, referral_code TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_documents (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), title TEXT NOT NULL, source_uri TEXT NOT NULL, version INTEGER NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(tenant_id,source_uri,version));
CREATE TABLE IF NOT EXISTS knowledge_chunks (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, content TEXT NOT NULL, tokens_json TEXT NOT NULL, UNIQUE(document_id,ordinal));
CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), agent_slug TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, interval_seconds INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, next_run_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metrics (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), installation_id TEXT REFERENCES installations(id), agent_slug TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, evidence_json TEXT NOT NULL DEFAULT '{}', observed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), external_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]', consent_at TEXT, opted_out_at TEXT, created_at TEXT NOT NULL, UNIQUE(tenant_id,external_id));
CREATE TABLE IF NOT EXISTS inventory_items (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), sku TEXT NOT NULL, name TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', reorder_point REAL NOT NULL DEFAULT 0, safety_stock REAL NOT NULL DEFAULT 0, lead_time_days REAL NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE(tenant_id,sku));
CREATE TABLE IF NOT EXISTS inventory_movements (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), item_id TEXT NOT NULL REFERENCES inventory_items(id), kind TEXT NOT NULL CHECK(kind IN ('receipt','issue','adjustment','count')), quantity REAL NOT NULL, reference TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(tenant_id,idempotency_key));
INSERT OR IGNORE INTO meta(key,value) VALUES ('schema_version','1'),('epoch','1');
`;

export class Store {
  constructor(config) {
    this.config = config;
    this.db = new DatabaseSync(resolve(config.dataDir, '2aos.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    const outboxColumns = this.all('PRAGMA table_info(outbox)').map((column) => column.name);
    if (!outboxColumns.includes('available_at')) this.db.exec('ALTER TABLE outbox ADD COLUMN available_at TEXT');
    this.txDepth = 0;
    this.bootstrapCredentials = this.bootstrap();
  }

  bootstrap() {
    if (this.get("SELECT id FROM api_keys WHERE revoked_at IS NULL LIMIT 1")) return null;
    const time = nowIso();
    const tenantId = 'tenant_default', userId = 'user_admin';
    this.db.prepare("INSERT OR IGNORE INTO tenants(id,name,created_at) VALUES (?,?,?)").run(tenantId, 'Default organization', time);
    this.db.prepare("INSERT OR IGNORE INTO users(id,tenant_id,email,name,role,created_at) VALUES (?,?,?,?,?,?)").run(userId, tenantId, 'admin@local', 'Local administrator', 'owner', time);
    const key = this.config.adminKey || `a2os_${token(24)}`;
    this.createApiKey({ tenantId, userId, name: 'Bootstrap owner', role: 'owner', key });
    return { apiKey: this.config.adminKey ? undefined : key, tenantId, userId };
  }

  close() { this.db.close(); }
  get(sql, ...params) { return asRow(this.db.prepare(sql).get(...params)); }
  all(sql, ...params) { return asRows(this.db.prepare(sql).all(...params)); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }

  transaction(fn) {
    const savepoint = `tx_${this.txDepth}`;
    this.db.exec(this.txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      this.db.exec(this.txDepth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.txDepth--;
      this.db.exec(this.txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  createApiKey({ tenantId, userId, name, role, key = `a2os_${token(24)}` }) {
    const keyId = id('key');
    this.run('INSERT INTO api_keys(id,tenant_id,user_id,name,prefix,hash,role,created_at) VALUES (?,?,?,?,?,?,?,?)',
      keyId, tenantId, userId, name, key.slice(0, 12), hashApiKey(key), role, nowIso());
    return { id: keyId, key };
  }

  authenticate(header) {
    if (!header?.startsWith('Bearer ')) return null;
    const key = header.slice(7).trim();
    if (!key) return null;
    return this.get(`SELECT k.id key_id,k.tenant_id,k.user_id,k.role,u.email,u.name FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.hash=? AND k.revoked_at IS NULL`, hashApiKey(key));
  }

  audit({ tenantId, actor, action, entityType, entityId, payload = {} }) {
    const previous = this.get('SELECT hash FROM audit_log WHERE tenant_id=? ORDER BY seq DESC LIMIT 1', tenantId);
    const entry = { id: id('audit'), tenantId, actor, action, entityType, entityId, payload, previousHash: previous?.hash || 'GENESIS', createdAt: nowIso() };
    const hash = digest(entry);
    this.run(`INSERT INTO audit_log(id,tenant_id,actor,action,entity_type,entity_id,payload_json,prev_hash,hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      entry.id, tenantId, actor, action, entityType, entityId, canonicalJson(payload), entry.previousHash, hash, entry.createdAt);
    return { id: entry.id, hash };
  }

  verifyAudit(tenantId) {
    const rows = this.all('SELECT * FROM audit_log WHERE tenant_id=? ORDER BY seq', tenantId);
    let previousHash = 'GENESIS';
    for (const row of rows) {
      if (row.prev_hash !== previousHash) return { valid: false, at: row.seq, reason: 'broken previous hash' };
      const entry = { id: row.id, tenantId: row.tenant_id, actor: row.actor, action: row.action, entityType: row.entity_type, entityId: row.entity_id, payload: JSON.parse(row.payload_json), previousHash: row.prev_hash, createdAt: row.created_at };
      if (digest(entry) !== row.hash) return { valid: false, at: row.seq, reason: 'invalid entry hash' };
      previousHash = row.hash;
    }
    return { valid: true, entries: rows.length, head: previousHash };
  }

  epoch() { return Number(this.get("SELECT value FROM meta WHERE key='epoch'").value); }
  incrementEpoch() {
    this.run("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='epoch'");
    return this.epoch();
  }
}
