import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonicalJson, HttpError, require } from '../util.mjs';

const WINDOWS = process.platform === 'win32', MACOS = process.platform === 'darwin';
const BUILTIN = {
  'system.info': WINDOWS ? { executable: 'systeminfo', args: [] } : { executable: 'uname', args: ['-a'] },
  'disk.list': WINDOWS ? { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace | ConvertTo-Json -Compress'] } : { executable: 'df', args: ['-h'] },
  'process.list': WINDOWS ? { executable: 'tasklist', args: ['/fo', 'csv'] } : { executable: 'ps', args: ['-eo', 'pid,ppid,comm,args'] },
  'network.list': WINDOWS ? { executable: 'ipconfig', args: ['/all'] } : MACOS ? { executable: 'ifconfig', args: [] } : { executable: 'ip', args: ['addr'] },
  'service.list': WINDOWS ? { executable: 'sc.exe', args: ['query', 'type=', 'service', 'state=', 'all'] } : MACOS ? { executable: 'launchctl', args: ['list'] } : { executable: 'systemctl', args: ['list-units', '--type=service', '--all', '--no-pager'] },
  'privileges.current': WINDOWS ? { executable: 'whoami', args: ['/groups'] } : { executable: 'id', args: [] }
};

export class HostSystem {
  constructor(config) {
    this.config = config;
    this.path = resolve(config.dataDir, 'host-profiles.json');
  }

  custom() {
    if (!existsSync(this.path)) return {};
    try { return JSON.parse(readFileSync(this.path, 'utf8')); }
    catch { throw new Error('Host profiles file is invalid'); }
  }

  profiles() {
    const builtins = Object.fromEntries(Object.entries(BUILTIN).map(([name, profile]) => [name, { ...profile, mutation: false, builtin: true }]));
    const custom = Object.fromEntries(Object.entries(this.custom()).map(([name, profile]) => [name, { ...profile, builtin: false }]));
    return { ...builtins, ...custom };
  }

  registerProfile(profile) {
    require(/^[a-z][a-z0-9.-]{2,80}$/.test(profile.name), 422, 'invalid_profile', 'Profile name must be a slug');
    require(typeof profile.executable === 'string' && isAbsolute(profile.executable) && !profile.executable.includes('\0'), 422, 'invalid_profile', 'Executable must be an absolute path');
    require(existsSync(profile.executable), 422, 'invalid_profile', 'Executable does not exist');
    require(Array.isArray(profile.args) && profile.args.length <= 100 && profile.args.every((arg) => typeof arg === 'string' && arg.length <= 10000 && !arg.includes('\0')), 422, 'invalid_profile', 'Args must be bounded strings');
    require(!Object.hasOwn(BUILTIN, profile.name), 409, 'profile_exists', 'Builtin profile cannot be replaced');
    const profiles = this.custom();
    profiles[profile.name] = {
      executable: profile.executable, args: profile.args,
      mutation: profile.mutation === true,
      timeoutMs: Math.min(Math.max(profile.timeoutMs || 10000, 100), 120000),
      maxOutputBytes: Math.min(Math.max(profile.maxOutputBytes || 2_000_000, 1024), 20_000_000),
      description: String(profile.description || '').slice(0, 1000)
    };
    writeFileSync(this.path, canonicalJson(profiles), { mode: 0o600 });
    return profiles[profile.name];
  }

  async execute(name, { input = '' } = {}) {
    const profile = this.profiles()[name];
    require(profile, 404, 'profile_not_found', `Unknown system profile: ${name}`);
    require(Buffer.byteLength(input) <= 1_000_000, 422, 'input_too_large', 'Profile stdin is limited to 1 MB');
    return executeProcess(profile, input);
  }
}

export function executeProcess(profile, input = '') {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const child = spawn(profile.executable, profile.args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), settled = false, truncated = false;
    const limit = profile.maxOutputBytes || 2_000_000;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise({ ...value, durationMs: Date.now() - started, truncated, exitCodeZeroNotCompletionProof: true });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new HttpError(504, 'profile_timeout', `System profile timed out after ${profile.timeoutMs}ms`));
    }, profile.timeoutMs || 10000);
    child.on('error', (error) => finish(new HttpError(503, 'profile_unavailable', error.message)));
    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > limit) { truncated = true; chunk = chunk.subarray(0, Math.max(0, limit - stdout.length)); }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length + chunk.length > limit) { truncated = true; chunk = chunk.subarray(0, Math.max(0, limit - stderr.length)); }
      stderr = Buffer.concat([stderr, chunk]);
    });
    child.on('close', (code, signal) => finish(null, { exitCode: code, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
