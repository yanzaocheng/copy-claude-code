// Text files in the encodings met on Chinese Windows machines: UTF-8 (with or without a BOM), UTF-16 with a BOM
// (what Windows PowerShell 5 redirects to), and GBK (code page 936: legacy projects, files saved by older tools).
// decodeText() says which one a file is in and encodeText() writes text back in it, so that an edit leaves every
// byte it did not change as it was. Decoding everything as UTF-8 used to turn each Chinese character of a GBK file
// into U+FFFD on its first edit. A file that is none of these is marked `lossy`: it can be read, not rewritten.

import { spawnSync } from './proc.js';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const lenientUtf8 = new TextDecoder('utf-8');
const strictGbk = new TextDecoder('gbk', { fatal: true }); // the WHATWG gbk decoder, which is the gb18030 one

// Whether bytes that are not valid UTF-8 as a whole are still UTF-8 text with a few bad bytes (a character cut at
// the end of a line by `cut -c` or `head -c`, a stray Latin-1 byte), rather than text in another encoding. Chinese
// UTF-8 is often valid GBK by chance (E4 B8 AD E6 96 87, "中文", reads as "涓枃"), so trying GBK first turned such
// a line or file into mojibake; GBK text read as UTF-8, the other way round, is mostly invalid sequences, with a
// valid two-byte character here and there by chance. An incomplete sequence counts once, however long.
export function mostlyUtf8(buf) {
  let good = 0;
  let bad = 0;
  for (let i = 0; i < buf.length;) {
    const b = buf[i];
    if (b < 0x80) { i++; continue; }
    const n = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    let k = 1;
    while (n && k < n && i + k < buf.length && (buf[i + k] & 0xc0) === 0x80) k++;
    if (n && k === n) good++;
    else bad++;
    i += n ? k : 1;
  }
  return bad === 0 || good >= 4 * bad;
}

// {text, encoding: 'utf8'|'utf16le'|'utf16be'|'gbk', bom, lossy}, or null for binary data. `lossy`: writing the
// text back would not give these bytes (undecodable bytes became U+FFFD, or GB18030 forms GBK cannot write).
// `writable: false` skips that check for a GBK file, for a caller that only reads (Grep).
export function decodeText(buf, { writable = true } = {}) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.toString('utf16le', 2), encoding: 'utf16le', bom: true, lossy: buf.length % 2 !== 0 };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf16be', bom: true, lossy: buf.length % 2 !== 0 };
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = bom ? buf.subarray(3) : buf;
  if (body.subarray(0, 8000).includes(0)) return null;
  try { return { text: strictUtf8.decode(body), encoding: 'utf8', bom, lossy: false }; } catch { /* not UTF-8 */ }
  if (!bom && !mostlyUtf8(body)) {
    let text = null;
    try { text = strictGbk.decode(body); } catch { /* not GBK either */ }
    // Writable only when the text turns back into exactly these bytes (GB18030's four-byte forms do not).
    if (text !== null) return { text, encoding: 'gbk', bom: false, lossy: writable && !encodeGbk(text).buffer?.equals(body) };
  }
  return { text: lenientUtf8.decode(body), encoding: 'utf8', bom, lossy: true };
}

// The name of an encoding for messages.
export const encodingName = (encoding) => ({ utf8: 'UTF-8', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', gbk: 'GBK' })[encoding] || encoding;

// `text` as bytes in `encoding` (with its BOM when `bom`): {buffer}, or {error, chars} when some characters cannot
// be written in it (GBK has no emoji, say).
export function encodeText(text, { encoding = 'utf8', bom = false } = {}) {
  if (encoding === 'utf16le') return { buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) };
  if (encoding === 'utf16be') {
    const le = Buffer.from(text, 'utf16le');
    for (let i = 0; i + 1 < le.length; i += 2) { const t = le[i]; le[i] = le[i + 1]; le[i + 1] = t; }
    return { buffer: Buffer.concat([Buffer.from([0xfe, 0xff]), le]) };
  }
  if (encoding === 'gbk') return encodeGbk(text);
  const utf8 = Buffer.from(text, 'utf8');
  return { buffer: bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]) : utf8 };
}

// GBK's two-byte table, character -> bytes, built once from the decoder itself (there is no GBK encoder in Node).
let gbkTable = null;
function gbkCodes() {
  if (gbkTable) return gbkTable;
  gbkTable = new Map();
  const lenient = new TextDecoder('gbk');
  const pair = Buffer.alloc(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      pair[0] = lead; pair[1] = trail;
      const ch = lenient.decode(pair);
      if (ch.length === 1 && ch !== '\ufffd' && !gbkTable.has(ch)) gbkTable.set(ch, (lead << 8) | trail);
    }
  }
  gbkTable.set('\u20ac', 0x80); // the euro sign, GBK's one single-byte character above ASCII
  return gbkTable;
}

