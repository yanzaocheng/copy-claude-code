// Files that other sessions send this one (/sendfile, MessagePeer's files) land in the user's Downloads folder:
// on Windows the folder the shell knows as Downloads (it can have been moved), else ~/Downloads (or what
// xdg-user-dir says). CLAUDE_PRO_DOWNLOAD_DIR replaces it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MAX_SEND_BYTES = 5 * 1024 ** 3; // a file; the gateway takes no more
export const MAX_SEND_FILES = 20; // a message

const DOWNLOADS_GUID = '{374DE290-123F-4565-9164-39C4925E467B}';
const PS_DOWNLOADS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$p = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders' -Name '${DOWNLOADS_GUID}' -ErrorAction Stop).'${DOWNLOADS_GUID}'
[Console]::Out.Write($p)
`;

function output(cmd, args) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve('');
      return;
    }
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out.trim() : ''); });
  });
}

let cached = null;

export function downloadsDir(env = process.env) {
  if (env.CLAUDE_PRO_DOWNLOAD_DIR) return Promise.resolve(path.resolve(env.CLAUDE_PRO_DOWNLOAD_DIR));
  cached ??= (async () => {
    const home = os.homedir();
    let dir = '';
    if (process.platform === 'win32') {
      dir = await output('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS_DOWNLOADS, 'utf16le').toString('base64')]);
    } else if (process.platform !== 'darwin') {
      dir = await output('xdg-user-dir', ['DOWNLOAD']);
      if (path.resolve(dir || home) === path.resolve(home)) dir = ''; // xdg's answer when it has none
    }
    return dir && path.isAbsolute(dir) ? dir : path.join(home, 'Downloads');
  })();
  return cached;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

// A name a file can be saved under, on any system, from the name another computer gave it.
export function safeFileName(name) {
  let base = String(name || '').split(/[\\/]/).pop();
  base = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!base || base === '.' || base === '..') base = 'file';
  const ext = path.extname(base);
  if (RESERVED.test(base.slice(0, base.length - ext.length))) base = `_${base}`;
  if (base.length > 200) base = base.slice(0, 200 - ext.length) + ext;
  return base;
}

// The files to send, checked: [{path, name, size}], or throws with what is wrong with which.
export function filesToSend(paths) {
  if (!paths.length) throw new Error('No file to send.');
  if (paths.length > MAX_SEND_FILES) throw new Error(`At most ${MAX_SEND_FILES} files at a time (${paths.length} given).`);
  return paths.map((p) => {
    let st;
    try { st = fs.statSync(p); } catch { throw new Error(`File not found: ${p}`); }
    if (st.isDirectory()) throw new Error(`${p} is a folder: send the files in it (or zip it first).`);
    if (!st.isFile()) throw new Error(`Not a file: ${p}`);
    if (st.size > MAX_SEND_BYTES) throw new Error(`${path.basename(p)} is ${formatBytes(st.size)}: at most ${formatBytes(MAX_SEND_BYTES)} a file.`);
    return { path: p, name: path.basename(p), size: st.size };
  });
}

export const formatBytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
