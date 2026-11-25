// Images for the model. The API refuses an image wider or taller than 8000 px, and in a request that carries many
// images (a long session that looked at screenshots) one beyond 2000 px. It scales anything whose long edge is over
// 1568 px down to that anyway, so images are scaled here to fit 1568 px before they go into the conversation:
// the model loses nothing it would have seen, and the conversation never carries an image that a later request
// is refused for. There is no image library: Windows scales with System.Drawing (PowerShell), macOS with sips,
// elsewhere ImageMagick when it is installed.
//
// A heavy PNG goes as JPEG (see PNG_AS_JPEG_BYTES). A screenshot of a 3D scene or a photo hardly compresses as
// PNG (2.3MB at 723×1568, 180KB as JPEG), and every request carries the whole conversation: a session that
// looked at eleven of them sent 31MB a request, which took the gateway past its memory limit and is close to the
// API's 32MB. Images are billed by their pixels, not their bytes, so tokens stay the same.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from './proc.js';

export const MAX_IMAGE_EDGE = 1568;
const API_MAX_EDGE = 2000; // what a request with many images accepts: sent as it is when it cannot be scaled
export const MAX_IMAGE_BYTES = 3_750_000; // ~5MB once base64 encoded
export const PNG_AS_JPEG_BYTES = 512 * 1024; // a PNG larger than this goes as JPEG (quality 85) when that is smaller

// {width, height} from the header of a PNG, JPEG, GIF or WebP; null for anything else.
export function imageSize(buf) {
  if (!buf || buf.length < 10) return null;
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.toString('latin1', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

function run(cmd, args, { env, timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: -1, out: '' });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim() }); });
  });
}

const PS_SCALE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($env:CLAUDE_PRO_IMG_IN)
$max = [int]$env:CLAUDE_PRO_IMG_MAX
$scale = [Math]::Min(1.0, $max / [Math]::Max($img.Width, $img.Height))
$w = [Math]::Max(1, [int][Math]::Round($img.Width * $scale)); $h = [Math]::Max(1, [int][Math]::Round($img.Height * $scale))
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($img, 0, 0, $w, $h)
$g.Dispose(); $img.Dispose()
$out = $env:CLAUDE_PRO_IMG_OUT
$jpegOnly = $env:CLAUDE_PRO_IMG_JPEG -eq '1'
$format = 'png'
if (-not $jpegOnly) { $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) }
if ($jpegOnly -or (Get-Item $out).Length -gt [int]$env:CLAUDE_PRO_IMG_BYTES) {
  # JPEG has no transparency: flatten onto white (a screenshot has none to lose)
  $flat = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($flat)
  $g.Clear([System.Drawing.Color]::White)
  $g.DrawImage($bmp, 0, 0, $w, $h)
  $g.Dispose()
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $params = New-Object System.Drawing.Imaging.EncoderParameters 1
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 85L
  $jpg = "$out.jpg"
  $flat.Save($jpg, $codec, $params)
  $flat.Dispose()
  if ($jpegOnly -or (Get-Item $jpg).Length -lt (Get-Item $out).Length) { Move-Item -Force $jpg $out; $format = 'jpeg' } else { Remove-Item $jpg }
}
$bmp.Dispose()
Write-Output "IMG $format"
`;

// The image file `input` scaled to fit `max` px into a new file: {buffer, media_type}, or null when nothing here
// can scale images. `jpeg`: as JPEG; else as PNG, or as JPEG when the PNG is over PNG_AS_JPEG_BYTES and the JPEG
// is smaller.
async function scaleFile(input, { max, jpeg }) {
  const out = path.join(os.tmpdir(), `claude-pro-img-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    if (process.platform === 'win32') {
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS_SCALE, 'utf16le').toString('base64')], {
        env: { CLAUDE_PRO_IMG_IN: input, CLAUDE_PRO_IMG_OUT: out, CLAUDE_PRO_IMG_MAX: String(max), CLAUDE_PRO_IMG_JPEG: jpeg ? '1' : '', CLAUDE_PRO_IMG_BYTES: String(PNG_AS_JPEG_BYTES) },
      });
      const m = /IMG (png|jpeg)/.exec(r.out);
      if (r.code !== 0 || !m) return null;
      return { buffer: fs.readFileSync(out), media_type: `image/${m[1]}` };
    }
    const produce = async (format) => {
      const target = `${out}.${format === 'jpeg' ? 'jpg' : 'png'}`;
      const asJpeg = format === 'jpeg' ? ['-background', 'white', '-flatten', '-quality', '85'] : [];
      const tries = process.platform === 'darwin'
        ? [['sips', ['-Z', String(max), '-s', 'format', format, ...(format === 'jpeg' ? ['-s', 'formatOptions', '85'] : []), input, '--out', target]]]
        : [['magick', [input, '-resize', `${max}x${max}>`, ...asJpeg, target]], ['convert', [input, '-resize', `${max}x${max}>`, ...asJpeg, target]]];
      for (const [cmd, args] of tries) {
        const r = await run(cmd, args);
        if (r.code === 0 && fs.existsSync(target)) {
          try { return { buffer: fs.readFileSync(target), media_type: `image/${format}` }; } finally { fs.rm(target, { force: true }, () => {}); }
        }
      }
      return null;
    };
    if (jpeg) return await produce('jpeg');
    const png = await produce('png');
    if (!png || png.buffer.length <= PNG_AS_JPEG_BYTES) return png;
    const jpg = await produce('jpeg');
    return jpg && jpg.buffer.length < png.buffer.length ? jpg : png;
  } catch {
    return null;
  } finally {
    fs.rm(out, { force: true }, () => {});
    fs.rm(`${out}.jpg`, { force: true }, () => {});
  }
}

