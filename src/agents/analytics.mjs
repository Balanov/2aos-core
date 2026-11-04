import { round } from '../util.mjs';
import { array, linearTrend, mean, number, result, route2opt, stddev, text } from './helpers.mjs';
import { validInn } from './documents.mjs';
import { sentiment } from './commerce.mjs';

export function driverLogistics(input) {
  const depot = input.depot;
  number(depot?.x, 'depot.x'); number(depot?.y, 'depot.y');
  const stops = array(input.stops, 'stops', 5000);
  for (const stop of stops) { text(stop.id, 'stop.id', 100); number(stop.x, 'stop.x'); number(stop.y, 'stop.y'); number(stop.demand || 0, 'stop.demand', 0); }
  const capacity = number(input.vehicleCapacity || stops.reduce((sum, s) => sum + (s.demand || 0), 0) || 1, 'vehicleCapacity', 0.0001);
  const load = stops.reduce((sum, stop) => sum + (stop.demand || 0), 0);
  const optimized = route2opt(stops, depot);
  let baselineDistance = 0, baselineCurrent = depot;
  for (const stop of stops) { baselineDistance += Math.hypot(stop.x - baselineCurrent.x, stop.y - baselineCurrent.y); baselineCurrent = stop; }
  if (stops.length) baselineDistance += Math.hypot(stops.at(-1).x - depot.x, stops.at(-1).y - depot.y);
  const legs = [];
  let current = depot, elapsed = 0, violations = [];
  for (const stop of optimized.route) {
    const travel = Math.hypot(stop.x - current.x, stop.y - current.y) / (input.speedUnitsPerMinute || 1);
    elapsed += travel;
    const arrival = elapsed;
    if (stop.timeWindowEnd !== undefined && arrival > stop.timeWindowEnd) violations.push({ stopId: stop.id, type: 'late', arrival, limit: stop.timeWindowEnd });
    if (stop.timeWindowStart !== undefined) elapsed = Math.max(elapsed, stop.timeWindowStart);
    legs.push({ stopId: stop.id, travelMinutes: round(travel, 2), arrivalMinute: round(arrival, 2), serviceMinutes: stop.serviceMinutes || 0 });
    elapsed += stop.serviceMinutes || 0; current = stop;
  }
  const maxWorkMinutes = input.maxWorkMinutes || 480;
  if (elapsed > maxWorkMinutes) violations.push({ type: 'driver_work_limit', elapsed, limit: maxWorkMinutes });
  if (load > capacity) violations.push({ type: 'capacity', load, capacity });
  const costPerKmMinor = input.costPerDistanceMinor || 0;
  const output = { stopIds: optimized.route.map((stop) => stop.id), distance: round(optimized.distance, 3), durationMinutes: round(elapsed, 2), load, capacity, costMinor: Math.round(optimized.distance * costPerKmMinor), legs, violations, feasible: violations.length === 0, baselineDistance: round(baselineDistance, 3), improvementClaimed: false };
  return result(output, { artifacts: [{ kind: 'logistics.waybill_draft', content: output }], effects: input.sendToDriver ? [{ type: 'logistics.dispatch', integration: input.integration || 'fleet', payload: output, consequential: true }] : [], usage: { unit: 'route', quantity: 1 } });
}

function holt(values, alpha, beta) {
  let level = values[0], trend = values[1] - values[0], fitted = [level];
  for (let i = 1; i < values.length; i++) {
    const previous = level;
    level = alpha * values[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - previous) + (1 - beta) * trend;
    fitted.push(level);
  }
  return { level, trend, fitted };
}
function mae(actual, predicted) { return mean(actual.map((value, index) => Math.abs(value - predicted[index]))); }

export function forecasting(input) {
  const values = array(input.values, 'values', 1_000_000);
  number(values.length, 'values.length', 4);
  values.forEach((value, i) => number(value, `values[${i}]`, 0));
  const horizon = number(input.horizon || 30, 'horizon', 1, 365);
  const holdout = Math.min(Math.max(1, Math.floor(values.length / 5)), 12);
  const train = values.slice(0, -holdout), test = values.slice(-holdout);
  let best = null;
  for (const alpha of [0.2, 0.4, 0.6, 0.8]) for (const beta of [0.05, 0.2, 0.4]) {
    const fit = holt(train, alpha, beta);
    const predicted = test.map((_, index) => Math.max(0, fit.level + (index + 1) * fit.trend));
    const error = mae(test, predicted);
    if (!best || error < best.error) best = { alpha, beta, error, predicted };
  }
  const final = holt(values, best.alpha, best.beta);
  const forecast = Array.from({ length: horizon }, (_, index) => Math.max(0, final.level + (index + 1) * final.trend));
  const baselinePredicted = test.map((_, index) => train[Math.max(0, train.length - (input.seasonLength || 1) + (index % (input.seasonLength || 1)))] ?? train.at(-1));
  const baselineMae = mae(test, baselinePredicted);
  const output = { forecast: forecast.map((v) => round(v, 3)), lower: forecast.map((v) => round(Math.max(0, v - 1.96 * best.error), 3)), upper: forecast.map((v) => round(v + 1.96 * best.error, 3)), model: { kind: 'holt_linear', alpha: best.alpha, beta: best.beta }, backtest: { holdout, mae: round(best.error, 3), seasonalNaiveMae: round(baselineMae, 3), beatsBaseline: best.error <= baselineMae }, caveat: 'Интервал основан на ошибке короткого backtest и не гарантирует будущий спрос.' };
  return result(output, { artifacts: [{ kind: 'forecast.series', content: output }], usage: { unit: 'forecast', quantity: 1 } });
}

