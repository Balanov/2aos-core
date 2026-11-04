#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { canonicalJson } from '../src/util.mjs';
import { DEVELOPER_COMMANDS, DeveloperExchange } from '../src/developer.mjs';
import { parseAgentPackage } from '../src/packages.mjs';
import { zip } from '../src/agents/pptx.mjs';

const exchange = new DeveloperExchange(null);
const [command = 'palette', ...args] = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index >= 0) return args[index + 1];
  const inline = args.find((value) => value.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
};
const positional = args.filter((value) => !value.startsWith('--') && !args[args.indexOf(value) - 1]?.startsWith('--'));
const server = () => arg('server', process.env.A2OS_SERVER || 'http://127.0.0.1:8787').replace(/\/$/, '');
const key = () => arg('key', process.env.A2OS_API_KEY || '');

async function request(method, path, body) {
  const response = await fetch(`${server()}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(key() ? { authorization: `Bearer ${key()}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${data?.error?.code || 'request_failed'}: ${data?.error?.message || response.statusText}`);
  return data;
}

function print(value) { console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }

try {
  if (command === 'commands') print(DEVELOPER_COMMANDS);
  else if (command === 'hints') {
    const name = positional[0];
    const found = DEVELOPER_COMMANDS.find((item) => item.command === name);
    if (!found) throw new Error(`Unknown command: ${name}. Use commands to list the palette.`);
    print({ ...found, flow: exchange.briefFlow() });
  } else if (command === 'opportunities') {
    const niche = arg('niche', '');
    print(await request('GET', `/v1/developer/opportunities${niche ? `?niche=${encodeURIComponent(niche)}` : ''}`));
  } else if (command === 'brief') {
    if (!positional[0]) throw new Error('Usage: brief <niche>');
    print(await request('GET', `/v1/developer/briefs/${encodeURIComponent(positional[0])}`));
  } else if (command === 'scaffold') {
    const niche = positional[0], directory = resolve(arg('dir', niche || 'agent'));
    if (!niche) throw new Error('Usage: scaffold <niche> --dir <directory>');
    mkdirSync(directory, { recursive: true });
    const manifest = exchange.scaffold(niche), path = resolve(directory, 'manifest.json');
    writeFileSync(path, `${canonicalJson(manifest)}\n`, { flag: 'wx' });
    print({ created: path, next: [`node bin/2aos-developer.mjs pack ${directory} ${niche}.zip`, `node bin/2aos-developer.mjs validate ${niche}.zip`, `node bin/2aos-developer.mjs submit ${niche}.zip --server ${server()}`] });
  } else if (command === 'pack') {
    const directory = resolve(positional[0] || '.'), output = resolve(positional[1] || 'agent.zip');
    if (!existsSync(resolve(directory, 'manifest.json'))) throw new Error('manifest.json is required');
    const entries = {};
    for (const file of walk(directory)) entries[relative(directory, file).replaceAll('\\', '/')] = readFileSync(file);
    writeFileSync(output, zip(entries));
    print({ package: output, files: Object.keys(entries).length, next: `node bin/2aos-developer.mjs validate ${output}` });
  } else if (command === 'validate') {
    const path = resolve(positional[0] || 'agent.zip');
    const result = parseAgentPackage(readFileSync(path), { registryPublicKey: process.env.A2OS_REGISTRY_PUBLIC_KEY || '', developmentPackages: !process.env.A2OS_REGISTRY_PUBLIC_KEY });
    print({ valid: true, slug: result.manifest.slug, version: result.manifest.version, digest: result.digest });
  } else if (command === 'submit') {
    const path = resolve(positional[0] || 'agent.zip');
    const parsed = parseAgentPackage(readFileSync(path), { registryPublicKey: process.env.A2OS_REGISTRY_PUBLIC_KEY || '', developmentPackages: !process.env.A2OS_REGISTRY_PUBLIC_KEY });
    print(await request('POST', '/v1/packages/upload', { zipBase64: readFileSync(path).toString('base64'), packageDigest: parsed.digest }));
  } else if (command === 'status') {
    const versions = await request('GET', '/v1/agent-versions');
    const selected = positional[0] ? versions.versions.filter((item) => item.id === positional[0]) : versions.versions;
    print(selected);
  } else if (command === 'dashboard') print(await request('GET', '/v1/developer/dashboard'));
  else if (command === 'palette') await palette();
  else throw new Error(`Unknown command ${command}. Use commands to list the palette.`);
} catch (error) {
  console.error(`2AOS developer: ${error.message}`);
  process.exitCode = 1;
}

function* walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name), stat = statSync(path);
    if (stat.isDirectory()) yield* walk(path);
    else if (stat.isFile()) yield path;
  }
}

async function palette() {
  const names = DEVELOPER_COMMANDS.map((item) => item.command);
  const rl = createInterface({
    input: process.stdin, output: process.stdout, terminal: true,
    completer: (line) => {
      const hits = names.filter((name) => name.startsWith(line));
      return [hits.length ? hits : names, line];
    }
  });
  console.log('2AOS Developer Palette. Type a command, number, hints <command>, flow, commands or quit.');
  const show = () => DEVELOPER_COMMANDS.forEach((item, index) => console.log(`${String(index + 1).padStart(2)}. ${item.command.padEnd(24)} ${item.description}`));
  show();
  for await (const line of rl) {
    const input = line.trim();
    if (['quit', 'exit', 'q'].includes(input)) break;
    if (!input) { rl.prompt(); continue; }
    if (input === 'commands') { show(); rl.prompt(); continue; }
    if (input === 'flow') { print(exchange.briefFlow()); rl.prompt(); continue; }
    if (input === 'hints' || input.startsWith('hints ')) {
      const name = input.slice(5).trim(), found = DEVELOPER_COMMANDS.find((item) => item.command === name);
      print(found || { error: `Unknown command ${name}` }); rl.prompt(); continue;
    }
    const name = /^\d+$/.test(input) ? DEVELOPER_COMMANDS[Number(input) - 1]?.command : input;
    const found = DEVELOPER_COMMANDS.find((item) => item.command === name);
    print(found || { error: `Unknown command ${name}. Tab completion is available.` });
    rl.prompt();
  }
  rl.close();
}
