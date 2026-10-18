// The computer service (`claude-pro host`): one background process per computer (per CONFIG_DIR) that makes this
// computer one the gateway's web page (远程控制) runs sessions on: it lists the directories to choose from, opens
// sessions in the one chosen (in the background without a window, see background.js, or in a terminal window),
// online at once with the id the gateway gave them, ends and restarts them, reopens kept conversations (history),
// gives logs, updates claude-pro, and reports the sessions and how busy the computer is. Like a session it only
// connects out to the gateway, with the API key of /login or claude-pro connect.
//
// Protocol (Bearer = the gateway API key; ARCHITECTURE.md 3.1.5):
//   POST   /v1/remote/hosts {id, machine, host, platform, version, home, terminal, autostart, sessions, stats}
//   GET    /v1/remote/hosts/:id/commands (SSE): online while it is open; {cid, type, body}: list, open, stop,
//          restart, window, logs, history, delete, update
//   POST   /v1/remote/hosts/:id/results {cid, ok: true, ...} | {cid, ok: false, error}
//   POST   /v1/remote/hosts/:id/state {sessions, stats}: on a change of the sessions, and every minute
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
import { gatewayLogin, normalizeGatewayUrl } from './gateway.js';
import { machineName, cleanName, listPeers } from './peers.js';
import { BackgroundSessions, markEnded, tailFile } from './background.js';
import { listConversations, deleteConversation, CONVERSATION_ID } from './history.js';
import { checkForUpdate, installUpdate } from './updater.js';
import { ENV_SUPERVISED, ENV_RESTART_FILE, ENV_RESTARTED } from './supervisor.js';

