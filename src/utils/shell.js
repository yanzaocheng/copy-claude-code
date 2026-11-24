import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { OutputDecoder } from './encoding.js';

const isWin = process.platform === 'win32';
let shellCache;

// The shell findShell found, or undefined before it was looked for.
export const knownShell = () => shellCache;

// Whether a process with this id runs (EPERM: it does, but is not ours to signal).
export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Locate the shell used by the Bash tool. On Windows we need Git Bash, like Claude Code.
export function findShell(config) {
  if (shellCache) return shellCache;
  const candidates = [];
  if (isWin) {
    if (config?.env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(config.env.CLAUDE_CODE_GIT_BASH_PATH);
    // Where git is on the PATH, looked up here (`where git` in a process of its own took 75 ms of every start):
    // ...\Git\cmd\git.exe or ...\Git\bin\git.exe or ...\Git\mingw64\bin\git.exe
    for (const entry of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      if (!['git.exe', 'git.cmd'].some((name) => fs.existsSync(path.join(entry, name)))) continue;
      let dir = entry;
      for (let i = 0; i < 3; i++) {
        candidates.push(path.join(dir, 'bin', 'bash.exe'));
        dir = path.dirname(dir);
      }
    }
    candidates.push('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe');
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return (shellCache = { path: c, kind: 'bash', name: 'bash (Git Bash)' });
    }
    return (shellCache = { path: process.env.ComSpec || 'cmd.exe', kind: 'cmd', name: 'cmd.exe' });
  }
  const envShell = process.env.SHELL;
  if (envShell && /(bash|zsh)$/.test(envShell) && fs.existsSync(envShell)) {
    return (shellCache = { path: envShell, kind: 'bash', name: path.basename(envShell) });
  }
  for (const c of ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/bin/sh']) {
    if (fs.existsSync(c)) return (shellCache = { path: c, kind: 'bash', name: path.basename(c) });
  }
  return (shellCache = { path: 'sh', kind: 'bash', name: 'sh' });
}

// ---- Process trees on Windows
//
// Git for Windows' bin\bash.exe is only a launcher: the real bash is its child, and what a command
// starts is created through MSYS's fork emulation, which leaves Windows' own parent links broken (a
// `sleep.exe` is not a descendant of the launcher as far as Windows can tell). `taskkill /T` on the
// launcher therefore kills bash and native children such as node, but leaves those processes running.
// MSYS keeps the true parent/child links (`ps -W` prints them), so before killing, the shell's own
// process id (written to a file by the script, see spawnShell) is used to ask MSYS for everything
// under it, and all of it is handed to taskkill together with the launcher.

// Rows of `ps -W`: PID PPID PGID WINPID ... where the first three are MSYS ids and WINPID the
// Windows process id. Header and unparsable lines are skipped.
export function parsePsRows(text) {
  return String(text).split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(line))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], pgid: +m[3], winpid: +m[4] }));
}

// Windows process ids of the MSYS process `rootPid`, everything below it by parent links, and every
// member of its process group (a child whose parent already exited is no longer linked to it).
export function msysTree(rows, rootPid) {
  const root = rows.find((r) => r.pid === rootPid);
  if (!root) {
    // The shell has ended. What it left running in the background stays in its process group, which it led, and has
    // no parent any more (PPID 1): those, and what they started. A group that only has the same number by now is
    // not taken: its leader has a parent.
    const group = rows.filter((r) => r.pgid === rootPid);
    const take = new Set(group.filter((r) => r.ppid === 1).map((r) => r.pid));
    for (let grew = true; grew;) {
      grew = false;
      for (const r of group) if (!take.has(r.pid) && take.has(r.ppid)) { take.add(r.pid); grew = true; }
    }
    return group.filter((r) => take.has(r.pid)).map((r) => r.winpid);
  }
  const children = new Map();
  for (const r of rows) {
    if (!children.has(r.ppid)) children.set(r.ppid, []);
    children.get(r.ppid).push(r);
  }
  const seen = new Set([root.pid]);
  const winpids = new Set([root.winpid]);
  const queue = [root.pid];
  while (queue.length) {
    for (const r of children.get(queue.pop()) || []) {
      if (seen.has(r.pid)) continue;
      seen.add(r.pid);
      winpids.add(r.winpid);
      queue.push(r.pid);
    }
  }
  if (root.pgid > 1) for (const r of rows) if (r.pgid === root.pgid) winpids.add(r.winpid);
  return [...winpids];
}

