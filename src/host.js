// The computer service (`claude-pro host`): one background process per computer (per CONFIG_DIR) that keeps
// this computer on the gateway's 远程控制 page, so that the page can open a new session here: it lists the
// directories to choose from, and opens a terminal window with claude-pro in the one chosen, online at once with
// the id the gateway gave it. Like a session it only connects out to the gateway, with the API key of /login.
//
// Protocol (Bearer = the gateway API key; ARCHITECTURE.md 3.1.5):
//   POST   /v1/remote/hosts {id, machine, host, platform, version, home, terminal} -> {id, ok}
//   GET    /v1/remote/hosts/:id/commands (SSE): online while it is open; {cid, type: 'list'|'open', body}
//   POST   /v1/remote/hosts/:id/results {cid, ok: true, ...} | {cid, ok: false, error}
//   DELETE /v1/remote/hosts/:id: off the page's list (`host stop`, a logout, another account)
//
// It runs in the foreground with `claude-pro host`, in the background (detached, no window, logging to
// CONFIG_DIR/host.log) with `host start`; an interactive session logged in to the gateway starts one when none
// runs (CLAUDE_PRO_HOST=0: not), and `host install` starts one at logon. CONFIG_DIR/host.json keeps its id (for
// good) and, while it runs, its pid and a heartbeat; host.lock keeps a second one from running. It follows the
// login in gateway.json (waits without one, registers again with another key), and a background one starts the
// new version of the program when its files change (an update, an edit of the source).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { CONFIG_DIR, INSTALL_DIR, VERSION, GATEWAY_DEFAULT_URL, loadConfig } from './config.js';
import { readGatewayLogin, normalizeGatewayUrl } from './gateway.js';
import { machineName, cleanName } from './peers.js';
import { ENV_SUPERVISED, ENV_RESTART_FILE, ENV_RESTARTED } from './supervisor.js';

export const ENTRY = path.join(INSTALL_DIR, 'bin', 'claude-pro.js');
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const BEAT_MS = 20_000; // host.json is written this often while it runs ...
const STALE_MS = 90_000; // ... and one whose heartbeat is older than this is not running (its pid may be another program's now)
const LOGIN_CHECK_MS = 5_000;
const CODE_CHECK_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const STREAM_SILENCE_MS = 50_000; // the gateway pings every 15 s
const MAX_ENTRIES = 1000;
const MAX_RECENT = 15;
const LOG_BYTES = 1_000_000;
const SESSION_ONLY = [ENV_SUPERVISED, ENV_RESTART_FILE, ENV_RESTARTED]; // a session's own: not for the service, nor the sessions it opens

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Whether sessions start the service by themselves (CLAUDE_PRO_HOST=0: only `claude-pro host start` does).
export const hostEnabled = (env = process.env) => !/^(0|false|no|off)$/i.test(env.CLAUDE_PRO_HOST || '');

const configDir = () => process.env.CLAUDE_PRO_CONFIG_DIR || CONFIG_DIR;
export const hostFiles = () => {
  const dir = configDir();
  return { dir, state: path.join(dir, 'host.json'), lock: path.join(dir, 'host.lock'), log: path.join(dir, 'host.log'), launch: path.join(dir, 'launch') };
};

// ---------------------------------------------------------------- host.json, the lock