export const ENTRY = path.join(INSTALL_DIR, 'bin', 'claude-pro.js');
const ID = /^[A-Za-z0-9_-]{8,64}$/;
// (CLAUDE_PRO_HOST_TICK_MS, for the tests: the heartbeat and the check of the program's files that often)
const TICK = Number(process.env.CLAUDE_PRO_HOST_TICK_MS) || 0;
const BEAT_MS = TICK || 20_000; // host.json is written this often while it runs ...
const STALE_MS = 90_000; // ... and one whose heartbeat is older than this is not running (its pid may be another program's now)
const LOGIN_CHECK_MS = 5_000;
const CODE_CHECK_MS = TICK || 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const STREAM_SILENCE_MS = 50_000; // the gateway pings every 15 s
const MAX_ENTRIES = 1000;
const MAX_RECENT = 15;
const LOG_BYTES = 1_000_000;
const STATE_MS = 60_000; // the state goes to the gateway at least this often (the numbers of Stats)
// A session's own (its supervisor's, and those of one command of its Bash tool, see utils/shell.js: `claude-pro host
// start` may be run there): not for the service, nor for the sessions it opens.
const SESSION_ONLY = [ENV_SUPERVISED, ENV_RESTART_FILE, ENV_RESTARTED, 'CLAUDE_PRO_CWD_FILE', 'CLAUDE_PRO_PID_FILE', 'CLAUDE_PRO_COMMAND'];

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
export function updateHostState(change) {
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

// This computer's id at the gateway: made once, then kept in host.json. The sessions register with it too
// (computerId), so that the page puts a computer's service and its sessions together.
function hostId() {
  const state = readHostState();
  if (ID.test(state.id || '')) return state.id;
  const id = crypto.randomBytes(9).toString('base64url');
  updateHostState({ id });
  return id;
}

let knownId = null;
export function computerId() {
  if (knownId && knownId.dir === configDir()) return knownId.id;
  knownId = { dir: configDir(), id: hostId() };
  return knownId.id;
}

// The id the gateway gave this computer when it was paired (claude-pro connect), when it is not the one it had.
export function setComputerId(id) {
  if (!ID.test(String(id || ''))) return;
  updateHostState({ id });
  knownId = null;
}

// A background session ended for good (/exit): the service does not open it again (see background.js).
export function markBackgroundEnded(sessionId) { markEnded(configDir(), sessionId); }

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
// What it prints on its own (a crash) goes to its log too.
export function startHostInBackground({ env = process.env } = {}) {
  let fd = 'ignore';
  try {
    fs.mkdirSync(hostFiles().dir, { recursive: true });
    fd = fs.openSync(hostFiles().log, 'a');
  } catch { /* nowhere: ignored */ }
  try {
    const child = spawn(process.execPath, [ENTRY, 'host', 'run', '--background'], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, cwd: os.homedir(), env: serviceEnv(env) });
    child.on('error', () => { /* the next session tries again */ });
    child.unref();
    return child.pid;
  } finally {
    if (typeof fd === 'number') try { fs.closeSync(fd); } catch { /* closed */ }
  }
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
const PASS_ENV = /^(CLAUDE_PRO_|CLAUDE_CODE_)/;
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
// terminal itself. `title`: the tab's first title, where the terminal takes one (Windows Terminal).
export function launchCommand(term, { cwd, node = process.execPath, entry = ENTRY, args = [], env = {}, envFile = null, sessionId = '', title = '' }) {
  const program = [node, ...(envFile ? [`--env-file=${envFile}`] : []), entry, ...args];
  const pairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const posix = [...(pairs.length ? ['env', ...pairs] : []), node, entry, ...args];
  const line = posix.map(shQuote).join(' ');
  switch (term.kind) {
    case 'wt': // a new window; wt reads ; as the start of another command
      return { cmd: term.path, args: ['-w', 'new', ...(title ? ['--title', title] : []), '-d', cwd, ...program].map((a) => a.replace(/;/g, '\\;')), options: { windowsHide: false }, wait: 'exit' };
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
  // `sessions`: the background sessions it runs (see background.js), null when it runs none (the tests).
  constructor({ id, log = () => {}, fetchImpl = globalThis.fetch, background = false, terminal, launch = runLaunch, home = os.homedir(), readLogin, loadConfig: load, sessions = null } = {}) {
    this.id = id;
    this.log = log;
    this.fetch = fetchImpl;
    this.background = background;
    this.sessions = sessions;
    this.stats = new Stats(home);
    this.stateTimer = null;
    this.terminal = terminal === undefined ? terminalFor() : terminal;
    this.launch = launch;
    this.home = home;
    this.loadConfig = load || (() => loadConfig({ cwd: home }));
    this.readLogin = readLogin || (() => {
      const cfg = this.cfg();
      return gatewayLogin(cfg.gatewayUrl, cfg.env.CLAUDE_PRO_GATEWAY_API_KEY);
    });
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

  // What the page shows of this computer now: its background sessions and how busy it is.
  state() {
    return { sessions: this.sessions?.list() || [], stats: this.stats.now() };
  }

  // The state to the gateway: soon after a change of the sessions (several changes in a row go as one), and every
  // minute for the numbers.
  reportState({ soon = true } = {}) {
    if (soon) {
      if (this.stateTimer) return;
      this.stateTimer = setTimeout(() => { this.stateTimer = null; this.reportState({ soon: false }); }, 300);
      this.stateTimer.unref?.();
      return;
    }
    if (!this.registered || !this.login || this.stopped) return;
    this.request('POST', `/v1/remote/hosts/${encodeURIComponent(this.id)}/state`, this.state()).catch((e) => {
      if (e.status === 404) { this.registered = false; this.streamAbort?.abort(); } // forgotten: registered again
    });
  }

  async register() {
    try {
      await this.request('POST', '/v1/remote/hosts', { ...this.info(), autostart: autostartKind(), ...this.state() });
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
    // the background sessions are the account's: gone with the login, back with a login
    if (!this.login) this.sessions?.suspendAll();
    else this.sessions?.resumeAll();
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
      setInterval(() => this.reportState({ soon: false }), STATE_MS),
      setInterval(() => this.stats.sample(), 5000),
    );
    for (const t of this.timers) t.unref?.();
    try { await this.loop(); } finally { for (const t of this.timers) clearInterval(t); clearTimeout(this.stateTimer); }
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
          // removed on the web page, or its key revoked: its background sessions end (kept to be opened again)
          this.note(`这台电脑已从网页上移除 (the gateway refused this computer's key: ${e.message}); waiting for /login or claude-pro connect`);
          this.sessions?.suspendAll();
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
      else if (cmd.type === 'stop') r = await this.needSessions().stop(String(body.sessionId || ''));
      else if (cmd.type === 'restart') r = await this.needSessions().restart(String(body.sessionId || ''));
      else if (cmd.type === 'logs') r = this.logs(body);
      else if (cmd.type === 'history') r = this.history(body);
      else if (cmd.type === 'update') r = await this.update();
      else if (cmd.type === 'window') r = await this.window(body);
      else if (cmd.type === 'delete') r = await this.deleteConversation(body);
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

  // window: a background session brought to the front in a terminal window of this computer, `claude-pro attach` in
  // it (chosen as open's terminal window is). A turn that runs goes on and shows there as it goes; the session stays
  // the service's. Closing the window (its X included: the attach process ends) only detaches it. Each call opens
  // another window. Without a desktop, a tmux session to attach to (`tmux attach -t claude-pro-<id>-…`).
  async window({ sessionId } = {}) {
    if (typeof sessionId !== 'string' || !ID.test(sessionId)) throw new Error('会话 id 不对');
    const rec = this.sessions?.sessions.get(sessionId);
    if (!rec) {
      if (this.sessions?.ended.some((e) => e.sessionId === sessionId)) throw new Error('会话没有在运行');
      throw new Error('这个会话不是这台电脑上的后台会话');
    }
    if (rec.state !== 'running' || !this.sessions.alive(rec)) throw new Error('会话没有在运行');
    const label = rec.name || sessionId;
    const term = this.terminal;
    if (!term) throw new Error(`这台电脑没有可以打开窗口的桌面（可以在终端里运行 claude-pro attach ${label}）`);
    let cwd = rec.cwd;
    try { if (!fs.statSync(cwd).isDirectory()) cwd = this.home; } catch { cwd = this.home; }
    const env = passedEnv();
    const key = `${sessionId}-w${Date.now().toString(36)}`; // its own env file and tmux session: one window more each time
    const envFile = process.platform === 'win32' && term.kind === 'wt' ? writeEnvFile(key, env) : null;
    try {
      await this.launch(launchCommand(term, { cwd, args: ['attach', sessionId, '--keep-open'], env, envFile, sessionId: key, title: `${label} · claude-pro` }));
    } catch (e) {
      throw new Error(`无法用 ${term.name} 打开终端：${e.message}`);
    }
    this.log(`opened ${term.name} attached to the background session ${sessionId} (${label})`);
    return { terminal: term.name };
  }

  // delete: what this computer keeps of a conversation (see history.js), for good. Open in a background session of this
  // service, that session is ended first with `stop` (as the stop command does), else it is refused; open in a terminal,
  // it is refused: a terminal the user works in is not closed for them. {files, bytes}
  async deleteConversation({ conversationId, stop = false } = {}) {
    const id = conversationId;
    if (typeof id !== 'string' || !CONVERSATION_ID.test(id)) throw new Error('对话 id 不对');
    const open = listPeers().filter((p) => p.conversationId === id);
    const ours = (p) => p.kind === 'background' && this.sessions?.sessions.has(p.remoteId);
    const terminal = open.find((p) => !ours(p) && p.kind !== 'background');
    if (terminal) throw new Error(`这段对话正开在终端里的会话 &${terminal.name} 里：请先在那台电脑上结束它（/exit）`);
    const other = open.find((p) => !ours(p));
    if (other) throw new Error(`这段对话正开在会话 &${other.name} 里：先结束它`);
    // the service's own sessions with it: those in the registry, and those starting or restarting
    const running = [...(this.sessions?.sessions.values() || [])].filter((r) => (r.conversationId === id || open.some((p) => p.remoteId === r.sessionId)) && this.sessions.alive(r));
    if (running.length && stop !== true) {
      // the name it has in the registry: its record learns it only at the next tick (see BackgroundSessions.tick)
      const name = open.find((p) => p.remoteId === running[0].sessionId)?.name || running[0].name || running[0].sessionId;
      throw new Error(`这段对话正开在会话 &${name} 里：先结束它`);
    }
    // what the registry says it has open, before its record learns it at the next tick: ended with it, the session's
    // log goes with the conversation
    for (const r of running) r.conversationId = id;
    for (const r of running) await this.sessions.stop(r.sessionId);
    const logs = this.sessions ? this.sessions.forgetConversation(id) : [];
    const r = deleteConversation({ projects: path.join(configDir(), 'projects'), id, extra: logs });
    this.log(`deleted the conversation ${id}: ${r.files} files, ${r.bytes} bytes${running.length ? ` (its session ${running.map((x) => x.sessionId).join(', ')} ended first)` : ''}`);
    return { files: r.files, bytes: r.bytes };
  }

  // The conversations kept on this computer (see history.js), with the session each one is open in.
  history({ query, cwd, limit, before } = {}) {
    if (before != null && Number.isNaN(Date.parse(before))) throw new Error('before 不是时间');
    if (cwd != null && (typeof cwd !== 'string' || !normalizeDir(cwd, { home: this.home }))) throw new Error(`不是绝对路径：${cwd}`);
    const open = new Map(listPeers().filter((p) => p.conversationId && p.remoteId).map((p) => [p.conversationId, p.remoteId]));
    return listConversations({
      projects: path.join(configDir(), 'projects'),
      query: typeof query === 'string' ? query : '',
      cwd: cwd ? normalizeDir(cwd, { home: this.home }) : null,
      limit,
      before,
      open,
    });
  }

  // update: a newer claude-pro from npm now (as /update). An install takes a while: it goes on after the answer,
  // and its result goes to the log. The service and the sessions pick the new version up by themselves.
  async update() {
    const found = await checkForUpdate({ force: true });
    if (found.status === 'dev') return { version: VERSION, message: `这台电脑运行的是源码目录里的 claude-pro ${VERSION}（${INSTALL_DIR}），不从 npm 更新` };
    if (found.status === 'current') return { version: VERSION, message: `已是最新 ${VERSION}` };
    if (found.status === 'installed') return { version: found.version, message: `已安装 ${found.version}，空闲后重启` };
    if (found.status !== 'available') throw new Error(`检查更新失败（${found.status}）`);
    this.updating ??= installUpdate(found.version).then((r) => {
      if (r.status === 'updated' || r.status === 'installed') this.log(`installed claude-pro ${r.version}`);
      else this.log(`could not install claude-pro ${found.version}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
    }, (e) => this.log(`could not install claude-pro ${found.version}: ${e.message}`)).finally(() => { this.updating = null; });
    return { version: found.version, message: `正在安装 ${found.version}，装好后空闲时自动重启` };
  }

  needSessions() {
    if (!this.sessions) throw new Error('这台电脑的 claude-pro 服务不运行后台会话');
    return this.sessions;
  }

  // The end of a log: a background session's, or the service's own. {text}
  logs({ sessionId, lines } = {}) {
    const n = Math.max(1, Math.min(2000, Number(lines) || 200));
    if (sessionId) {
      if (!ID.test(String(sessionId))) throw new Error('会话 id 不对');
      const file = this.needSessions().logFile(sessionId);
      if (!fs.existsSync(file) && !fs.existsSync(`${file}.1`)) throw new Error('这个会话没有日志');
      return { text: tailFile(file, n) };
    }
    return { text: tailFile(hostFiles().log, n) };
  }

  // A new session in `cwd`, online at once as `sessionId` (and named `name`): in the background (no window, see
  // background.js), or with `window` in a terminal window. `resume`: a conversation of this computer, opened again
  // (where it is already open, that session is the answer: {existing: its id at the gateway}). `model`: to start with.
  async open({ sessionId, cwd, create, name, window = true, resume = null, model = null } = {}) {
    if (typeof sessionId !== 'string' || !ID.test(sessionId)) throw new Error('会话 id 不对');
    if (resume != null && (typeof resume !== 'string' || !/^[0-9a-f-]{8,}$/i.test(resume))) throw new Error('对话 id 不对');
    if (model != null && (typeof model !== 'string' || !/^[\w.:/[\]-]{1,100}$/.test(model))) throw new Error('模型名不对');
    if (resume) {
      const open = listPeers().find((p) => p.conversationId === resume);
      if (open?.remoteId) return { existing: open.remoteId };
      if (open) throw new Error(`这段对话已经在这台电脑的会话 &${open.name} 里打开了（它没有连上网关）`);
    }
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
    const label = typeof name === 'string' && name.trim() ? cleanName(name) : '';
    if (window === false) {
      const r = this.needSessions().open({ sessionId, cwd: dir, name: label, resume, model });
      this.log(`opened a background session in ${dir} for ${sessionId}${label ? ` (${label})` : ''}${resume ? `, resuming ${resume}` : ''}`);
      return { pid: r.pid };
    }
    const term = this.terminal;
    if (!term) throw new Error('这台电脑上找不到能打开的终端（Windows Terminal、Terminal.app、x-terminal-emulator、gnome-terminal、konsole、xterm 或 tmux）');
    const args = ['--remote-id', sessionId, ...(label ? ['--name', label] : []), ...(resume ? ['--resume', resume] : []), ...(model ? ['--model', model] : [])];
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

// How busy this computer is, for the page: {cpu (percent, the last minute, all cores), memUsed, memTotal, diskFree,
// diskTotal (bytes; the disk of the home directory), uptime (seconds)}. The CPU is sampled every 5 seconds.
export class Stats {
  constructor(home = os.homedir()) {
    this.home = home;
    this.samples = [];
    this.sample();
  }

  sample() {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    this.samples.push({ at: Date.now(), idle, total });
    while (this.samples.length > 2 && Date.now() - this.samples[1].at >= 60_000) this.samples.shift();
  }

  now() {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const busy = last && first && last.total > first.total ? 1 - (last.idle - first.idle) / (last.total - first.total) : 0;
    let diskFree = null;
    let diskTotal = null;
    try {
      const s = fs.statfsSync(this.home);
      diskFree = s.bavail * s.bsize;
      diskTotal = s.blocks * s.bsize;
    } catch { /* unknown */ }
    return {
      cpu: Math.round(Math.max(0, Math.min(1, busy)) * 1000) / 10,
      memUsed: os.totalmem() - os.freemem(),
      memTotal: os.totalmem(),
      diskFree,
      diskTotal,
      uptime: Math.round(os.uptime()),
    };
  }
}

// `claude-pro host check`: the code of this version loads (the service's, and a session's). A service that runs
// asks this before it hands over to a new version (see runHost).
export async function checkCommand() {
  await import('./background.js');
  await import('./ui/repl.js');
  await import('./main.js');
  process.stdout.write(`claude-pro ${VERSION} loads\n`);
  return 0;
}

// Whether the code now on disk starts: `host check` in a process of its own. null, or what went wrong.
function newVersionFails() {
  const r = spawnSync(process.execPath, [ENTRY, 'host', 'check'], { cwd: os.homedir(), env: serviceEnv(), windowsHide: true, encoding: 'utf8', timeout: 60_000 });
  if (r.status === 0) return null;
  const said = `${r.stderr || ''}${r.stdout || ''}`.trim().split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
  return said || r.error?.message || `exit code ${r.status}`;
}

// `claude-pro host run [--background]`: the service, until it is stopped. Returns the exit code.
//
// When the program's files change (an update, an edit of the source), a background service hands over to the new
// version, carefully: this machine must not lose the web page's control. The new code is checked first (`host
// check`); when it does not load, this one goes on (and says why in the log) until the files change again. When it
// does, the new service is started and this one leaves once it runs; when it does not come up, this one takes over
// again. The background sessions run on through it all (each is a process of its own, taken over by the next one).
export async function runHost({ background = false } = {}) {
  for (const k of SESSION_ONLY) delete process.env[k];
  // its log: host.log (where the web page reads it, see logs), and in the foreground the terminal too
  const toFile = fileLogger();
  const toTerminal = background ? null : consoleLogger();
  const log = (msg) => { toFile(msg); toTerminal?.(msg); };
  if (!takeLock()) {
    (toTerminal || toFile)(`claude-pro host runs already (pid ${readHostState().pid || '?'}): this one stops`);
    return background ? 0 : 1;
  }
  const sessions = new BackgroundSessions({ dir: configDir(), entry: ENTRY, env: serviceEnv(), log });
  let service = null;
  const stop = () => service?.stop();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
  sessions.start();
  for (;;) {
    service = new HostService({ id: hostId(), log, background, sessions });
    sessions.onChange = () => service.reportState();
    log(`claude-pro host ${VERSION} started (pid ${process.pid}${background ? ', in the background' : ''}; terminal: ${service.terminal?.name || 'none found'})`);
    try {
      await service.run();
    } catch (e) {
      log(`the service stopped on an error: ${e.stack || e.message}`);
    }
    if (!service.reloading) break;
    const failure = newVersionFails();
    if (failure) {
      log(`the new version does not start, this one goes on: ${failure}`);
      continue;
    }
    log('the program changed: starting its new version');
    sessions.close();
    releaseLock();
    if (readHostState().pid === process.pid) updateHostState({ pid: undefined, beat: undefined, online: false });
    const pid = startHostInBackground();
    let handedOver = false;
    for (let t = 0; t < 30_000 && !handedOver; t += 500) {
      await sleep(500);
      const s = readHostState();
      handedOver = Boolean(pid && s.pid === pid && hostRunning(s));
    }
    if (handedOver) { log(`the new version runs (pid ${pid}): this one leaves`); return 0; }
    if (!takeLock()) { log('the new version has the lock but did not report yet: this one leaves'); return 0; }
    log(`the new version did not come up (pid ${pid}), this one goes on; see the lines above`);
    sessions.start();
  }
  sessions.close();
  releaseLock();
  if (readHostState().pid === process.pid) updateHostState({ pid: undefined, beat: undefined, online: false });
  log('stopped');
  return 0;
}

// ---------------------------------------------------------------- start, stop, status

async function gatewayRequest(method, route) {
  const cfg = loadConfig({ cwd: os.homedir() });
  const login = gatewayLogin(cfg.gatewayUrl, cfg.env.CLAUDE_PRO_GATEWAY_API_KEY);
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
      const login = gatewayLogin(cfg.gatewayUrl, cfg.env.CLAUDE_PRO_GATEWAY_API_KEY);
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
  const boot = bootAutostartInstalled();
  const lines = [
    `claude-pro host (the web page runs and manages sessions on this computer through it): ${running ? `running, pid ${state.pid}, since ${state.startedAt || '?'}` : state.disabled ? 'stopped (claude-pro host start)' : 'not running (claude-pro host start)'}`,
  ];
  if (running) lines.push(`  gateway: ${state.gateway ? `${state.gateway}${state.account ? ` as ${state.account}` : ''} · ${state.online ? 'online' : 'not connected now'}` : 'not logged in (it waits for /login)'}`);
  if (state.id) lines.push(`  id: ${state.id}${state.machine ? ` · computer: ${state.machine}` : ''}${state.terminal ? ` · opens: ${state.terminal}` : ''}${state.version ? ` · version ${state.version}` : ''}`);
  lines.push(`  log: ${hostFiles().log}`);
  lines.push(`  starts by itself: ${boot ? `at boot, before anyone logs in (${process.platform === 'win32' ? `scheduled task "${bootTaskName()}"` : 'systemd user service, lingering'})` : auto ? `at logon (${auto})` : 'no (claude-pro host install; --at-boot: before anyone logs in)'}${boot || auto ? ' · claude-pro host uninstall stops that' : ''}`);
  console.log(lines.join('\n'));
  return 0;
}

// ---------------------------------------------------------------- starting by itself: at logon, at boot
//
// By default the service starts when the user logs in (Windows: a script in the Startup folder, without a window;
// macOS: a LaunchAgent; Linux: a desktop autostart entry, else a systemd user service). `host install --at-boot`:
// already when the computer starts, before anyone logs in (Windows: a scheduled task "at startup" that runs as the
// user whether logged on or not, S4U: no password kept, no network shares; Linux: the systemd user service with
// lingering; macOS: not without root, so at logon). A session logged in to the gateway, /login and `claude-pro
// connect` set up the start at logon by themselves (ensureAutostart), unless `host uninstall` said no.

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

export const bootTaskName = () => `claude-pro host${suffix()}`;

// How the service starts by itself: 'boot' (before anyone logs in, host install --at-boot), 'logon', or ''.
export function autostartKind() {
  if (bootAutostartInstalled()) return 'boot';
  return installedAutostart() ? 'logon' : '';
}

let bootKnown = { at: 0, value: false };
function bootAutostartInstalled() {
  if (Date.now() - bootKnown.at < 60_000) return bootKnown.value;
  let value = false;
  if (process.platform === 'win32') {
    value = spawnSync('schtasks', ['/Query', '/TN', bootTaskName()], { windowsHide: true, stdio: 'ignore' }).status === 0;
  } else if (process.platform === 'linux') {
    const unit = autostartFiles()[1];
    const linger = spawnSync('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger'], { encoding: 'utf8' });
    value = fs.existsSync(unit) && /Linger=yes/.test(linger.stdout || '');
  }
  bootKnown = { at: Date.now(), value };
  return value;
}

function installedAutostart() {
  return autostartFiles().find((f) => fs.existsSync(f)) || null;
}

// What runs at logon: `claude-pro host start`, with the config directory when it is not the default one.
function startCommandLine(sub = ['host', 'start']) {
  const env = process.env.CLAUDE_PRO_CONFIG_DIR ? { CLAUDE_PRO_CONFIG_DIR: path.resolve(process.env.CLAUDE_PRO_CONFIG_DIR) } : {};
  return { program: [process.execPath, ENTRY, ...sub], env };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The start at logon, set up: {file, note}.
export function installLogonAutostart() {
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
    note = writeSystemdUnit(service);
  }
  bootKnown.at = 0;
  return { file, note };
}

// Linux: the systemd user service (Type=oneshot + RemainAfterExit: the service's process stays in its cgroup).
function writeSystemdUnit(file) {
  const { program, env } = startCommandLine();
  const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `[Unit]\nDescription=claude-pro host: lets the gateway's web page open claude-pro sessions on this computer\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=${program.map(q).join(' ')}\n${Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}\n`).join('')}\n[Install]\nWantedBy=default.target\n`);
  const daemon = spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  const enabled = spawnSync('systemctl', ['--user', 'enable', path.basename(file)], { stdio: 'ignore' });
  return daemon.status === 0 && enabled.status === 0 ? ' (systemd user service)' : ' (systemctl --user did not take it: enable it by hand)';
}

// Windows: the scheduled task that starts the service at boot, as this user, logged on or not (S4U).
export function bootTaskXml({ user = `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}`, home = os.homedir() } = {}) {
  const { program, env } = startCommandLine(['host', 'run', '--background']);
  let command = program[0];
  let args = program.slice(1).map(quoteWindowsArg).join(' ');
  if (Object.keys(env).length) { // a task cannot set variables: cmd does
    command = process.env.ComSpec || 'cmd.exe';
    args = `/d /c "${Object.entries(env).map(([k, v]) => `set "${k}=${v}"&& `).join('')}${program.map(quoteWindowsArg).join(' ')}"`;
  }
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>claude-pro host: lets the gateway's web page use this computer (claude-pro host uninstall removes it)</Description></RegistrationInfo>
  <Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
    <Hidden>true</Hidden>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(command)}</Command><Arguments>${xml(args)}</Arguments><WorkingDirectory>${xml(home)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

// The start at boot, set up: a line saying how. Throws what to do when it cannot be (no administrator rights).
export function installBootAutostart() {
  bootKnown.at = 0;
  if (process.platform === 'win32') {
    const file = path.join(os.tmpdir(), `claude-pro-boot-task-${process.pid}.xml`);
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(bootTaskXml(), 'utf16le')]));
    try {
      const r = spawnSync('schtasks', ['/Create', '/TN', bootTaskName(), '/XML', file, '/F'], { windowsHide: true, encoding: 'latin1' });
      if (r.status !== 0) {
        throw new Error(`Windows did not create the scheduled task (schtasks exit code ${r.status}). It takes an administrator: run \`claude-pro host install --at-boot\` again in a terminal started with "Run as administrator". (Without a password kept, the service cannot use network shares; it does not need them.)`);
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
    return `a scheduled task "${bootTaskName()}" starts it when Windows starts, as ${os.userInfo().username}, logged on or not`;
  }
  if (process.platform === 'linux') {
    const note = writeSystemdUnit(autostartFiles()[1]);
    const user = os.userInfo().username;
    const linger = spawnSync('loginctl', ['enable-linger', user], { stdio: 'ignore' });
    if (linger.status !== 0) throw new Error(`The systemd user service is set up${note}, but lingering is not on, so it starts only once ${user} logs in: run \`sudo loginctl enable-linger ${user}\`.`);
    return `the systemd user service starts it at boot (lingering is on for ${user})`;
  }
  throw new Error('On macOS a program starts before anyone logs in only as a LaunchDaemon, which takes root: claude-pro starts at logon instead (a LaunchAgent). Turn on automatic login in System Settings to have it after a restart.');
}

function removeBootAutostart() {
  bootKnown.at = 0;
  if (process.platform === 'win32') {
    if (spawnSync('schtasks', ['/Query', '/TN', bootTaskName()], { windowsHide: true, stdio: 'ignore' }).status !== 0) return null;
    const r = spawnSync('schtasks', ['/Delete', '/TN', bootTaskName(), '/F'], { windowsHide: true, stdio: 'ignore' });
    return r.status === 0 ? `the scheduled task "${bootTaskName()}"` : `(the scheduled task "${bootTaskName()}" could not be removed: as administrator, schtasks /Delete /TN "${bootTaskName()}" /F)`;
  }
  return null; // Linux: the unit goes with the files below; lingering may serve other services, it stays
}

// For a session logged in to the gateway, /login (`force`) and `claude-pro connect`: the start at logon, set up once,
// unless the user said no (`host uninstall`) or turned the service off (CLAUDE_PRO_HOST=0).
export function ensureAutostart({ force = false, env = process.env } = {}) {
  if (!hostEnabled(env)) return null;
  const state = readHostState();
  if (state.autostartDeclined || (state.autostartAuto && !force)) return null;
  if (installedAutostart() || bootAutostartInstalled()) { updateHostState({ autostartAuto: new Date().toISOString() }); return null; }
  try {
    const r = installLogonAutostart();
    updateHostState({ autostartAuto: new Date().toISOString() });
    return r;
  } catch {
    return null;
  }
}

async function installCommand(args = []) {
  updateHostState({ autostartDeclined: undefined, autostartAuto: new Date().toISOString() });
  if (args.includes('--at-boot')) {
    try {
      console.log(`claude-pro host starts at boot now: ${installBootAutostart()}.`);
    } catch (e) {
      console.log(e.message);
      if (process.platform !== 'darwin') return 1;
    }
  }
  if (!args.includes('--at-boot') || process.platform === 'darwin') {
    const { file, note } = installLogonAutostart();
    console.log(`claude-pro host starts at logon now: ${file}${note}`);
  }
  return startCommand();
}

function uninstallCommand() {
  const removed = [];
  const task = removeBootAutostart();
  if (task) removed.push(task);
  for (const file of autostartFiles()) {
    if (!fs.existsSync(file)) continue;
    if (process.platform === 'darwin') spawnSync('launchctl', ['unload', '-w', file], { stdio: 'ignore' });
    if (file.endsWith('.service')) spawnSync('systemctl', ['--user', 'disable', path.basename(file)], { stdio: 'ignore' });
    fs.rmSync(file, { force: true });
    removed.push(file);
  }
  bootKnown.at = 0;
  updateHostState({ autostartDeclined: true }); // sessions and /login do not set it up again
  console.log(removed.length ? `Removed ${removed.join(', ')}` : 'claude-pro host was not set to start by itself.');
  if (hostRunning()) console.log('It is still running now: `claude-pro host stop` stops it.');
  return 0;
}

const USAGE = `Usage: claude-pro host [run | start | stop | status | install | uninstall]

The computer service: it makes this computer one the gateway's web page (远程控制) runs sessions on. From the
page: new sessions here, in the directory chosen there, in the background without a window (or, when asked, in
a terminal window); bringing a background session to the front in a terminal window here (also while it works;
closing the window sends it back); ending and restarting them; opening a conversation kept here again (history),
or deleting it from this computer; their logs and its own; updating claude-pro. A background session that
crashes is opened again, and after a restart of the computer the service opens again those that ran (the
conversation, not the task that was running). \`claude-pro attach\` shows a background session in a terminal here.

It uses the gateway login of /login or claude-pro connect, and only connects out to the gateway. A session
logged in to the gateway starts it by itself, and /login and connect set it up to start at logon
(CLAUDE_PRO_HOST=0: neither).

  claude-pro host            Run it here, in the foreground (Ctrl+C stops it)
  claude-pro host start      Run it in the background (log: ~/.claude-pro/host.log)
  claude-pro host stop       Stop it and take this computer off the gateway's list (sessions then no longer start it)
  claude-pro host status     Whether it runs, its id, its log
  claude-pro host install    Start it at logon (Windows: a script in the Startup folder; macOS: a LaunchAgent;
                             Linux: a desktop autostart entry, else a systemd user service). /login and
                             claude-pro connect do this by themselves
  claude-pro host install --at-boot
                             Start it when the computer starts, before anyone logs in (Windows: a scheduled
                             task, as administrator; Linux: lingering; macOS: not possible, at logon instead)
  claude-pro host uninstall  Not by itself any more (sessions and /login do not set it up again)
`;

// `claude-pro host ...`: returns the exit code (`run` ends the process itself once the service has stopped).
export async function hostCommand(args = []) {
  const [sub = 'run', ...rest] = args;
  switch (sub) {
    case 'run': process.exit(await runHost({ background: rest.includes('--background') })); break;
    case 'check': return checkCommand();
    case 'start': return startCommand();
    case 'stop': return stopCommand();
    case 'status': return statusCommand();
    case 'install': return installCommand(rest);
    case 'uninstall': return uninstallCommand();
    case 'help': case '-h': case '--help': process.stdout.write(USAGE); return 0;
    default: process.stderr.write(`Unknown host command: ${sub}\n\n${USAGE}`); return 2;
  }
  return 0;
}
