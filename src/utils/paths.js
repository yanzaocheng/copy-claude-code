import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const isWin = process.platform === 'win32';

// Where Git for Windows is installed (its `/`), from the Git Bash the Bash tool uses; null when not found.
let gitRoot;
function gitBashRoot() {
  if (gitRoot !== undefined) return gitRoot;
  gitRoot = null;
  const configured = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  for (const bash of [configured, 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
    if (bash && fs.existsSync(bash)) { gitRoot = path.dirname(path.dirname(bash)); break; }
  }
  return gitRoot;
}

// A Git Bash path as Windows sees it, after its mount table (`mount`): /c/... is drive C:, /tmp is the Windows
// temp directory, /bin is /usr/bin, and anything else is under the Git installation. A command that wrote
// /tmp/out.txt can then be followed by a Read of /tmp/out.txt (it used to resolve to D:\tmp\out.txt).
export function msysPath(p) {
  const drive = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (drive) return `${drive[1].toUpperCase()}:${(drive[2] || '/').replace(/\//g, '\\')}`;
  if (p === '/tmp' || p.startsWith('/tmp/')) return path.join(os.tmpdir(), p.slice(4));
  const root = gitBashRoot();
  if (!root) return p;
  if (p === '/bin' || p.startsWith('/bin/')) return path.join(root, 'usr', 'bin', p.slice(4));
  return path.join(root, p);
}

// Resolve a path the model gave us. Accepts absolute, relative (to cwd), ~, and on Windows
// also Git-Bash style paths such as /d/foo/bar, /c/Users/... or /tmp/x (see msysPath).
export function resolvePath(p, cwd) {
  if (!p) return cwd;
  p = String(p).trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  if (isWin && p.startsWith('/') && !p.startsWith('//')) p = msysPath(p);
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