// How to run npm for the node running this: its npm-cli.js with this node when it sits next to it (a Node install,
// nvm, the portable Node of the install scripts), without a shell; else npm from PATH (npm.cmd needs cmd.exe on
// Windows: one command line, as an argument array with a shell is deprecated, DEP0190). {file, args, shell}
export function npmInvocation(args, { execPath = process.execPath } = {}) {
  const dir = path.dirname(execPath);
  const cli = [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    .find((p) => fs.existsSync(p));
  if (cli) return { file: execPath, args: [cli, ...args], shell: false };
  if (process.platform !== 'win32') return { file: 'npm', args, shell: false };
  const quote = (a) => (/[\s"&|<>^()%!]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
  return { file: ['npm.cmd', ...args].map(quote).join(' '), args: [], shell: true };
}

let psCache;
// Git Bash's ps.exe (`ps -W` lists MSYS's processes with their Windows ids), or null without Git Bash.
export function findPs() {
  if (psCache !== undefined) return psCache;
  psCache = null;
  const shell = findShell(null);
  if (shell.kind === 'bash') {
    const bin = path.dirname(shell.path);
    for (const candidate of [path.join(bin, '..', 'usr', 'bin', 'ps.exe'), path.join(bin, 'ps.exe')]) {
      if (fs.existsSync(candidate)) { psCache = path.resolve(candidate); break; }
    }
  }
  return psCache;
}

// Windows ids of the processes MSYS says are under the shell started by spawnShell (empty when unknown).
// `sync`: with spawnSync (the exit path, which must not leave anything running); else without blocking.
function msysDescendants(child, { sync }) {
  let root, ps;
  try {
    root = parseInt(fs.readFileSync(child.claudeProPidFile, 'utf8'), 10);
    ps = findPs();
  } catch { /* no pid file (yet) */ }
  if (!Number.isFinite(root) || !ps) return sync ? [] : Promise.resolve([]);
  if (sync) {
    try {
      const r = spawnSync(ps, ['-W'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      return r.status === 0 ? msysTree(parsePsRows(r.stdout), root) : [];
    } catch {
      return [];
    }
  }
  return runAsync(ps, ['-W'], { timeout: 5000 }).then((r) => (r.code === 0 ? msysTree(parsePsRows(r.out), root) : []));
}

// The trimmed output of a command that succeeded, or null, as run() gives it, without blocking the event loop. An
// output past maxChars is null too. Never rejects.
export function runText(cmd, args, { cwd, timeout = 5000, maxChars = 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeout);
    const done = (value) => { clearTimeout(timer); resolve(value); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; if (out.length > maxChars) try { child.kill(); } catch { /* gone */ } });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 && out.length <= maxChars ? out.trim() : null));
  });
}

