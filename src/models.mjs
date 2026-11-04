import { HttpError, require } from './util.mjs';
import { requestJson } from './http.mjs';
import { validateSchema } from './schema.mjs';

export class LocalModel {
  constructor(config) { this.config = config; }

  async health() {
    if (!this.config.model.enabled) return { enabled: false, available: false, reason: 'Model is disabled by configuration' };
    try {
      if (this.config.model.kind === 'ollama') {
        const { data } = await requestJson(`${this.config.model.baseUrl}/api/tags`, { allowedEndpoints: this.config.allowedEndpoints, timeoutMs: 5000 });
        const models = (data?.models || []).map((m) => m.name || m.model);
        return { enabled: true, available: models.includes(this.config.model.name), models, name: this.config.model.name };
      }
      const { data } = await requestJson(`${this.config.model.baseUrl}/v1/models`, { allowedEndpoints: this.config.allowedEndpoints, timeoutMs: 5000 });
      const models = (data?.data || []).map((m) => m.id);
      return { enabled: true, available: models.includes(this.config.model.name), models, name: this.config.model.name };
    } catch (error) {
      return { enabled: true, available: false, reason: error.message };
    }
  }

  async complete({ system = '', prompt, schema, images = [], vision = false, temperature = 0.1 }) {
    require(this.config.model.enabled, 503, 'model_disabled', 'Local model is not enabled');
    const health = await this.health();
    require(health.available, 503, 'model_unavailable', `Required local model is unavailable: ${this.config.model.name}`);
    require(!vision || this.config.model.visionName, 503, 'vision_model_missing', 'A local vision model is not configured');
    const model = vision ? this.config.model.visionName : this.config.model.name;
    let text;
    if (this.config.model.kind === 'ollama') {
      const body = { model, stream: false, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt, ...(images.length ? { images } : []) }], options: { temperature }, ...(schema ? { format: schema } : {}) };
      const { data } = await requestJson(`${this.config.model.baseUrl}/api/chat`, { method: 'POST', body, allowedEndpoints: this.config.allowedEndpoints, timeoutMs: this.config.model.timeoutMs, maxBytes: 20_000_000 });
      text = data?.message?.content;
    } else {
      const content = images.length ? [{ type: 'text', text: prompt }, ...images.map((image) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }))] : prompt;
      const body = { model, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }], temperature, ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'agent_result', strict: true, schema } } } : {}) };
      const { data } = await requestJson(`${this.config.model.baseUrl}/v1/chat/completions`, { method: 'POST', body, allowedEndpoints: this.config.allowedEndpoints, timeoutMs: this.config.model.timeoutMs, maxBytes: 20_000_000 });
      text = data?.choices?.[0]?.message?.content;
    }
    require(typeof text === 'string' && text.length > 0, 502, 'invalid_model_response', 'Local model returned empty content');
    if (!schema) return text;
    let result;
    try { result = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); }
    catch { throw new HttpError(502, 'invalid_model_json', 'Local model did not return valid JSON'); }
    validateSchema(schema, result);
    return result;
  }
}
