import { inflateRawSync } from 'node:zlib';
import { createPublicKey, verify } from 'node:crypto';
import { canonicalJson, HttpError, require, sha256Prefixed } from './util.mjs';
import { requireManifest } from './schema.mjs';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function unzipSafe(buffer, { maxFiles = 100, maxFileBytes = 20_000_000, maxTotalBytes = 100_000_000 } = {}) {
  require(Buffer.isBuffer(buffer) && buffer.length >= 22 && buffer.length <= 110_000_000, 422, 'invalid_zip', 'ZIP is empty or too large');
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  require(eocd >= 0, 422, 'invalid_zip', 'ZIP end record is missing');
  require(buffer.readUInt16LE(eocd + 8) === buffer.readUInt16LE(eocd + 10), 422, 'unsupported_zip', 'Multi-disk ZIP is not supported');
  const count = buffer.readUInt16LE(eocd + 10), centralSize = buffer.readUInt32LE(eocd + 12), centralOffset = buffer.readUInt32LE(eocd + 16);
  require(count <= maxFiles && centralOffset + centralSize <= buffer.length, 422, 'invalid_zip', 'Invalid ZIP directory');
  require(buffer.readUInt16LE(eocd + 20) === buffer.length - eocd - 22, 422, 'unsupported_zip', 'ZIP comments are not accepted');
  const files = new Map();
  let offset = centralOffset, total = 0;
  for (let index = 0; index < count; index++) {
    require(buffer.readUInt32LE(offset) === 0x02014b50, 422, 'invalid_zip', 'Invalid central directory entry');
    const flags = buffer.readUInt16LE(offset + 8), method = buffer.readUInt16LE(offset + 10), expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20), size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttrs = buffer.readUInt32LE(offset + 38), localOffset = buffer.readUInt32LE(offset + 42);
    require(!(flags & 1) && !(flags & 0x40), 422, 'unsupported_zip', 'Encrypted ZIP entries are not supported');
    require([0, 8].includes(method), 422, 'unsupported_zip', 'Only stored/deflated ZIP entries are supported');
    require(size <= maxFileBytes && compressedSize <= maxFileBytes && size !== 0xFFFFFFFF && compressedSize !== 0xFFFFFFFF, 422, 'zip_limit', 'ZIP entry exceeds limit or uses ZIP64');
    require(size === 0 || compressedSize / Math.max(size, 1) > 0.001, 422, 'zip_bomb', 'Suspicious ZIP compression ratio');
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    require(name && !name.includes('\0') && !name.includes('\\') && !name.startsWith('/') && !/^[a-z]:/i.test(name), 422, 'unsafe_zip_path', 'Unsafe ZIP path');
    const normalized = name.replace(/\/+/g, '/');
    const pathParts = normalized.split('/');
    require(pathParts.every((part, index) => part !== '..' && part !== '.' && (part !== '' || (index === pathParts.length - 1 && normalized.endsWith('/')))), 422, 'unsafe_zip_path', 'Path traversal is not allowed');
    require(((externalAttrs >>> 16) & 0o170000) !== 0o120000, 422, 'unsafe_zip_entry', 'Symbolic links are not allowed');
    require(!files.has(normalized), 422, 'invalid_zip', 'Duplicate ZIP entry');
    offset += 46 + nameLength + extraLength + commentLength;
    if (normalized.endsWith('/')) continue;
    require(buffer.readUInt32LE(localOffset) === 0x04034b50, 422, 'invalid_zip', 'Invalid local entry');
    const localNameLength = buffer.readUInt16LE(localOffset + 26), localExtraLength = buffer.readUInt16LE(localOffset + 28), dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    require(dataOffset + compressedSize <= buffer.length, 422, 'invalid_zip', 'Truncated ZIP data');
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let content;
    try { content = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: maxFileBytes + 1, finishFlush: 4 }); }
    catch { throw new HttpError(422, 'invalid_zip', `Cannot inflate ${normalized}`); }
    require(content.length === size && crc32(content) === expectedCrc, 422, 'invalid_zip', `CRC/size mismatch in ${normalized}`);
    total += content.length;
    require(total <= maxTotalBytes, 422, 'zip_limit', 'ZIP uncompressed content exceeds total limit');
    files.set(normalized, content);
  }
  return files;
}

export function parseAgentPackage(buffer, config) {
  const files = unzipSafe(buffer);
  require(files.has('manifest.json'), 422, 'manifest_missing', 'manifest.json must be at ZIP root');
  require(files.size <= 50, 422, 'zip_limit', 'Too many package files');
  let manifest;
  try { manifest = JSON.parse(files.get('manifest.json').toString('utf8')); }
  catch { throw new HttpError(422, 'invalid_manifest', 'manifest.json is not valid UTF-8 JSON'); }
  requireManifest(manifest);
  const { signature: _signature, ...unsignedManifest } = manifest;
  const packageDigest = sha256Prefixed(canonicalJson(unsignedManifest));
  if (config.registryPublicKey) {
    require(manifest.signature, 403, 'signature_required', 'Signed registry package is required');
    const key = createPublicKey({ key: Buffer.from(config.registryPublicKey, 'base64'), format: 'der', type: 'spki' });
    require(verify(null, Buffer.from(packageDigest), key, Buffer.from(manifest.signature, 'base64')), 403, 'invalid_signature', 'Package signature is invalid');
  } else {
    require(config.developmentPackages, 403, 'signature_required', 'Unsigned packages are allowed only in development mode');
  }
  return { manifest, files, digest: packageDigest };
}
