// The files of a workspace, for the console's page: its 文件 tab (js/dock-files.js) and its editor
// (js/dock-editor.js). Folders listed a level at a time, text files read and written back in the encoding they are in
// (utils/encoding.js: UTF-8, UTF-16, GBK) with their line endings, pictures served as they are, and files found by
// name. The page is that of a console which runs agents with full access on this computer, logged in as its user:
// where it may look is not narrowed here, as the agents' tools are not.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from '../utils/proc.js';
import { CONFIG_DIR } from '../config.js';
import { ripgrepPath } from '../utils/shell.js';
import { decodeText, encodeText, encodingName } from '../utils/encoding.js';
import { httpError } from './data.js';

const isWin = process.platform === 'win32';
const HIDDEN = new Set(['.git', '.DS_Store', 'Thumbs.db']); // (not shown in the tree, as VS Code does)
const SKIP = new Set(['.git', 'node_modules']); // (not searched by name)
const MAX_ENTRIES = 5000; // of one folder
const EDIT_LIMIT = 5 * 1024 * 1024; // larger: not opened in the editor
const RAW_LIMIT = 40 * 1024 * 1024;
const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif' };
const ENCODINGS = new Set(['utf8', 'utf16le', 'utf16be', 'gbk']);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function absolute(p, what) {
  if (typeof p !== 'string' || !p.trim()) throw httpError(400, `缺少${what}`);
  if (!path.isAbsolute(p)) throw httpError(400, `${what}必须是绝对路径`);
  return path.resolve(p);
}
const fsError = (e, what) => httpError(e.code === 'ENOENT' ? 404 : e.code === 'EEXIST' ? 409 : e.code === 'ENOTDIR' ? 400 : 403,
  e.code === 'ENOENT' ? `${what}不存在` : e.code === 'EEXIST' ? '已经有同名的文件或文件夹' : e.code === 'EACCES' || e.code === 'EPERM' ? `没有权限：${e.message}` : e.message);

// ---------------------------------------------------------------- folders

export async function listDir(dir) {
  const d = absolute(dir, '目录');
  let entries;
  try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { throw fsError(e, '目录'); }
  const out = [];
  let truncated = false;
  for (const e of entries) {
    if (HIDDEN.has(e.name)) continue;
    if (out.length >= MAX_ENTRIES) { truncated = true; break; }
    let isDir = e.isDirectory();
    const link = e.isSymbolicLink();
    if (link) { try { isDir = (await fs.promises.stat(path.join(d, e.name))).isDirectory(); } catch { /* a broken link: a file */ } }
    out.push(link ? { name: e.name, dir: isDir, link: true } : { name: e.name, dir: isDir });
  }
  out.sort((a, b) => b.dir - a.dir || collator.compare(a.name, b.name));
  return { path: d, entries: out, truncated };
}

// Several folders at once: the page's tree, refreshed (the folders open in it).
export async function listDirs(paths) {
  if (!Array.isArray(paths)) throw httpError(400, 'paths is required');
  const lists = {};
  await Promise.all(paths.slice(0, 100).map(async (p) => {
    try { lists[p] = await listDir(p); } catch (e) { lists[p] = { error: e.message, status: e.status || 500 }; }
  }));
  return { lists };
}

// ---------------------------------------------------------------- files

