import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256 } from './util.mjs';

export function hashApiKey(key) {
  return sha256(`2aos-api-key-v1\0${key}`);
}

export function safeEqualText(a, b) {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function encryptJson(value, masterKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptJson(payload, masterKey) {
  const [version, ivText, tagText, bodyText] = String(payload).split('.');
  if (version !== 'v1' || !ivText || !tagText || !bodyText) throw new Error('Invalid encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(bodyText, 'base64url')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /token|secret|password|api.?key|private.?key|credential/i.test(key) ? '[REDACTED]' : redactSecrets(item)
  ]));
}