export function readHostState() {
  try {
    const state = JSON.parse(fs.readFileSync(hostFiles().state, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch {
    return {};
  }
}

// Merges `change` into host.json (an undefined value removes the key).
function updateHostState(change) {
  const next = { ...readHostState(), ...change };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  const file = hostFiles().state;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* best effort: the next heartbeat writes it again */ }
  return next;
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function hostRunning(state = readHostState(), now = Date.now()) {
  return Boolean(state.pid && pidAlive(state.pid) && now - (Number(state.beat) || 0) < STALE_MS);
}

// This computer's id at the gateway: made once, then kept in host.json.
function hostId() {
  const state = readHostState();
  if (ID.test(state.id || '')) return state.id;
  const id = crypto.randomBytes(9).toString('base64url');
  updateHostState({ id });
  return id;
}

// One service per CONFIG_DIR: host.lock holds the pid of the one that runs. A lock is taken over when its process
// is gone, or when it is old and no heartbeat says it runs (its pid may be another program's now).
function takeLock() {
  const { lock } = hostFiles();
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let holder = 0;
    let age = Infinity;
    try { holder = Number(fs.readFileSync(lock, 'utf8')); age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
    const state = readHostState();
    if (holder !== process.pid && pidAlive(holder) && (age < STALE_MS || (state.pid === holder && Date.now() - (Number(state.beat) || 0) < STALE_MS))) return false;
    try { fs.rmSync(lock, { force: true }); } catch { /* taken again below, or not */ }
  }
  return false;
}

function releaseLock(pid = process.pid) {
  const { lock } = hostFiles();
  try { if (Number(fs.readFileSync(lock, 'utf8')) === pid) fs.rmSync(lock, { force: true }); } catch { /* not ours, or gone */ }
}

// ---------------------------------------------------------------- logging

function fileLogger() {
  const file = hostFiles().log;
  return (msg) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { if (fs.statSync(file).size > LOG_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* none yet */ }
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
    } catch { /* nowhere to say it */ }
  };
}

const consoleLogger = () => (msg) => process.stdout.write(`[${new Date().toLocaleTimeString()}] ${msg}\n`);

// ---------------------------------------------------------------- starting it from elsewhere

function serviceEnv(env = process.env) {
  const out = { ...env };
  for (const k of SESSION_ONLY) delete out[k];
  return out;
}

// A service in the background: detached (it outlives the session or terminal that started it), without a window.
export function startHostInBackground({ env = process.env } = {}) {
  const child = spawn(process.execPath, [ENTRY, 'host', 'run', '--background'], { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.homedir(), env: serviceEnv(env) });
  child.on('error', () => { /* the next session tries again */ });
  child.unref();
  return child.pid;
}

// For a session that starts (see App.ensureHost): a service, unless one runs, `claude-pro host stop` stopped it, or
// one was started a moment ago (by another session starting at the same time). Returns the pid of a new one.
export function ensureHost({ env = process.env } = {}) {
  const state = readHostState();
  if (hostRunning(state) || state.disabled) return null;
  if (Date.now() - (Number(state.spawnedAt) || 0) < 30_000) return null;
  updateHostState({ spawnedAt: Date.now() });
  return startHostInBackground({ env });
}

// What /status says about it.
export function describeHost(env = process.env) {
  const state = readHostState();
  if (hostRunning(state)) return `running (pid ${state.pid})${state.online ? ' · the web page can open sessions on this computer' : ' · not connected to the gateway now'}`;
  if (state.disabled) return 'stopped with `claude-pro host stop` (`claude-pro host start` starts it again)';
  return hostEnabled(env) ? 'not running (a session starts it once this computer is logged in to the gateway; or `claude-pro host start`)' : 'not running (CLAUDE_PRO_HOST=0: `claude-pro host start` starts it)';
}

// ---------------------------------------------------------------- directories (the list command)

// `input` as an absolute directory of this computer: "" (or ~) is the home directory, "D:" is the root of D:, and
// forward slashes do on Windows too. null when it is not absolute.
export function normalizeDir(input, { platform = process.platform, home = os.homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let s = String(input ?? '').trim();
  if (!s || s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) s = p.join(home, s.slice(2));
  if (platform === 'win32') {
    s = s.replace(/\//g, '\\');
    if (/^[A-Za-z]:$/.test(s)) s += '\\';
    if (!/^([A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(s)) return null;
    s = s.replace(/^[a-z]:/, (d) => d.toUpperCase());
  } else if (!s.startsWith('/')) {
    return null;
  }
  return p.resolve(s);
}

const describeFsError = (e, dir) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? `目录不存在：${dir}`
  : e.code === 'EACCES' || e.code === 'EPERM' ? `没有权限读取：${dir}`
    : `读取 ${dir} 失败：${e.message}`);

let rootsCache = { at: 0, roots: [] };
async function roots(platform = process.platform) {
  if (platform !== 'win32') return ['/'];
  if (Date.now() - rootsCache.at < 30_000) return rootsCache.roots;
  // a disconnected network drive can take long to answer: 1.5 seconds each, all at once
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(letters.map((l) => Promise.race([
    fsp.access(`${l}:\\`).then(() => `${l}:\\`, () => null),
    sleep(1500).then(() => null),
  ])));
  rootsCache = { at: Date.now(), roots: found.filter(Boolean) };
  return rootsCache.roots;
}

// The directories in `input` (only directories, links to them included), for the page to choose from.
export async function listDirectory(input, { home = os.homedir(), recent = () => [] } = {}) {
  const dir = normalizeDir(input, { home });
  if (!dir) throw new Error(`不是绝对路径：${input}`);
  let st;
  try { st = await fsp.stat(dir); } catch (e) { throw new Error(describeFsError(e, dir)); }
  if (!st.isDirectory()) throw new Error(`不是目录：${dir}`);
  let dirents;
  try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { throw new Error(describeFsError(e, dir)); }
  const entries = [];
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      // a link to a directory counts, unless it cannot be opened (Windows' old junctions in the profile:
      // "My Documents", "Application Data" ... refuse to be listed)
      try { isDir = (await fsp.stat(full)).isDirectory(); } catch { isDir = false; }
      if (isDir) {
        let handle = null;
        try {
          handle = await fsp.opendir(full);
          await handle.read(); // Windows checks the access at the first read, not at the opening
        } catch {
          isDir = false;
        } finally {
          await handle?.close().catch(() => {});
        }
      }
      // ... and the profile's other compatibility junctions ("Application Data", "Recent", the Start Menu in the
      // system's language ...), which Explorer hides: all lead into AppData
      if (isDir && process.platform === 'win32' && dir.toLowerCase() === path.resolve(home).toLowerCase()) {
        try {
          if ((await fsp.realpath(full)).toLowerCase().startsWith(`${path.join(home, 'AppData').toLowerCase()}\\`)) isDir = false;
        } catch { isDir = false; }
      }
    }
    if (isDir) entries.push({ name: d.name, path: full });
  }
  const hidden = (name) => (name.startsWith('.') ? 1 : 0);
  entries.sort((a, b) => hidden(a.name) - hidden(b.name) || a.name.localeCompare(b.name, undefined, { sensitivity: 'accent', numeric: true }));
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    sep: path.sep,
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
    home,
    roots: await roots(),
    recent: recent(),
  };
}

// The first line of a session file is {type: 'meta', cwd, ...} (see SessionStore.append).
function sessionCwd(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, n).toString('utf8').split('\n')[0];
    const meta = JSON.parse(line);
    return meta?.type === 'meta' && typeof meta.cwd === 'string' ? meta.cwd : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// Where claude-pro sessions ran lately on this computer, newest first: [{path, at}] of the directories that are
// still there. One line read per project (its newest session's first line).
export function recentDirectories({ projects = path.join(configDir(), 'projects'), max = MAX_RECENT } = {}) {
  let dirs = [];
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
  const found = [];
  for (const d of dirs) {
    const sub = path.join(projects, d.name);
    let newest = null;
    try {
      for (const f of fs.readdirSync(sub)) {
        if (!f.endsWith('.jsonl')) continue;
        const m = fs.statSync(path.join(sub, f)).mtimeMs;
        if (!newest || m > newest.m) newest = { f, m };
      }
    } catch { continue; }
    if (!newest) continue;
    const cwd = sessionCwd(path.join(sub, newest.f));
    if (cwd) found.push({ path: path.resolve(cwd), at: newest.m });
  }
  found.sort((a, b) => b.at - a.at);
  const seen = new Set();
  const out = [];
  for (const r of found) {
    const key = process.platform === 'win32' ? r.path.toLowerCase() : r.path;
    if (seen.has(key)) continue;
    seen.add(key);
    try { if (!fs.statSync(r.path).isDirectory()) continue; } catch { continue; }
    out.push({ path: r.path, at: new Date(r.at).toISOString() });
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------- terminals (the open command)

// A program on the PATH. Windows Terminal's wt.exe is an "app execution alias" that only lstat sees.
export function findCommand(name, { env = process.env, platform = process.platform } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' && !p.extname(name) ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const extra = platform === 'win32' && env.LOCALAPPDATA ? [p.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps')] : [];
  for (const dir of [...dirs, ...extra]) {
    for (const ext of exts) {
      const file = p.join(dir, name + ext);
      try {
        const st = fs.lstatSync(file);
        if (st.isFile() || st.isSymbolicLink()) return file;
      } catch { /* not here */ }
    }
  }
  return null;
}

// What opens a terminal window on this computer: {kind, name, path}, or null when nothing here can.
export function terminalFor({ platform = process.platform, env = process.env, find = (name) => findCommand(name, { env, platform }) } = {}) {
  if (platform === 'win32') {
    const wt = find('wt.exe');
    return wt ? { kind: 'wt', name: 'Windows Terminal', path: wt } : { kind: 'console', name: 'Windows console', path: 'powershell.exe' };
  }
  if (platform === 'darwin') {
    const osa = find('osascript');
    return osa ? { kind: 'osascript', name: 'Terminal.app', path: osa } : null;
  }
  if (env.DISPLAY || env.WAYLAND_DISPLAY) {
    for (const cmd of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
      const found = find(cmd);
      if (found) return { kind: cmd, name: cmd, path: found };
    }
  }
  const tmux = find('tmux');
  return tmux ? { kind: 'tmux', name: 'tmux', path: tmux } : null;
}

// One argument of a Windows command line, quoted as the C runtime reads it back.
export function quoteWindowsArg(arg) {
  const s = String(arg);
  if (s && !/[\s"]/.test(s)) return s;
  let out = '"';
  let slashes = 0;
  for (const ch of s) {
    if (ch === '\\') { slashes++; continue; }
    out += ch === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${ch}`;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The settings of this service's environment that a session it opens needs too (the config directory, the
// gateway's address, the computer's name ...): Windows Terminal starts the program with its own environment, and
// tmux and a desktop's terminal with theirs. Not the secrets: those stay where they were set.
const PASS_ENV = /^(CLAUDE_PRO_|ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$)/;
const SECRET = /TOKEN|KEY|SECRET|PASSWORD|HEADERS/i;
export function passedEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!PASS_ENV.test(k) || SECRET.test(k) || SESSION_ONLY.includes(k) || /^CLAUDE_PRO_LAUNCH_/.test(k) || v == null || /[\r\n\0]/.test(String(v))) continue;
    out[k] = String(v);
  }
  return out;
}

// For Windows: the variables as a file for `node --env-file` (whose single and back quotes keep backslashes as they
// are). Files of launches more than 10 minutes old are removed.
function writeEnvFile(sessionId, vars) {
  const entries = Object.entries(vars);
  if (!entries.length) return null;
  const dir = hostFiles().launch;
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      if (Date.now() - fs.statSync(file).mtimeMs > 10 * 60_000) fs.rmSync(file, { force: true });
    }
  } catch { /* the next launch cleans up */ }
  const quote = (v) => (!v.includes("'") ? `'${v}'` : !v.includes('`') ? `\`${v}\`` : null);
  const lines = entries.map(([k, v]) => (quote(v) ? `${k}=${quote(v)}` : null)).filter(Boolean);
  const file = path.join(dir, `${sessionId}.env`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}

// How `term` opens a window that runs `node entry ...args` in `cwd`: {cmd, args, options, wait}. `wait`: 'exit'
// when the command ends once the window is open (its exit code says whether it worked), 'spawn' when it is the
// terminal itself.
export function launchCommand(term, { cwd, node = process.execPath, entry = ENTRY, args = [], env = {}, envFile = null, sessionId = '' }) {
  const program = [node, ...(envFile ? [`--env-file=${envFile}`] : []), entry, ...args];
  const pairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const posix = [...(pairs.length ? ['env', ...pairs] : []), node, entry, ...args];
  const line = posix.map(shQuote).join(' ');
  switch (term.kind) {
    case 'wt': // a new window; wt reads ; as the start of another command
      return { cmd: term.path, args: ['-w', 'new', '-d', cwd, ...program].map((a) => a.replace(/;/g, '\\;')), options: { windowsHide: false }, wait: 'exit' };
    case 'console': { // a console window of its own; Start-Process takes the command line as it is
      // what went wrong: only its message, in UTF-8 (PowerShell writes errors as CLIXML in the system's code page)
      const script = [
        "$ProgressPreference = 'SilentlyContinue'",
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
        'try { Start-Process -ErrorAction Stop -FilePath $env:CLAUDE_PRO_LAUNCH_FILE -ArgumentList $env:CLAUDE_PRO_LAUNCH_ARGS -WorkingDirectory $env:CLAUDE_PRO_LAUNCH_DIR; exit 0 }',
        'catch { [Console]::Out.Write($_.Exception.Message); exit 1 }',
      ].join('\n');
      return {
        cmd: term.path,
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        // not detached: a detached (console-less) PowerShell ends at once without doing anything; hidden, its
        // console does not show
        options: { windowsHide: true, detached: false, env: { ...process.env, CLAUDE_PRO_LAUNCH_FILE: program[0], CLAUDE_PRO_LAUNCH_ARGS: program.slice(1).map(quoteWindowsArg).join(' '), CLAUDE_PRO_LAUNCH_DIR: cwd } },
        wait: 'exit',
      };
    }
    case 'osascript': {
      const as = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      return { cmd: term.path, args: ['-e', `tell application "Terminal" to do script ${as(`cd ${shQuote(cwd)} && exec ${line}`)}`, '-e', 'tell application "Terminal" to activate'], options: {}, wait: 'exit' };
    }
    case 'tmux': // no desktop: a tmux session (`tmux attach -t claude-pro-<id>` shows it here; the web page works anyway)
      return { cmd: term.path, args: ['new-session', '-d', '-s', `claude-pro-${sessionId}`, '-c', cwd, `exec ${line}`], options: { cwd }, wait: 'exit' };
    default: { // a desktop's terminal: sh goes to `cwd` first, as not every terminal starts where it was started
      const inDir = ['sh', '-c', 'cd "$0" && exec "$@"', cwd, ...posix];
      const head = term.kind === 'gnome-terminal' ? [`--working-directory=${cwd}`, '--'] : term.kind === 'konsole' ? ['--workdir', cwd, '-e'] : ['-e'];
      return { cmd: term.path, args: [...head, ...inDir], options: { cwd }, wait: 'spawn' };
    }
  }
}

// Runs what launchCommand made: resolves once the window is open, rejects with what went wrong.
export function runLaunch(spec, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const exits = spec.wait === 'exit';
    let child;
    // a terminal that runs on must not write into a closed pipe: only a command that ends tells its error
    const out = exits ? 'pipe' : 'ignore';
    try { child = spawn(spec.cmd, spec.args, { detached: true, stdio: ['ignore', out, out], ...spec.options }); } catch (e) { reject(e); return; }
    let err = '';
    const keep = (d) => { if (err.length < 4000) err += d; };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let settled = false;
    const done = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      if (e) reject(e); else resolve();
    };
    const timer = setTimeout(() => done(exits ? new Error('打开终端超时') : null), exits ? timeoutMs : 1500);
    child.on('error', (e) => done(e));
    child.on('exit', (code) => done(code === 0 ? null : new Error(err.trim().split(/\r?\n/).filter(Boolean).pop() || `退出码 ${code}`)));
  });
}

// ---------------------------------------------------------------- the service

export class HostService {
  // `readLogin`, `loadConfig`, `launch`, `terminal`, `home`: what the tests give it instead of this computer's.
  constructor({ id, log = () => {}, fetchImpl = globalThis.fetch, background = false, terminal, launch = runLaunch, home = os.homedir(), readLogin, loadConfig: load } = {}) {
    this.id = id;
    this.log = log;
    this.fetch = fetchImpl;
    this.background = background;
    this.terminal = terminal === undefined ? terminalFor() : terminal;
    this.launch = launch;
    this.home = home;
    this.loadConfig = load || (() => loadConfig({ cwd: home }));
    this.readLogin = readLogin || (() => readGatewayLogin(this.cfg().gatewayUrl));
    this.config = null;
    this.configAt = 0;
    this.login = null; // {url, apiKey, account} of gateway.json
    this.registered = false;
    this.online = false;
    this.stopped = false;
    this.reloading = false;
    this.inflight = 0;
    this.streamAbort = null;
    this.wake = null;
    this.timers = [];
    this.refusedKey = null;
    this.lastNote = '';
    this.recent = { at: 0, list: [] };
  }

  cfg() {
    if (!this.config || Date.now() - this.configAt > 60_000) {
      try { this.config = this.loadConfig(); } catch { this.config ??= { env: process.env, gatewayUrl: GATEWAY_DEFAULT_URL }; }
      this.configAt = Date.now();
    }
    return this.config;
  }

  base(login = this.login) { return normalizeGatewayUrl(login?.url || this.cfg().gatewayUrl); }

  // Logged once until something else happens (a gateway that is down is retried every 30 seconds).
  note(msg) {
    if (msg === this.lastNote) return;
    this.lastNote = msg;
    this.log(msg);
  }

  async request(method, route, body, { timeout = REQUEST_TIMEOUT_MS, login = this.login } = {}) {
    const res = await this.fetch(`${this.base(login)}${route}`, {
      method,
      headers: { authorization: `Bearer ${login.apiKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || (typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`)), { status: res.status });
    return data;
  }

  // What the page shows of this computer. `machine` is the name its sessions register with, so that the page puts
  // them together.
  info() {
    return { id: this.id, machine: machineName(this.cfg().env), host: os.hostname(), platform: process.platform, version: VERSION, home: this.home, terminal: this.terminal?.name || '' };
  }

  async register() {
    try {
      await this.request('POST', '/v1/remote/hosts', this.info());
    } catch (e) {
      if (e.status === 404) e.noHosts = true; // a gateway without computers (yet): not the one that forgot this one
      throw e;
    }
    this.registered = true;
    this.note(`registered at ${this.base()} as ${this.info().machine} (${this.id})`);
  }

  // Follows gateway.json: logged out, the computer leaves the page's list and the service waits for a login; with
  // another account it leaves the old one's list and joins the new one's.
  checkLogin() {
    let login = null;
    try { login = this.readLogin(); } catch { /* none */ }
    const key = (l) => (l?.apiKey ? `${this.base(l)}\n${l.apiKey}` : '');
    if (key(login) === key(this.login)) return;
    const old = this.login;
    this.login = login?.apiKey ? login : null;
    this.registered = false;
    if (old) {
      this.log(this.login ? 'the gateway login changed: registering with the new one' : 'logged out of the gateway: waiting for /login');
      this.request('DELETE', `/v1/remote/hosts/${encodeURIComponent(this.id)}`, undefined, { login: old, timeout: 5000 }).catch(() => {});
    } else if (this.login) {
      this.log(`logged in to the gateway ${this.base()}`);
    }
    this.streamAbort?.abort();
    this.wakeUp();
  }

  sleep(ms) {
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { clearTimeout(timer); if (this.wake === done) this.wake = null; resolve(); };
      timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  wakeUp() { this.wake?.(); }

  setOnline(online) {
    if (online === this.online) return;
    this.online = online;
    if (online) this.lastNote = '';
    this.log(online ? 'online: the web page can open sessions on this computer' : 'offline');
    this.beat();
  }

  beat() {
    if (this.stopped) return;
    updateHostState({
      id: this.id,
      pid: process.pid,
      version: VERSION,
      startedAt: this.startedAt,
      beat: Date.now(),
      online: this.online,
      gateway: this.login ? this.base() : null,
      account: this.login?.account?.email || this.login?.account?.name || null,
      machine: this.info().machine,
      terminal: this.terminal?.name || '',
      background: this.background,
      disabled: undefined,
      spawnedAt: undefined,
    });
  }

  // Until stop(): resolves when the service has stopped (or stops to start its new version: `reloading`).
  async run() {
    this.startedAt = new Date().toISOString();
    this.code = codeFingerprint();
    this.checkLogin();
    if (!this.login) this.log(`not logged in to the gateway ${this.base()}: waiting for /login`);
    this.beat();
    this.timers.push(
      setInterval(() => this.beat(), BEAT_MS),
      setInterval(() => this.checkLogin(), LOGIN_CHECK_MS),
      setInterval(() => this.checkCode(), CODE_CHECK_MS),
    );
    try { await this.loop(); } finally { for (const t of this.timers) clearInterval(t); }
  }

  async loop() {
    let wait = 1000;
    while (!this.stopped) {
      // without a login, or with a key the gateway refused (tried again every 10 minutes): a new login helps
      const refused = this.login && this.refusedKey === this.login.apiKey && Date.now() - this.refusedAt < 10 * 60_000;
      if (!this.login || refused) {
        this.setOnline(false);
        await this.sleep(this.login ? 60_000 : 30_000);
        continue;
      }
      try {
        if (!this.registered) await this.register();
        await this.listen();
        wait = 1000;
      } catch (e) {
        if (e.noHosts) { this.note(`the gateway ${this.base()} does not take computers (yet): trying again every 5 minutes`); wait = 5 * 60_000; }
        else if (e.status === 404) this.registered = false; // the gateway forgot this computer (it restarted): register again
        else if (e.status === 401 || e.status === 403) {
          this.refusedKey = this.login?.apiKey;
          this.refusedAt = Date.now();
          this.registered = false;
          this.note(`the gateway refused this computer's key (${e.message}): waiting for /login`);
        }
        else if (!this.stopped && e.name !== 'AbortError') this.note(`cannot reach the gateway ${this.base()}: ${e.message}`);
      }
      this.setOnline(false);
      if (this.stopped) break;
      await this.sleep(wait);
      wait = Math.min(wait * 2, 30_000);
    }
  }

  // The command stream, open until the gateway ends it, it stays silent too long, or abort().
  async listen() {
    const abort = new AbortController();
    this.streamAbort = abort;
    const res = await this.fetch(`${this.base()}/v1/remote/hosts/${encodeURIComponent(this.id)}/commands`, {
      headers: { authorization: `Bearer ${this.login.apiKey}`, accept: 'text/event-stream' },
      signal: abort.signal,
    });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    }
    this.setOnline(true);
    let last = Date.now();
    const watchdog = setInterval(() => { if (Date.now() - last > STREAM_SILENCE_MS) abort.abort(); }, 5000);
    try {
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        last = Date.now();
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          let cmd;
          try { cmd = JSON.parse(data); } catch { continue; }
          this.command(cmd);
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) throw e;
    } finally {
      clearInterval(watchdog);
      if (this.streamAbort === abort) this.streamAbort = null;
    }
  }

  async command(cmd) {
    if (!cmd || typeof cmd.cid !== 'string' || !cmd.cid) return;
    const login = this.login;
    this.inflight++;
    let result;
    try {
      const body = cmd.body && typeof cmd.body === 'object' ? cmd.body : {};
      let r;
      if (cmd.type === 'list') r = await this.list(body);
      else if (cmd.type === 'open') r = await this.open(body);
      else throw new Error(`这台电脑上的 claude-pro ${VERSION} 不认识命令 ${cmd.type}，请升级`);
      result = { cid: cmd.cid, ok: true, ...r };
    } catch (e) {
      result = { cid: cmd.cid, ok: false, error: e.message };
    } finally {
      this.inflight--;
    }
    if (login) {
      try {
        await this.request('POST', `/v1/remote/hosts/${encodeURIComponent(this.id)}/results`, result, { login });
      } catch (e) {
        this.note(`could not send the result of ${cmd.type}: ${e.message}`);
      }
    }
    if (this.reloadWanted && !this.inflight) this.reload();
  }

  list(body) {
    return listDirectory(typeof body.path === 'string' ? body.path : '', {
      home: this.home,
      recent: () => {
        if (Date.now() - this.recent.at > 30_000) this.recent = { at: Date.now(), list: recentDirectories() };
        return this.recent.list;
      },
    });
  }

  // A new terminal window with an interactive claude-pro in `cwd`, online at once as `sessionId` (and named `name`).
  async open({ sessionId, cwd, create, name } = {}) {
    if (typeof sessionId !== 'string' || !ID.test(sessionId)) throw new Error('会话 id 不对');
    const dir = typeof cwd === 'string' ? normalizeDir(cwd, { home: this.home }) : null;
    if (!dir || !String(cwd).trim()) throw new Error(`请选择一个绝对路径的目录：${cwd ?? ''}`);
    let st = null;
    try { st = await fsp.stat(dir); } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(describeFsError(e, dir));
    }
    if (!st) {
      if (create !== true) throw new Error(`目录不存在：${dir}`);
      try { await fsp.mkdir(dir, { recursive: true }); } catch (e) { throw new Error(`创建目录失败：${dir}（${e.message}）`); }
    } else if (!st.isDirectory()) {
      throw new Error(`不是目录：${dir}`);
    }
    const term = this.terminal;
    if (!term) throw new Error('这台电脑上找不到能打开的终端（Windows Terminal、Terminal.app、x-terminal-emulator、gnome-terminal、konsole、xterm 或 tmux）');
    const label = typeof name === 'string' && name.trim() ? cleanName(name) : '';
    const args = ['--remote-id', sessionId, ...(label ? ['--name', label] : [])];
    const env = passedEnv();
    const envFile = process.platform === 'win32' && term.kind === 'wt' ? writeEnvFile(sessionId, env) : null;
    try {
      await this.launch(launchCommand(term, { cwd: dir, args, env, envFile, sessionId }));
    } catch (e) {
      throw new Error(`无法用 ${term.name} 打开终端：${e.message}`);
    }
    this.log(`opened ${term.name} in ${dir} for the session ${sessionId}${label ? ` (${label})` : ''}`);
    return { terminal: term.name };
  }

  // The program's files changed (an update, an edit of the source): a background service starts its new version
  // once the files have stayed the same for a check and no command is being answered.
  checkCode() {
    const now = codeFingerprint();
    if (now === this.code) { this.pendingCode = null; return; }
    if (!this.background) {
      if (!this.toldCode) this.log("claude-pro's files changed: restart `claude-pro host` to run the new version");
      this.toldCode = true;
      return;
    }
    if (now !== this.pendingCode) { this.pendingCode = now; return; }
    this.reloadWanted = true;
    if (!this.inflight) this.reload();
  }

  reload() {
    this.reloading = true;
    this.stop();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.streamAbort?.abort();
    this.wakeUp();
  }
}

// The program's files as they are now (names, sizes, times): another value means another version.
export function codeFingerprint(root = INSTALL_DIR) {
  const hash = crypto.createHash('sha1');
  for (const dir of ['bin', 'src']) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir), { recursive: true }).map(String).filter((n) => /\.(m?js|json)$/i.test(n)).sort(); } catch { /* none */ }
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(root, dir, n));
        hash.update(`${dir}/${n}:${st.size}:${st.mtimeMs}\n`);
      } catch { /* gone meanwhile */ }
    }
  }
  try { hash.update(fs.readFileSync(path.join(root, 'package.json'))); } catch { /* none */ }
  return hash.digest('base64');
}

