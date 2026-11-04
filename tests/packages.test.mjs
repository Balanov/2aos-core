import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { zip } from '../src/agents/pptx.mjs';
import { parseAgentPackage, unzipSafe } from '../src/packages.mjs';
import { canonicalJson, sha256Prefixed } from '../src/util.mjs';
import { manifest } from './helpers.mjs';
import { extractDocument } from '../src/documents.mjs';

test('ZIP parser rejects traversal', () => {
  const buffer = zip({ '../evil.txt': 'bad' });
  assert.throws(() => unzipSafe(buffer), /traversal|Unsafe/);
});

test('Ed25519 package signature verifies and tampering fails', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const definition = manifest();
  const digest = sha256Prefixed(canonicalJson(definition));
  definition.signature = sign(null, Buffer.from(digest), privateKey).toString('base64');
  const config = { registryPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), developmentPackages: false };
  const parsed = parseAgentPackage(zip({ 'manifest.json': canonicalJson(definition) }), config);
  assert.equal(parsed.digest, digest);
  definition.name = 'Tampered';
  assert.throws(() => parseAgentPackage(zip({ 'manifest.json': canonicalJson(definition) }), config), /signature/);
});

test('directory entries are accepted and DOCX text is extracted', async () => {
  const packageBuffer = zip({ 'assets/': Buffer.alloc(0), 'manifest.json': canonicalJson(manifest()) });
  assert.ok(parseAgentPackage(packageBuffer, { registryPublicKey: '', developmentPackages: true }));
  const docx = zip({ 'word/': Buffer.alloc(0), 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Счёт &amp; накладная</w:t></w:r></w:p></w:body></w:document>' });
  const result = await extractDocument({ filename: 'invoice.docx', buffer: docx });
  assert.match(result.text, /Счёт & накладная/);
});
