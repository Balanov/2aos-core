import { canonicalJson, id, nowIso, require, round } from './util.mjs';

const PROCESS_PROFILES = {
  'invoice-manual': { agents: ['invoice-ocr', 'accounting'], metric: 'document_error_rate' },
  'contract-review': { agents: ['legal'], metric: 'reviewed_risk_count' },
  'accounting-manual': { agents: ['accounting', 'rpa'], metric: 'reconciliation_error_rate' },
  'warehouse-stock': { agents: ['warehouse', 'forecasting'], metric: 'stockout_rate' },
  'recruiting-resume': { agents: ['recruiting'], metric: 'screening_time' },
  'customer-reviews': { agents: ['reputation', 'moderation'], metric: 'negative_response_time' },
  'knowledge-regulation': { agents: ['knowledge-rag', 'compliance'], metric: 'grounded_answer_rate' },
  'sales-crm': { agents: ['chat-voice', 'application-scoring'], metric: 'qualified_action_rate' },
  'security-logs': { agents: ['security', 'financial-monitoring'], metric: 'incident_rate' },
  'machine-sensors': { agents: ['predictive-maintenance', 'vision-quality'], metric: 'unplanned_downtime' },
  'content-presentation': { agents: ['content-generation', 'presentation'], metric: 'approved_content_rate' },
  'knowledge-communication': { agents: ['knowledge-rag', 'compliance'], metric: 'grounded_answer_rate' },
  'machine-vision': { agents: ['vision-quality'], metric: 'reviewed_defect_rate' },
  'route-logistics': { agents: ['driver-logistics', 'warehouse'], metric: 'cost_per_route' },
  'development-tasks': { agents: ['knowledge-rag'], metric: 'grounded_answer_rate' }
};

const RULES = [
  { match: /invoice|bill|document|account|счет|наклад|бухгал/i, agents: ['invoice-ocr', 'accounting'], metric: 'document_error_rate' },
  { match: /call|lead|dialog|phone|звон|лид|продаж/i, agents: ['chat-voice', 'application-scoring'], metric: 'qualified_action_rate' },
  { match: /route|logistic|delivery|маршрут|логист|достав/i, agents: ['driver-logistics', 'warehouse'], metric: 'cost_per_route' },
  { match: /stock|inventory|warehouse|склад|остат/i, agents: ['warehouse', 'forecasting'], metric: 'stockout_rate' },
  { match: /review|reputation|отзыв|репутац/i, agents: ['reputation', 'moderation'], metric: 'negative_response_time' },
  { match: /knowledge|regulation|search|знан|регламент|поиск/i, agents: ['knowledge-rag', 'compliance'], metric: 'grounded_answer_rate' },
  { match: /security|fraud|безопас|мошен/i, agents: ['security', 'financial-monitoring'], metric: 'incident_rate' },
  { match: /machine|sensor|maintenance|стан|датчик|ремонт|оборуд/i, agents: ['predictive-maintenance', 'vision-quality'], metric: 'unplanned_downtime' },
  { match: /hire|recruit|resume|кадр|найм|резюме/i, agents: ['recruiting'], metric: 'screening_time' },
  { match: /clinic|patient|медиц|клиник|пациент/i, agents: ['clinic'], metric: 'appointment_completion_rate' },
  { match: /contract|legal|договор|юрид/i, agents: ['legal'], metric: 'reviewed_risk_count' },
  { match: /content|marketing|email|контент|маркет|рассыл/i, agents: ['content-generation', 'email-marketing'], metric: 'consented_conversion_rate' }
];

export class Director {
  constructor(store, catalog, billing) { this.store = store; this.catalog = catalog; this.billing = billing; }

  upsertObject({ tenantId, kind, externalId, data, provenance, actor }) {
    require(/^[a-z][a-z0-9-]{1,60}$/.test(kind), 422, 'validation_error', 'Invalid business object kind');
    require(typeof externalId === 'string' && externalId.length > 0 && externalId.length <= 200, 422, 'validation_error', 'externalId is required');
    require(provenance?.source && provenance?.observedAt, 422, 'evidence_required', 'provenance.source and observedAt are required');
    const existing = this.store.get('SELECT * FROM business_objects WHERE tenant_id=? AND kind=? AND external_id=?', tenantId, kind, externalId);
    const version = (existing?.version || 0) + 1;
    const objectId = existing?.id || id('object');
    this.store.run(`INSERT INTO business_objects(id,tenant_id,kind,external_id,version,data_json,provenance_json,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,kind,external_id) DO UPDATE SET version=excluded.version,data_json=excluded.data_json,provenance_json=excluded.provenance_json,updated_at=excluded.updated_at`, objectId, tenantId, kind, externalId, version, canonicalJson(data), canonicalJson(provenance), nowIso());
    this.store.audit({ tenantId, actor, action: 'business_object.upserted', entityType: kind, entityId: objectId, payload: { externalId, version, provenance } });
    return { id: objectId, kind, externalId, version, data, provenance };
  }