// `claude-pro host run [--background]`: the service, until it is stopped. Returns the exit code.
export async function runHost({ background = false } = {}) {
  for (const k of SESSION_ONLY) delete process.env[k];
  const log = background ? fileLogger() : consoleLogger();
  if (!takeLock()) {
    log(`claude-pro host runs already (pid ${readHostState().pid || '?'}): this one stops`);
    return background ? 0 : 1;
  }
  const service = new HostService({ id: hostId(), log, background });
  const stop = () => service.stop();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
  log(`claude-pro host ${VERSION} started (pid ${process.pid}${background ? ', in the background' : ''}; terminal: ${service.terminal?.name || 'none found'})`);
  try {
    await service.run();
  } finally {
    releaseLock();
    if (readHostState().pid === process.pid) updateHostState({ pid: undefined, beat: undefined, online: false });
  }
  if (service.reloading) {
    log('the program changed: starting its new version');
    startHostInBackground();
  } else {
    log('stopped');
  }
  return 0;
}

// ---------------------------------------------------------------- start, stop, status

async function gatewayRequest(method, route) {
  const cfg = loadConfig({ cwd: os.homedir() });
  const login = readGatewayLogin(cfg.gatewayUrl);
  if (!login) return false;
  const res = await fetch(`${normalizeGatewayUrl(login.url || cfg.gatewayUrl)}${route}`, { method, headers: { authorization: `Bearer ${login.apiKey}` }, signal: AbortSignal.timeout(8000) });
  return res.ok || res.status === 404;
}

