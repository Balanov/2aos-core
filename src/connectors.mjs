import { createHmac } from 'node:crypto';
import { canonicalJson, id, nowIso, require } from './util.mjs';
import { encryptJson, decryptJson } from './security.mjs';
import { requestJson } from './http.mjs';
import { sendSmtp } from './smtp.mjs';

export class ConnectorDispatcher {
  constructor(store) { this.store = store; this.config = store.config; }

  upsertIntegration({ tenantId, kind, name, config, actor }) {
    require(/^[a-z][a-z0-9-]{1,50}$/.test(kind) && /^[a-z][a-z0-9-]{1,50}$/.test(name), 422, 'validation_error', 'Invalid integration kind/name');
    require(config && typeof config === 'object', 422, 'validation_error', 'Integration config is required');
    if (config.baseUrl) {
      const origin = new URL(config.baseUrl).origin;
      require(this.config.allowedEndpoints.has(origin), 403, 'endpoint_not_allowed', `Add ${origin} to A2OS_ALLOWED_ENDPOINTS first`);
    }
    const integrationId = id('integration');
    this.store.run(`INSERT INTO integrations(id,tenant_id,kind,name,config_encrypted,enabled,created_at) VALUES (?,?,?,?,?,1,?) ON CONFLICT(tenant_id,kind,name) DO UPDATE SET config_encrypted=excluded.config_encrypted,enabled=1`, integrationId, tenantId, kind, name, encryptJson(config, this.config.masterKey), nowIso());
    const saved = this.store.get('SELECT * FROM integrations WHERE tenant_id=? AND kind=? AND name=?', tenantId, kind, name);
    this.store.audit({ tenantId, actor, action: 'integration.upserted', entityType: 'integration', entityId: saved.id, payload: { kind, name } });
    return { id: saved.id, kind, name, enabled: true, configStored: 'encrypted' };
  }

  async test(integrationId, tenantId) {
    const { integration, config } = this.integration(integrationId, tenantId);
    if (integration.kind === 'memory') return { ok: true, provider: 'memory' };
    if (integration.kind === 'webhook') {
      const response = await requestJson(config.baseUrl, { method: 'GET', allowedEndpoints: this.config.allowedEndpoints, timeoutMs: 10000 });
      return { ok: response.status < 400, provider: 'webhook', status: response.status };
    }
    if (integration.kind === 'smtp') return { ok: Boolean(config.host && config.port && (config.from || config.username)), provider: 'smtp', note: 'Configuration check only; send a draft to verify delivery' };
    return { ok: false, reason: 'No non-mutating health check for this integration kind' };
  }

  integration(integrationId, tenantId) {
    const integration = this.store.get('SELECT * FROM integrations WHERE id=? AND tenant_id=? AND enabled=1', integrationId, tenantId);
    require(integration, 503, 'integration_not_configured', 'Enabled integration not found');
    return { integration, config: decryptJson(integration.config_encrypted, this.config.masterKey) };
  }

  async dispatch({ outboxId, tenantId, operation, payload }) {
    const outbox = this.store.get('SELECT * FROM outbox WHERE id=? AND tenant_id=?', outboxId, tenantId);
    require(outbox, 404, 'outbox_not_found', 'Outbox entry not found');
    if (outbox.status === 'sent') return { ...JSON.parse(outbox.provider_receipt_json || '{}'), idempotent: true };
    const { integration, config } = this.integration(outbox.integration_id, tenantId);
    let receipt;
    if (integration.kind === 'memory') receipt = { provider: 'memory', accepted: true, receiptId: id('receipt'), operation };
    else if (integration.kind === 'webhook') {
      const body = { operation, payload, idempotencyKey: outbox.idempotency_key, eventId: outbox.id, sentAt: nowIso() };
      const signature = createHmac('sha256', config.secret || '').update(canonicalJson(body)).digest('hex');
      const response = await requestJson(config.baseUrl, { method: 'POST', headers: { 'x-2aos-signature': `sha256=${signature}`, 'idempotency-key': outbox.idempotency_key, ...(config.headers || {}) }, body, allowedEndpoints: this.config.allowedEndpoints, timeoutMs: config.timeoutMs || 30000 });
      receipt = { provider: 'webhook', accepted: true, status: response.status, assertion: response.data };
    } else if (integration.kind === 'smtp') {
      require(operation === 'email.send' || operation === 'email.send_report', 422, 'unsupported_operation', `SMTP cannot execute ${operation}`);
      const message = operation === 'email.send_report' ? { to: payload.recipients, subject: payload.subject || '2AOS report', text: payload.summary } : payload;
      receipt = await sendSmtp(config, message);
    } else if (integration.kind === 'telegram') {
      require(['message.send', 'content.schedule'].includes(operation), 422, 'unsupported_operation', `Telegram cannot execute ${operation}`);
      const text = payload.text || payload.summary;
      const response = await requestJson(`${config.baseUrl || 'https://api.telegram.org'}/bot${config.token}/sendMessage`, { method: 'POST', body: { chat_id: payload.chatId || config.chatId, text, disable_web_page_preview: true }, allowedEndpoints: this.config.allowedEndpoints });
      receipt = { provider: 'telegram', accepted: response.data?.ok === true, assertion: response.data?.result || response.data };
    } else if (integration.kind === 'whatsapp') {
      require(operation === 'message.send', 422, 'unsupported_operation', `WhatsApp cannot execute ${operation}`);
      const response = await requestJson(`${config.baseUrl || 'https://graph.facebook.com/v24.0'}/${config.phoneNumberId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${config.token}` }, body: { messaging_product: 'whatsapp', to: payload.to || config.recipient, type: 'text', text: { body: payload.text } }, allowedEndpoints: this.config.allowedEndpoints });
      receipt = { provider: 'whatsapp', accepted: Boolean(response.data?.messages?.[0]?.id), assertion: response.data };
    } else throw Object.assign(new Error(`Unsupported integration kind ${integration.kind}`), { status: 422, code: 'unsupported_integration' });
    this.store.run("UPDATE outbox SET status='sent',provider_receipt_json=?,error=NULL,updated_at=? WHERE id=?", canonicalJson(receipt), nowIso(), outboxId);
    return receipt;
  }
}
