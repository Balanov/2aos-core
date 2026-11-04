import { canonicalJson, digest, id, integer, nowIso, require } from './util.mjs';

const PERIOD = () => nowIso().slice(0, 7);

export class Billing {
  constructor(store, catalog) { this.store = store; this.catalog = catalog; }

  agent(slug) {
    const builtin = this.catalog.find((item) => item.slug === slug);
    if (builtin) return { ...builtin, version: '1.0.0' };
    const version = this.store.get("SELECT * FROM agent_versions WHERE slug=? AND status='active' ORDER BY created_at DESC LIMIT 1", slug);
    if (!version) return null;
    const manifest = JSON.parse(version.manifest_json);
    return { ...manifest, status: 'active', developerId: version.developer_id, packageDigest: version.digest };
  }

  quote({ tenantId, agentSlug, actor, trialDays = 7, monthlyMinor, unitPriceMinor }) {
    const agent = this.agent(agentSlug);
    require(agent && agent.status === 'active', 404, 'agent_not_found', 'Active catalog agent not found');
    integer(trialDays, 'trialDays', { min: 0, max: 90 });
    const price = {
      currency: 'RUB',
      monthlyMinor: monthlyMinor ?? agent.pricing.monthlyMinor,
      unit: agent.pricing.unit ? { ...agent.pricing.unit, priceMinor: unitPriceMinor ?? agent.pricing.unit.priceMinor } : null
    };
    integer(price.monthlyMinor, 'monthlyMinor', { min: 0, max: 10_000_000_000 });
    if (price.unit) integer(price.unit.priceMinor, 'unitPriceMinor', { min: 0, max: 1_000_000_000 });
    const payload = { schemaVersion: '2aos.install-quote/v1', tenantId, agentSlug, version: agent.version, price, trialDays, catalogDigest: digest(agent) };
    return this.createApproval({ tenantId, action: 'agent.install', payload, actor });
  }

  packageQuote({ tenantId, packageSlug, packages, actor, trialDays = 7 }) {
    const item = packages.find((p) => p.slug === packageSlug);
    require(item, 404, 'package_not_found', 'Package not found');
    const payload = { schemaVersion: '2aos.package-quote/v1', tenantId, packageSlug, agents: item.agents, price: { currency: 'RUB', monthlyMinor: item.pricing.monthlyMinor }, trialDays, catalogDigest: digest(item) };
    return this.createApproval({ tenantId, action: 'package.install', payload, actor });
  }