// A command's exit code and output, without blocking the event loop. Never rejects.
function runAsync(cmd, args, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve({ code: null, out }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, out }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// Kill a process and all its children, without blocking the event loop (`ps -W` and taskkill take up to seconds,
// and Ctrl+C, a timeout or KillShell used to freeze the interface for that long). Resolves when done; never
// rejects. The tree has to be looked up before anything is killed: once its parents are gone the links are too.
// `orphans`: also when the process itself has ended, for what it left running (a background shell whose `server &`
// still holds its output open): only the processes found through it then, never its own pid, which may be another
// process's by now. Only for callers that know something of it still runs (a background shell not closed yet).
export async function killTree(child, { orphans = false } = {}) {
  if (!child || child.killed) return;
  const ended = child.exitCode !== null || child.signalCode !== null;
  if (ended && !orphans) return;
  try {
    if (isWin) {
      const pids = new Set([...(ended ? [] : [child.pid]), ...(child.claudeProPidFile ? await msysDescendants(child, { sync: false }) : [])]);
      if (!pids.size) return;
      const args = ['/F', '/T'];
      for (const pid of pids) args.push('/PID', String(pid));
      await runAsync('taskkill', args);
      if (child.claudeProPidFile) fs.rmSync(child.claudeProPidFile, { force: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    if (!ended) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  }
}

// The same, done before it returns: for the exit, after which nothing would be left to finish the kill.
export function killTreeSync(child, { orphans = false } = {}) {
  if (!child || child.killed) return;
  const ended = child.exitCode !== null || child.signalCode !== null;
  if (ended && !orphans) return;
  try {
    if (isWin) {
      const pids = new Set([...(ended ? [] : [child.pid]), ...(child.claudeProPidFile ? msysDescendants(child, { sync: true }) : [])]);
      if (!pids.size) return;
      const args = ['/F', '/T'];
      for (const pid of pids) args.push('/PID', String(pid));
      spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      if (child.claudeProPidFile) fs.rmSync(child.claudeProPidFile, { force: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    if (!ended) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  }
}

// Run a quick command and return stdout (used for git info etc.). Never throws.
// The environment of what the program starts (Bash, REPL, hooks, MCP servers): non-interactive and colour free, and
// without what makes a process a restartable session of this program (a hook that ran `claude-pro -p` was given the
// Restart tool and the prompt about its own source).
export function childEnv() {
  const env = { ...process.env };
  Object.assign(env, { GIT_EDITOR: 'true', GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1', CLAUDE_PRO: '1' });
  delete env.FORCE_COLOR;
  for (const key of ['CLAUDE_PRO_SUPERVISED', 'CLAUDE_PRO_RESTART_FILE', 'CLAUDE_PRO_RESTARTED']) delete env[key];
  return env;
}

export function run(cmd, args, { cwd, timeout = 5000, maxBuffer = 1024 * 1024 } = {}) {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

const rgWorks = new Map();
// The ripgrep binary to use: CLAUDE_PRO_RIPGREP_PATH if it runs, else `rg` on PATH, else the copy VS Code ships
// (Windows), else null (Grep then uses its JS scanner, about 4x slower). CLAUDE_PRO_RIPGREP_PATH=off skips
// ripgrep altogether.
export function ripgrepPath(config) {
  const configured = String(config?.env?.CLAUDE_PRO_RIPGREP_PATH ?? process.env.CLAUDE_PRO_RIPGREP_PATH ?? '').trim();
  if (/^(off|none|false|0)$/i.test(configured)) return null;
  for (const c of [configured, 'rg', ...vscodeRipgreps()].filter(Boolean)) {
    if (!rgWorks.has(c)) rgWorks.set(c, run(c, ['--version']) !== null);
    if (rgWorks.get(c)) return c;
  }
  return null;
}

// rg.exe inside VS Code installs, newest version first. Recent versions keep it under a folder named by a hash
// that changes with every update, so a path set by hand stops working after one.
let vscodeRg;
function vscodeRipgreps() {
  if (vscodeRg) return vscodeRg;
  vscodeRg = [];
  if (!isWin) return vscodeRg;
  const inside = [
    'resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/win32-x64/rg.exe',
    'resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg.exe',
    'resources/app/node_modules/@vscode/ripgrep/bin/rg.exe',
  ];
  const bases = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code'), process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code')].filter(Boolean);
  for (const base of bases) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(base, d.name))
        .map((dir) => ({ dir, t: fs.statSync(dir).mtimeMs })).sort((a, b) => b.t - a.t).map((d) => d.dir);
    } catch { continue; }
    for (const dir of [...dirs, base]) for (const rel of inside) {
      const file = path.join(dir, rel);
      if (fs.existsSync(file)) vscodeRg.push(file);
    }
  }
  return vscodeRg;
}
export function hasRipgrep(config) { return ripgrepPath(config) !== null; }

// `stdin`: text to feed the command on standard input (hooks get their event JSON this way).
// Without it the command's stdin is closed, so nothing can hang waiting for input.
// `out`: a file descriptor for its output (stdout and stderr) instead of pipes: a background shell (shells.js), which
// must not die with this process. `exitFile`: where bash writes the command's exit code when it ends; `pidFile`: where
// it writes its MSYS id on Windows (kept: else a temporary file, removed once the shell closes).
export function spawnShell(shell, command, { cwd, env, stdin, out = null, exitFile = null, pidFile: keptPidFile = null }) {
  const withStdin = typeof stdin === 'string';
  const stdio = [withStdin ? 'pipe' : 'ignore', out ?? 'pipe', out ?? 'pipe'];
  const feed = (child) => {
    if (withStdin) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
    return child;
  };
  if (shell.kind === 'cmd') {
    return feed(spawn(shell.path, ['/d', '/s', '/c', `"${command}"`], {
      cwd, env, windowsHide: true, windowsVerbatimArguments: true, stdio,
    }));
  }
  // The command is evaluated via an env var so no quoting is needed. Each command starts in the session's
  // directory: a `cd` lasts for that command only (the user's choice, 2026-11-21). On Windows the script first
  // writes its own (MSYS) process id to a file, which is how killTree finds everything under it.
  const pidFile = isWin ? keptPidFile || path.join(os.tmpdir(), `claude-pro-pid-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`) : null;
  const script = [
    ...(pidFile ? ['if [ -n "$CLAUDE_PRO_PID_FILE" ]; then echo $$ > "$CLAUDE_PRO_PID_FILE"; fi'] : []),
    // (a trap: the command's own `exit` ends the shell before any line after it)
    ...(exitFile ? ['if [ -n "$CLAUDE_PRO_EXIT_FILE" ]; then trap \'echo $? > "$CLAUDE_PRO_EXIT_FILE"\' EXIT; fi'] : []),
    `eval "$CLAUDE_PRO_COMMAND"${withStdin ? '' : ' < /dev/null'}`,
    '__ccc_status=$?',
    'exit $__ccc_status',
  ].join('\n');
  const child = spawn(shell.path, ['-c', script], {
    cwd,
    env: { ...env, CLAUDE_PRO_COMMAND: command, CLAUDE_PRO_PID_FILE: pidFile || '', CLAUDE_PRO_EXIT_FILE: exitFile || '' },
    windowsHide: true,
    detached: !isWin,
    stdio,
  });
  if (pidFile) {
    child.claudeProPidFile = pidFile;
    if (!keptPidFile) child.once('close', () => { try { fs.rmSync(pidFile, { force: true }); } catch { /* best effort */ } });
  }
  return feed(child);
}

// Collect the output of a shell started with spawnShell and report when it is finished:
// onOutput(text, 'stdout' | 'stderr') for each piece (decoded line by line, UTF-8 or the console code page,
// see OutputDecoder) and done(code, error) exactly once.
//
// A command that leaves a process running (`server &`) keeps the shell's output pipes open after the
// shell itself has exited, and 'close' would not fire until that process ends. Waiting for it would hold
// the caller until its timeout, which then kills the very process the command meant to start. So once the
// shell is gone, done is called as soon as the output has been quiet for idleMs, or after graceMs at the
// latest. The pipes are drained rather than closed, so the process is not killed by a broken pipe.
export function watchShell(child, { onOutput, done, idleMs = 500, graceMs = 3000 }) {
  let finished = false;
  let exited = false;
  let idleTimer = null;
  let graceTimer = null;
  const finish = (code, err) => {
    if (finished) return;
    finished = true;
    clearTimeout(idleTimer);
    clearTimeout(graceTimer);
    done(code, err);
  };
  const settleAfterExit = () => finish(child.exitCode);
  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(settleAfterExit, idleMs); };
  for (const stream of ['stdout', 'stderr']) {
    const decoder = new OutputDecoder();
    const take = (text) => { if (text) onOutput(text, stream); };
    child[stream].on('data', (chunk) => {
      if (finished) return; // late output of a process the command left running is drained, not kept
      take(decoder.write(chunk));
      if (exited) armIdle();
    });
    child[stream].on('end', () => { if (!finished) take(decoder.end()); });
  }
  child.on('error', (e) => finish(null, e));
  child.on('exit', () => {
    exited = true;
    graceTimer = setTimeout(settleAfterExit, graceMs);
    armIdle();
  });
  child.on('close', (code) => finish(code));
}

// Delete the small files shells leave in the temp directory (pid files, working directory files)
// when the program was killed before it could remove them. Best effort, run at startup.
export function pruneStaleShellFiles(dir = os.tmpdir(), maxAgeMs = 7 * 24 * 3600_000) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of names) {
    if (!/^claude-pro-(?:pid|cwd)-/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) { fs.rmSync(file, { force: true }); removed++; }
    } catch { /* ignore */ }
  }
  return removed;
}