function encodeGbk(text) {
  const out = Buffer.alloc(text.length * 2);
  let n = 0;
  let codes = null;
  const missing = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { out[n++] = cp; continue; }
    codes ??= gbkCodes();
    const code = codes.get(ch);
    if (code === undefined) { missing.add(ch); continue; }
    if (code > 0xff) out[n++] = code >> 8;
    out[n++] = code & 0xff;
  }
  if (missing.size) {
    const chars = [...missing].slice(0, 10).map((c) => `${c} (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`);
    return { error: `characters GBK cannot represent: ${chars.join(', ')}${missing.size > 10 ? ', …' : ''}`, chars: [...missing] };
  }
  return { buffer: out.subarray(0, n) };
}

// ---- Output of commands
//
// MSYS tools, git and node write UTF-8, but native Windows programs writing to a pipe use the console code page:
// 936 (GBK) on Chinese Windows, so the output of ipconfig, tasklist, schtasks, cmd, javac or MSBuild used to reach
// the model as mojibake. OutputDecoder decodes it line by line: UTF-8 where a line is UTF-8, else in the console
// code page. A line is decoded once it is complete, so a character is never cut between two chunks.

const CODE_PAGES = { 936: 'gbk', 54936: 'gb18030', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr', 866: 'ibm866', 874: 'windows-874' };
let legacyDecoder; // undefined: not looked up yet; null: none (UTF-8 console, not Windows, unknown code page)

// A strict TextDecoder for this machine's console code page (`chcp`, looked up once), or null.
export function consoleDecoder() {
  if (legacyDecoder !== undefined) return legacyDecoder;
  legacyDecoder = null;
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('chcp', [], { windowsHide: true, timeout: 3000 });
    const cp = Number(/(\d+)\s*$/.exec(String(r.stdout || '').trim())?.[1]);
    const label = CODE_PAGES[cp] || (cp >= 1250 && cp <= 1258 ? `windows-${cp}` : null);
    if (label) legacyDecoder = new TextDecoder(label, { fatal: true });
  } catch { /* none: such lines stay lenient UTF-8 */ }
  return legacyDecoder;
}

const isAscii = (buf) => { for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7f) return false; return true; };

// Complete lines (or a whole stream) of command output as text.
export function decodeOutput(buf) {
  if (!buf.length) return '';
  try { return strictUtf8.decode(buf); } catch { /* some line is not UTF-8 */ }
  let out = '';
  let start = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl < 0 ? buf.length : nl + 1;
    const line = buf.subarray(start, end);
    let text = null;
    try { text = strictUtf8.decode(line); } catch {
      const legacy = mostlyUtf8(line) ? null : consoleDecoder();
      if (legacy) { try { text = legacy.decode(line); } catch { /* neither */ } }
    }
    out += text ?? lenientUtf8.decode(line);
    start = end;
  }
  return out;
}

export class OutputDecoder {
  constructor() { this.pending = null; }

  // The text of `chunk` that can be decoded now. An unfinished last line waits for the next chunk when it has
  // non-ASCII bytes (it could end inside a character); a long one is let through at a UTF-8 character boundary.
  write(chunk) {
    let buf = this.pending ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = null;
    const cut = buf.lastIndexOf(0x0a) + 1;
    const tail = buf.subarray(cut);
    if (!tail.length || isAscii(tail)) return decodeOutput(buf);
    if (tail.length > 65_536) {
      let keep = tail.length;
      for (let i = tail.length - 1; i >= tail.length - 3 && i >= 0; i--) {
        if (tail[i] < 0x80) break;
        if (tail[i] >= 0xc0) { if (tail.length - i < (tail[i] >= 0xf0 ? 4 : tail[i] >= 0xe0 ? 3 : 2)) keep = i; break; }
      }
      this.pending = keep < tail.length ? Buffer.from(tail.subarray(keep)) : null;
      return decodeOutput(buf.subarray(0, cut + keep));
    }
    this.pending = Buffer.from(tail);
    return decodeOutput(buf.subarray(0, cut));
  }

  // What is still held back, at the end of the stream.
  end() {
    const rest = this.pending;
    this.pending = null;
    return rest ? decodeOutput(rest) : '';
  }
}