async function startCommand() {
  const state = readHostState();
  if (hostRunning(state)) {
    console.log(`claude-pro host is running already (pid ${state.pid}).`);
    return 0;
  }
  updateHostState({ disabled: undefined, spawnedAt: Date.now() });
  const pid = startHostInBackground();
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    const now = readHostState();
    if (hostRunning(now)) {
      const cfg = loadConfig({ cwd: os.homedir() });
      const login = readGatewayLogin(cfg.gatewayUrl);
      console.log(`claude-pro host started in the background (pid ${now.pid}). Log: ${hostFiles().log}`);
      if (!login) console.log(`This computer is not logged in to the gateway ${cfg.gatewayUrl}: it waits until /login in a session.`);
      return 0;
    }
  }
  console.log(`claude-pro host was started (pid ${pid}) but has not reported yet: see ${hostFiles().log}`);
  return 1;
}

async function stopCommand() {
  const state = readHostState();
  const running = hostRunning(state);
  updateHostState({ disabled: true });
  if (running) {
    try { process.kill(state.pid); } catch { /* gone already */ }
    for (let i = 0; i < 25 && pidAlive(state.pid); i++) await sleep(200);
    releaseLock(state.pid);
  }
  // again: a heartbeat between the first write and the end of the process clears it
  updateHostState({ disabled: true, pid: undefined, beat: undefined, online: false });
  let removed = false;
  if (state.id) removed = await gatewayRequest('DELETE', `/v1/remote/hosts/${encodeURIComponent(state.id)}`).catch(() => false);
  console.log(`${running ? `Stopped claude-pro host (pid ${state.pid}).` : 'claude-pro host was not running.'}${removed ? ' This computer is off the gateway\'s list.' : ''}`);
  console.log('Sessions no longer start it by themselves: `claude-pro host start` does.');
  return 0;
}