  createApproval({ tenantId, action, payload, actor }) {
    const approvalId = id('approval'), time = nowIso(), expires = new Date(Date.now() + 30 * 60_000).toISOString();
    const payloadDigest = digest(payload);
    this.store.run(`INSERT INTO approvals(id,tenant_id,job_id,action,payload_json,payload_digest,status,requested_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, approvalId, tenantId, null, action, canonicalJson(payload), payloadDigest, 'pending', actor, expires, time);
    this.store.audit({ tenantId, actor, action: 'quote.created', entityType: 'approval', entityId: approvalId, payload: { action, digest: payloadDigest } });
    return { approvalId, action, payload, digest: payloadDigest, expiresAt: expires, status: 'pending' };
  }

  installApproved(approval, actor) {
    const payload = JSON.parse(approval.payload_json);
    if (approval.action === 'package.install') {
      const agents = payload.agents.map((agentSlug) => this.agent(agentSlug));
      require(agents.every(Boolean), 404, 'agent_not_found', 'Package agent not found');
      const retailTotal = agents.reduce((sum, agent) => sum + agent.pricing.monthlyMinor, 0);
      let allocated = 0;
      const results = [];
      for (const [index, agent] of agents.entries()) {
        const monthlyMinor = index === agents.length - 1 ? payload.price.monthlyMinor - allocated : Math.round(payload.price.monthlyMinor * agent.pricing.monthlyMinor / retailTotal);
        allocated += monthlyMinor;
        const price = { currency: 'RUB', monthlyMinor, unit: agent.pricing.unit || null };
        results.push(this.install({ tenantId: approval.tenant_id, agentSlug: agent.slug, price, trialDays: payload.trialDays, actor, packageSlug: payload.packageSlug, skipCatalogDigest: true }));
      }
      return { packageSlug: payload.packageSlug, allocatedMonthlyMinor: allocated, installations: results };
    }
    require(approval.action === 'agent.install', 422, 'unsupported_action', 'Unsupported installation action');
    return this.install({ tenantId: approval.tenant_id, agentSlug: payload.agentSlug, price: payload.price, trialDays: payload.trialDays, actor, catalogDigest: payload.catalogDigest });
  }

  install({ tenantId, agentSlug, price, trialDays, actor, packageSlug = null, catalogDigest = null, skipCatalogDigest = false }) {
    const agent = this.agent(agentSlug);
    require(agent && agent.status === 'active', 404, 'agent_not_found', 'Catalog agent not found');
    if (!skipCatalogDigest) require(catalogDigest === digest(agent), 409, 'quote_stale', 'Catalog changed after quote');
    const installationId = id('installation'), time = nowIso();
    const trialEnds = trialDays > 0 ? new Date(Date.now() + trialDays * 86_400_000).toISOString() : null;
    this.store.run(`INSERT INTO installations(id,tenant_id,agent_slug,version,status,config_json,price_json,installed_by,trial_ends_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,agent_slug) DO UPDATE SET version=excluded.version,status=excluded.status,price_json=excluded.price_json,trial_ends_at=excluded.trial_ends_at,disabled_at=NULL`, installationId, tenantId, agentSlug, agent.version, trialDays > 0 ? 'trial' : 'active', canonicalJson({ packageSlug }), canonicalJson(price), actor, trialEnds, time);
    const saved = this.store.get('SELECT * FROM installations WHERE tenant_id=? AND agent_slug=?', tenantId, agentSlug);
    this.store.audit({ tenantId, actor, action: 'agent.installed', entityType: 'installation', entityId: saved.id, payload: { agentSlug, version: agent.version, packageSlug, trialEnds } });
    return { installationId: saved.id, agentSlug, version: agent.version, status: saved.status, trialEndsAt: saved.trial_ends_at, price };
  }

  entitlement(tenantId, agentSlug) {
    const item = this.store.get('SELECT * FROM installations WHERE tenant_id=? AND agent_slug=?', tenantId, agentSlug);
    require(item && ['trial', 'active'].includes(item.status), 403, 'agent_not_entitled', 'Agent is not installed or is disabled');
    if (item.status === 'trial' && item.trial_ends_at && Date.parse(item.trial_ends_at) <= Date.now()) {
      this.store.run("UPDATE installations SET status='paused',disabled_at=? WHERE id=?", nowIso(), item.id);
      throw Object.assign(new Error('Trial expired; activate a subscription'), { status: 403, code: 'trial_expired' });
    }
    return item;
  }

  recordUsage({ tenantId, agentSlug, jobId = null, unit, quantity = 1, idempotencyKey, unitPriceMinor }) {
    const installation = this.entitlement(tenantId, agentSlug);
    integer(quantity, 'quantity', { min: 1, max: 1_000_000 });
    const price = JSON.parse(installation.price_json);
    const effectivePrice = unitPriceMinor ?? price.unit?.priceMinor ?? 0;
    integer(effectivePrice, 'unitPriceMinor', { min: 0, max: 1_000_000_000 });
    const existing = this.store.get('SELECT * FROM usage_events WHERE tenant_id=? AND idempotency_key=?', tenantId, idempotencyKey);
    if (existing) return { ...existing, idempotent: true };
    const usageId = id('usage'), time = nowIso();
    this.store.run('INSERT INTO usage_events(id,tenant_id,installation_id,job_id,unit,quantity,unit_price_minor,amount_minor,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', usageId, tenantId, installation.id, jobId, unit, quantity, effectivePrice, effectivePrice * quantity, idempotencyKey, time);
    return { id: usageId, installationId: installation.id, amountMinor: effectivePrice * quantity, idempotent: false };
  }

  issueInvoice({ tenantId, agentSlug, period = PERIOD(), actor }) {
    const installation = this.store.get('SELECT * FROM installations WHERE tenant_id=? AND agent_slug=?', tenantId, agentSlug);
    require(installation, 404, 'installation_not_found', 'Installation not found');
    const existing = this.store.get('SELECT * FROM invoices WHERE tenant_id=? AND installation_id=? AND period=?', tenantId, installation.id, period);
    if (existing) return existing;
    const price = JSON.parse(installation.price_json);
    const usage = this.store.get("SELECT COALESCE(SUM(amount_minor),0) amount FROM usage_events WHERE tenant_id=? AND installation_id=? AND substr(created_at,1,7)=?", tenantId, installation.id, period);
    const amount = price.monthlyMinor + usage.amount;
    const invoiceId = id('invoice');
    this.store.run('INSERT INTO invoices(id,tenant_id,installation_id,period,amount_minor,currency,status,created_at) VALUES (?,?,?,?,?,?,?,?)', invoiceId, tenantId, installation.id, period, amount, price.currency || 'RUB', 'issued', nowIso());
    this.store.audit({ tenantId, actor, action: 'invoice.issued', entityType: 'invoice', entityId: invoiceId, payload: { amountMinor: amount, period } });
    return this.store.get('SELECT * FROM invoices WHERE id=?', invoiceId);
  }

  markPaid({ tenantId, invoiceId, externalReceipt, actor }) {
    const invoice = this.store.get('SELECT * FROM invoices WHERE id=? AND tenant_id=?', invoiceId, tenantId);
    require(invoice, 404, 'invoice_not_found', 'Invoice not found');
    require(invoice.status === 'issued', 409, 'invalid_invoice_state', 'Only issued invoice can be marked paid');
    require(typeof externalReceipt === 'string' && externalReceipt.length >= 3, 422, 'receipt_required', 'External payment receipt is required');
    const time = nowIso();
    this.store.transaction(() => {
      this.store.run("UPDATE invoices SET status='paid',external_receipt=?,paid_at=? WHERE id=?", externalReceipt, time, invoiceId);
      const referral = this.store.get('SELECT p.* FROM referrals r JOIN partners p ON p.id=r.partner_id WHERE r.referred_tenant_id=? ORDER BY r.created_at LIMIT 1', tenantId);
      if (referral) this.addLedger({ tenantId, partnerId: referral.id, invoiceId, kind: 'partner_commission', amountMinor: Math.round(invoice.amount_minor * referral.commission_bps / 10000), key: `partner:${invoiceId}` });
      const installation = this.store.get('SELECT * FROM installations WHERE id=?', invoice.installation_id);
      const agent = this.agent(installation.agent_slug);
      const developerId = this.store.get("SELECT developer_id FROM agent_versions WHERE slug=? AND version=? AND status='active' AND developer_id IS NOT NULL", installation.agent_slug, installation.version)?.developer_id;
      if (developerId) this.addLedger({ tenantId, developerId, invoiceId, kind: 'developer_revenue', amountMinor: Math.round(invoice.amount_minor * (agent.developerBps ?? 7000) / 10000), key: `developer:${invoiceId}` });
      this.store.audit({ tenantId, actor, action: 'invoice.paid', entityType: 'invoice', entityId: invoiceId, payload: { externalReceipt } });
    });
    return this.store.get('SELECT * FROM invoices WHERE id=?', invoiceId);
  }

  addLedger({ tenantId, partnerId = null, developerId = null, invoiceId, kind, amountMinor, key }) {
    this.store.run('INSERT INTO ledger_entries(id,tenant_id,partner_id,developer_id,invoice_id,kind,amount_minor,status,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id('ledger'), tenantId, partnerId, developerId, invoiceId, kind, amountMinor, 'pending', key, nowIso());
  }

  developerDashboard(tenantId, developerId) {
    const agents = this.store.all(`SELECT v.slug,v.version,v.status,COUNT(DISTINCT i.tenant_id) connections FROM agent_versions v LEFT JOIN installations i ON i.agent_slug=v.slug AND i.version=v.version AND i.status IN ('trial','active') WHERE v.developer_id=? GROUP BY v.id ORDER BY v.created_at DESC`, developerId);
    const revenue = this.store.get("SELECT COALESCE(SUM(CASE WHEN kind='developer_revenue' AND status!='void' THEN amount_minor ELSE 0 END),0) total,COALESCE(SUM(CASE WHEN kind='developer_revenue' AND status='paid' THEN amount_minor ELSE 0 END),0) paid FROM ledger_entries WHERE developer_id=?", developerId);
    const quotes = this.store.get("SELECT COUNT(*) count FROM approvals a JOIN agent_versions v ON json_extract(a.payload_json,'$.agentSlug')=v.slug AND json_extract(a.payload_json,'$.version')=v.version WHERE v.developer_id=? AND a.action='agent.install'", developerId);
    const paid = this.store.get("SELECT COUNT(DISTINCT invoice_id) count FROM ledger_entries WHERE developer_id=? AND kind='developer_revenue'", developerId);
    return { agents, revenueMinor: revenue.total, paidMinor: revenue.paid, quotes: quotes.count, paidConnections: paid.count, conversion: quotes.count ? paid.count / quotes.count : 0, payouts: 'external_adapter_required' };
  }

  partnerDashboard(tenantId, partnerId) {
    const partner = this.store.get('SELECT * FROM partners WHERE id=? AND tenant_id=?', partnerId, tenantId);
    require(partner, 404, 'partner_not_found', 'Partner not found');
    const referrals = this.store.get('SELECT COUNT(*) count FROM referrals WHERE partner_id=?', partnerId);
    const amounts = this.store.get("SELECT COALESCE(SUM(CASE WHEN status!='void' THEN amount_minor ELSE 0 END),0) pending,COALESCE(SUM(CASE WHEN status='paid' THEN amount_minor ELSE 0 END),0) paid FROM ledger_entries WHERE partner_id=? AND kind='partner_commission'", partnerId);
    return { partner: { ...partner }, referrals: referrals.count, accruedMinor: amounts.pending, paidMinor: amounts.paid, payouts: 'external_adapter_required' };
  }
}
