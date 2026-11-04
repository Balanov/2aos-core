import { canonicalJson, digest, id, integer, nowIso, percentile, require, round } from './util.mjs';

const ALLOWED = new Set(['processCode', 'observationCount', 'monthlyCostMinor', 'manualMinutesPerMonth', 'urgency', 'complexity', 'agentCount', 'outcomeCode']);
const CODES = /^[a-z][a-z0-9-]{1,60}$/;

export class PrivacyGateway {
  constructor(store) { this.store = store; }

  setConsent(tenantId, enabled, actor) {
    this.store.run('UPDATE tenants SET privacy_opt_in=? WHERE id=?', enabled ? 1 : 0, tenantId);
    this.store.audit({ tenantId, actor, action: enabled ? 'privacy.opt_in' : 'privacy.opt_out', entityType: 'tenant', entityId: tenantId });
  }

  createSignal({ tenantId, niche, payload, actor }) {
    const tenant = this.store.get('SELECT * FROM tenants WHERE id=?', tenantId);
    require(tenant?.privacy_opt_in === 1, 409, 'privacy_consent_required', 'Explicit privacy opt-in is required');
    require(CODES.test(niche), 422, 'validation_error', 'Invalid niche code');
    require(payload && typeof payload === 'object' && !Array.isArray(payload), 422, 'privacy_schema', 'Signal payload must be an object');
    for (const key of Object.keys(payload)) require(ALLOWED.has(key), 422, 'privacy_field_denied', `Field is not exportable: ${key}`);
    require(CODES.test(payload.processCode), 422, 'privacy_schema', 'processCode is required and must be a taxonomy code');
    integer(payload.observationCount, 'observationCount', { min: 1, max: 1_000_000 });
    for (const key of ['monthlyCostMinor', 'manualMinutesPerMonth', 'agentCount']) {
      if (payload[key] !== undefined) integer(payload[key], key, { min: 0, max: Number.MAX_SAFE_INTEGER });
    }
    for (const key of ['urgency', 'complexity']) if (payload[key] !== undefined) require(Number.isInteger(payload[key]) && payload[key] >= 1 && payload[key] <= 5, 422, 'privacy_schema', `${key} must be integer 1..5`);
    if (payload.outcomeCode !== undefined) require(CODES.test(payload.outcomeCode), 422, 'privacy_schema', 'outcomeCode must be a taxonomy code');
    const signalId = id('signal'), time = nowIso();
    this.store.run('INSERT INTO privacy_signals(id,tenant_id,niche,payload_json,consent_at,created_at) VALUES (?,?,?,?,?,?)', signalId, tenantId, niche, canonicalJson(payload), time, time);
    this.store.audit({ tenantId, actor, action: 'privacy.signal_created', entityType: 'privacy_signal', entityId: signalId, payload: { niche, fields: Object.keys(payload).sort() } });
    return { id: signalId, niche, status: 'local_pending_cohort', payload };
  }

  buildExport(niche) {
    require(CODES.test(niche), 422, 'validation_error', 'Invalid niche code');
    const signals = this.store.all('SELECT * FROM privacy_signals WHERE niche=? AND exported_at IS NULL', niche);
    const tenantIds = new Set(signals.map((s) => s.tenant_id));
    if (tenantIds.size < this.store.config.exportMinTenants) {
      return { exported: false, reason: 'insufficient_independent_cohort', requiredTenants: this.store.config.exportMinTenants, availableTenants: tenantIds.size };
    }
    const payloads = signals.map((s) => JSON.parse(s.payload_json));
    require(payloads.every((p) => new Set(Object.keys(p)).size <= ALLOWED.size && Object.keys(p).every((k) => ALLOWED.has(k))), 500, 'privacy_schema', 'Stored signal violates allowlist');
    const stats = (key, rounding) => {
      const values = payloads.map((p) => p[key]).filter(Number.isFinite).sort((a, b) => a - b);
      return values.length ? Math.round(percentile(values, 0.5) / rounding) * rounding : undefined;
    };
    const aggregate = {
      schemaVersion: '2aos.market/v1', niche,
      companyCount: tenantIds.size,
      observationCount: payloads.reduce((sum, p) => sum + p.observationCount, 0),
      monthlyCostMinorMedianRounded: stats('monthlyCostMinor', 100_000),
      manualMinutesMedianRounded: stats('manualMinutesPerMonth', 10),
      urgencyMedianRounded: stats('urgency', 1),
      complexityMedianRounded: stats('complexity', 1),
      agentCountMedianRounded: stats('agentCount', 1),
      outcomes: [...new Set(payloads.map((p) => p.outcomeCode).filter(Boolean))].sort(),
      privacy: { k: tenantIds.size, rawText: false, tenantIds: false, amountsRoundedToMinor: 100_000 }
    };
    const exportId = id('market'), time = nowIso();
    this.store.transaction(() => {
      this.store.run('INSERT INTO market_exports(id,payload_json,tenant_count,digest,created_at) VALUES (?,?,?,?,?)', exportId, canonicalJson(aggregate), tenantIds.size, digest(aggregate), time);
      for (const signal of signals) this.store.run('UPDATE privacy_signals SET exported_at=?,export_id=? WHERE id=?', time, exportId, signal.id);
    });
    return { exported: true, exportId, digest: digest(aggregate), payload: aggregate };
  }

  overview(niche) {
    const rows = niche ? this.store.all('SELECT * FROM market_exports WHERE niche=? ORDER BY created_at DESC', niche) : this.store.all('SELECT * FROM market_exports ORDER BY created_at DESC');
    return rows.map((row) => ({ exportId: row.id, ...JSON.parse(row.payload_json), createdAt: row.created_at }));
  }
}