function statusCommand() {
  const state = readHostState();
  const running = hostRunning(state);
  const auto = installedAutostart();
  const lines = [
    `claude-pro host (lets the gateway's web page open sessions on this computer): ${running ? `running, pid ${state.pid}, since ${state.startedAt || '?'}` : state.disabled ? 'stopped (claude-pro host start)' : 'not running (claude-pro host start)'}`,
  ];
  if (running) lines.push(`  gateway: ${state.gateway ? `${state.gateway}${state.account ? ` as ${state.account}` : ''} · ${state.online ? 'online' : 'not connected now'}` : 'not logged in (it waits for /login)'}`);
  if (state.id) lines.push(`  id: ${state.id}${state.machine ? ` · computer: ${state.machine}` : ''}${state.terminal ? ` · opens: ${state.terminal}` : ''}${state.version ? ` · version ${state.version}` : ''}`);
  lines.push(`  log: ${hostFiles().log}`);
  lines.push(`  at logon: ${auto ? `starts (${auto}; claude-pro host uninstall stops that)` : 'no (claude-pro host install)'}`);
  console.log(lines.join('\n'));
  return 0;
}

// ---------------------------------------------------------------- starting at logon

const suffix = () => (process.env.CLAUDE_PRO_CONFIG_DIR ? `-${crypto.createHash('sha1').update(path.resolve(process.env.CLAUDE_PRO_CONFIG_DIR)).digest('hex').slice(0, 8)}` : '');

