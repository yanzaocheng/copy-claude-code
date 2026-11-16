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
  claude: hex('#d77757'), // the orange brand accent
  permission: hex('#b1b9f9'),
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

// Some Windows conhosts render symbols such as ·, … and ↓ in two cells even in UTF-8. Use the cursor
// advances measured at startup instead of guessing from the code page (or changing the user's console settings).
const terminalWidths = new Map();
export function setTerminalWidths(widths) {
  terminalWidths.clear();
  for (const [char, width] of widths) {
    if (width === 1 || width === 2) terminalWidths.set(char.codePointAt(0), width);
  }
}

export function codePointWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRanges(cp, ZERO)) return 0;
  return terminalWidths.get(cp) ?? (inRanges(cp, WIDE) ? 2 : 1);
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
  // Emoji presentation selector or ZWJ sequences render wide, and so does a flag (two regional indicators).
  if (g.length > 1 && w === 1 && (/[️‍]/.test(g) || (cp >= 0x1f1e6 && cp <= 0x1f1ff))) w = 2;
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

// The SGR state (colours and attributes) after `params` (what is between ESC[ and m), from `s`.
function sgrApply(s, params) {
  const p = params === '' ? [0] : params.split(';').map(Number);
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0) s = {};
    else if (n === 1) s.bold = 1; else if (n === 2) s.dim = 2; else if (n === 22) { delete s.bold; delete s.dim; }
    else if (n === 3) s.italic = 3; else if (n === 23) delete s.italic;
    else if (n === 4) s.underline = 4; else if (n === 24) delete s.underline;
    else if (n === 7) s.inverse = 7; else if (n === 27) delete s.inverse;
    else if (n === 9) s.strike = 9; else if (n === 29) delete s.strike;
    else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) s.fg = n; else if (n === 39) delete s.fg;
    else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) s.bg = n; else if (n === 49) delete s.bg;
    else if (n === 38 || n === 48) {
      const key = n === 38 ? 'fg' : 'bg';
      if (p[i + 1] === 5) { s[key] = `${n};5;${p[i + 2]}`; i += 2; }
      else if (p[i + 1] === 2) { s[key] = `${n};2;${p[i + 2]};${p[i + 3]};${p[i + 4]}`; i += 4; }
    }
  }
  return s;
}

