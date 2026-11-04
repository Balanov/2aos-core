import { HttpError, require } from './util.mjs';

export function assertAllowedUrl(url, allowedEndpoints) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new HttpError(422, 'invalid_url', 'Invalid endpoint URL'); }
  require(['http:', 'https:'].includes(parsed.protocol), 422, 'invalid_url', 'Only HTTP(S) endpoints are allowed');
  require(!parsed.username && !parsed.password, 422, 'invalid_url', 'Credentials must not be embedded in URL');
  const origin = parsed.origin.replace(/\/$/, '');
  require(allowedEndpoints.has(origin), 403, 'endpoint_not_allowed', `Endpoint origin is not allowlisted: ${origin}`);
  return parsed;
}

export async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30000, allowedEndpoints, maxBytes = 10_000_000 } = {}) {
  const parsed = assertAllowedUrl(url, allowedEndpoints);
  let response;
  try {
    response = await fetch(parsed, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new HttpError(503, 'endpoint_unavailable', `Endpoint request failed: ${error.name}`);
  }
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maxBytes) throw new HttpError(502, 'response_too_large', 'Endpoint response exceeds limit');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new HttpError(502, 'response_too_large', 'Endpoint response exceeds limit');
  const text = buffer.toString('utf8');
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { throw new HttpError(502, 'invalid_endpoint_json', 'Endpoint returned non-JSON data'); }
  }
  if (!response.ok) throw new HttpError(502, 'endpoint_error', `Endpoint returned HTTP ${response.status}`, { status: response.status, body: data });
  return { data, headers: response.headers, status: response.status };
}
