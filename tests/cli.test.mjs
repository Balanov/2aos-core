import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../src/util.mjs';

function cli(args) {
  const result = spawnSync(process.execPath, ['bin/2aos-developer.mjs', ...args], { encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

test('developer CLI lists machine commands with hints', () => {
  const commands = JSON.parse(cli(['commands']));
  assert.ok(commands.some((item) => item.command === 'agent.submit'));
  const hints = JSON.parse(cli(['hints', 'agent.submit']));
  assert.equal(hints.path, '/v1/packages/upload');
  assert.ok(hints.flow.length >= 5);
});

test('developer CLI scaffolds, packs and validates an agent', () => {
  const directory = resolve('.tmp', `cli-${randomUUID()}`), packagePath = resolve('.tmp', `cli-${randomUUID()}.zip`);
  mkdirSync(directory, { recursive: true });
  try {
    const scaffold = JSON.parse(cli(['scaffold', 'invoice', '--dir', directory]));
    assert.ok(scaffold.created.endsWith('manifest.json'));
    const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.slug, 'invoice-solution');
    const packed = JSON.parse(cli(['pack', directory, packagePath]));
    assert.equal(packed.package, packagePath);
    const validated = JSON.parse(cli(['validate', packagePath]));
    assert.equal(validated.valid, true);
    assert.equal(validated.slug, 'invoice-solution');
    assert.equal(validated.digest.startsWith('sha256-'), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(packagePath, { force: true });
  }
});
