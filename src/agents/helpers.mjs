import { id, require } from '../util.mjs';

export const result = (output, { artifacts = [], effects = [], usage = { unit: 'run', quantity: 1 } } = {}) => ({ output, artifacts: artifacts.map((item) => ({ id: item.id || id('artifact'), ...item })), effects, usage });
export const required = (value, name) => require(value !== undefined && value !== null, 422, 'validation_error', `${name} is required`);
export const text = (value, name, max = 2_000_000) => {
  required(value, name);
  require(typeof value === 'string' && value.trim() && value.length <= max, 422, 'validation_error', `${name} must be non-empty text up to ${max} characters`);
  return value;
};
export const array = (value, name, max = 10000) => {
  require(Array.isArray(value) && value.length <= max, 422, 'validation_error', `${name} must be an array up to ${max} items`);
  return value;
};
export const number = (value, name, min = -Infinity, max = Infinity) => {
  require(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, 422, 'validation_error', `${name} is invalid`);
  return value;
};
export const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
export const stddev = (values) => values.length < 2 ? 0 : Math.sqrt(values.reduce((sum, value) => sum + (value - mean(values)) ** 2, 0) / (values.length - 1));
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export const money = (value) => `${Math.round(value / 100).toLocaleString('ru-RU')} ₽`;
export const modelSchema = (properties, requiredKeys = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required: requiredKeys, properties });

export function linearTrend(values) {
  const n = values.length;
  const xMean = (n - 1) / 2, yMean = mean(values);
  let numerator = 0, denominator = 0;
  values.forEach((value, index) => { numerator += (index - xMean) * (value - yMean); denominator += (index - xMean) ** 2; });
  const slope = denominator ? numerator / denominator : 0;
  return { intercept: yMean - slope * xMean, slope };
}

export function route2opt(points, start, distanceFn = distance) {
  if (!points.length) return { route: [], distance: 0 };
  const remaining = [...points], route = [];
  let current = start, total = 0;
  while (remaining.length) {
    let bestIndex = 0, bestDistance = distanceFn(current, remaining[0]);
    for (let i = 1; i < remaining.length; i++) {
      const candidate = distanceFn(current, remaining[i]);
      if (candidate < bestDistance) { bestDistance = candidate; bestIndex = i; }
    }
    const next = remaining.splice(bestIndex, 1)[0];
    route.push(next); total += bestDistance; current = next;
  }
  total += distanceFn(current, start);
  const ids = route.map((point) => point.id);
  let improved = true, iterations = 0;
  while (improved && iterations++ < 100) {
    improved = false;
    for (let i = 0; i < ids.length - 1; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const before = routeDistance(ids, start, points, distanceFn);
        const candidate = [...ids.slice(0, i), ...ids.slice(i, j + 1).reverse(), ...ids.slice(j + 1)];
        const after = routeDistance(candidate, start, points, distanceFn);
        if (after + 1e-9 < before) { ids.splice(0, ids.length, ...candidate); improved = true; }
      }
    }
  }
  const byId = new Map(points.map((point) => [point.id, point]));
  return { route: ids.map((pointId) => byId.get(pointId)), distance: routeDistance(ids, start, points, distanceFn) };
}
function routeDistance(ids, start, points, distanceFn) {
  const byId = new Map(points.map((point) => [point.id, point]));
  let current = start, total = 0;
  for (const pointId of ids) { const next = byId.get(pointId); total += distanceFn(current, next); current = next; }
  return total + distanceFn(current, start);
}
