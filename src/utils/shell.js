import fs from 'node:fs';
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

// Kill a process and all its children.
export function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (isWin) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
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

let rgCache;
export function hasRipgrep() {
  if (rgCache !== undefined) return rgCache;
  rgCache = run('rg', ['--version']) !== null;
  return rgCache;
}

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
  // record the final working directory so `cd` persists between calls.
  const script = [
    `eval "$CLAUDE_PRO_COMMAND"${withStdin ? '' : ' < /dev/null'}`,
    '__ccc_status=$?',
    'if [ -n "$CLAUDE_PRO_CWD_FILE" ]; then { pwd -W 2>/dev/null || pwd -P; } > "$CLAUDE_PRO_CWD_FILE" 2>/dev/null; fi',
    'exit $__ccc_status',
  ].join('\n');
  return feed(spawn(shell.path, ['-c', script], {
    cwd,
    env: { ...env, CLAUDE_PRO_COMMAND: command, CLAUDE_PRO_CWD_FILE: cwdFile || '' },
    windowsHide: true,
    detached: !isWin,
    stdio,
  }));
}
