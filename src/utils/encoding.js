// Text files in the encodings met on Chinese Windows machines: UTF-8 (with or without a BOM), UTF-16 with a BOM
// (what Windows PowerShell 5 redirects to), and GBK (code page 936: legacy projects, files saved by older tools).
// decodeText() says which one a file is in and encodeText() writes text back in it, so that an edit leaves every
// byte it did not change as it was. Decoding everything as UTF-8 used to turn each Chinese character of a GBK file
// into U+FFFD on its first edit. A file that is none of these is marked `lossy`: it can be read, not rewritten.

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const lenientUtf8 = new TextDecoder('utf-8');
const strictGbk = new TextDecoder('gbk', { fatal: true }); // the WHATWG gbk decoder, which is the gb18030 one

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
  if (!bom) {
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
