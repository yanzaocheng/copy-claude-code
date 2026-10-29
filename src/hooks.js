// Hooks: user-defined shell commands that run around tool calls, in the same shape as
// Claude Code's settings.json:
//   "hooks": { "PreToolUse": [ { "matcher": "Bash|Edit", "hooks": [ { "type": "command", "command": "..." } ] } ],
//              "PostToolUse": [...], "UserPromptSubmit": [...], "Stop": [...] }
// The event payload is passed as JSON on stdin (like Claude Code) and in $CLAUDE_PRO_HOOK_INPUT; $CLAUDE_PROJECT_DIR is set too.
// Exit code 0: fine (stdout is kept as extra context). Exit code 2: block, stderr goes to the model.
// Any other non-zero exit code, a hook that cannot start and one that times out are reported as a warning and
// let through, unless the hook says "onFailure": "block" (as in Claude Code): then they block like exit code 2.
// <system-reminder> tags in a hook's output are escaped, so that it cannot pass itself off as the harness.

import { childEnv, spawnShell, killTree, findShell, watchShell } from './utils/shell.js';
import { stripAnsi } from './ui/ansi.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export const escapeReminders = (text) => String(text).replace(/<(\/?\s*system-reminder)/gi, '&lt;$1');

function matches(matcher, name) {
  if (!matcher || matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test(name || ''); } catch { return matcher === name; }
}

function runCommand(shell, command, { cwd, payload, timeout, signal }) {
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false;
    let child;
    try {
      const json = JSON.stringify(payload);
      child = spawnShell(shell, command, {
        cwd,
        env: { ...childEnv(), CLAUDE_PRO_HOOK_INPUT: json, CLAUDE_PROJECT_DIR: cwd },
        stdin: json,
      });
    } catch (e) {
      resolve({ code: 1, out: '', err: e.message });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    watchShell(child, {
      onOutput: (text, stream) => { if (stream === 'stderr') err += text; else out += text; },
      done: (code, error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) err += error.message;
        resolve({ code: timedOut || error ? 1 : code, out: stripAnsi(out).trim(), err: stripAnsi(err + (timedOut ? `\nhook timed out after ${timeout}ms` : '')).trim() });
      },
    });
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
          result.message = escapeReminders(r.err || r.out || `Blocked by ${event} hook: ${h.command}`);
          return result;
        }
        if (r.code !== 0) {
          const failure = `${event} hook "${h.command}" exited with ${r.code}${r.err ? `: ${r.err.split('\n')[0]}` : ''}`;
          if (h.onFailure === 'block' && !signal?.aborted) {
            result.blocked = true;
            result.message = escapeReminders(`${failure}\n(The hook failed and is set to block on failure.)`);
            return result;
          }
          result.warnings.push(failure);
        } else if (r.out) result.context.push(escapeReminders(r.out));
      }
    }
    return result;
  }
}
