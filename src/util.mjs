import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const id = (prefix) => `${prefix}_${randomUUID()}`;
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const sha256Prefixed = (value) => `sha256-${sha256(value)}`;
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const round = (value, digits = 2) => Number(value.toFixed(digits));

export function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite number is not allowed');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    }
    return result;
  }
  throw new TypeError(`Unsupported canonical value: ${typeof value}`);
}

export const canonicalJson = (value) => JSON.stringify(canonicalize(value));
export const digest = (value) => sha256Prefixed(canonicalJson(value));
export const parseJson = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  return JSON.parse(value);
};
export const asRows = (rows) => rows.map((row) => ({ ...row }));
export const asRow = (row) => row ? ({ ...row }) : null;

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function require(condition, status, code, message, details) {
  if (!condition) throw new HttpError(status, code, message, details);
}

export function requiredString(value, name, max = 10000) {
  require(typeof value === 'string' && value.trim().length > 0, 422, 'validation_error', `${name} is required`);
  require(value.length <= max, 422, 'validation_error', `${name} exceeds ${max} characters`);
  return value.trim();
}

export function optionalString(value, name, max = 10000) {
  if (value === undefined || value === null || value === '') return '';
  require(typeof value === 'string', 422, 'validation_error', `${name} must be a string`);
  require(value.length <= max, 422, 'validation_error', `${name} exceeds ${max} characters`);
  return value.trim();
}

export function finiteNumber(value, name, { min = -Infinity, max = Infinity } = {}) {
  require(typeof value === 'number' && Number.isFinite(value), 422, 'validation_error', `${name} must be a finite number`);
  require(value >= min && value <= max, 422, 'validation_error', `${name} is outside allowed range`);
  return value;
}

export function integer(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  require(Number.isSafeInteger(value), 422, 'validation_error', `${name} must be a safe integer`);
  require(value >= min && value <= max, 422, 'validation_error', `${name} is outside allowed range`);
  return value;
}

export function slug(value) {
  const result = String(value).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  require(result.length >= 2, 422, 'validation_error', 'Slug must contain at least two ASCII letters/digits');
  return result;
}

export function parseCsv(text) {
  requiredString(text, 'CSV', 20_000_000);
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  require(!quoted, 422, 'invalid_csv', 'Unclosed quoted CSV field');
  row.push(field);
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

export function csvObjects(text) {
  const rows = parseCsv(text);
  require(rows.length > 0, 422, 'invalid_csv', 'CSV header is missing');
  const headers = rows[0].map((x) => x.trim());
  require(new Set(headers).size === headers.length && headers.every(Boolean), 422, 'invalid_csv', 'CSV headers must be unique and non-empty');
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((key, i) => [key, cells[i] ?? ''])));
}

export function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const percentile = (sorted, p) => {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
};

export function redactText(text) {
  return String(text)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-zА-Яа-я]{2,}/gu, '[EMAIL]')
    .replace(/(?:\+7|8)[\s(~-]*\d{3}[\s)~-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g, '[PHONE]')
    .replace(/\b\d{10}(?:\d{2})?\b/g, '[TAX_ID]')
    .replace(/\b\d{13}\b/g, '[OGRN]')
    .replace(/\b\d{20}\b/g, '[BANK_ACCOUNT]');
}

export function bounded(value, max = 100000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}
