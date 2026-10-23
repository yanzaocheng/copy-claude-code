import path from 'node:path';
import os from 'node:os';

const isWin = process.platform === 'win32';

// Resolve a path the model gave us. Accepts absolute, relative (to cwd), ~, and on Windows
// also Git-Bash style paths such as /d/foo/bar or /c/Users/...
export function resolvePath(p, cwd) {
  if (!p) return cwd;
  p = String(p).trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  if (isWin) {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) p = `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
  }
  return path.resolve(cwd, p);
}

// Short path for display: relative to cwd when inside it.
export function displayPath(p, cwd) {
  if (!p) return '';
  const rel = path.relative(cwd, p);
  if (!rel) return '.';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  const home = os.homedir();
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function samePath(a, b) {
  return isWin ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

// `input` as an absolute directory: "" (or ~) is the home directory, "D:" is the root of D:, and forward slashes do
// on Windows too. null when it is not absolute.
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
