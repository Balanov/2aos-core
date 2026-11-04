import * as documents from './documents.mjs';
import * as commerce from './commerce.mjs';
import * as analytics from './analytics.mjs';
import * as vision from './vision.mjs';
import { canonicalJson, require } from '../util.mjs';
import { validateSchema } from '../schema.mjs';
import { result } from './helpers.mjs';

export const BUILTINS = {
  'chat-voice': commerce.chatVoice,
  'reputation': commerce.reputation,
  'application-scoring': commerce.applicationScoring,
  'content-generation': commerce.contentGeneration,
  'driver-logistics': analytics.driverLogistics,
  'invoice-ocr': documents.invoiceOcr,
  'rpa': documents.rpa,
  'knowledge-rag': documents.knowledgeRag,
  'accounting': documents.accounting,
  'translator': documents.translator,
  'forecasting': analytics.forecasting,
  'reporting': analytics.reporting,
  'security': analytics.security,
  'financial-monitoring': analytics.financialMonitoring,
  'compliance': analytics.compliance,
  'moderation': analytics.moderation,
  'vision-quality': vision.visionQuality,
  'warehouse': analytics.warehouse,
  'predictive-maintenance': analytics.predictiveMaintenance,
  'construction-bim': vision.constructionBim,
  'recruiting': commerce.recruiting,
  'tutoring': commerce.tutoring,
  'clinic': commerce.clinic,
  'legal': documents.legal,
  'email-marketing': commerce.emailMarketing,
  'presentation': commerce.presentation
};

function lookup(root, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], root);
}
function interpolate(value, scope) {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
    if (exact) return lookup(scope, exact[1]);
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, path) => {
      const resolved = lookup(scope, path);
      return resolved === undefined ? '' : typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, scope));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, scope)]));
  return value;
}

export async function runDeclarative(manifest, input, context) {
  const { context: runtimeContext, ...agentInput } = input;
  validateSchema(manifest.inputSchema, agentInput);
  const scope = { input: agentInput, context: runtimeContext, steps: {} }, artifacts = [];
  let finalOutput = {};
  for (const step of manifest.runtime.steps) {
    if (step.type === 'template') {
      scope.steps[step.id] = { output: interpolate(step.value, scope) };
    } else if (step.type === 'model') {
      const prompt = interpolate(step.prompt, scope);
      require(typeof prompt === 'string' && prompt.length > 0, 422, 'invalid_manifest', `Model step ${step.id} has empty prompt`);
      const output = await context.model.complete({ system: step.system || 'You are a scoped business agent. Use only supplied evidence and return the required schema.', prompt, schema: step.outputSchema || manifest.outputSchema, images: step.vision ? interpolate(step.images || [], scope) : [], vision: step.vision === true });
      scope.steps[step.id] = { output };
    } else if (step.type === 'artifact') {
      const content = interpolate(step.content, scope);
      const artifact = { kind: step.kind || 'custom.artifact', content, metadata: { agentSlug: manifest.slug, version: manifest.version, stepId: step.id } };
      artifacts.push(artifact);
      scope.steps[step.id] = { output: { artifact } };
    } else if (step.type === 'assert') {
      const left = lookup(scope, step.path), right = interpolate(step.value, scope);
      const passed = step.operator === 'exists' ? left !== undefined && left !== null : step.operator === 'equals' ? canonicalJson(left) === canonicalJson(right) : step.operator === 'not_empty' ? Boolean(left?.length) : false;
      require(passed, 422, 'agent_assertion_failed', `Assertion failed in step ${step.id}`);
      scope.steps[step.id] = { output: { passed } };
    }
    finalOutput = scope.steps[step.id].output;
  }
  const output = manifest.runtime.output ? interpolate(manifest.runtime.output, scope) : finalOutput;
  validateSchema(manifest.outputSchema, output);
  return result(output, { artifacts, usage: { unit: manifest.pricing?.unit?.kind || 'run', quantity: 1 } });
}

export async function runAgent({ slug, input, context, store }) {
  const handler = BUILTINS[slug];
  if (handler) return await handler(input, context);
  const version = store.get("SELECT * FROM agent_versions WHERE slug=? AND status='active' ORDER BY created_at DESC LIMIT 1", slug);
  require(version, 404, 'agent_not_found', `No executable agent registered for ${slug}`);
  return await runDeclarative(JSON.parse(version.manifest_json), input, context);
}