// Where `host install` puts what starts it at logon, by platform (two kinds on Linux: a desktop's autostart, else a
// systemd user service).
export function autostartFiles({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const s = suffix();
  if (platform === 'win32') return [path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `claude-pro-host${s}.vbs`)];
  if (platform === 'darwin') return [path.join(home, 'Library', 'LaunchAgents', `com.claude-pro.host${s}.plist`)];
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [path.join(config, 'autostart', `claude-pro-host${s}.desktop`), path.join(config, 'systemd', 'user', `claude-pro-host${s}.service`)];
}

function installedAutostart() {
  return autostartFiles().find((f) => fs.existsSync(f)) || null;
}

// What runs at logon: `claude-pro host start`, with the config directory when it is not the default one.
function startCommandLine() {
  const env = process.env.CLAUDE_PRO_CONFIG_DIR ? { CLAUDE_PRO_CONFIG_DIR: path.resolve(process.env.CLAUDE_PRO_CONFIG_DIR) } : {};
  return { program: [process.execPath, ENTRY, 'host', 'start'], env };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function installCommand() {
  const { program, env } = startCommandLine();
  const [desktop, service] = autostartFiles();
  let file;
  let note = '';
  if (process.platform === 'win32') {
    file = desktop;
    const vbs = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const text = [
      "' claude-pro: starts its computer service (claude-pro host) at logon, without a window.",
      "' `claude-pro host uninstall` removes this file.",
      'Set shell = CreateObject("WScript.Shell")',
      ...Object.entries(env).map(([k, v]) => `shell.Environment("PROCESS")(${vbs(k)}) = ${vbs(v)}`),
      `shell.Run ${vbs(program.map(quoteWindowsArg).join(' '))}, 0, False`,
      '',
    ].join('\r\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])); // UTF-16: any user name
  } else if (process.platform === 'darwin') {
    file = desktop;
    const label = path.basename(file, '.plist');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>${program.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries({ PATH: process.env.PATH || '', ...env }).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>
</dict>
</plist>
`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, plist);
    spawnSync('launchctl', ['unload', file], { stdio: 'ignore' });
    spawnSync('launchctl', ['load', '-w', file], { stdio: 'ignore' });
  } else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    file = desktop;
    const q = (s) => `"${String(s).replace(/(["`$\\])/g, '\\$1')}"`;
    const exec = [...(Object.keys(env).length ? ['env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`)] : []), ...program].map(q).join(' ');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=claude-pro host\nComment=Lets the gateway's web page open claude-pro sessions on this computer\nExec=${exec}\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n`);
  } else {
    file = service;
    const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `[Unit]\nDescription=claude-pro host: lets the gateway's web page open claude-pro sessions on this computer\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=${program.map(q).join(' ')}\n${Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}\n`).join('')}\n[Install]\nWantedBy=default.target\n`);
    const daemon = spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    const enabled = spawnSync('systemctl', ['--user', 'enable', path.basename(file)], { stdio: 'ignore' });
    note = daemon.status === 0 && enabled.status === 0
      ? ` (systemd user service; \`loginctl enable-linger ${os.userInfo().username}\` keeps it running without a login)`
      : ' (systemctl --user did not take it: enable it by hand)';
  }
  console.log(`claude-pro host starts at logon now: ${file}${note}`);
  return startCommand();
}

function uninstallCommand() {
  let removed = 0;
  for (const file of autostartFiles()) {
    if (!fs.existsSync(file)) continue;
    if (process.platform === 'darwin') spawnSync('launchctl', ['unload', '-w', file], { stdio: 'ignore' });
    if (file.endsWith('.service')) spawnSync('systemctl', ['--user', 'disable', path.basename(file)], { stdio: 'ignore' });
    fs.rmSync(file, { force: true });
    console.log(`Removed ${file}`);
    removed++;
  }
  if (!removed) console.log('claude-pro host was not set to start at logon.');
  if (hostRunning()) console.log('It is still running now: `claude-pro host stop` stops it.');
  return 0;
}

const USAGE = `Usage: claude-pro host [run | start | stop | status | install | uninstall]

The computer service: it keeps this computer on the gateway's 远程控制 page, so that the page can open a new
claude-pro session here (in a terminal window, in the directory chosen there). It uses the gateway login of
/login, and only connects out to the gateway. A session logged in to the gateway starts it by itself
(CLAUDE_PRO_HOST=0: not).

  claude-pro host            Run it here, in the foreground (Ctrl+C stops it)
  claude-pro host start      Run it in the background (log: ~/.claude-pro/host.log)
  claude-pro host stop       Stop it and take this computer off the gateway's list (sessions then no longer start it)
  claude-pro host status     Whether it runs, its id, its log
  claude-pro host install    Start it at logon too (Windows: a script in the Startup folder; macOS: a LaunchAgent;
                             Linux: a desktop autostart entry, else a systemd user service)
  claude-pro host uninstall  Not at logon any more
`;

// `claude-pro host ...`: returns the exit code (`run` ends the process itself once the service has stopped).
export async function hostCommand(args = []) {
  const [sub = 'run', ...rest] = args;
  switch (sub) {
    case 'run': process.exit(await runHost({ background: rest.includes('--background') })); break;
    case 'start': return startCommand();
    case 'stop': return stopCommand();
    case 'status': return statusCommand();
    case 'install': return installCommand();
    case 'uninstall': return uninstallCommand();
    case 'help': case '-h': case '--help': process.stdout.write(USAGE); return 0;
    default: process.stderr.write(`Unknown host command: ${sub}\n\n${USAGE}`); return 2;
  }
  return 0;
}
