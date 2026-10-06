import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';
let shellCache;

// Locate the shell used by the Bash tool. On Windows we need Git Bash, like Claude Code.
export function findShell(config) {
  if (shellCache) return shellCache;
  const candidates = [];
  if (isWin) {
    if (config?.env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(config.env.CLAUDE_CODE_GIT_BASH_PATH);
    try {
      const where = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
      for (const line of (where.stdout || '').split(/\r?\n/).filter(Boolean)) {
        // ...\Git\cmd\git.exe or ...\Git\bin\git.exe or ...\Git\mingw64\bin\git.exe
        let dir = path.dirname(line.trim());
        for (let i = 0; i < 3; i++) {
          candidates.push(path.join(dir, 'bin', 'bash.exe'));
          dir = path.dirname(dir);
        }
      }
    } catch { /* ignore */ }
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
  if (!root) return [];
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

let psCache;
function findPs() {
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
function msysDescendants(child) {
  try {
    const root = parseInt(fs.readFileSync(child.claudeProPidFile, 'utf8'), 10);
    const ps = findPs();
    if (!Number.isFinite(root) || !ps) return [];
    const r = spawnSync(ps, ['-W'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return r.status === 0 ? msysTree(parsePsRows(r.stdout), root) : [];
  } catch {
    return [];
  }
}

// Kill a process and all its children.
export function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (isWin) {
      // The tree has to be looked up before anything is killed: once its parents are gone the links are too.
      const pids = new Set([child.pid, ...(child.claudeProPidFile ? msysDescendants(child) : [])]);
      const args = ['/F', '/T'];
      for (const pid of pids) args.push('/PID', String(pid));
      spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      if (child.claudeProPidFile) fs.rmSync(child.claudeProPidFile, { force: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

// Run a quick command and return stdout (used for git info etc.). Never throws.
export function run(cmd, args, { cwd, timeout = 5000 } = {}) {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

const rgWorks = new Map();
// The ripgrep binary to use: CLAUDE_PRO_RIPGREP_PATH if it runs, else `rg` on PATH, else null
// (Grep then uses its JS scanner). CLAUDE_PRO_RIPGREP_PATH=off skips ripgrep altogether.
export function ripgrepPath(config) {
  const configured = String(config?.env?.CLAUDE_PRO_RIPGREP_PATH ?? process.env.CLAUDE_PRO_RIPGREP_PATH ?? '').trim();
  if (/^(off|none|false|0)$/i.test(configured)) return null;
  for (const c of [configured, 'rg'].filter(Boolean)) {
    if (!rgWorks.has(c)) rgWorks.set(c, run(c, ['--version']) !== null);
    if (rgWorks.get(c)) return c;
  }
  return null;
}
export function hasRipgrep(config) { return ripgrepPath(config) !== null; }

// `stdin`: text to feed the command on standard input (hooks get their event JSON this way).
// Without it the command's stdin is closed, so nothing can hang waiting for input.
export function spawnShell(shell, command, { cwd, env, cwdFile, stdin }) {
  const withStdin = typeof stdin === 'string';
  const stdio = [withStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'];
  const feed = (child) => {
    if (withStdin) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
    return child;
  };
  if (shell.kind === 'cmd') {
    return feed(spawn(shell.path, ['/d', '/s', '/c', `"${command}"`], {
      cwd, env, windowsHide: true, windowsVerbatimArguments: true, stdio,
    }));
  }
  // The command is evaluated via an env var so no quoting is needed; afterwards we
  // record the final working directory so `cd` persists between calls. On Windows the script first
  // writes its own (MSYS) process id to a file, which is how killTree finds everything under it.
  const pidFile = isWin ? path.join(os.tmpdir(), `claude-pro-pid-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`) : null;
  const script = [
    ...(pidFile ? ['if [ -n "$CLAUDE_PRO_PID_FILE" ]; then echo $$ > "$CLAUDE_PRO_PID_FILE"; fi'] : []),
    `eval "$CLAUDE_PRO_COMMAND"${withStdin ? '' : ' < /dev/null'}`,
    '__ccc_status=$?',
    'if [ -n "$CLAUDE_PRO_CWD_FILE" ]; then { pwd -W 2>/dev/null || pwd -P; } > "$CLAUDE_PRO_CWD_FILE" 2>/dev/null; fi',
    'exit $__ccc_status',
  ].join('\n');
  const child = spawn(shell.path, ['-c', script], {
    cwd,
    env: { ...env, CLAUDE_PRO_COMMAND: command, CLAUDE_PRO_CWD_FILE: cwdFile || '', CLAUDE_PRO_PID_FILE: pidFile || '' },
    windowsHide: true,
    detached: !isWin,
    stdio,
  });
  if (pidFile) {
    child.claudeProPidFile = pidFile;
    child.once('close', () => { try { fs.rmSync(pidFile, { force: true }); } catch { /* best effort */ } });
  }
  return feed(child);
}

// Collect the output of a shell started with spawnShell and report when it is finished:
// onOutput(text, 'stdout' | 'stderr') for each piece (decoded as a stream, so a multi-byte character
// split between two chunks survives) and done(code, error) exactly once.
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
    child[stream].setEncoding('utf8');
    child[stream].on('data', (text) => {
      if (finished) return; // late output of a process the command left running is drained, not kept
      onOutput(text, stream);
      if (exited) armIdle();
    });
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
