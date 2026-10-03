// Hooks: user-defined shell commands that run around tool calls, in the same shape as
// Claude Code's settings.json:
//   "hooks": { "PreToolUse": [ { "matcher": "Bash|Edit", "hooks": [ { "type": "command", "command": "..." } ] } ],
//              "PostToolUse": [...], "UserPromptSubmit": [...], "Stop": [...] }
// The event payload is passed as JSON in $CCC_HOOK_INPUT (also $CLAUDE_PROJECT_DIR).
// Exit code 0: fine (stdout is kept as extra context). Exit code 2: block, stderr goes to the model.
// Any other non-zero exit code is reported as a warning and ignored.

import { spawnShell, killTree, findShell } from './utils/shell.js';
import { stripAnsi } from './ui/ansi.js';

const DEFAULT_TIMEOUT_MS = 60_000;

function matches(matcher, name) {
  if (!matcher || matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test(name || ''); } catch { return matcher === name; }
}

function runCommand(shell, command, { cwd, payload, timeout, signal }) {
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false;
    let child;
    try {
      child = spawnShell(shell, command, {
        cwd,
        env: { ...process.env, CCC_HOOK_INPUT: JSON.stringify(payload), CLAUDE_PROJECT_DIR: cwd, CCC: '1' },
      });
    } catch (e) {
      resolve({ code: 1, out: '', err: e.message });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const done = (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: timedOut ? 1 : code, out: stripAnsi(out).trim(), err: stripAnsi(err + (timedOut ? `\nhook timed out after ${timeout}ms` : '')).trim() });
    };
    child.on('error', (e) => { err += e.message; done(1); });
    child.on('close', done);
  });
}

export class HookRunner {
  constructor(config) {
    this.config = config;
    this.shell = null;
  }

  has(event) { return (this.config.settings.hooks?.[event] || []).length > 0; }

  // Returns {blocked, message, context: string[], warnings: string[]}.
  async run(event, payload, { cwd, signal } = {}) {
    const result = { blocked: false, message: '', context: [], warnings: [] };
    const entries = this.config.settings.hooks?.[event] || [];
    if (!entries.length) return result;
    this.shell ||= findShell(this.config);
    const full = { hook_event_name: event, cwd, ...payload };
    for (const entry of entries) {
      if (!matches(entry.matcher, payload.tool_name)) continue;
      for (const h of entry.hooks || []) {
        if (h.type && h.type !== 'command') continue;
        if (!h.command) continue;
        const r = await runCommand(this.shell, h.command, { cwd, payload: full, timeout: h.timeout ? h.timeout * 1000 : DEFAULT_TIMEOUT_MS, signal });
        if (r.code === 2) {
          result.blocked = true;
          result.message = r.err || r.out || `Blocked by ${event} hook: ${h.command}`;
          return result;
        }
        if (r.code !== 0) result.warnings.push(`${event} hook "${h.command}" exited with ${r.code}${r.err ? `: ${r.err.split('\n')[0]}` : ''}`);
        else if (r.out) result.context.push(r.out);
      }
    }
    return result;
  }
}