export function reporting(input) {
  const rows = array(input.rows, 'rows', 1_000_000);
  const revenueKey = input.revenueKey || 'revenueMinor', quantityKey = input.quantityKey || 'quantity';
  const totalRevenue = rows.reduce((sum, row) => sum + (row[revenueKey] || 0), 0);
  const totalQuantity = rows.reduce((sum, row) => sum + (row[quantityKey] || 0), 0);
  const groups = {};
  for (const row of rows) {
    const key = row[input.groupBy || 'category'] || 'other';
    groups[key] = (groups[key] || 0) + (row[revenueKey] || 0);
  }
  const top = Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, value]) => ({ name, revenueMinor: value, share: totalRevenue ? round(value / totalRevenue, 4) : 0 }));
  const previousRevenue = input.previousPeriodRevenueMinor;
  const growth = Number.isFinite(previousRevenue) && previousRevenue !== 0 ? round((totalRevenue - previousRevenue) / Math.abs(previousRevenue), 4) : null;
  const summary = `Выручка: ${(totalRevenue / 100).toFixed(2)} ₽. Операций: ${rows.length}. Количество: ${totalQuantity}.${growth === null ? ' Сравнение с прошлым периодом: недостаточно данных.' : ` Изменение к прошлому периоду: ${(growth * 100).toFixed(1)}%.`} Топ-5: ${top.map((item) => item.name).join(', ') || 'нет данных'}.`;
  return result({ totalRevenueMinor: totalRevenue, totalQuantity, averageCheckMinor: totalQuantity ? Math.round(totalRevenue / totalQuantity) : null, growthRate: growth, top, summary, evidence: { rowCount: rows.length, period: input.period || null } }, { artifacts: [{ kind: 'report.management', content: { summary, top, growthRate: growth } }], effects: input.recipients?.length ? [{ type: 'email.send_report', integration: 'smtp', payload: { recipients: input.recipients, summary }, consequential: true }] : [], usage: { unit: 'report', quantity: 1 } });
}

export function security(input) {
  const events = array(input.events, 'events', 1_000_000);
  const baselines = input.baselines || {};
  const incidents = [];
  for (const [index, event] of events.entries()) {
    const baseline = baselines[event.actor] || {};
    const reasons = [];
    if (event.device && baseline.devices && !baseline.devices.includes(event.device)) reasons.push('new_device');
    if (event.ip && baseline.ips && !baseline.ips.includes(event.ip)) reasons.push('new_ip');
    if (Number.isFinite(event.bytes) && Number.isFinite(baseline.maxBytes) && event.bytes > baseline.maxBytes) reasons.push('download_above_baseline');
    if (Number.isFinite(event.hour) && baseline.workHours && (event.hour < baseline.workHours[0] || event.hour > baseline.workHours[1])) reasons.push('outside_work_hours');
    if ((event.failedLogins || 0) >= (baseline.maxFailedLogins || 5)) reasons.push('brute_force_threshold');
    if (reasons.length) incidents.push({ index, actor: event.actor, reasons, severity: reasons.includes('download_above_baseline') || reasons.includes('brute_force_threshold') ? 'high' : 'medium', event, recommendedAction: 'quarantine_and_review' });
  }
  const effects = incidents.filter((incident) => incident.severity === 'high' && input.quarantine === true).map((incident) => ({ type: 'security.quarantine', integration: input.integration || 'siem', payload: incident, consequential: true, idempotencyKey: `security:${incident.actor}:${incident.index}` }));
  return result({ events: events.length, incidents, monitoringOnly: !input.quarantine }, { effects, usage: { unit: 'event', quantity: Math.max(1, events.length) } });
}

