// Directories of this computer for the gateway's web page: what it shows to choose a working directory from
// (/cd from the page, see App.remoteList). Moved here from the computer service (host.js, removed in 0.8.0), whose
// listing the page was built for: the fields and the messages (Chinese, as the page is) are the same.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeDir } from './paths.js';

const MAX_ENTRIES = 1000;
const MAX_RECENT = 15;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const describeFsError = (e, dir) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? `目录不存在：${dir}`
  : e.code === 'EACCES' || e.code === 'EPERM' ? `没有权限读取：${dir}`
    : `读取 ${dir} 失败：${e.message}`);

let rootsCache = { at: 0, roots: [] };
async function roots(platform = process.platform) {
  if (platform !== 'win32') return ['/'];
  if (Date.now() - rootsCache.at < 30_000) return rootsCache.roots;
  // a disconnected network drive can take long to answer: 1.5 seconds each, all at once
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(letters.map((l) => Promise.race([
    fsp.access(`${l}:\\`).then(() => `${l}:\\`, () => null),
    sleep(1500).then(() => null),
  ])));
  rootsCache = { at: Date.now(), roots: found.filter(Boolean) };
  return rootsCache.roots;
}

// The directories in `input` (only directories, links to them included), for the page to choose from:
// {path, parent, sep, entries: [{name, path}], truncated, home, roots, recent}.
export async function listDirectory(input, { home = os.homedir(), recent = () => [] } = {}) {
  const dir = normalizeDir(input, { home });
  if (!dir) throw new Error(`不是绝对路径：${input}`);
  let st;
  try { st = await fsp.stat(dir); } catch (e) { throw new Error(describeFsError(e, dir)); }
  if (!st.isDirectory()) throw new Error(`不是目录：${dir}`);
  let dirents;
  try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { throw new Error(describeFsError(e, dir)); }
  const entries = [];
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      // a link to a directory counts, unless it cannot be opened (Windows' old junctions in the profile:
      // "My Documents", "Application Data" ... refuse to be listed)
      try { isDir = (await fsp.stat(full)).isDirectory(); } catch { isDir = false; }
      if (isDir) {
        let handle = null;
        try {
          handle = await fsp.opendir(full);
          await handle.read(); // Windows checks the access at the first read, not at the opening
        } catch {
          isDir = false;
        } finally {
          await handle?.close().catch(() => {});
        }
      }
      // ... and the profile's other compatibility junctions ("Application Data", "Recent", the Start Menu in the
      // system's language ...), which Explorer hides: all lead into AppData
      if (isDir && process.platform === 'win32' && dir.toLowerCase() === path.resolve(home).toLowerCase()) {
        try {
          if ((await fsp.realpath(full)).toLowerCase().startsWith(`${path.join(home, 'AppData').toLowerCase()}\\`)) isDir = false;
        } catch { isDir = false; }
      }
    }
    if (isDir) entries.push({ name: d.name, path: full });
  }
  const hidden = (name) => (name.startsWith('.') ? 1 : 0);
  entries.sort((a, b) => hidden(a.name) - hidden(b.name) || a.name.localeCompare(b.name, undefined, { sensitivity: 'accent', numeric: true }));
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    sep: path.sep,
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
    home,
    roots: await roots(),
    recent: recent(),
  };
}

// The first line of a session file is {type: 'meta', cwd, ...} (see SessionStore.append).
function sessionCwd(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const meta = JSON.parse(buf.subarray(0, n).toString('utf8').split('\n')[0]);
    return meta?.type === 'meta' && typeof meta.cwd === 'string' ? meta.cwd : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// Where claude-pro sessions ran lately on this computer, newest first: [{path, at}] of the directories that are
// still there. `projects`: the config directory's projects folder. One line read per project (its newest session's
// first line).
export function recentDirectories({ projects, max = MAX_RECENT }) {
  let dirs = [];
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
  const found = [];
  for (const d of dirs) {
    const sub = path.join(projects, d.name);
    let newest = null;
    try {
      for (const f of fs.readdirSync(sub)) {
        if (!f.endsWith('.jsonl')) continue;
        const m = fs.statSync(path.join(sub, f)).mtimeMs;
        if (!newest || m > newest.m) newest = { f, m };
      }
    } catch { continue; }
    if (!newest) continue;
    const cwd = sessionCwd(path.join(sub, newest.f));
    if (cwd) found.push({ path: path.resolve(cwd), at: newest.m });
  }
  found.sort((a, b) => b.at - a.at);
  const seen = new Set();
  const out = [];
  for (const r of found) {
    const key = process.platform === 'win32' ? r.path.toLowerCase() : r.path;
    if (seen.has(key)) continue;
    seen.add(key);
    try { if (!fs.statSync(r.path).isDirectory()) continue; } catch { continue; }
    out.push({ path: r.path, at: new Date(r.at).toISOString() });
    if (out.length >= max) break;
  }
  return out;
}
