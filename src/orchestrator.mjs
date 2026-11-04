import { canonicalJson, digest, HttpError, id, nowIso, require, sleep } from './util.mjs';
import { runAgent } from './agents/index.mjs';

export class Orchestrator {
  constructor({ store, billing, model, knowledge, dispatcher }) {
    this.store = store; this.billing = billing; this.model = model; this.knowledge = knowledge; this.dispatcher = dispatcher;
    this.timer = null; this.workers = new Set(); this.running = false;
  }

  enqueue({ tenantId, agentSlug, type = 'run', payload = {}, idempotencyKey, priority = 100, dependsOn = [], maxAttempts = 3, runAt, actor, autonomous = false, conversationId = null }) {
    require(typeof agentSlug === 'string' && agentSlug.length > 0, 422, 'validation_error', 'agentSlug is required');
    require(typeof idempotencyKey === 'string' && idempotencyKey.length >= 3 && idempotencyKey.length <= 300, 422, 'idempotency_required', 'idempotencyKey is required');
    require(Array.isArray(dependsOn) && dependsOn.every((value) => typeof value === 'string'), 422, 'validation_error', 'dependsOn must contain job IDs');
    const existing = this.store.get('SELECT * FROM jobs WHERE tenant_id=? AND idempotency_key=?', tenantId, idempotencyKey);
    if (existing) return { ...existing, idempotent: true };
    this.billing.entitlement(tenantId, agentSlug);
    for (const dependency of dependsOn) require(this.store.get('SELECT id FROM jobs WHERE id=? AND tenant_id=?', dependency, tenantId), 422, 'dependency_not_found', `Dependency not found: ${dependency}`);
    const jobId = id('job'), time = nowIso(), epoch = this.store.epoch();
    const envelope = { input: payload, runtime: { autonomous: autonomous === true, conversationId } };
    this.store.run(`INSERT INTO jobs(id,tenant_id,agent_slug,type,payload_json,idempotency_key,status,priority,max_attempts,run_at,epoch,depends_on_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, jobId, tenantId, agentSlug, type, canonicalJson(envelope), idempotencyKey, dependsOn.length ? 'waiting_dependencies' : 'queued', priority, maxAttempts, runAt || time, epoch, canonicalJson(dependsOn), time, time);
    this.store.audit({ tenantId, actor, action: 'job.enqueued', entityType: 'job', entityId: jobId, payload: { agentSlug, type, dependsOn, autonomous } });
    return this.store.get('SELECT * FROM jobs WHERE id=?', jobId);
  }

  recover() {
    const time = nowIso();
    this.store.run("UPDATE jobs SET status='queued',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE status='leased' AND lease_until<?", time, time);
    this.store.run("UPDATE jobs SET status='queued',updated_at=? WHERE status='waiting_dependencies'", time);
  }

  claim(workerId) {
    return this.store.transaction(() => {
      const time = nowIso();
      this.store.run("UPDATE jobs SET status='queued',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE status='leased' AND lease_until<?", time, time);
      this.store.run("UPDATE jobs SET status='queued',updated_at=? WHERE status='waiting_dependencies' AND run_at<=?", time);
      const candidates = this.store.all("SELECT * FROM jobs WHERE status='queued' AND run_at<=? ORDER BY priority,id LIMIT 50", time);
      for (const job of candidates) {
        if (job.epoch !== this.store.epoch()) { this.store.run("UPDATE jobs SET status='cancelled',error='Epoch fence',updated_at=? WHERE id=?", time, job.id); continue; }
        const dependencies = JSON.parse(job.depends_on_json);
        if (dependencies.length) {
          const states = this.store.all(`SELECT id,status FROM jobs WHERE id IN (${dependencies.map(() => '?').join(',')})`, ...dependencies);
          if (states.some((state) => ['failed', 'dead_letter', 'cancelled'].includes(state.status))) {
            this.store.run("UPDATE jobs SET status='cancelled',error='Dependency failed or was cancelled',updated_at=? WHERE id=?", time, job.id); continue;
          }
          if (states.length !== dependencies.length || states.some((state) => state.status !== 'succeeded')) {
            this.store.run("UPDATE jobs SET status='waiting_dependencies',updated_at=? WHERE id=?", time, job.id); continue;
          }
        }
        const leaseUntil = new Date(Date.now() + this.store.config.leaseMs).toISOString();
        const changed = this.store.run("UPDATE jobs SET status='leased',lease_owner=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'", workerId, leaseUntil, time, job.id);
        if (changed.changes === 1) return this.store.get('SELECT * FROM jobs WHERE id=?', job.id);
      }
      return null;
    });
  }

  async executeClaimed(job, workerId) {
    const envelope = JSON.parse(job.payload_json), runtime = envelope.runtime || {};
    const dependencyOutputs = {};
    for (const dependencyId of JSON.parse(job.depends_on_json)) {
      const dependency = this.store.get('SELECT result_json FROM jobs WHERE id=? AND tenant_id=?', dependencyId, job.tenant_id);
      dependencyOutputs[dependencyId] = JSON.parse(dependency?.result_json || 'null');
    }
    const businessObjects = this.store.all('SELECT kind,external_id,version,data_json,provenance_json,updated_at FROM business_objects WHERE tenant_id=? ORDER BY updated_at DESC LIMIT 1000', job.tenant_id).map((row) => ({ ...row, data: JSON.parse(row.data_json), provenance: JSON.parse(row.provenance_json) }));
    const heartbeat = setInterval(() => {
      this.store.run("UPDATE jobs SET lease_until=? WHERE id=? AND lease_owner=? AND status='leased'", new Date(Date.now() + this.store.config.leaseMs).toISOString(), job.id, workerId);
    }, Math.max(1000, Math.floor(this.store.config.leaseMs / 3)));
    heartbeat.unref();
    try {
      const input = { ...envelope.input, context: { jobId: job.id, dependencies: dependencyOutputs, businessObjects, epoch: job.epoch } };
      const execution = await runAgent({ slug: job.agent_slug, input, context: { tenantId: job.tenant_id, actor: job.lease_owner, model: this.model, knowledge: this.knowledge, store: this.store, jobId: job.id }, store: this.store });
      if (job.epoch !== this.store.epoch()) {
        this.store.run("UPDATE jobs SET status='cancelled',error='Late completion rejected by epoch fence',updated_at=? WHERE id=? AND epoch=?", nowIso(), job.id, job.epoch);
        return { jobId: job.id, status: 'rejected_late_completion' };
      }
      const artifactIds = [];
      this.store.transaction(() => {
        for (const artifact of execution.artifacts || []) {
          const artifactId = artifact.id || id('artifact');
          artifactIds.push(artifactId);
          const content = artifact.base64 ? { base64: artifact.base64 } : artifact.content;
          this.store.run('INSERT INTO artifacts(id,tenant_id,job_id,kind,uri,content_json,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)', artifactId, job.tenant_id, job.id, artifact.kind, artifact.uri || null, canonicalJson(content), canonicalJson(artifact.metadata || {}), nowIso());
        }
        const usage = execution.usage || { unit: 'run', quantity: 1 };
        this.billing.recordUsage({ tenantId: job.tenant_id, agentSlug: job.agent_slug, jobId: job.id, unit: usage.unit, quantity: usage.quantity, idempotencyKey: `usage:${job.id}` });
        const time = nowIso();
        this.store.run("UPDATE jobs SET status='succeeded',result_json=?,error=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND epoch=?", canonicalJson(execution.output), time, job.id, job.epoch);
        this.store.run("UPDATE jobs SET status='queued',updated_at=? WHERE status='waiting_dependencies'", time);
      });
      const effects = [];
      for (const effect of execution.effects || []) effects.push(await this.prepareEffect({ job, effect, autonomous: runtime.autonomous === true, actor: job.lease_owner }));
      if (runtime.conversationId) {
        this.store.run('INSERT INTO messages(id,tenant_id,conversation_id,sender_type,sender_id,body,structured_json,epoch,created_at) VALUES (?,?,?,?,?,?,?,?,?)', id('message'), job.tenant_id, runtime.conversationId, 'agent', job.agent_slug, typeof execution.output === 'string' ? execution.output : JSON.stringify(execution.output), canonicalJson({ output: execution.output, artifactIds, effects }), job.epoch, nowIso());
      }
      this.store.audit({ tenantId: job.tenant_id, actor: workerId, action: 'job.succeeded', entityType: 'job', entityId: job.id, payload: { artifactIds, effectCount: effects.length } });
      return { jobId: job.id, status: 'succeeded', output: execution.output, artifactIds, effects };
    } catch (error) {
      const failed = this.store.get('SELECT * FROM jobs WHERE id=?', job.id);
      const attempts = failed?.attempts || job.attempts;
      const dead = attempts >= job.max_attempts || error.status === 422 || error.status === 403 || error.code?.startsWith('model_');
      const runAt = new Date(Date.now() + Math.min(60_000, 1000 * 2 ** attempts)).toISOString();
      this.store.run(`UPDATE jobs SET status=?,error=?,run_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?`, dead ? 'dead_letter' : 'queued', String(error.message).slice(0, 4000), runAt, nowIso(), job.id);
      this.store.audit({ tenantId: job.tenant_id, actor: workerId, action: dead ? 'job.dead_letter' : 'job.retry_scheduled', entityType: 'job', entityId: job.id, payload: { error: error.code || error.name, attempts } });
      return { jobId: job.id, status: dead ? 'dead_letter' : 'retry', error: error.message };
    } finally { clearInterval(heartbeat); }
  }

  async prepareEffect({ job, effect, autonomous, actor }) {
    const payload = { effect, jobId: job.id, tenantId: job.tenant_id, epoch: job.epoch };
    const idempotencyKey = effect.idempotencyKey || `effect:${job.id}:${digest(payload)}`;
    const existing = this.store.get('SELECT * FROM outbox WHERE tenant_id=? AND idempotency_key=?', job.tenant_id, idempotencyKey);
    if (existing) return { outboxId: existing.id, status: existing.status, idempotent: true };
    const outboxId = id('outbox');
    let integration = this.store.get('SELECT * FROM integrations WHERE tenant_id=? AND name=? AND enabled=1', job.tenant_id, effect.integration);
    if (!integration) integration = this.store.get('SELECT * FROM integrations WHERE tenant_id=? AND kind=? AND enabled=1 ORDER BY created_at LIMIT 1', job.tenant_id, effect.integration);
    const availableAt = effect.payload?.publishAt || nowIso();
    if (autonomous && effect.consequential !== false) {
      require(integration, 503, 'integration_not_configured', `Autonomous effect requires configured integration: ${effect.integration}`);
      this.store.run('INSERT INTO outbox(id,tenant_id,integration_id,operation,payload_json,idempotency_key,status,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', outboxId, job.tenant_id, integration.id, effect.type, canonicalJson(effect.payload), idempotencyKey, 'pending', availableAt, nowIso(), nowIso());
      if (Date.parse(availableAt) > Date.now()) return { outboxId, status: 'scheduled', availableAt };
      const receipt = await this.dispatcher.dispatch({ outboxId, tenantId: job.tenant_id, operation: effect.type, payload: effect.payload });
      return { outboxId, status: 'sent', receipt };
    }
    const approvalId = id('approval'), time = nowIso(), payloadDigest = digest(payload);
    this.store.transaction(() => {
      this.store.run(`INSERT INTO approvals(id,tenant_id,job_id,action,payload_json,payload_digest,status,requested_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, approvalId, job.tenant_id, job.id, effect.type, canonicalJson(payload), payloadDigest, 'pending', actor || 'system', new Date(Date.now() + 24 * 3600_000).toISOString(), time);
      this.store.run('INSERT INTO outbox(id,tenant_id,integration_id,operation,payload_json,idempotency_key,status,approval_id,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', outboxId, job.tenant_id, integration?.id || null, effect.type, canonicalJson(effect.payload), idempotencyKey, 'draft', approvalId, availableAt, time, time);
    });
    return { outboxId, approvalId, status: 'waiting_approval', digest: payloadDigest, availableAt };
  }

  approve({ tenantId, approvalId, actor, expectedDigest }) {
    const approval = this.store.get('SELECT * FROM approvals WHERE id=? AND tenant_id=?', approvalId, tenantId);
    require(approval, 404, 'approval_not_found', 'Approval not found');
    if (approval.status === 'consumed') return { approvalId, status: 'consumed', idempotent: true };
    require(approval.status === 'pending' || approval.status === 'approved', 409, 'invalid_approval_state', `Cannot approve in state ${approval.status}`);
    require(approval.payload_digest === expectedDigest, 409, 'digest_mismatch', 'Exact approval digest is required');
    if (approval.status === 'pending') {
      require(Date.parse(approval.expires_at) > Date.now(), 409, 'approval_expired', 'Approval has expired');
      this.store.run("UPDATE approvals SET status='approved',decided_by=?,decided_at=? WHERE id=? AND status='pending'", actor, nowIso(), approvalId);
    }
    return this.commitApproval({ tenantId, approvalId, actor });
  }

  async commitApproval({ tenantId, approvalId, actor }) {
    const approval = this.store.get('SELECT * FROM approvals WHERE id=? AND tenant_id=?', approvalId, tenantId);
    require(approval, 404, 'approval_not_found', 'Approval not found');
    if (approval.status === 'consumed') return { approvalId, status: 'consumed', idempotent: true };
    require(approval.status === 'approved', 409, 'invalid_approval_state', 'Approval must be approved before commit');
    let result;
    if (['agent.install', 'package.install'].includes(approval.action)) {
      result = this.billing.installApproved(approval, actor);
    } else {
      const outbox = this.store.get('SELECT * FROM outbox WHERE approval_id=? AND tenant_id=?', approvalId, tenantId);
      require(outbox, 404, 'outbox_not_found', 'No outbox action linked to approval');
      require(outbox.integration_id, 503, 'integration_not_configured', 'Connect the required integration before committing');
      if (outbox.status === 'sent') result = JSON.parse(outbox.provider_receipt_json || '{}');
      else if (outbox.available_at && Date.parse(outbox.available_at) > Date.now()) {
        this.store.run("UPDATE outbox SET status='pending',updated_at=? WHERE id=?", nowIso(), outbox.id);
        result = { scheduled: true, availableAt: outbox.available_at, outboxId: outbox.id };
      } else {
        try { result = await this.dispatcher.dispatch({ outboxId: outbox.id, tenantId, operation: outbox.operation, payload: JSON.parse(outbox.payload_json) }); }
        catch (error) { this.store.run("UPDATE outbox SET status='failed',error=?,updated_at=? WHERE id=?", error.message, nowIso(), outbox.id); throw error; }
      }
    }
    this.store.run("UPDATE approvals SET status='consumed',decided_by=?,decided_at=? WHERE id=?", actor, nowIso(), approvalId);
    this.store.audit({ tenantId, actor, action: 'approval.consumed', entityType: 'approval', entityId: approvalId, payload: { action: approval.action, resultDigest: digest(result) } });
    return { approvalId, status: 'consumed', result };
  }

  reject({ tenantId, approvalId, actor, reason }) {
    const changed = this.store.run("UPDATE approvals SET status='rejected',decided_by=?,reason=?,decided_at=? WHERE id=? AND tenant_id=? AND status='pending'", actor, reason || 'Rejected by user', nowIso(), approvalId, tenantId);
    require(changed.changes === 1, 409, 'invalid_approval_state', 'Only pending approval can be rejected');
    this.store.run("UPDATE outbox SET status='cancelled',updated_at=? WHERE approval_id=? AND tenant_id=?", nowIso(), approvalId, tenantId);
    this.store.audit({ tenantId, actor, action: 'approval.rejected', entityType: 'approval', entityId: approvalId, payload: { reason } });
    return { approvalId, status: 'rejected' };
  }

  stop(tenantId, reason, actor) {
    const epoch = this.store.incrementEpoch();
    const time = nowIso();
    this.store.run("UPDATE jobs SET status='cancelled',error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE tenant_id=? AND status IN ('queued','leased','waiting_dependencies','waiting_approval')", reason || 'Emergency stop', time, tenantId);
    this.store.audit({ tenantId, actor, action: 'orchestrator.stopped', entityType: 'tenant', entityId: tenantId, payload: { epoch, reason } });
    return { epoch, status: 'stopped', note: 'Late completions from previous epochs are rejected' };
  }

  createPool({ tenantId, name, description = '', mode = 'approval', members = [], actor }) {
    require(['approval', 'autonomous'].includes(mode), 422, 'validation_error', 'Pool mode must be approval or autonomous');
    const poolId = id('pool');
    this.store.transaction(() => {
      this.store.run('INSERT INTO pools(id,tenant_id,name,description,mode,created_at) VALUES (?,?,?,?,?,?)', poolId, tenantId, name, description, mode, nowIso());
      for (const member of members) {
        this.billing.entitlement(tenantId, member.agentSlug);
        this.store.run('INSERT INTO pool_members(pool_id,agent_slug,role,weight) VALUES (?,?,?,?)', poolId, member.agentSlug, member.role || 'worker', member.weight || 1);
      }
      this.store.audit({ tenantId, actor, action: 'pool.created', entityType: 'pool', entityId: poolId, payload: { name, mode, members } });
    });
    return { poolId, name, mode, members };
  }

  poolMessage({ tenantId, poolId, body, actor, channel = 'api', externalId = null, inputs = {}, eventId = id('event') }) {
    const pool = this.store.get('SELECT * FROM pools WHERE id=? AND tenant_id=?', poolId, tenantId);
    require(pool, 404, 'pool_not_found', 'Pool not found');
    require(typeof body === 'string' && body.trim(), 422, 'validation_error', 'Message body is required');
    let conversation = this.store.get('SELECT * FROM conversations WHERE tenant_id=? AND pool_id=? AND channel=? AND external_id IS ?', tenantId, poolId, channel, externalId);
    const conversationId = conversation?.id || id('conversation');
    if (!conversation) this.store.run('INSERT INTO conversations(id,tenant_id,pool_id,channel,external_id,title,created_at) VALUES (?,?,?,?,?,?,?)', conversationId, tenantId, poolId, channel, externalId, pool.name, nowIso());
    const members = this.store.all('SELECT * FROM pool_members WHERE pool_id=? ORDER BY role,weight DESC', poolId);
    const duplicate = this.store.get("SELECT id FROM messages WHERE conversation_id=? AND json_extract(structured_json,'$.eventId')=?", conversationId, eventId);
    if (duplicate) return { conversationId, poolId, mode: pool.mode, jobs: members.map((member) => this.store.get('SELECT * FROM jobs WHERE tenant_id=? AND idempotency_key=?', tenantId, `pool:${conversationId}:${eventId}:${member.agent_slug}`)), idempotent: true };
    const epoch = this.store.epoch();
    this.store.run('INSERT INTO messages(id,tenant_id,conversation_id,sender_type,sender_id,body,structured_json,epoch,created_at) VALUES (?,?,?,?,?,?,?,?,?)', id('message'), tenantId, conversationId, 'user', actor, body, canonicalJson({ eventId }), epoch, nowIso());
    const jobs = [];
    let previous = null;
    for (const member of members) {
      const job = this.enqueue({ tenantId, agentSlug: member.agent_slug, type: 'pool_message', payload: inputs[member.agent_slug] || { goal: body }, idempotencyKey: `pool:${conversationId}:${eventId}:${member.agent_slug}`, dependsOn: member.role === 'coordinator' || !previous ? [] : [previous], actor, autonomous: pool.mode === 'autonomous', conversationId });
      previous = job.id; jobs.push(job);
    }
    return { conversationId, poolId, mode: pool.mode, jobs, epoch, eventId };
  }

  async dispatchDueOutbox() {
    const due = this.store.all("SELECT * FROM outbox WHERE status='pending' AND integration_id IS NOT NULL AND (available_at IS NULL OR available_at<=?) ORDER BY created_at LIMIT 50", nowIso());
    const results = [];
    for (const outbox of due) {
      try {
        const receipt = await this.dispatcher.dispatch({ outboxId: outbox.id, tenantId: outbox.tenant_id, operation: outbox.operation, payload: JSON.parse(outbox.payload_json) });
        results.push({ outboxId: outbox.id, status: 'sent', receipt });
      } catch (error) {
        this.store.run("UPDATE outbox SET status='failed',error=?,updated_at=? WHERE id=?", error.message, nowIso(), outbox.id);
        results.push({ outboxId: outbox.id, status: 'failed', error: error.message });
      }
    }
    return results;
  }

  schedule({ tenantId, agentSlug, type = 'run', payload = {}, intervalSeconds, actor }) {
    require(Number.isSafeInteger(intervalSeconds) && intervalSeconds >= 60 && intervalSeconds <= 31_536_000, 422, 'validation_error', 'intervalSeconds must be 60..31536000');
    const scheduleId = id('schedule'), next = nowIso();
    this.store.run('INSERT INTO schedules(id,tenant_id,agent_slug,type,payload_json,interval_seconds,next_run_at,created_at) VALUES (?,?,?,?,?,?,?,?)', scheduleId, tenantId, agentSlug, type, canonicalJson(payload), intervalSeconds, next, nowIso());
    this.store.audit({ tenantId, actor, action: 'schedule.created', entityType: 'schedule', entityId: scheduleId, payload: { agentSlug, intervalSeconds } });
    return { scheduleId, nextRunAt: next };
  }

  tickSchedules() {
    const due = this.store.all('SELECT * FROM schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 100', nowIso());
    const jobs = [];
    for (const schedule of due) {
      const next = new Date(Date.now() + schedule.interval_seconds * 1000).toISOString();
      this.store.run('UPDATE schedules SET last_run_at=?,next_run_at=? WHERE id=?', nowIso(), next, schedule.id);
      jobs.push(this.enqueue({ tenantId: schedule.tenant_id, agentSlug: schedule.agent_slug, type: schedule.type, payload: JSON.parse(schedule.payload_json), idempotencyKey: `schedule:${schedule.id}:${schedule.next_run_at}`, actor: `schedule:${schedule.id}` }));
    }
    return jobs;
  }

  async drain(concurrency = this.store.config.workerConcurrency, maxJobs = 10000) {
    const active = new Set(), results = [];
    while (results.length < maxJobs) {
      while (active.size < concurrency && results.length + active.size < maxJobs) {
        const job = this.claim(`worker-drainer-${results.length + active.size}`);
        if (!job) break;
        const promise = this.executeClaimed(job, job.lease_owner).then((result) => { results.push(result); active.delete(promise); });
        active.add(promise);
      }
      if (!active.size) break;
      await Promise.race(active);
    }
    await Promise.all(active);
    return results;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.recover();
    const loop = async () => {
      if (!this.running) return;
      try { this.tickSchedules(); await this.drain(); await this.dispatchDueOutbox(); } catch { /* individual jobs carry errors; loop remains alive */ }
      this.timer = setTimeout(loop, 1000);
      this.timer.unref();
    };
    loop();
  }

  async shutdown() {
    this.running = false;
    clearTimeout(this.timer);
    await Promise.allSettled(this.workers);
  }
}
