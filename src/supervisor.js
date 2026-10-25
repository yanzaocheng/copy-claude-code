// A thin supervisor for interactive sessions, so that the program can restart itself and pick up changes
// to its own source code without the user quitting and starting it again.
//
// bin/claude-pro.js runs an interactive session as a child process of the supervisor, on the same terminal.
// A session that wants fresh code writes what has to survive into the file named by CLAUDE_PRO_RESTART_FILE
// (see restart.js) and exits with RESTART_EXIT_CODE; the supervisor starts the program again, which reads
// that file and carries on with the same conversation. Any other exit ends the session as it would have
// without a supervisor.
//
// This file uses nothing but Node's built-in modules and stays loaded for the whole session, so a broken
// source file can never take it down. (A change to this file or to bin/claude-pro.js is only picked up by
// the next real start, because the running supervisor is the old code.)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import tty from 'node:tty';

export const RESTART_EXIT_CODE = 75; // EX_TEMPFAIL: the usual "start me again"
export const ENV_SUPERVISED = 'CLAUDE_PRO_SUPERVISED'; // set in the child: it runs under a supervisor
export const ENV_RESTART_FILE = 'CLAUDE_PRO_RESTART_FILE'; // where a restart request is left for the next child
export const ENV_RESTARTED = 'CLAUDE_PRO_RESTARTED'; // set in a child that was started by a restart

const NOT_INTERACTIVE = new Set(['-p', '--print', '-h', '--help', '-v', '--version', '--self-check']);
const QUICK_CRASH_MS = 15_000;

// How the session is started. VS Code (1.140 and later, terminal.integrated.tabs.allowAgentCliTitle) shows
// the title a program sets (see Screen.setTitle) as the tab label only for the AI command lines it
// recognises; any other program's tab just says "node". On Windows it recognises them by the command line
// of node.exe, where a `\claude-code\` path segment means Claude Code. Starting the session through such a
// path gets this program the same treatment. The directory does not have to exist: Node resolves `..` in
// the path of the main script by itself, before looking at the file.
export function sessionEntry(entry, platform = process.platform) {
  if (platform !== 'win32') return entry;
  const sep = path.win32.sep;
  return `${path.win32.dirname(entry)}${sep}claude-code${sep}..${sep}${path.win32.basename(entry)}`;
}

// Whether this invocation is an interactive session that should run under the supervisor.
export function shouldSupervise(argv, env = process.env, isTty = (fd) => tty.isatty(fd)) {
  if (env[ENV_SUPERVISED] || /^(1|true|yes)$/i.test(env.CLAUDE_PRO_NO_SUPERVISOR || '')) return false;
  if (['config', 'host', 'attach', 'connect'].includes(argv[0])) return false; // a command, or a removed one (see main.js)
  if (!isTty(0) || !isTty(1)) return false;
  return !argv.some((a) => NOT_INTERACTIVE.has(a));
}

function putTerminalRight() {
  // The child may have died with the terminal in the mode it had set for itself.
  // (the fullscreen renderer's alternate screen and mouse reporting included)
  if (!tty.isatty(1)) return;
  try { process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1049l\x1b[?2004l\x1b[?25h'); } catch { /* nothing to do */ }
  try { if (tty.isatty(0)) process.stdin.setRawMode(false); } catch { /* nothing to do */ }
}

// Run `entry` (the program's own bin script) with `argv` until it ends without asking for a restart.
// Resolves with the exit code to end the process with.
export function supervise(argv, { entry, env = process.env, execPath = process.execPath, err = process.stderr } = {}) {
  return new Promise((resolve) => {
    const stateFile = path.join(os.tmpdir(), `claude-pro-restart-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
    let child = null;
    let stopping = false;
    let restarted = false;
    let finished = false;

    const stop = (signal) => { stopping = true; try { child?.kill(signal); } catch { /* already gone */ } };
    const handlers = {
      SIGINT: () => { /* the terminal sends it to the child too, which decides what it means */ },
      SIGTERM: () => stop('SIGTERM'),
      SIGHUP: () => stop('SIGHUP'),
    };
    for (const [signal, fn] of Object.entries(handlers)) { try { process.on(signal, fn); } catch { /* not on this platform */ } }

    const finish = (code, { abnormal = false } = {}) => {
      if (finished) return;
      finished = true;
      for (const [signal, fn] of Object.entries(handlers)) { try { process.off(signal, fn); } catch { /* ignore */ } }
      try { fs.rmSync(stateFile, { force: true }); } catch { /* ignore */ }
      if (abnormal) putTerminalRight();
      resolve(code);
    };

    const start = () => {
      const childEnv = { ...env, [ENV_SUPERVISED]: '1', [ENV_RESTART_FILE]: stateFile };
      if (restarted) childEnv[ENV_RESTARTED] = '1'; else delete childEnv[ENV_RESTARTED];
      const startedAt = Date.now();
      child = spawn(execPath, [sessionEntry(entry), ...argv], { stdio: 'inherit', env: childEnv });
      child.on('error', (e) => {
        child = null;
        err.write(`claude-pro: could not start (${e.message})\n`);
        finish(1, { abnormal: true });
      });
      child.on('exit', (code, signal) => {
        child = null;
        if (finished) return;
        if (code === RESTART_EXIT_CODE && !stopping) {
          restarted = true;
          start();
          return;
        }
        const exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1);
        const quick = restarted && exitCode !== 0 && Date.now() - startedAt < QUICK_CRASH_MS;
        if (quick) {
          err.write(`\nclaude-pro stopped (exit code ${exitCode}) right after restarting. The code that was just loaded may be broken: fix it and start claude-pro again. The conversation is saved; \`claude-pro --continue\` resumes it.\n`);
        }
        finish(exitCode, { abnormal: exitCode !== 0 });
      });
    };
    start();
  });
}
