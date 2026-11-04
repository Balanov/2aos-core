import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Store } from './db.mjs';
import { LocalModel } from './models.mjs';
import { KnowledgeBase } from './knowledge.mjs';
import { Billing } from './billing.mjs';
import { Director } from './director.mjs';
import { PrivacyGateway } from './privacy.mjs';
import { ConnectorDispatcher } from './connectors.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { canonicalJson, HttpError, id, nowIso, optionalString, parseJson, require, requiredString } from './util.mjs';
import { parseAgentPackage } from './packages.mjs';
import { openApi } from './openapi.mjs';
import { assertAllowedUrl } from './http.mjs';
import { DeveloperExchange } from './developer.mjs';
import { HostClient } from './host/client.mjs';
import { HostSystem } from './host/system.mjs';

const catalog = JSON.parse(readFileSync(new URL('../catalog/agents.json', import.meta.url), 'utf8'));
const packages = JSON.parse(readFileSync(new URL('../catalog/packages.json', import.meta.url), 'utf8'));
const ROLE = { viewer: 10, partner: 20, developer: 30, operator: 50, admin: 80, owner: 100 };

export function createRuntime(config) {
  const store = new Store(config), model = new LocalModel(config), knowledge = new KnowledgeBase(store, model), billing = new Billing(store, catalog), director = new Director(store, catalog, billing), privacy = new PrivacyGateway(store), dispatcher = new ConnectorDispatcher(store), orchestrator = new Orchestrator({ store, billing, model, knowledge, dispatcher });
  const developerExchange = new DeveloperExchange(store), hostSystem = new HostSystem(config);
  const rateLimits = new Map(), hostClients = new Map();

  async function handler(req, res) {
    const requestId = id('req'), started = Date.now();
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-request-id', requestId);
    try {
      const url = new URL(req.url, 'http://local');
      const path = url.pathname.replace(/\/$/, '') || '/';
      const method = req.method;
      if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (path === '/health/live' && method === 'GET') return send(res, 200, { status: 'ok', uptimeSeconds: process.uptime() });
      if (path === '/health/ready' && method === 'GET') {
        store.get('SELECT 1 ok');
        return send(res, 200, { status: 'ready', database: 'ok', model: await model.health(), telemetry: false });
      }
      if (path === '/openapi.json' && method === 'GET') return send(res, 200, openApi(config.publicBaseUrl || `http://${config.host}:${config.port}`));
      if (path === '/.well-known/2aos.json' && method === 'GET') return send(res, 200, developerExchange.card(config.publicBaseUrl || `http://${config.host}:${config.port}`));
      if (path === '/llms.txt' && method === 'GET') { res.setHeader('content-type', 'text/plain; charset=utf-8'); return send(res, 200, developerExchange.llmsText(config.publicBaseUrl || `http://${config.host}:${config.port}`)); }
      if (path === '/v1/catalog/public' && method === 'GET') return send(res, 200, { agents: catalog.map(publicAgent), packages });
      if (path === '/v1/leads' && method === 'POST') {
        rateLimit(rateLimits, req.socket.remoteAddress || 'local');
        const body = await bodyJson(req, config.bodyLimit);
        const leadId = id('lead');
        const name = requiredString(body.name, 'name', 300), contact = requiredString(body.contact, 'contact', 500);
        store.run('INSERT INTO leads(id,tenant_id,kind,name,contact,email,company,payload_json,referral_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', leadId, 'tenant_default', optionalString(body.form_type, 'form_type', 100) || 'website', name, contact, optionalString(body.email, 'email', 320), optionalString(body.company, 'company', 500), canonicalJson(body), optionalString(body.referral_code, 'referral_code', 100) || null, nowIso());
        return send(res, 201, { success: true, id: leadId, message: 'Заявка сохранена. Региональный центр свяжется с вами.' });
      }
      const auth = store.authenticate(req.headers.authorization);
      require(auth, 401, 'unauthorized', 'Valid bearer API key is required');
      const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await bodyJson(req, config.bodyLimit) : {};
      const actor = auth.user_id, tenantId = auth.tenant_id;
      const role = (minimum) => require(ROLE[auth.role] >= ROLE[minimum], 403, 'forbidden', `Requires ${minimum} role`);
      const match = (pattern) => matchPath(path, pattern);

      if (path === '/v1/me' && method === 'GET') return send(res, 200, { tenantId, userId: actor, role: auth.role, email: auth.email, name: auth.name });
      if (path === '/v1/tenants' && method === 'POST') {
        role('owner');
        const newTenantId = id('tenant'), newUserId = id('user'), time = nowIso();
        store.run('INSERT INTO tenants(id,name,region,created_at) VALUES (?,?,?,?)', newTenantId, requiredString(body.name, 'name', 300), optionalString(body.region, 'region', 200), time);
        store.run('INSERT INTO users(id,tenant_id,email,name,role,created_at) VALUES (?,?,?,?,?,?)', newUserId, newTenantId, requiredString(body.email, 'email', 320), requiredString(body.adminName, 'adminName', 300), 'owner', time);
        const apiKey = store.createApiKey({ tenantId: newTenantId, userId: newUserId, name: 'Owner API key', role: 'owner' });
        return send(res, 201, { tenantId: newTenantId, userId: newUserId, apiKey: apiKey.key, warning: 'Save API key now; only its hash is stored' });
      }
      if (path === '/v1/catalog' && method === 'GET') return send(res, 200, { agents: catalog.map(publicAgent), custom: store.all("SELECT id,slug,version,status,digest,created_at FROM agent_versions WHERE status='active'") });
      if (path === '/v1/packages' && method === 'GET') return send(res, 200, { packages });
      if (path === '/v1/objects' && method === 'POST') { role('operator'); return send(res, 201, director.upsertObject({ tenantId, kind: body.kind, externalId: body.externalId, data: body.data, provenance: body.provenance, actor })); }
      if (path === '/v1/director/analyze' && method === 'POST') { role('operator'); return send(res, 200, director.analyze({ tenantId, observations: body.observations, actor })); }
      if (path === '/v1/installations/quote' && method === 'POST') { role('operator'); return send(res, 201, billing.quote({ tenantId, agentSlug: body.agentSlug, trialDays: body.trialDays ?? 7, monthlyMinor: body.monthlyMinor, unitPriceMinor: body.unitPriceMinor, actor })); }
      if (path === '/v1/packages/quote' && method === 'POST') { role('operator'); return send(res, 201, billing.packageQuote({ tenantId, packageSlug: body.packageSlug, packages, trialDays: body.trialDays ?? 7, actor })); }
      if (path === '/v1/installations' && method === 'GET') return send(res, 200, { installations: store.all('SELECT * FROM installations WHERE tenant_id=? ORDER BY created_at DESC', tenantId) });
      if (path === '/v1/jobs' && method === 'POST') { role('operator'); return send(res, 202, orchestrator.enqueue({ tenantId, agentSlug: body.agentSlug, type: body.type, payload: body.payload || {}, idempotencyKey: body.idempotencyKey, priority: body.priority, dependsOn: body.dependsOn || [], maxAttempts: body.maxAttempts, runAt: body.runAt, actor, autonomous: body.autonomous === true })); }
      let m;
      if ((m = match('/v1/jobs/:id')) && method === 'GET') return send(res, 200, jobView(store.get('SELECT * FROM jobs WHERE id=? AND tenant_id=?', m.id, tenantId)));
      if (path === '/v1/jobs/drain' && method === 'POST') { role('admin'); return send(res, 200, { results: await orchestrator.drain(body.concurrency || config.workerConcurrency, body.maxJobs || 1000) }); }
      if (path === '/v1/pools' && method === 'POST') { role('operator'); return send(res, 201, orchestrator.createPool({ tenantId, name: requiredString(body.name, 'name', 300), description: body.description, mode: body.mode || 'approval', members: body.members || [], actor })); }
      if ((m = match('/v1/pools/:id/messages')) && method === 'POST') { role('operator'); return send(res, 202, orchestrator.poolMessage({ tenantId, poolId: m.id, body: body.body, channel: body.channel || 'api', externalId: body.externalId || null, inputs: body.inputs || {}, eventId: body.eventId, actor })); }
      if ((m = match('/v1/conversations/:id/messages')) && method === 'GET') return send(res, 200, { messages: store.all('SELECT * FROM messages WHERE conversation_id=? AND tenant_id=? ORDER BY created_at', m.id, tenantId) });
      if (path === '/v1/approvals' && method === 'GET') return send(res, 200, { approvals: store.all('SELECT * FROM approvals WHERE tenant_id=? ORDER BY created_at DESC LIMIT 500', tenantId) });
      if ((m = match('/v1/approvals/:id/approve')) && method === 'POST') { role('operator'); return send(res, 200, await orchestrator.approve({ tenantId, approvalId: m.id, expectedDigest: body.digest, actor })); }
      if ((m = match('/v1/approvals/:id/reject')) && method === 'POST') { role('operator'); return send(res, 200, orchestrator.reject({ tenantId, approvalId: m.id, reason: body.reason, actor })); }
      if (path === '/v1/stop' && method === 'POST') { role('admin'); return send(res, 200, orchestrator.stop(tenantId, body.reason, actor)); }
      if (path === '/v1/integrations' && method === 'POST') { role('admin'); return send(res, 201, dispatcher.upsertIntegration({ tenantId, kind: body.kind, name: body.name, config: body.config, actor })); }
      if ((m = match('/v1/integrations/:id/test')) && method === 'POST') { role('admin'); return send(res, 200, await dispatcher.test(m.id, tenantId)); }
      if (path === '/v1/packages/upload' && method === 'POST') { role('developer'); return send(res, 201, uploadPackage(Buffer.from(requiredString(body.zipBase64, 'zipBase64', 100000000), 'base64'))); }
      if (path === '/v1/packages/import' && method === 'POST') {
        role('developer');
        const parsed = assertAllowedUrl(requiredString(body.url, 'url', 2000), config.allowedEndpoints);
        const response = await fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(60000) });
        require(response.ok, 502, 'package_download_failed', `Package URL returned ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        require(buffer.length <= 100000000, 422, 'zip_limit', 'Package download exceeds limit');
        return send(res, 201, uploadPackage(buffer));
      }
      if (path === '/v1/agent-versions' && method === 'GET') { role('developer'); return send(res, 200, { versions: store.all(auth.role === 'developer' ? 'SELECT id,slug,version,status,digest,created_at FROM agent_versions WHERE developer_id=?' : 'SELECT id,slug,version,status,digest,created_at FROM agent_versions', ...(auth.role === 'developer' ? [actor] : [])) }); }
      if ((m = match('/v1/agent-versions/:id/moderate')) && method === 'POST') {
        role('admin'); require(['active', 'rejected', 'disabled'].includes(body.status), 422, 'validation_error', 'Invalid moderation status');
        const version = store.get('SELECT * FROM agent_versions WHERE id=?', m.id); require(version, 404, 'version_not_found', 'Agent version not found');
        store.run('UPDATE agent_versions SET status=?,moderation_reason=?,moderated_at=? WHERE id=?', body.status, body.reason || null, nowIso(), m.id);
        store.audit({ tenantId: version.tenant_id, actor, action: 'agent.moderated', entityType: 'agent_version', entityId: m.id, payload: { status: body.status, reason: body.reason } });
        return send(res, 200, { id: m.id, status: body.status });
      }
      if (path === '/v1/developer/dashboard' && method === 'GET') { role('developer'); return send(res, 200, billing.developerDashboard(tenantId, actor)); }
      if (path === '/v1/partners' && method === 'POST') {
        role('admin'); const partnerId = id('partner');
        store.run('INSERT INTO partners(id,tenant_id,owner_user_id,name,code,region,commission_bps,created_at) VALUES (?,?,?,?,?,?,?,?)', partnerId, tenantId, actor, requiredString(body.name, 'name', 300), requiredString(body.code, 'code', 100), optionalString(body.region, 'region', 200), body.commissionBps ?? 3000, nowIso());
        if (body.referredTenantId) store.run('INSERT INTO referrals(id,partner_id,referred_tenant_id,source,created_at) VALUES (?,?,?,?,?)', id('referral'), partnerId, body.referredTenantId, body.source || '', nowIso());
        return send(res, 201, { partnerId });
      }
      if ((m = match('/v1/partners/:id/dashboard')) && method === 'GET') { role('partner'); return send(res, 200, billing.partnerDashboard(tenantId, m.id)); }
      if (path === '/v1/privacy/consent' && method === 'POST') { role('admin'); privacy.setConsent(tenantId, body.enabled === true, actor); return send(res, 200, { enabled: body.enabled === true }); }
      if (path === '/v1/privacy/signals' && method === 'POST') { role('operator'); return send(res, 201, privacy.createSignal({ tenantId, niche: body.niche, payload: body.payload, actor })); }
      if (path === '/v1/market/export' && method === 'POST') { role('admin'); return send(res, 200, privacy.buildExport(body.niche)); }
      if (path === '/v1/market/overview' && method === 'GET') return send(res, 200, { market: privacy.overview(url.searchParams.get('niche')) });
      if (path === '/v1/knowledge/documents' && method === 'POST') { role('operator'); return send(res, 201, knowledge.ingest({ tenantId, title: body.title, sourceUri: body.sourceUri, text: body.text, actor })); }
      if (path === '/v1/knowledge/query' && method === 'POST') return send(res, 200, await knowledge.answer({ tenantId, query: body.query, useModel: body.useModel === true }));
      if (path === '/v1/schedules' && method === 'POST') { role('operator'); return send(res, 201, orchestrator.schedule({ tenantId, agentSlug: body.agentSlug, type: body.type, payload: body.payload || {}, intervalSeconds: body.intervalSeconds, actor })); }
      if (path === '/v1/usage' && method === 'POST') { role('admin'); return send(res, 201, billing.recordUsage({ tenantId, agentSlug: body.agentSlug, unit: body.unit || 'run', quantity: body.quantity || 1, idempotencyKey: body.idempotencyKey, unitPriceMinor: body.unitPriceMinor })); }
      if ((m = match('/v1/invoices/:slug')) && method === 'POST') { role('admin'); return send(res, 201, billing.issueInvoice({ tenantId, agentSlug: m.slug, period: body.period, actor })); }
      if ((m = match('/v1/invoices/:id/paid')) && method === 'POST') { role('admin'); return send(res, 200, billing.markPaid({ tenantId, invoiceId: m.id, externalReceipt: body.externalReceipt, actor })); }
      if (path === '/v1/metrics' && method === 'POST') { role('operator'); const metricId = id('metric'); store.run('INSERT INTO metrics(id,tenant_id,installation_id,agent_slug,name,value,evidence_json,observed_at) VALUES (?,?,?,?,?,?,?,?)', metricId, tenantId, body.installationId || null, requiredString(body.agentSlug, 'agentSlug', 100), requiredString(body.name, 'name', 100), body.value, canonicalJson(body.evidence || {}), body.observedAt || nowIso()); return send(res, 201, { metricId }); }
      if ((m = match('/v1/director/efficiency/:slug')) && method === 'GET') return send(res, 200, director.efficiency(tenantId, m.slug));
      if (path === '/v1/audit/verify' && method === 'GET') return send(res, 200, store.verifyAudit(tenantId));
      if (path === '/v1/artifacts' && method === 'GET') return send(res, 200, { artifacts: store.all('SELECT id,job_id,kind,uri,metadata_json,created_at FROM artifacts WHERE tenant_id=? ORDER BY created_at DESC LIMIT 500', tenantId) });
      if ((m = match('/v1/artifacts/:id')) && method === 'GET') { const artifact = store.get('SELECT * FROM artifacts WHERE id=? AND tenant_id=?', m.id, tenantId); require(artifact, 404, 'artifact_not_found', 'Artifact not found'); return send(res, 200, { ...artifact, content: parseJson(artifact.content_json), metadata: parseJson(artifact.metadata_json, {}) }); }
      if (path === '/v1/developer/opportunities' && method === 'GET') { role('developer'); return send(res, 200, { opportunities: developerExchange.opportunities(url.searchParams.get('niche')) }); }
      if ((m = match('/v1/developer/briefs/:niche')) && method === 'GET') { role('developer'); return send(res, 200, developerExchange.brief(m.niche)); }
      if ((m = match('/v1/developer/scaffold/:niche')) && method === 'GET') { role('developer'); return send(res, 200, { manifest: developerExchange.scaffold(m.niche) }); }
      if (path === '/v1/director/submissions' && method === 'GET') { role('operator'); return send(res, 200, { submissions: store.all("SELECT id,tenant_id,slug,version,developer_id,status,digest,created_at FROM agent_versions WHERE status IN ('moderation','active') ORDER BY created_at DESC") }); }
      if ((m = match('/v1/director/submissions/:id/accept')) && method === 'POST') {
        role('admin');
        const version = store.get('SELECT * FROM agent_versions WHERE id=?', m.id);
        require(version, 404, 'version_not_found', 'Submission not found');
        store.run("UPDATE agent_versions SET status='active',moderated_at=?,moderation_reason=NULL WHERE id=?", nowIso(), m.id);
        store.audit({ tenantId: version.tenant_id, actor, action: 'agent.moderated', entityType: 'agent_version', entityId: m.id, payload: { status: 'active', via: 'director' } });
        return send(res, 200, billing.quote({ tenantId, agentSlug: version.slug, actor, trialDays: body.trialDays ?? 7 }));
      }
      if (path === '/v1/host/discover' && method === 'POST') { role('operator'); const result = await hostFor(body.roots, body.policy).discover(); return send(res, 200, result); }
      if (path === '/v1/host/inventory' && method === 'GET') { role('viewer'); const latest = hostFor().latest(); return send(res, 200, { ...latest, files: latest.files.slice(0, Number(url.searchParams.get('limit') || 1000)) }); }
      if (path === '/v1/host/watch/start' && method === 'POST') { role('operator'); await hostFor(body.roots, body.policy).start(); return send(res, 202, { watching: true, intervalMs: config.hostScanIntervalMs }); }
      if (path === '/v1/host/watch/stop' && method === 'POST') { role('operator'); await hostFor().stop(); return send(res, 200, { watching: false }); }
      if (path === '/v1/host/changes' && method === 'GET') { role('viewer'); return send(res, 200, { changes: hostFor().changes() }); }
      if (path === '/v1/host/profiles' && method === 'GET') { role('admin'); return send(res, 200, { profiles: hostSystem.profiles() }); }
      if (path === '/v1/host/profiles' && method === 'POST') { role('owner'); const profile = hostSystem.registerProfile(body); store.audit({ tenantId, actor, action: 'host.profile_registered', entityType: 'host_profile', entityId: body.name, payload: { mutation: body.mutation === true, executable: body.executable, args: body.args } }); return send(res, 201, { profile }); }
      if ((m = match('/v1/host/system/:profile')) && method === 'POST') {
        role('operator');
        const profile = hostSystem.profiles()[m.profile];
        require(profile && !profile.mutation, 403, 'approval_required', 'Mutating profiles require host.command approval');
        return send(res, 200, await hostSystem.execute(m.profile, { input: body.input || '' }));
      }
      if (path === '/v1/host/effects' && method === 'POST') {
        role('admin');
        const result = await orchestrator.prepareEffect({ job: { id: null, tenant_id: tenantId, agent_slug: 'host-system', epoch: store.epoch() }, effect: { type: 'host.command', integration: body.integration || 'host-shell', payload: { profile: body.profile, input: body.input || '' }, consequential: true, idempotencyKey: body.idempotencyKey }, autonomous: body.autonomous === true, actor });
        return send(res, 202, result);
      }
      throw new HttpError(404, 'not_found', 'API route not found');

      function hostFor(roots = config.hostRoots, policy = {}) {
        const key = `${tenantId}:${(roots || config.hostRoots).join('|')}`;
        if (!hostClients.has(key)) hostClients.set(key, new HostClient({ store, knowledge, director, tenantId, roots: roots || config.hostRoots, policy, intervalMs: config.hostScanIntervalMs }));
        return hostClients.get(key);
      }

      function uploadPackage(buffer) {
        const parsed = parseAgentPackage(buffer, config), versionId = id('agent_version');
        store.run('INSERT INTO agent_versions(id,tenant_id,slug,version,developer_id,manifest_json,digest,signature,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', versionId, tenantId, parsed.manifest.slug, parsed.manifest.version, actor, canonicalJson(parsed.manifest), parsed.digest, parsed.manifest.signature || null, 'moderation', nowIso());
        store.audit({ tenantId, actor, action: 'agent.package_uploaded', entityType: 'agent_version', entityId: versionId, payload: { slug: parsed.manifest.slug, version: parsed.manifest.version, digest: parsed.digest } });
        return { id: versionId, slug: parsed.manifest.slug, version: parsed.manifest.version, digest: parsed.digest, status: 'moderation' };
      }
    } catch (error) {
      const status = error.status || 500;
      send(res, status, { error: { code: error.code || 'internal_error', message: status === 500 ? 'Internal server error' : error.message, ...(error.details ? { details: error.details } : {}), requestId } });
      if (status === 500 && config.logLevel !== 'silent') console.error(`[${requestId}]`, error);
    } finally {
      if (config.logLevel === 'debug') console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }

  const server = createServer(handler);
  return { store, model, knowledge, billing, director, privacy, dispatcher, orchestrator, developerExchange, hostSystem, hostClients, handler, server, catalog, packages };
}

function matchPath(path, pattern) {
  const expected = pattern.split('/').filter(Boolean), actual = path.split('/').filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params = {};
  for (let i = 0; i < expected.length; i++) {
    if (expected[i].startsWith(':')) params[expected[i].slice(1)] = decodeURIComponent(actual[i]);
    else if (expected[i] !== actual[i]) return null;
  }
  return params;
}
async function bodyJson(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new HttpError(413, 'body_too_large', 'Request body exceeds limit'); chunks.push(chunk); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON'); }
}
function send(res, status, data) { if (res.writableEnded) return; res.writeHead(status); res.end(JSON.stringify(data ?? {})); }
function rateLimit(store, key) { const now = Date.now(), record = store.get(key) || []; const recent = record.filter((time) => now - time < 600000); require(recent.length < 20, 429, 'rate_limited', 'Too many leads from this address'); recent.push(now); store.set(key, recent); }
function publicAgent(agent) { return { slug: agent.slug, name: agent.name, cluster: agent.cluster, description: agent.description, pricing: agent.pricing, launchDays: agent.launchDays, hardware: agent.hardware, advertised: { verified: false } }; }
function jobView(job) { require(job, 404, 'job_not_found', 'Job not found'); return { ...job, payload: parseJson(job.payload_json), result: parseJson(job.result_json), dependsOn: parseJson(job.depends_on_json, []) }; }
