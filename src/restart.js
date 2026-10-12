// The program's side of restarting itself (the supervisor's is supervisor.js): what is handed from one
// process to the next, the check that the new code starts before it is trusted, and the watch on the
// source files.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { INSTALL_DIR } from './config.js';
import { ENV_SUPERVISED, ENV_RESTART_FILE, ENV_RESTARTED, RESTART_EXIT_CODE } from './supervisor.js';

export { RESTART_EXIT_CODE };

export const MAX_RESTARTS = 5; // more than this many within RESTART_WINDOW_MS is a loop, not a workflow
export const RESTART_WINDOW_MS = 5 * 60_000;

// True in a session that runs under the supervisor, so that it can restart.
export function canRestart(env = process.env) {
  return env[ENV_SUPERVISED] === '1' && Boolean(env[ENV_RESTART_FILE]);
}

// Leave what the next process needs, where the supervisor said. Throws when it cannot be written, so
// that a restart that would lose the conversation does not happen.
export function writeRestartState(state, env = process.env) {
  const file = env[ENV_RESTART_FILE];
  if (!file) throw new Error('not running under the supervisor');
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}

// In a process that was started by a restart: what the previous one left (once). {} when there is nothing
// readable, which still tells the caller that this is a restart, not a fresh start. null otherwise.
export function takeRestartState(env = process.env) {
  if (env[ENV_RESTARTED] !== '1') return null;
  const file = env[ENV_RESTART_FILE];
  if (!file) return {};
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch {
    return {};
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
}

const tidy = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').replace(/\n+Node\.js v[\d.]+\s*$/, '').trim().slice(0, 4000);

// Start the program's own code in a throwaway process (`claude-pro --self-check`: every module loads, the
// interface comes up in a fake terminal, the tools and the system prompt are well formed) and say whether
// it worked. Resolves {ok, output, ms}; never rejects.
export function runSelfCheck({ root = INSTALL_DIR, signal, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const began = Date.now();
    const env = { ...process.env, CLAUDE_PRO_SELF_CHECK: '1' };
    for (const key of [ENV_SUPERVISED, ENV_RESTART_FILE, ENV_RESTARTED]) delete env[key];
    let output = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(process.execPath, [path.join(root, 'bin', 'claude-pro.js'), '--self-check'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, output: e.message, ms: 0 });
      return;
    }
    const add = (chunk) => { if (output.length < 40_000) output += chunk; };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const kill = () => { try { child.kill(); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    const done = (ok, text) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({ ok, output: text, ms: Date.now() - began });
    };
    child.on('error', (e) => done(false, e.message));
    child.on('close', (code) => {
      if (timedOut) return done(false, `The check did not finish within ${Math.round(timeoutMs / 1000)} seconds.\n${tidy(output)}`.trim());
      if (signal?.aborted) return done(false, 'The check was cancelled.');
      done(code === 0, tidy(output));
    });
  });
}

// Watch the program's own source (src/ and bin/) and call `onChange(file)` once the files have stopped
// changing for a moment. Returns {close()}. A platform that cannot watch just never calls back.
// Only a change of content counts: Windows also reports a file whose last access time was updated, which
// reading it does (at most once an hour: another window starting, npm packing it, a search).
export function watchSource(root, onChange) {
  const watchers = [];
  let timer = null;
  const SOURCE = /\.(m?js|json)$/i;
  const digest = (file) => { try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('base64'); } catch { return null; } };
  const known = new Map(); // file -> digest of its content when last seen (null: not there)
  for (const dir of ['src', 'bin']) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir), { recursive: true }); } catch { /* not there */ }
    for (const name of names) if (SOURCE.test(name)) known.set(path.join(root, dir, name), digest(path.join(root, dir, name)));
  }
  const hit = (dir) => (_event, name) => {
    if (name && !SOURCE.test(String(name))) return;
    if (name) {
      const file = path.join(root, dir, String(name));
      const now = digest(file);
      if (now === (known.get(file) ?? null)) return;
      known.set(file, now);
    }
    clearTimeout(timer);
    timer = setTimeout(() => { try { onChange(String(name || '')); } catch { /* the callback's problem */ } }, 400);
    timer.unref?.();
  };
  for (const dir of ['src', 'bin']) {
    try {
      const watcher = fs.watch(path.join(root, dir), { recursive: true, persistent: false }, hit(dir));
      watcher.on('error', () => { /* a directory that vanished, a watch limit: not worth a crash */ });
      watchers.push(watcher);
    } catch { /* not supported here */ }
  }
  return {
    close() {
      clearTimeout(timer);
      for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
    },
  };
}

// What the model is told when the conversation continues in the new process. It starts with "[" so that it
// is never taken for what the session is about (see firstUserText).
export function restartNote({ reason = '', then = '' } = {}) {
  const why = reason ? ` (${reason})` : '';
  return `[claude-pro restarted${why}. The new code is loaded and the conversation was resumed from the saved session. ${then ? `Continue with: ${then}` : 'Carry on where you left off.'}]`;
}
