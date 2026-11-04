import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['src', 'bin', 'scripts', 'tests'];
let files = 0;
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const file of walk(resolve(root))) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
    files++;
  }
}
const agents = JSON.parse(readFileSync('catalog/agents.json', 'utf8'));
if (new Set(agents.map((a) => a.slug)).size !== agents.length) throw new Error('Duplicate agent slugs');
if (agents.length !== 26) throw new Error(`Expected 26 agents, got ${agents.length}`);
const packages = JSON.parse(readFileSync('catalog/packages.json', 'utf8'));
for (const item of packages) {
  const allocated = item.agents.every((slug) => agents.some((agent) => agent.slug === slug));
  if (!allocated) throw new Error(`Unknown agent in package ${item.slug}`);
}
console.log(`Syntax OK: ${files} modules; catalog OK: ${agents.length} agents, ${packages.length} packages`);
function* walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name), stat = statSync(path);
    if (stat.isDirectory()) yield* walk(path);
    else if (stat.isFile() && path.endsWith('.mjs')) yield path;
  }
}