// The rows a line was wrapped onto, each one after the first starting in the colours the row before it ended in: the
// screen resets them at the end of every row, so a bold or coloured span that was wrapped lost them on its next rows.
function carryStyles(rows) {
  let s = {};
  return rows.map((row, i) => {
    const codes = Object.values(s);
    const out = i && codes.length ? `\x1b[${codes.join(';')}m${row}` : row;
    for (const m of row.matchAll(/\x1b\[([0-9;]*)m/g)) s = sgrApply(s, m[1]);
    return out;
  });
}

// Hard-wrap a (possibly ANSI colored) single line to the given width. Returns array of lines.
export function wrapLine(line, width) {
  const rows = hardWrap(line, width);
  return rows.length > 1 ? carryStyles(rows) : rows;
}

function hardWrap(line, width) {
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

// A run of text with CJK in it: such text has no spaces between its words (see wordWrap).
const CJK = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;
// What does not start a row (closing punctuation) and what does not end one (opening brackets), as CJK typesetting
// has it.
const NO_ROW_START = /^[，。、；：？！）」』】》〉’”…,.;:?!)\]}]$/;
const NO_ROW_END = /^[（「『【《〈‘“([{]$/;

// `word` cut where its first `room` columns end, or before: [head, rest], head '' when no place fits. It is cut only
// next to a wide character, never inside a run of narrow ones (an English word, a number, a path) nor before
// closing punctuation; colour codes in front of a character stay with it.
function cutNearWide(word, room) {
  let at = 0, w = 0, cut = 0, prevEnd = 0, prevWide = false, prev = null;
  for (const tok of tokenize(word)) {
    if (tok.ansi) { at += tok.t.length; continue; }
    const tw = tok.t === '\t' ? 4 : tok.w;
    const wide = tw > 1;
    if (prev !== null && (wide || prevWide) && !NO_ROW_START.test(tok.t) && !NO_ROW_END.test(prev)) cut = prevEnd;
    if (w + tw > room) break;
    w += tw;
    at += tok.t.length;
    prevEnd = at;
    prevWide = wide;
    prev = tok.t;
  }
  return cut ? [word.slice(0, cut), word.slice(cut)] : ['', word];
}

// Word-aware wrap for prose; falls back to hard wrap for long words. A run with CJK in it that does not fit goes on
// in the rest of the row (see cutNearWide): moved to a row of its own, as an English word is, it left a short ragged
// row before every such run ("先用 Node 24 " alone, the Chinese after it on the next rows).
export function wordWrap(line, width) {
  width = Math.max(1, width);
  if (stringWidth(line) <= width) return [line];
  const words = line.split(/(\s+)/);
  const lines = [];
  let cur = '', curW = 0;
  const flush = () => { lines.push(cur); cur = ''; curW = 0; };
  for (let word of words) {
    if (!word) continue;
    let w = stringWidth(word);
    if (curW + w <= width) { cur += word; curW += w; continue; }
    if (/^\s+$/.test(word)) { flush(); continue; }
    if (CJK.test(word)) {
      while (curW + w > width) {
        const [head, rest] = cutNearWide(word, width - curW);
        if (head) { cur += head; flush(); word = rest; w = stringWidth(word); continue; }
        if (curW > 0) { flush(); continue; }
        // no place to cut on a whole row either (a long run of narrow characters): anywhere
        const parts = hardWrap(word, width);
        lines.push(...parts.slice(0, -1));
        word = parts[parts.length - 1];
        w = stringWidth(word);
      }
      cur += word;
      curW += w;
      continue;
    }
    if (curW > 0) { lines.push(cur); cur = ''; curW = 0; }
    if (w > width) {
      const parts = hardWrap(word, width);
      lines.push(...parts.slice(0, -1));
      cur = parts[parts.length - 1];
      curW = stringWidth(cur);
    } else { cur = word; curW = w; }
  }
  lines.push(cur);
  return lines.length > 1 ? carryStyles(lines) : lines;
}

// Cut a (possibly ANSI colored) string to `width` columns, ending in `ellipsis` when it was longer. It reads only as
// far as the width reaches: the live region calls it every frame on queued messages, tool input and commands of any
// length, and measuring all of a 200 KB paste first took some 50 ms a frame.
export function truncate(s, width, ellipsis = '…') {
  const room = width - stringWidth(ellipsis);
  let out = '', w = 0;
  let cut = null; // what fits before the ellipsis, once the string has gone past `room`
  const take = (text) => { // true: the string is wider than `width`
    for (const { segment: g } of segmenter.segment(text)) {
      const gw = graphemeWidth(g);
      if (cut === null && w + gw > room) cut = out;
      if (w + gw > width) return true;
      out += g;
      w += gw;
    }
    return false;
  };
  const re = new RegExp(ANSI_RE.source, 'g');
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last && take(s.slice(last, m.index))) return cut + ellipsis + (colorEnabled ? '\x1b[0m' : '');
    out += m[0];
    last = m.index + m[0].length;
  }
  if (last < s.length && take(s.slice(last))) return cut + ellipsis + (colorEnabled ? '\x1b[0m' : '');
  return s;
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
  up: (n) => (n > 0 ? `\x1b[${n}A` : ''),
  right: (n) => (n > 0 ? `\x1b[${n}C` : ''),
  bracketedPasteOn: '\x1b[?2004h',
  bracketedPasteOff: '\x1b[?2004l',
  clearScreen: '\x1b[2J\x1b[3J\x1b[H',
};