export function financialMonitoring(input) {
  const inn = text(input.inn, 'inn', 12);
  const registry = input.registry || {}, transactions = input.transactions || [];
  const risks = [];
  if (!validInn(inn)) risks.push({ code: 'invalid_inn', severity: 'critical' });
  for (const key of ['bankruptcy', 'disqualified', 'rnp']) if (registry[key]) risks.push({ code: key, severity: 'critical' });
  if (registry.taxDebtMinor > 0) risks.push({ code: 'tax_debt', severity: 'high', amountMinor: registry.taxDebtMinor });
  if (registry.enforcementCount > 0) risks.push({ code: 'enforcement', severity: 'high', count: registry.enforcementCount });
  if (registry.activeLawsuitsCount > 0) risks.push({ code: 'lawsuits', severity: 'medium', count: registry.activeLawsuitsCount });
  const suspicious = transactions.filter((t) => /обнал|крипт|возврат.*друг/i.test(t.purpose || '') || (t.isNewCounterparty && Math.abs(t.amountMinor) >= (input.largeAmountMinor || 100_000_000))).map((t) => ({ ...t, reason: 'transaction_rule' }));
  const score = Math.max(0, 100 - risks.reduce((sum, risk) => sum + ({ critical: 100, high: 35, medium: 15 }[risk.severity]), 0) - suspicious.length * 15);
  const output = { inn, score, decision: score >= 80 ? 'allow_draft' : score >= 50 ? 'manual_review' : 'block_draft', risks, suspiciousTransactions: suspicious, evidence: registry.evidence || null, registryObservedAt: registry.observedAt || null, humanReviewRequired: true };
  return result(output, { effects: suspicious.length ? [{ type: 'finance.freeze_transaction', integration: input.integration || 'bank', payload: { inn, suspicious }, consequential: true }] : [], usage: { unit: 'counterparty', quantity: 1 } });
}

export function compliance(input) {
  const messages = array(input.messages, 'messages', 1_000_000);
  const policies = array(input.policies, 'policies', 1000);
  const violations = [];
  for (const [messageIndex, message] of messages.entries()) for (const policy of policies) {
    for (const phrase of policy.forbidden || []) {
      const index = String(message.text || '').toLowerCase().indexOf(phrase.toLowerCase());
      if (index >= 0) violations.push({ messageIndex, policy: policy.name, type: 'forbidden', excerpt: message.text.slice(Math.max(0, index - 40), index + phrase.length + 40), observedAt: message.observedAt });
    }
    for (const phrase of policy.required || []) if (!String(message.text || '').toLowerCase().includes(phrase.toLowerCase())) violations.push({ messageIndex, policy: policy.name, type: 'required_missing', phrase, observedAt: message.observedAt });
  }
  return result({ checked: messages.length, violations, auditReady: messages.every((m) => m.observedAt), evidencePreserved: true }, { artifacts: [{ kind: 'compliance.audit', content: { violations } }], usage: { unit: 'message', quantity: Math.max(1, messages.length) } });
}

