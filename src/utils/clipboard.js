// Clipboard helpers for explicit Ctrl+C copy and Ctrl+V text/image paste.
// Image files can also be attached by path through imageFromFile.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from './proc.js';
import { MAX_IMAGE_BYTES } from './images.js';

const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function run(cmd, args, { env, timeout = 15_000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try {
      child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, out: '', err: e.message });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
  });
}

// Read an image from the system clipboard for Ctrl+V in the prompt dialog.
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$out = $env:CLAUDE_PRO_IMG_OUT
$img = $null
if ($env:CLAUDE_PRO_IMG_SOURCE) {
  $img = [System.Drawing.Image]::FromFile($env:CLAUDE_PRO_IMG_SOURCE)
} elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $img = [System.Windows.Forms.Clipboard]::GetImage()
} elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  foreach ($f in [System.Windows.Forms.Clipboard]::GetFileDropList()) {
    if ($f -match '\\.(png|jpe?g|gif|webp|bmp)$') { Write-Output "FILE $f"; exit 0 }
  }
}
if ($img -eq $null) { exit 2 }
$max = 1568
$scale = [Math]::Min(1.0, $max / [Math]::Max($img.Width, $img.Height))
if ($scale -lt 1.0) {
  $w = [int][Math]::Round($img.Width * $scale); $h = [int][Math]::Round($img.Height * $scale)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($img, 0, 0, $w, $h)
  $g.Dispose(); $img.Dispose(); $img = $bmp
}
$img.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$format = 'png'
if ((Get-Item $out).Length -gt ${MAX_IMAGE_BYTES}) {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $params = New-Object System.Drawing.Imaging.EncoderParameters 1
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 85L
  $img.Save($out, $codec, $params)
  $format = 'jpeg'
}
Write-Output ("IMG " + $format + " " + $img.Width + "x" + $img.Height)
`;

// Turn a file on disk into an image block, or return an error string.
export function imageFromFile(file) {
  const media = IMAGE_EXT[path.extname(file).toLowerCase()];
  if (!media) return { error: `Not a supported image type: ${path.basename(file)}` };
  let st;
  try { st = fs.statSync(file); } catch { return { error: `File not found: ${file}` }; }
  if (!st.isFile()) return { error: `Not a file: ${file}` };
  // the turn scales it down to what the API takes (fitImagesIn), as it does a Read image: a 5 MB phone photo is fine
  if (st.size > 30 * 1024 * 1024) return { error: `Image is too large (${(st.size / 1e6).toFixed(1)}MB, max 30MB)` };
  return { image: { media_type: media, data: fs.readFileSync(file).toString('base64'), bytes: st.size, source: file } };
}

async function readWindows(source) {
  const outFile = path.join(os.tmpdir(), `claude-pro-clipboard-${process.pid}-${Date.now()}.img`);
  const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    env: { CLAUDE_PRO_IMG_OUT: outFile, CLAUDE_PRO_IMG_SOURCE: source || '' },
  });
  try {
    if (r.code === 2) return { error: null };
    if (r.code !== 0) return { error: `Could not read the clipboard: ${(r.err || r.out || `exit ${r.code}`).split('\n')[0]}` };
    if (r.out.startsWith('FILE ')) return imageFromFile(r.out.slice(5).trim());
    const m = /^IMG (\w+) (\d+)x(\d+)/m.exec(r.out);
    if (!m) return { error: `Unexpected clipboard reader output: ${r.out.slice(0, 200)}` };
    const buf = fs.readFileSync(outFile);
    return { image: { media_type: `image/${m[1]}`, data: buf.toString('base64'), bytes: buf.length, width: +m[2], height: +m[3] } };
  } finally {
    fs.rm(outFile, { force: true }, () => {});
  }
}

async function readMac() {
  const outFile = path.join(os.tmpdir(), `claude-pro-clipboard-${process.pid}-${Date.now()}.png`);
  const r = await run('osascript', [
    '-e', `set f to (open for access POSIX file "${outFile}" with write permission)`,
    '-e', 'try', '-e', 'write (the clipboard as «class PNGf») to f', '-e', 'end try', '-e', 'close access f',
  ]);
  try {
    const size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
    if (r.code !== 0 || size === 0) return { error: null };
    return imageFromFile(outFile);
  } finally {
    fs.rm(outFile, { force: true }, () => {});
  }
}

async function readLinux() {
  for (const [cmd, args] of [['wl-paste', ['--type', 'image/png']], ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']]]) {
    const r = await new Promise((resolve) => {
      const chunks = [];
      let child;
      try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve(null); return; }
      const timer = setTimeout(() => child.kill(), 5000);
      child.stdout.on('data', (d) => chunks.push(d));
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? Buffer.concat(chunks) : null); });
    });
    if (r?.length) {
      // scaled down when it is sent (fitImagesIn), as a dropped image file is
      if (r.length > 30 * 1024 * 1024) return { error: `Image is too large (${(r.length / 1e6).toFixed(1)}MB, max 30MB)` };
      return { image: { media_type: 'image/png', data: r.toString('base64'), bytes: r.length } };
    }
  }
  return { error: null };
}

export async function readClipboardImage({ source } = {}) {
  if (process.platform === 'win32') return readWindows(source);
  if (process.platform === 'darwin') return readMac();
  return readLinux();
}

// Put `text` on the system clipboard for an explicit Ctrl+C copy: Windows PowerShell (read as UTF-8 from stdin,
// so any text and any length), pbcopy on macOS, wl-copy / xclip / xsel elsewhere. Resolves with whether one of them
// took it.
export async function writeClipboard(text) {
  const tries = process.platform === 'win32'
    ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.Encoding]::UTF8).ReadToEnd(); Set-Clipboard -Value $s']]]
    : process.platform === 'darwin'
      ? [['pbcopy', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of tries) {
    const ok = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => child.kill(), 10_000);
      child.on('error', () => { clearTimeout(timer); resolve(false); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
      child.stdin.on('error', () => {});
      child.stdin.end(Buffer.from(process.platform === 'win32' ? text.replace(/\r?\n/g, '\r\n') : text, 'utf8'));
    });
    if (ok) return true;
  }
  return false;
}

// Read the text on the system clipboard for an explicit Ctrl+V paste: Windows PowerShell (written out as UTF-8),
// pbpaste on macOS, wl-paste / xclip / xsel elsewhere. Returns '' when there is no readable clipboard.
export async function readClipboardText() {
  const tries = process.platform === 'win32'
    ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$t = Get-Clipboard -Raw; if ($t) { $b = [Text.Encoding]::UTF8.GetBytes($t); $o = [Console]::OpenStandardOutput(); $o.Write($b, 0, $b.Length) }']]]
    : process.platform === 'darwin'
      ? [['pbpaste', []]]
      : [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]];
  for (const [cmd, args] of tries) {
    const text = await new Promise((resolve) => {
      const chunks = [];
      let child;
      try {
        child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => child.kill(), 10_000);
      child.stdout.on('data', (d) => chunks.push(d));
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null); });
    });
    if (text !== null) return text;
  }
  return '';
}