// The image as the model should get it. `data` is base64. Returns {data, media_type, width, height, from, changed}
// where `from` is the size it had when it was scaled (null when its size stays) and `changed` says whether `data`
// is new (scaled, or a heavy PNG as JPEG), or {error} when it is too large and cannot be scaled here.
export async function fitImage({ data, media_type }) {
  const buf = Buffer.from(data, 'base64');
  const size = imageSize(buf);
  const keep = { data, media_type, width: size?.width ?? null, height: size?.height ?? null, from: null, changed: false };
  if (!size) return keep; // not a format it knows: the API will say what it thinks of it
  const edge = Math.max(size.width, size.height);
  const heavyPng = media_type === 'image/png' && buf.length > PNG_AS_JPEG_BYTES;
  if (edge <= MAX_IMAGE_EDGE && buf.length <= MAX_IMAGE_BYTES && !heavyPng) return keep;
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[media_type] || '.img';
  const input = path.join(os.tmpdir(), `claude-pro-img-in-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  let scaled = null;
  try {
    fs.writeFileSync(input, buf);
    scaled = await scaleFile(input, { max: Math.min(edge, MAX_IMAGE_EDGE), jpeg: media_type === 'image/jpeg' });
  } catch { /* scaled stays null */ } finally {
    fs.rm(input, { force: true }, () => {});
  }
  const got = scaled && imageSize(scaled.buffer);
  const smaller = edge > MAX_IMAGE_EDGE; // in pixels
  // the new one when it fits, and is needed or at least lighter (a PNG that stayed PNG may not be)
  if (got && Math.max(got.width, got.height) <= API_MAX_EDGE && scaled.buffer.length <= MAX_IMAGE_BYTES && (smaller || buf.length > MAX_IMAGE_BYTES || scaled.buffer.length < buf.length)) {
    return { data: scaled.buffer.toString('base64'), media_type: scaled.media_type, width: got.width, height: got.height, from: smaller ? size : null, changed: true };
  }
  if (edge <= API_MAX_EDGE && buf.length <= MAX_IMAGE_BYTES) return keep;
  return { error: `the image is ${size.width}×${size.height} px${buf.length > MAX_IMAGE_BYTES ? ` and ${(buf.length / 1e6).toFixed(1)}MB` : ''}, more than the API accepts (${API_MAX_EDGE} px a side when a conversation has many images), and it could not be scaled down here` };
}

// Every base64 image block in `blocks` (content blocks, tool_result blocks with content inside, or messages)
// fitted in place, so that the conversation that holds them changes too. Returns how many were changed; an
// image that cannot be fitted becomes a text block that says so.
export async function fitImagesIn(blocks) {
  let changed = 0;
  const visit = async (list) => {
    if (!Array.isArray(list)) return;
    for (const b of list) {
      if (!b || typeof b !== 'object') continue;
      if (b.role && Array.isArray(b.content)) { await visit(b.content); continue; }
      if (b.type === 'tool_result' && Array.isArray(b.content)) { await visit(b.content); continue; }
      if (b.type !== 'image' || b.source?.type !== 'base64' || typeof b.source.data !== 'string') continue;
      const fit = await fitImage(b.source);
      if (fit.error) {
        const mark = b.cache_control;
        for (const k of Object.keys(b)) delete b[k];
        Object.assign(b, { type: 'text', text: `[image left out: ${fit.error}]` }, mark ? { cache_control: mark } : {});
        changed++;
      } else if (fit.changed) {
        b.source = { type: 'base64', media_type: fit.media_type, data: fit.data };
        changed++;
      }
    }
  };
  await visit(blocks);
  return changed;
}

// Heavy PNGs (see PNG_AS_JPEG_BYTES) already in a conversation (messages or content blocks) re-encoded in place:
// those from before images were, or from a tool that left them as they were. Nothing else in it changes. Returns
// how many changed. A few at a time, as each is a process; one that stays as it is (nothing here can re-encode
// it, or the JPEG is not smaller) is remembered, so that it is not tried again before every request.
const keptAsPng = new Set(); // sha1 of the base64 data
export async function lightenImagesIn(blocks) {
  const heavy = [];
  const visit = (list) => {
    if (!Array.isArray(list)) return;
    for (const b of list) {
      if (!b || typeof b !== 'object') continue;
      if (Array.isArray(b.content)) visit(b.content); // a message, or a tool_result
      else if (b.type === 'image' && b.source?.type === 'base64' && b.source.media_type === 'image/png' && typeof b.source.data === 'string'
        && b.source.data.length * 0.75 > PNG_AS_JPEG_BYTES) heavy.push(b);
    }
  };
  visit(blocks);
  let changed = 0;
  const lighten = async (b) => {
    const key = crypto.createHash('sha1').update(b.source.data).digest('base64');
    if (keptAsPng.has(key)) return;
    const fit = await fitImage(b.source);
    if (fit.error || !fit.changed) {
      if (keptAsPng.size >= 1000) keptAsPng.clear();
      keptAsPng.add(key);
      return;
    }
    b.source = { type: 'base64', media_type: fit.media_type, data: fit.data };
    changed++;
  };
  for (let i = 0; i < heavy.length; i += 4) await Promise.all(heavy.slice(i, i + 4).map(lighten));
  return changed;
}