export async function statFile(p) {
  const file = absolute(p, '文件');
  try {
    const st = await fs.promises.stat(file);
    return { path: file, exists: true, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
  } catch { return { path: file, exists: false }; }
}

// A file for the editor: its text with what it takes to write it back the same way, or why it is not shown as text.
export async function readFile(p) {
  const file = absolute(p, '文件');
  let st;
  try { st = await fs.promises.stat(file); } catch (e) { throw fsError(e, '文件'); }
  if (st.isDirectory()) throw httpError(400, '这是一个文件夹');
  const base = { path: file, name: path.basename(file), size: st.size, mtime: st.mtimeMs };
  if (IMAGES[path.extname(file).toLowerCase()]) return { ...base, image: true };
  if (st.size > EDIT_LIMIT) return { ...base, tooLarge: true };
  let buf;
  try { buf = await fs.promises.readFile(file); } catch (e) { throw fsError(e, '文件'); }
  const d = decodeText(buf);
  if (!d) return { ...base, binary: true };
  return {
    ...base, text: d.text, encoding: d.encoding, encodingName: encodingName(d.encoding), bom: d.bom,
    eol: d.text.includes('\r\n') ? 'crlf' : 'lf',
    // (bytes that are no text in its encoding: saving would not give them back)
    readonly: d.lossy ? `文件里有 ${encodingName(d.encoding)} 无法解码的字节，保存会改坏它，所以只读` : undefined,
  };
}

// Saved from the editor. `mtime`: when the file was as the editor read it; changed on disk since (an agent edited it),
// it is not overwritten unless `force` (409 with the time it has now).
export async function writeFile(body) {
  const file = absolute(body?.path, '文件');
  if (typeof body.text !== 'string') throw httpError(400, 'text is required');
  let st = null;
  try { st = await fs.promises.stat(file); } catch { /* deleted meanwhile: saved again */ }
  if (st?.isDirectory()) throw httpError(400, '这是一个文件夹');
  if (st && !body.force && Number.isFinite(body.mtime) && Math.abs(st.mtimeMs - body.mtime) > 1) {
    throw Object.assign(httpError(409, '文件在磁盘上已经被改动'), { data: { conflict: true, mtime: st.mtimeMs } });
  }
  const encoding = ENCODINGS.has(body.encoding) ? body.encoding : 'utf8';
  const text = body.eol === 'crlf' ? body.text.replace(/\r?\n/g, '\r\n') : body.text;
  const r = encodeText(text, { encoding, bom: Boolean(body.bom) });
  if (r.error) throw httpError(400, `${encodingName(encoding)} 编码写不下这些字符：${r.chars.slice(0, 8).join(' ')}`);
  try { await fs.promises.writeFile(file, r.buffer); } catch (e) { throw fsError(e, '文件'); }
  const now = await fs.promises.stat(file);
  return { path: file, mtime: now.mtimeMs, size: now.size };
}

// 新建文件 / 新建文件夹: never over something that is there.
export async function createEntry(body) {
  const target = absolute(body?.path, '路径');
  try {
    // (a/b: the folders on the way made too)
    if (body.dir) {
      if (fs.existsSync(target)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      await fs.promises.mkdir(target, { recursive: true });
    } else {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, '', { flag: 'wx' });
    }
  } catch (e) { throw fsError(e, '上级目录'); }
  return { path: target };
}

export async function renameEntry(body) {
  const from = absolute(body?.from, '路径');
  const to = absolute(body?.to, '新路径');
  // (a change of case only, on Windows, is the same file: allowed)
  const sameFile = isWin && from.toLowerCase() === to.toLowerCase();
  if (!sameFile && fs.existsSync(to)) throw httpError(409, '已经有同名的文件或文件夹');
  try { await fs.promises.rename(from, to); } catch (e) { throw fsError(e, '文件'); }
  return { path: to };
}

// 删除: never outright. To the system's recycle bin (Windows), the desktop's trash (macOS, Linux with gio), else to
// CONFIG_DIR/trash/files. The path goes to the helper as data (an environment variable, an argument), never as code.
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, timeout: 60_000, ...opts }, (err) => resolve(!err));
});
// SHFileOperation with FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT: to the bin, no window of any
// kind (the console may be used from a phone). About a second, the first time three.
const RECYCLE_PS = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class CpRecycle {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Op { public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags; public bool aborted; public IntPtr maps; public string title; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref Op op);
  public static int Recycle(string path) {
    var op = new Op { wFunc = 3, pFrom = path + "\\0\\0", fFlags = 0x40 | 0x10 | 0x400 | 0x4 };
    int r = SHFileOperation(ref op);
    return r != 0 ? r : (op.aborted ? -1 : 0);
  }
}
'@
exit [CpRecycle]::Recycle($env:CP_TRASH_PATH)`;

async function toSystemTrash(target, timeout) {
  if (isWin) {
    const sys = process.env.SystemRoot || 'C:\\Windows';
    return run(path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_PS], { env: { ...process.env, CP_TRASH_PATH: target }, timeout });
  }
  if (process.platform === 'darwin') return run('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv))', '-e', 'end run', target], { timeout });
  return run('gio', ['trash', '--', target], { timeout });
}

// (`timeout`: a whole project folder takes the bin minutes)
export async function trashEntry(body, { timeout = 60_000 } = {}) {
  const target = absolute(body?.path, '路径');
  if (path.dirname(target) === target) throw httpError(400, '不能删除磁盘的根目录');
  try { await fs.promises.lstat(target); } catch (e) { throw fsError(e, '文件'); }
  if ((await toSystemTrash(target, timeout)) && !fs.existsSync(target)) return { path: target, recycled: true };
  if (!fs.existsSync(target)) return { path: target, recycled: true };
  const dest = path.join(CONFIG_DIR, 'trash', 'files', `${Date.now()}__${path.basename(target)}`);
  try {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    try { await fs.promises.rename(target, dest); } catch (e) {
      if (e.code !== 'EXDEV') throw e; // (another drive than the configuration's)
      await fs.promises.cp(target, dest, { recursive: true });
      await fs.promises.rm(target, { recursive: true, force: true });
    }
  } catch (e) { throw fsError(e, '文件'); }
  return { path: target, trashed: dest };
}

// A picture, for the editor's tab: served with a policy that runs nothing, should it be opened on its own.
export async function rawFile(p) {
  const file = absolute(p, '文件');
  const type = IMAGES[path.extname(file).toLowerCase()];
  if (!type) throw httpError(415, '只能这样打开图片');
  let st;
  try { st = await fs.promises.stat(file); } catch (e) { throw fsError(e, '文件'); }
  if (st.size > RAW_LIMIT) throw httpError(413, '图片太大');
  return { raw: { type, data: await fs.promises.readFile(file), headers: { 'content-security-policy': "default-src 'none'; sandbox" } } };
}

// ---------------------------------------------------------------- finding files by name (Ctrl+P)

const LIST_MAX = 200_000;
const LIST_TTL = 30_000;
const LIST_TIMEOUT = 10_000;
const fileLists = new Map(); // root -> {at, files, truncated} or {pending}

function rgFiles(rg, root) {
  return new Promise((resolve) => {
    const files = [];
    let rest = '';
    let truncated = false;
    let child;
    try {
      child = spawn(rg, ['--files', '--hidden', '--no-messages', '--path-separator', '/', '-g', '!.git', '-g', '!node_modules'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { resolve(null); return; }
    const timer = setTimeout(() => { truncated = true; child.kill(); }, LIST_TIMEOUT);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        if (files.length >= LIST_MAX) { truncated = true; child.kill(); return; }
        const f = line.replace(/\r$/, '').replace(/^\.\//, '');
        if (f) files.push(f);
      }
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      if (rest.trim() && files.length < LIST_MAX) files.push(rest.trim().replace(/^\.\//, ''));
      resolve({ files, truncated });
    });
  });
}

async function walkFiles(root) {
  const files = [];
  const until = Date.now() + LIST_TIMEOUT;
  const queue = [''];
  while (queue.length) {
    if (files.length >= LIST_MAX || Date.now() > until) return { files, truncated: true };
    const rel = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) queue.push(r); else files.push(r);
    }
  }
  return { files, truncated: false };
}

function filesUnder(root) {
  const hit = fileLists.get(root);
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.at < LIST_TTL) return Promise.resolve(hit);
  const rg = ripgrepPath();
  const pending = (async () => {
    const found = (rg && (await rgFiles(rg, root))) || (await walkFiles(root));
    const entry = { ...found, at: Date.now() };
    fileLists.set(root, entry);
    if (fileLists.size > 20) fileLists.delete(fileLists.keys().next().value);
    return entry;
  })().catch((e) => { fileLists.delete(root); throw e; });
  fileLists.set(root, { pending });
  return pending;
}

// How well `rel` matches the query (lower case, no spaces): a substring of the name first, else the query's letters in
// order, worth more where they follow each other, start a word or fall in the name. -1: no match.
export function fuzzyScore(q, rel) {
  const s = rel.toLowerCase();
  const base = s.lastIndexOf('/') + 1;
  const name = s.slice(base);
  const at = name.indexOf(q);
  if (at >= 0) return 1000 + (at === 0 ? 200 : 0) - at - name.length - s.length * 0.01;
  let qi = q.length - 1;
  let prev = -1;
  let score = 0;
  for (let i = s.length - 1; i >= 0 && qi >= 0; i--) {
    if (s[i] !== q[qi]) continue;
    score += 1;
    if (prev === i + 1) score += 4;
    if (i === 0 || '/_-. '.includes(s[i - 1])) score += 3;
    if (i >= base) score += 2;
    prev = i;
    qi--;
  }
  return qi >= 0 ? -1 : score - s.length * 0.01;
}

export async function findFiles(rootParam, query) {
  const root = absolute(rootParam, '目录');
  const q = String(query || '').toLowerCase().replace(/\s+/g, '').replace(/\\/g, '/');
  if (!q) return { results: [], truncated: false };
  try { if (!fs.statSync(root).isDirectory()) throw new Error(); } catch { throw httpError(404, '目录不存在'); }
  const { files, truncated } = await filesUnder(root);
  const scored = [];
  for (const rel of files) {
    const score = fuzzyScore(q, rel);
    if (score >= 0) scored.push([score, rel]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length);
  return { results: scored.slice(0, 60).map(([, rel]) => ({ rel, path: path.join(root, rel) })), truncated, total: files.length };
}
