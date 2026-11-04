import { HttpError, require } from './util.mjs';

export function validateSchema(schema, value, path = '$') {
  if (!schema || typeof schema !== 'object') throw new HttpError(500, 'invalid_schema', `Schema at ${path} is invalid`);
  if (schema.const !== undefined && value !== schema.const) fail(path, 'must equal const');
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) fail(path, 'must be one of enum values');
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => matchesType(type, value))) fail(path, `expected ${types.join(' or ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(path, 'is too short');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(path, 'is too long');
    if (schema.pattern && !(new RegExp(schema.pattern, 'u').test(value))) fail(path, 'does not match pattern');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(path, 'is below minimum');
    if (schema.maximum !== undefined && value > schema.maximum) fail(path, 'is above maximum');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(path, 'has too few items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(path, 'has too many items');
    if (schema.items) value.forEach((item, index) => validateSchema(schema.items, item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) if (value[key] === undefined) fail(path, `missing required property ${key}`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) fail(path, `unexpected property ${key}`);
    }
    for (const [key, item] of Object.entries(value)) if (properties[key]) validateSchema(properties[key], item, `${path}.${key}`);
  }
  return value;
}

function matchesType(type, value) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function fail(path, reason) {
  throw new HttpError(422, 'schema_validation', `${path} ${reason}`);
}

export function requireManifest(manifest) {
  require(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 422, 'invalid_manifest', 'Manifest must be an object');
  require(manifest.schemaVersion === '2aos.agent/v1', 422, 'invalid_manifest', 'schemaVersion must be 2aos.agent/v1');
  require(/^[a-z][a-z0-9-]{1,79}$/.test(manifest.slug), 422, 'invalid_manifest', 'Invalid agent slug');
  require(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version), 422, 'invalid_manifest', 'Version must be semver');
  require(typeof manifest.name === 'string' && manifest.name.length >= 2 && manifest.name.length <= 120, 422, 'invalid_manifest', 'Invalid agent name');
  require(manifest.runtime?.kind === 'declarative', 422, 'unsupported_runtime', 'Only declarative third-party runtime is accepted');
  require(manifest.inputSchema?.type === 'object' && manifest.outputSchema?.type === 'object', 422, 'invalid_manifest', 'Input/output JSON Schemas are required');
  require(Array.isArray(manifest.runtime.steps) && manifest.runtime.steps.length >= 1 && manifest.runtime.steps.length <= 20, 422, 'invalid_manifest', 'Between 1 and 20 steps are required');
  const permissions = manifest.permissions || [];
  require(Array.isArray(permissions) && permissions.length <= 30 && permissions.every((p) => typeof p === 'string' && /^(data\.(read|write)|model\.(text|vision)|network\.https?:\/\/[a-z0-9.-]+(?::\d+)?|effect\.[a-z0-9.-]+)$/.test(p)), 422, 'invalid_permissions', 'Invalid or excessive permissions');
  const ids = new Set();
  for (const step of manifest.runtime.steps) {
    require(step && typeof step.id === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(step.id) && !ids.has(step.id), 422, 'invalid_manifest', 'Step IDs must be unique slugs');
    ids.add(step.id);
    require(['template', 'model', 'artifact', 'assert'].includes(step.type), 422, 'invalid_manifest', `Unsupported step type: ${step.type}`);
    if (step.type === 'model') require(manifest.permissions.includes(step.vision ? 'model.vision' : 'model.text'), 403, 'permission_required', 'Model step lacks permission');
  }
  if (manifest.pricing) {
    require(Number.isSafeInteger(manifest.pricing.monthlyMinor) && manifest.pricing.monthlyMinor >= 0, 422, 'invalid_manifest', 'monthlyMinor must be a non-negative integer');
    require(['RUB', 'USD', 'EUR'].includes(manifest.pricing.currency || 'RUB'), 422, 'invalid_manifest', 'Unsupported currency');
  }
  return manifest;
}
