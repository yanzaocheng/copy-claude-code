// Starting programs: node:child_process, with one difference on Windows. There a command given by its name alone
// ("git", "rg", "taskkill", "powershell.exe") is looked for in the working directory before PATH (libuv does as
// CreateProcess does), and a session's working directory is the project: a repository that carries a git.exe would
// have it run by the first message, before anyone trusted the project. So a bare name is resolved here, on PATH
// alone, and started by its full path; one that is not on PATH fails as a missing program does.
//
// Everything in src/ starts programs through this module (the supervisor starts only node itself, by its path).

import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';
const found = new Map();

const envValue = (env, name) => {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
};

// The full path of `command` when it is a bare name, on Windows; anything else as it is. `extensions`: what may be
// started (a program for spawn; cmd.exe also takes scripts, see mcp.js).
export function onPath(command, env = process.env, extensions = ['.com', '.exe']) {
  if (!isWin || typeof command !== 'string' || !command || /[\\/:]/.test(command)) return command;
  const dirs = String(envValue(env, 'PATH') ?? envValue(process.env, 'PATH') ?? '');
  const key = `${command.toLowerCase()}\0${extensions.join()}\0${dirs}`;
  if (found.has(key)) return found.get(key);
  const names = path.extname(command) ? [command] : extensions.map((ext) => command + ext);
  let hit = null;
  for (const entry of dirs.split(';')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !path.isAbsolute(dir)) continue; // ("." and relative entries are the working directory again)
    for (const name of names) {
      const file = path.join(dir, name);
      try { if (fs.statSync(file).isFile()) { hit = file; break; } } catch { /* not here */ }
    }
    if (hit) break;
  }
  // (not on PATH: a path that does not exist, so that it fails instead of being found in the working directory)
  hit ??= path.join(envValue(process.env, 'SystemRoot') || 'C:\\Windows', 'System32', `not-on-path-${command}`);
  if (found.size > 500) found.clear();
  found.set(key, hit);
  return hit;
}

// (args may be left out: spawn(command, options))
const safely = (start) => (command, args, options, ...rest) => {
  const opts = Array.isArray(args) ? options : args;
  const shell = opts && typeof opts === 'object' && opts.shell;
  return start(shell ? command : onPath(command, opts && typeof opts === 'object' ? opts.env : undefined), args, options, ...rest);
};

export const spawn = safely(cp.spawn);
export const spawnSync = safely(cp.spawnSync);
export const execFile = safely(cp.execFile);
export const execFileSync = safely(cp.execFileSync);
