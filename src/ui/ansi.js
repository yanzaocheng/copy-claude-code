// Terminal primitives: colors, ANSI-aware string width (CJK / emoji aware), wrapping, truncation.

const out = process.stdout;
const depth = process.env.NO_COLOR ? 1 : (out.isTTY && out.getColorDepth ? out.getColorDepth() : (process.env.FORCE_COLOR ? 24 : 1));

const sgr = (open, close) => (s) => (depth <= 1 ? String(s) : `\x1b[${open}m${s}\x1b[${close}m`);

function rgbTo256(r, g, b) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const c = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * c(r) + 6 * c(g) + c(b);
}

function rgbTo16(r, g, b) {
  const bright = Math.max(r, g, b) > 170 ? 60 : 0;
  const code = (b > 127 ? 4 : 0) | (g > 127 ? 2 : 0) | (r > 127 ? 1 : 0);
  return 30 + code + bright;
}

function hex(h, bg = false) {
  const n = parseInt(h.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (depth <= 1) return (s) => String(s);
  if (depth >= 24) return sgr(`${bg ? 48 : 38};2;${r};${g};${b}`, bg ? 49 : 39);
  if (depth >= 8) return sgr(`${bg ? 48 : 38};5;${rgbTo256(r, g, b)}`, bg ? 49 : 39);
  const c = rgbTo16(r, g, b);
  return sgr(bg ? c + 10 : c, bg ? 49 : 39);
}

export const c = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  underline: sgr(4, 24),
  inverse: sgr(7, 27),
  strike: sgr(9, 29),
  red: hex('#ff6b80'),
  green: hex('#4eba65'),
  yellow: hex('#ffc107'),
  blue: hex('#7aa2f7'),
  cyan: hex('#56b6c2'),
  magenta: hex('#c678dd'),
  gray: hex('#8a8a8a'),
  white: hex('#ffffff'),
  claude: hex('#d77757'), // the orange brand accent
  permission: hex('#b1b9f9'),
  plan: hex('#48968c'),
  edits: hex('#af87ff'),
  code: hex('#b1b9f9'),
  userBg: hex('#373737', true), // the band behind the user's messages (see renderUserMessage)
  userText: hex('#e4e4e4'),
  diffAdd: hex('#225c2b', true),
  diffDel: hex('#7a2936', true),
  diffAddWord: hex('#38a660', true),
  diffDelWord: hex('#b3596b', true),
};

export const colorEnabled = depth > 1;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

const ZERO = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f], [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x2064], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0xe0100, 0xe01ef],
];

function inRanges(cp, ranges) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

export function codePointWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRanges(cp, ZERO)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemes(s) {
  const res = [];
  for (const { segment } of segmenter.segment(s)) res.push(segment);
  return res;
}

export function graphemeWidth(g) {
  if (g === '\t') return 4;
  const cp = g.codePointAt(0);
  let w = codePointWidth(cp);
  // Emoji presentation selector or ZWJ sequences render wide.
  if (g.length > 1 && /[️‍]/.test(g) && w === 1) w = 2;
  return w;
}

export function stringWidth(s) {
  s = stripAnsi(s);
  let w = 0;
  // fast path for ASCII
  if (/^[\x20-\x7e]*$/.test(s)) return s.length;
  for (const g of graphemes(s)) w += graphemeWidth(g);
  return w;
}

// Tokenize a string into ANSI escape tokens and grapheme tokens.
function tokenize(s) {
  const tokens = [];
  let last = 0;
  ANSI_RE.lastIndex = 0;
  let m;
  while ((m = ANSI_RE.exec(s))) {
    if (m.index > last) for (const g of graphemes(s.slice(last, m.index))) tokens.push({ t: g, w: graphemeWidth(g) });
    tokens.push({ t: m[0], w: 0, ansi: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) for (const g of graphemes(s.slice(last))) tokens.push({ t: g, w: graphemeWidth(g) });
  return tokens;
}

// Hard-wrap a (possibly ANSI colored) single line to the given width. Returns array of lines.
export function wrapLine(line, width) {
  width = Math.max(1, width);
  if (stringWidth(line) <= width) return [line];
  const lines = [];
  let cur = '', curW = 0;
  for (const tok of tokenize(line)) {
    if (tok.ansi) { cur += tok.t; continue; }
    const tw = tok.t === '\t' ? 4 : tok.w;
    const text = tok.t === '\t' ? '    ' : tok.t;
    if (curW + tw > width && curW > 0) {
      lines.push(cur);
      cur = '';
      curW = 0;
    }
    cur += text;
    curW += tw;
  }
  lines.push(cur);
  return lines;
}

// Word-aware wrap for prose; falls back to hard wrap for long words.
export function wordWrap(line, width) {
  width = Math.max(1, width);
  if (stringWidth(line) <= width) return [line];
  const words = line.split(/(\s+)/);
  const lines = [];
  let cur = '', curW = 0;
  for (const word of words) {
    if (!word) continue;
    const w = stringWidth(word);
    if (curW + w <= width) { cur += word; curW += w; continue; }
    if (/^\s+$/.test(word)) { lines.push(cur); cur = ''; curW = 0; continue; }
    if (curW > 0) { lines.push(cur); cur = ''; curW = 0; }
    if (w > width) {
      const parts = wrapLine(word, width);
      lines.push(...parts.slice(0, -1));
      cur = parts[parts.length - 1];
      curW = stringWidth(cur);
    } else { cur = word; curW = w; }
  }
  lines.push(cur);
  return lines;
}

export function truncate(s, width, ellipsis = '…') {
  if (stringWidth(s) <= width) return s;
  let res = '', w = 0;
  const ew = stringWidth(ellipsis);
  for (const tok of tokenize(s)) {
    if (tok.ansi) { res += tok.t; continue; }
    if (w + tok.w > width - ew) break;
    res += tok.t;
    w += tok.w;
  }
  return res + ellipsis + (colorEnabled ? '\x1b[0m' : '');
}

export function padEnd(s, width) {
  const w = stringWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function termWidth() {
  return Math.max(20, (process.stdout.columns || 100));
}

export const ESC = {
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearDown: '\x1b[0J',
  clearLine: '\x1b[2K',
  up: (n) => (n > 0 ? `\x1b[${n}A` : ''),
  down: (n) => (n > 0 ? `\x1b[${n}B` : ''),
  right: (n) => (n > 0 ? `\x1b[${n}C` : ''),
  col0: '\r',
  bracketedPasteOn: '\x1b[?2004h',
  bracketedPasteOff: '\x1b[?2004l',
  clearScreen: '\x1b[2J\x1b[3J\x1b[H',
};
