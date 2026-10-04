// Bash tool plus background shell management (BashOutput / KillShell).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findShell, killTree, spawnShell } from '../utils/shell.js';
import { stripAnsi } from '../ui/ansi.js';
import { toolResultsDir } from '../session.js';

const background = new Map(); // id -> {child, command, output, readPos, status, exitCode, startedAt}
let bgCounter = 0;

function truncateOutput(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.4));
  const tail = text.slice(-Math.floor(max * 0.6));
  const dropped = text.slice(head.length, text.length - tail.length).split('\n').length;
  return `${head}\n\n... [${dropped} lines truncated] ...\n\n${tail}`;
}

// Keep the full text of truncated output so the model can still get at it.
function saveFullOutput(root, text) {
  try {
    const dir = toolResultsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(file, text);
    return file;
  } catch {
    return null;
  }
}

function childEnv() {
  const env = { ...process.env };
  // Keep child processes non-interactive and colour free.
  Object.assign(env, { GIT_EDITOR: 'true', GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1', CCC: '1' });
  delete env.FORCE_COLOR;
  return env;
}

export function shutdownBackgroundShells() {
  for (const bg of background.values()) if (bg.status === 'running') killTree(bg.child);
}

export function listBackgroundShells() {
  return [...background.entries()].map(([id, bg]) => ({ id, command: bg.command, status: bg.status, exitCode: bg.exitCode }));
}

export function makeBashTool(config) {
  const shell = findShell(config);
  const isCmd = shell.kind === 'cmd';
  return {
    name: 'Bash',
    description: `Executes a given ${isCmd ? 'cmd.exe' : 'bash'} command with an optional timeout. The working directory persists between commands; shell state (variables, functions) does not.

IMPORTANT: This tool is for terminal operations like git, npm, docker, running builds and tests. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

Before executing the command:
1. If the command will create new directories or files, first verify the parent directory exists (e.g. with ls).
2. Always quote file paths that contain spaces with double quotes.

Usage notes:
- The command argument is required.
- You can specify an optional timeout in milliseconds (up to ${config.bashMaxTimeout}ms / ${config.bashMaxTimeout / 60000} minutes). Default is ${config.bashDefaultTimeout}ms.
- Write a clear, concise description of what the command does in 5-10 words.
- If the output exceeds ${config.bashMaxOutput} characters, output will be truncated before being returned to you.
- You can use the \`run_in_background\` parameter to run the command in the background (dev servers, watchers, long builds). Use BashOutput to read its output later and KillShell to stop it. Never use \`&\` at the end of the command for this.
- Commands run non-interactively with stdin closed; never run commands that wait for input (use flags like --yes, and avoid interactive editors, \`git rebase -i\`, \`git add -i\`).
- Avoid using search/read commands like \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` for file work; use Glob, Grep, Read, Edit and Write instead.
- When issuing multiple commands: if they are independent, make multiple Bash tool calls in parallel in a single message; if they depend on each other, chain them with '&&'.
- Try to maintain your current working directory by using absolute paths and avoiding \`cd\`.${os.platform() === 'win32' && !isCmd ? '\n- This is Git Bash on Windows: use Unix syntax (forward slashes, /dev/null, $VAR). Windows paths like C:/Users/... also work.' : ''}

# Committing changes with git
Only create commits when requested by the user. When asked to commit: run git status, git diff and git log in parallel to understand the change and the repo's message style; stage only relevant files (never secrets such as .env); write a concise message focused on the "why"; pass the message via a HEREDOC. Never update git config, never force push, never skip hooks (--no-verify) and never amend unless explicitly asked. Do not push unless asked.`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'number', description: `Optional timeout in milliseconds (max ${config.bashMaxTimeout})` },
        description: { type: 'string', description: 'Clear, concise description of what this command does in 5-10 words, in active voice.' },
        run_in_background: { type: 'boolean', description: 'Set to true to run this command in the background. Use BashOutput to read the output later.' },
      },
      required: ['command'],
    },
    summarize(input) { return input.command || ''; },
    async call(input, ctx) {
      const command = String(input.command || '').trim();
      if (!command) return { isError: true, content: 'Empty command' };
      const cwdFile = path.join(os.tmpdir(), `ccc-cwd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      let cwd = ctx.cwd;
      if (!fs.existsSync(cwd)) cwd = ctx.projectRoot;

      if (input.run_in_background) {
        const child = spawnShell(shell, command, { cwd, env: childEnv() });
        const id = `bash_${++bgCounter}`;
        const bg = { child, command, output: '', readPos: 0, status: 'running', exitCode: null, startedAt: Date.now() };
        background.set(id, bg);
        const onData = (d) => { bg.output += stripAnsi(d.toString()); if (bg.output.length > 5_000_000) bg.output = bg.output.slice(-2_000_000); };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('close', (code) => { bg.status = bg.status === 'killed' ? 'killed' : 'completed'; bg.exitCode = code; });
        child.on('error', (e) => { bg.status = 'failed'; bg.output += `\n${e.message}`; });
        return { content: `Command running in background with ID: ${id}`, display: { summary: `Running in background (${id})` } };
      }

      const timeout = Math.min(Math.max(1000, input.timeout || config.bashDefaultTimeout), config.bashMaxTimeout);
      return await new Promise((resolve, reject) => {
        let output = '';
        let timedOut = false;
        let settled = false;
        let child;
        try {
          child = spawnShell(shell, command, { cwd, env: childEnv(), cwdFile });
        } catch (e) {
          resolve({ isError: true, content: `Failed to start shell: ${e.message}` });
          return;
        }
        const onData = (d) => {
          output += d.toString();
          if (output.length > 10_000_000) output = output.slice(-5_000_000);
          ctx.onProgress?.(stripAnsi(output));
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
        const onAbort = () => killTree(child);
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        const finish = (code, err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
          try {
            const newCwd = fs.readFileSync(cwdFile, 'utf8').trim();
            if (newCwd && fs.existsSync(newCwd)) ctx.setCwd(path.resolve(newCwd));
          } catch { /* command may have exited early */ }
          fs.rm(cwdFile, { force: true }, () => {});
          if (ctx.signal?.aborted) {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError', partialOutput: output }));
            return;
          }
          let text = stripAnsi(output).replace(/\r\n/g, '\n').replace(/\s+$/, '');
          if (text.length > config.bashMaxOutput) {
            const saved = saveFullOutput(ctx.projectRoot, text);
            const size = text.length;
            text = truncateOutput(text, config.bashMaxOutput);
            if (saved) text += `\n\n(Output was ${size} characters and has been truncated. The full output is saved at ${saved}; use Read with offset/limit or Grep on that file to see the rest.)`;
          }
          if (err) text += `${text ? '\n' : ''}${err.message}`;
          if (timedOut) text += `${text ? '\n' : ''}Command timed out after ${timeout}ms`;
          const isError = timedOut || !!err || (code !== 0 && code !== null);
          if (code && code !== 0 && !timedOut) text += `${text ? '\n' : ''}Exit code ${code}`;
          resolve({ isError, content: text || '(no output)', display: { output: text, exitCode: code } });
        };
        child.on('error', (e) => finish(null, e));
        child.on('close', (code) => finish(code));
      });
    },
  };
}

export const BashOutputTool = {
  name: 'BashOutput',
  readOnly: true,
  description: `Retrieves output from a running or completed background bash shell.
- Takes a bash_id parameter identifying the shell
- Always returns only new output since the last check, along with the shell status
- Supports optional regex filtering to show only lines matching a pattern`,
  input_schema: {
    type: 'object',
    properties: {
      bash_id: { type: 'string', description: 'The ID of the background shell to retrieve output from' },
      filter: { type: 'string', description: 'Optional regular expression to filter the output lines' },
    },
    required: ['bash_id'],
  },
  summarize(input) { return input.bash_id; },
  async call(input) {
    const bg = background.get(input.bash_id);
    if (!bg) return { isError: true, content: `No background shell with id ${input.bash_id}. Known: ${[...background.keys()].join(', ') || 'none'}` };
    let fresh = bg.output.slice(bg.readPos);
    bg.readPos = bg.output.length;
    if (input.filter) {
      try {
        const re = new RegExp(input.filter);
        fresh = fresh.split('\n').filter((l) => re.test(l)).join('\n');
      } catch (e) { return { isError: true, content: `Invalid filter regex: ${e.message}` }; }
    }
    fresh = truncateOutput(fresh.replace(/\r\n/g, '\n'), 30_000);
    const status = `<status>${bg.status}</status>${bg.exitCode !== null ? `\n<exit_code>${bg.exitCode}</exit_code>` : ''}`;
    return { content: `${status}\n<output>\n${fresh || '(no new output)'}\n</output>`, display: { summary: `${bg.status}${fresh ? `, ${fresh.split('\n').length} new lines` : ', no new output'}` } };
  },
};

export const KillShellTool = {
  name: 'KillShell',
  description: 'Kills a running background bash shell by its ID.',
  input_schema: {
    type: 'object',
    properties: { shell_id: { type: 'string', description: 'The ID of the background shell to kill' } },
    required: ['shell_id'],
  },
  summarize(input) { return input.shell_id; },
  async call(input) {
    const bg = background.get(input.shell_id);
    if (!bg) return { isError: true, content: `No background shell with id ${input.shell_id}` };
    if (bg.status !== 'running') return { content: `Shell ${input.shell_id} is not running (status: ${bg.status})` };
    bg.status = 'killed';
    killTree(bg.child);
    return { content: `Successfully killed shell: ${input.shell_id} (${bg.command})` };
  },
};
