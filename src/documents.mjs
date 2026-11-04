import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSafe } from './packages.mjs';
import { HttpError, require } from './util.mjs';

function decodeXml(text) {
  return text.replace(/<w:tab[^>]*>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function run(command, args, { timeout = 60000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new HttpError(503, 'ocr_timeout', `${command} timed out`)); }, timeout);
    function finish(error, value) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolvePromise(value);
    }
    child.stdout.on('data', (data) => { stdout += data.toString(); if (stdout.length > 20_000_000) child.kill(); });
    child.stderr.on('data', (data) => { stderr += data.toString().slice(0, 2000); });
    child.on('error', (error) => finish(new HttpError(503, 'ocr_dependency_missing', `${command} is not installed or unavailable`, { cause: error.code })));
    child.on('close', (code) => code === 0 ? finish(null, { stdout, stderr }) : finish(new HttpError(422, 'ocr_failed', `${command} failed with code ${code}`, { stderr })));
  });
}

export async function extractDocument({ filename, buffer, model, vision = false }) {
  require(typeof filename === 'string' && filename.length <= 255, 422, 'invalid_document', 'Valid filename is required');
  require(Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= 20_000_000, 422, 'invalid_document', 'Document must be 1 byte..20 MB');
  const extension = extname(filename).toLowerCase();
  if (['.txt', '.md', '.csv', '.json', '.xml', '.html'].includes(extension)) return { text: buffer.toString('utf8'), method: 'direct', contentType: extension.slice(1) };
  if (extension === '.docx') {
    const files = unzipSafe(buffer, { maxFiles: 1000, maxTotalBytes: 100_000_000 });
    require(files.has('word/document.xml'), 422, 'invalid_docx', 'word/document.xml is missing');
    return { text: decodeXml(files.get('word/document.xml').toString('utf8')), method: 'docx_xml', contentType: 'docx' };
  }
  const tempDir = mkdtempSync(resolve(process.cwd(), `.2aos-ocr-${randomUUID()}-`));
  const input = resolve(tempDir, filename.replace(/[^a-zA-Z0-9_.-]/g, '_'));
  writeFileSync(input, buffer, { flag: 'wx' });
  try {
    if (extension === '.pdf') {
      const { stdout } = await run('pdftotext', ['-layout', '-nopgbrk', input, '-']);
      require(stdout.trim(), 422, 'empty_document', 'PDF contains no extractable text; use OCR/VLM');
      return { text: stdout, method: 'local_pdftotext', contentType: 'pdf' };
    }
    if (['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'].includes(extension)) {
      if (vision && model) {
        const result = await model.complete({ prompt: 'Transcribe the document exactly. Return JSON with text only.', images: [buffer.toString('base64')], vision: true, schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1 } } } });
        return { text: result.text, method: 'local_vision_model', contentType: 'image' };
      }
      const { stdout } = await run('tesseract', [input, 'stdout', '-l', 'rus+eng']);
      require(stdout.trim(), 422, 'empty_document', 'OCR returned no text');
      return { text: stdout, method: 'local_tesseract', contentType: 'image' };
    }
    throw new HttpError(422, 'unsupported_document', `Unsupported document extension: ${extension}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