export function moderation(input) {
  const messages = array(input.messages, 'messages', 1_000_000);
  const items = messages.map((message, index) => {
    const content = text(message.text, `messages[${index}].text`, 1000000);
    const urls = content.match(/https?:\/\//gi)?.length || 0;
    const spam = urls >= 3 || /(заработок.*быстро|кликни.*ссылк|бесплатно.*крипт|подпишись.*реклам)/i.test(content);
    const toxic = /идиот|тупой|дебил|ублюд|убью|ненавиж/i.test(content);
    const legalRisk = /(персональн\w*\s+данн|паспорт|карта\s*\d{12,}|угроз|шантаж)/i.test(content);
    const tone = sentiment(content);
    return { id: message.id || index, decision: legalRisk || toxic || spam ? 'review_or_hide_draft' : 'allow', reasons: [...(spam ? ['spam'] : []), ...(toxic ? ['toxicity'] : []), ...(legalRisk ? ['legal_or_privacy_risk'] : [])], tone: tone.label, evidence: content.slice(0, 500) };
  });
  const effects = items.filter((item) => input.hide === true && item.decision !== 'allow').map((item) => ({ type: 'moderation.hide', integration: input.integration || 'community', payload: { id: item.id, reasons: item.reasons }, consequential: true, idempotencyKey: `moderation:${item.id}` }));
  return result({ items, summary: { total: items.length, review: items.filter((i) => i.decision !== 'allow').length, allow: items.filter((i) => i.decision === 'allow').length } }, { effects, usage: { unit: 'message', quantity: Math.max(1, messages.length) } });
}

export function predictiveMaintenance(input) {
  const assets = array(input.assets, 'assets', 100000);
  const reports = assets.map((asset) => {
    const readings = array(asset.readings, `asset ${asset.id} readings`, 1_000_000);
    number(readings.length, 'readings.length', 8);
    const values = readings.map((r) => number(r.value, 'reading.value'));
    const baseline = values.slice(0, -3), recent = values.slice(-3);
    const average = mean(baseline), deviation = stddev(baseline), latest = values.at(-1);
    const z = deviation ? (latest - average) / deviation : latest === average ? 0 : Infinity;
    const trend = linearTrend(values);
    const horizon = input.horizonDays || 14;
    const threshold = asset.threshold ?? average + 3 * Math.max(deviation, 1e-9);
    const predicted = trend.intercept + trend.slope * (values.length - 1 + horizon);
    const risk = Math.abs(z) >= 3 || (asset.threshold !== undefined && predicted >= asset.threshold) ? 'high' : Math.abs(z) >= 2 ? 'medium' : 'low';
    return { assetId: asset.id, latest, baselineMean: round(average, 4), baselineStdDev: round(deviation, 4), zScore: Number.isFinite(z) ? round(z, 3) : String(z), threshold, predictedAtHorizon: round(predicted, 4), risk, workOrderDraft: risk === 'low' ? null : { assetId: asset.id, priority: risk, reason: 'telemetry_threshold_or_anomaly', evidence: readings.slice(-10) } };
  });
  const effects = reports.filter((r) => r.workOrderDraft && input.createWorkOrders).map((report) => ({ type: 'maintenance.create_work_order', integration: input.integration || 'eAM'.toLowerCase(), payload: report.workOrderDraft, consequential: true, idempotencyKey: `maintenance:${report.assetId}:${report.latest}` }));
  return result({ assets: reports, highRisk: reports.filter((r) => r.risk === 'high').length, limitation: 'Пороговая диагностика по истории; не подтверждает физическую поломку без осмотра.' }, { effects, usage: { unit: 'reading', quantity: Math.max(1, assets.reduce((sum, a) => sum + a.readings.length, 0)) } });
}

export function warehouse(input) {
  const items = array(input.items, 'items', 1_000_000);
  const analyzed = items.map((item) => {
    const movements = item.movements || [];
    const stock = Number.isFinite(item.stock) ? item.stock : movements.reduce((sum, m) => sum + (m.kind === 'receipt' ? m.quantity : m.kind === 'issue' ? -m.quantity : m.quantity), 0);
    const demand = item.dailyDemand || movements.filter((m) => m.kind === 'issue').map((m) => Math.abs(m.quantity));
    const dailyMean = demand.length ? mean(demand) : 0;
    const reorderPoint = item.reorderPoint ?? dailyMean * (item.leadTimeDays || 1) + (item.safetyStock || 0);
    const consumptionValue = (item.annualConsumption || dailyMean * 365) * (item.unitCostMinor || 0);
    const cv = demand.length > 1 && dailyMean ? stddev(demand) / dailyMean : 0;
    return { sku: item.sku, stock, dailyMean: round(dailyMean, 3), reorderPoint: round(reorderPoint, 3), orderDraft: stock <= reorderPoint ? { sku: item.sku, quantity: Math.max(0, round(reorderPoint * 2 - stock, 3)) } : null, consumptionValueMinor: consumptionValue, xyz: cv <= 0.5 ? 'X' : cv <= 1 ? 'Y' : 'Z', daysWithoutMovement: item.daysWithoutMovement ?? null };
  });
  const sorted = [...analyzed].sort((a, b) => b.consumptionValueMinor - a.consumptionValueMinor);
  const total = sorted.reduce((sum, item) => sum + item.consumptionValueMinor, 0);
  let cumulative = 0;
  for (const item of sorted) { cumulative += item.consumptionValueMinor; item.abc = total && cumulative / total <= 0.8 ? 'A' : cumulative / total <= 0.95 ? 'B' : 'C'; }
  const output = { items: analyzed, reorderDrafts: analyzed.filter((i) => i.orderDraft).map((i) => i.orderDraft), deadStock: analyzed.filter((i) => i.daysWithoutMovement >= 90).map((i) => i.sku), discrepancies: analyzed.filter((i) => i.stock < 0).map((i) => ({ sku: i.sku, stock: i.stock })), note: 'Закупки являются черновиками до согласования.' };
  return result(output, { effects: input.createPurchaseOrders ? output.reorderDrafts.map((draft) => ({ type: 'procurement.create_draft', integration: input.integration || 'erp', payload: draft, consequential: true, idempotencyKey: `purchase:${draft.sku}:${draft.quantity}` })) : [], usage: { unit: 'sku', quantity: Math.max(1, items.length) } });
}
