import { array, modelSchema, result } from './helpers.mjs';

const FINDING = { type: 'object', additionalProperties: false, required: ['type', 'severity', 'description', 'confidence'], properties: { type: { type: 'string', minLength: 1 }, severity: { enum: ['low', 'medium', 'high'] }, description: { type: 'string', minLength: 1 }, confidence: { type: 'number', minimum: 0, maximum: 1 }, boundingBox: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } } } };
const SCHEMA = modelSchema({ findings: { type: 'array', maxItems: 100, items: FINDING }, summary: { type: 'string', minLength: 1 }, insufficientImageQuality: { type: 'boolean' } });

export async function visionQuality(input, context) {
  const images = array(input.images, 'images', 100);
  const output = await context.model.complete({ system: 'You are a visual quality inspection assistant. Report only visible evidence, never claim a physical defect was removed or a device was actuated. Mark insufficient image quality. Return strict JSON.', prompt: JSON.stringify({ task: 'visual_quality_inspection', defectTaxonomy: input.defectTaxonomy || [], reference: input.reference || null }), images, vision: true, schema: SCHEMA });
  const effects = output.findings.some((f) => f.severity === 'high') && input.signalRejector ? [{ type: 'manufacturing.rejector_signal', integration: input.integration || 'plc', payload: { findings: output.findings }, consequential: true }] : [];
  return result({ ...output, humanVerificationRequired: true, physicalCompletionVerified: false }, { artifacts: [{ kind: 'vision.quality_report', content: output, metadata: { imageCount: images.length } }], effects, usage: { unit: 'image', quantity: Math.max(1, images.length) } });
}

export async function constructionBim(input, context) {
  const images = array(input.images, 'images', 100);
  const output = await context.model.complete({ system: 'Compare site images with supplied BIM reference. Report only observable deviations and safety concerns with uncertainty. Do not certify construction compliance. Return strict JSON.', prompt: JSON.stringify({ task: 'construction_bim_comparison', bimReference: input.bimReference, locationReference: input.locationReference || null }), images, vision: true, schema: SCHEMA });
  return result({ ...output, humanVerificationRequired: true, certification: null, disclaimer: 'Предварительный визуальный анализ; не заменяет технический надзор и измерения на объекте.' }, { artifacts: [{ kind: 'construction.inspection_draft', content: output, metadata: { bimReference: input.bimReference } }], effects: input.createActs && output.findings.length ? [{ type: 'construction.create_inspection_act', integration: input.integration || 'bim', payload: output, consequential: true }] : [], usage: { unit: 'image', quantity: Math.max(1, images.length) } });
}