  analyze({ tenantId, observations, actor }) {
    require(Array.isArray(observations) && observations.length > 0, 422, 'observations_required', 'At least one observation is required');
    const findings = observations.map((observation) => this.analyzeObservation(observation));
    const recommendations = [];
    for (const finding of findings) {
      for (const agentSlug of finding.agentSlugs) {
        const agent = this.catalog.find((item) => item.slug === agentSlug);
        if (!agent) continue;
        recommendations.push({
          agentSlug, name: agent.name, processCode: finding.processCode,
          observationIds: [finding.id],
          baseline: { monthlyCostMinor: finding.monthlyCostMinor, manualMinutesPerMonth: finding.manualMinutesPerMonth, errorRate: finding.errorRate },
          price: agent.pricing,
          comparison: { note: 'Baseline is observed input, not promised saving. Measure actual effect during pilot.', monthlyPriceMinor: agent.pricing.monthlyMinor },
          nextAction: { type: 'request_install_quote', agentSlug }
        });
      }
    }
    const analysisId = id('analysis');
    this.store.audit({ tenantId, actor, action: 'director.analysis_created', entityType: 'analysis', entityId: analysisId, payload: { observationCount: findings.length, recommendationCount: recommendations.length } });
    return { analysisId, findings, recommendations, privacyRequest: recommendations.length ? { required: true, action: 'explicit_opt_in', rawDataExport: false } : null };
  }

  analyzeObservation(observation) {
    require(observation && typeof observation === 'object', 422, 'validation_error', 'Observation must be an object');
    require(typeof observation.processCode === 'string' && observation.processCode.length > 1, 422, 'validation_error', 'processCode is required');
    require(observation.evidence?.source && observation.evidence?.observedAt, 422, 'evidence_required', 'Every observation needs evidence.source and observedAt');
    const rule = PROCESS_PROFILES[observation.processCode] || RULES.find((item) => item.match.test(`${observation.processCode} ${observation.description || ''}`));
    return {
      id: observation.id || id('observation'), processCode: observation.processCode,
      description: observation.description || '', evidence: observation.evidence,
      monthlyCostMinor: Number.isSafeInteger(observation.monthlyCostMinor) ? observation.monthlyCostMinor : null,
      manualMinutesPerMonth: Number.isFinite(observation.manualMinutesPerMonth) ? observation.manualMinutesPerMonth : null,
      errorRate: Number.isFinite(observation.errorRate) ? observation.errorRate : null,
      agentSlugs: rule?.agents || [],
      pilot: rule ? { metric: rule.metric, baseline: observation.metrics || null, target: observation.target || null, stopCondition: 'Stop or escalate if the agreed metric does not improve during the approved measurement window.' } : null,
      limitation: rule ? null : 'No verified agent mapping; collect process details instead of guessing.'
    };
  }

  efficiency(tenantId, agentSlug) {
    const installation = this.store.get('SELECT * FROM installations WHERE tenant_id=? AND agent_slug=?', tenantId, agentSlug);
    const metrics = this.store.all('SELECT * FROM metrics WHERE tenant_id=? AND agent_slug=? ORDER BY observed_at DESC LIMIT 100', tenantId, agentSlug);
    if (!metrics.length) return { agentSlug, status: 'insufficient_data', action: 'observe' };
    const grouped = {};
    for (const metric of metrics) (grouped[metric.name] ||= []).push(metric.value);
    const summary = Object.fromEntries(Object.entries(grouped).map(([name, values]) => [name, { latest: values[0], average: values.reduce((a, b) => a + b, 0) / values.length, samples: values.length }]));
    const quality = summary.success_rate?.average ?? summary.quality?.average;
    return { agentSlug, installationStatus: installation?.status, metrics: summary, action: quality !== undefined && quality < 0.7 && summary[quality < 0.7 ? 'success_rate' : 'quality'].samples >= 3 ? 'recommend_review_or_replacement' : 'continue_observation', automaticTermination: false };
  }
}
