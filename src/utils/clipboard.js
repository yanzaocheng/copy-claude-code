// Read an image from the system clipboard (alt+v / ctrl+v in the prompt), like Claude Code.
// Windows: PowerShell + System.Windows.Forms; macOS: osascript; Linux: wl-paste / xclip.
// Large images are scaled so the long edge is at most 1568px (the API's recommended size).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MAX_IMAGE_BYTES = 3_750_000; // ~5MB once base64 encoded
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

// Prints "IMG <format> <w>x<h>" after writing $env:CLAUDE_PRO_IMG_OUT, or "FILE <path>" when the
// clipboard holds a copied image file. Exit code 2 = no image. CLAUDE_PRO_IMG_SOURCE (a file) replaces
// the clipboard as input, which the tests use so they don't clobber the real clipboard.
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
  if (st.size > MAX_IMAGE_BYTES) return { error: `Image is too large (${(st.size / 1e6).toFixed(1)}MB, max 3.7MB)` };
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
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      // A clipboard owner that never answers must not leave the reader hanging.
      const timer = setTimeout(() => child.kill(), 5000);
      child.stdout.on('data', (d) => chunks.push(d));
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? Buffer.concat(chunks) : null); });
    });
    if (r?.length) {
      if (r.length > MAX_IMAGE_BYTES) return { error: 'Image is too large (max 3.7MB)' };
      return { image: { media_type: 'image/png', data: r.toString('base64'), bytes: r.length } };
    }
  }
  return { error: null };
}

// Returns {image} on success, {error: string} on failure, or {error: null} when the clipboard has no image.
export async function readClipboardImage({ source } = {}) {
  if (process.platform === 'win32') return readWindows(source);
  if (process.platform === 'darwin') return readMac();
  return readLinux();
}
