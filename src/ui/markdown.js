// Streaming markdown -> ANSI renderer. Text arrives in small deltas; complete lines are
// rendered immediately (tables are buffered until they end) and the in-progress line
// can be previewed separately.

import { c, stringWidth, wordWrap, wrapLine } from './ansi.js';

const KEYWORDS = new Set(('abstract as async await break case catch class const continue debugger def default del delete do elif else enum export extends ' +
  'false final finally fn for from func function go if impl import in instanceof interface is lambda let loop match mod module mut new nil none null ' +
  'package pass private protected pub public raise return self static struct super switch this throw throws trait true try type typeof undefined ' +
  'use var void where while with yield None True False').split(' '));

export function highlightCode(line, lang = '') {
  const hashComments = /^(py|python|sh|bash|shell|zsh|rb|ruby|yaml|yml|toml|r|perl|pl|dockerfile|make|makefile|ps1|powershell)$/i.test(lang);
  const out = [];
  const re = hashComments
    ? /(#.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d[\d_.]*(?:e\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z_$\d"'#]+)/g
    : /(\/\/.*$|\/\*.*?\*\/|<!--.*?-->)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.]*(?:e\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z_$\d"'`/]+|\/)/g;
  let m;
  let last = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) out.push(c.gray(m[1]));
    else if (m[2]) out.push(c.green(m[2]));
    else if (m[3]) out.push(c.yellow(m[3]));
    else if (m[4]) out.push(KEYWORDS.has(m[4]) ? c.magenta(m[4]) : /^[A-Z]/.test(m[4]) ? c.cyan(m[4]) : m[4]);
    else out.push(m[0]);
    if (m[0] === '') re.lastIndex++;
  }
  if (last < line.length) out.push(line.slice(last));
  return out.join('');
}

export function renderInline(text) {
  const parts = text.split(/(`+[^`]+?`+)/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return c.code(part.replace(/^`+|`+$/g, ''));
    return part
      .replace(/\[([^\]]+)\]\((\S+?)\)/g, (m, t, u) => (t === u ? c.blue(u) : `${t} ${c.dim(`(${u})`)}`))
      .replace(/\*\*\*([^*]+)\*\*\*/g, (m, t) => c.bold(c.italic(t)))
      .replace(/\*\*([^*]+)\*\*/g, (m, t) => c.bold(t))
      .replace(/(?<![\w_])__([^_]+)__(?![\w_])/g, (m, t) => c.bold(t))
      .replace(/(?<![\w*\\])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, (m, t) => c.italic(t))
      .replace(/(?<![\w_\\])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g, (m, t) => c.italic(t))
      .replace(/~~([^~]+)~~/g, (m, t) => c.strike(t));
  }).join('');
}

function parseRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const isSeparatorRow = (cells) => cells.length > 0 && cells.every((x) => /^:?-{1,}:?$/.test(x.replace(/\s/g, '')));

export function renderTable(lines, width) {
  const rows = lines.map(parseRow);
  let align = [];
  const body = [];
  let header = null;
  for (let i = 0; i < rows.length; i++) {
    if (i === 1 && isSeparatorRow(rows[i])) {
      align = rows[i].map((x) => (x.trim().endsWith(':') ? (x.trim().startsWith(':') ? 'center' : 'right') : 'left'));
      continue;
    }
    if (i === 0 && rows.length > 1 && isSeparatorRow(rows[1])) header = rows[i];
    else body.push(rows[i]);
  }
  const all = header ? [header, ...body] : body;
  const n = Math.max(...all.map((r) => r.length));
  const rendered = all.map((r) => Array.from({ length: n }, (_, j) => renderInline(r[j] ?? '')));
  const natural = Array.from({ length: n }, (_, j) => Math.max(3, ...rendered.map((r) => stringWidth(r[j]))));
  const overhead = 3 * n + 1;
  const widths = natural.slice();
  while (widths.reduce((a, b) => a + b, 0) + overhead > width) {
    const max = Math.max(...widths);
    if (max <= 6) break;
    widths[widths.indexOf(max)] = max - 1;
  }
  if (widths.reduce((a, b) => a + b, 0) + overhead > width) return lines.map((l) => renderInline(l));
  const border = (l, m, r) => c.gray(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  const out = [border('┌', '┬', '┐')];
  rendered.forEach((row, ri) => {
    const wrapped = row.map((cell, j) => wordWrap(cell, widths[j]));
    const height = Math.max(...wrapped.map((w) => w.length));
    for (let k = 0; k < height; k++) {
      const cells = wrapped.map((w, j) => {
        const text = w[k] ?? '';
        const pad = widths[j] - stringWidth(text);
        const a = align[j] || 'left';
        const t = ri === 0 && header ? c.bold(text) : text;
        if (a === 'right') return ' '.repeat(pad) + t;
        if (a === 'center') return ' '.repeat(Math.floor(pad / 2)) + t + ' '.repeat(Math.ceil(pad / 2));
        return t + ' '.repeat(pad);
      });
      out.push(c.gray('│ ') + cells.join(c.gray(' │ ')) + c.gray(' │'));
    }
    if (ri === 0 && header) out.push(border('├', '┼', '┤'));
  });
  out.push(border('└', '┴', '┘'));
  return out;
}

export class MarkdownStream {
  // firstPrefix is printed before the first line (e.g. "⏺ "), indent before the rest.
  constructor({ width, firstPrefix = '', indent = '', style = (s) => s }) {
    this.width = width;
    this.firstPrefix = firstPrefix;
    this.indent = indent;
    this.style = style;
    this.pending = '';
    this.fence = null;
    this.table = [];
    this.emittedAny = false;
    this.lastBlank = true;
  }

  get contentWidth() { return Math.max(10, this.width - stringWidth(this.indent)); }

  prefix(lines) {
    return lines.map((l) => {
      if (!this.emittedAny) {
        this.emittedAny = true;
        return this.firstPrefix + l;
      }
      return this.indent + l;
    });
  }

  write(delta) {
    this.pending += delta;
    const out = [];
    let i;
    while ((i = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, i).replace(/\r$/, '');
      this.pending = this.pending.slice(i + 1);
      out.push(...this.line(line));
    }
    return out;
  }

  end() {
    const out = [];
    if (this.pending) { out.push(...this.line(this.pending)); this.pending = ''; }
    out.push(...this.flushTable());
    return out;
  }

  // Rendered preview of the incomplete line (not committed).
  partial() {
    if (!this.pending && !this.table.length) return [];
    const saved = { emittedAny: this.emittedAny };
    const lines = [];
    if (this.table.length) lines.push(...this.table.map((l) => renderInline(l)));
    if (this.pending) {
      const p = this.fence ? highlightCode(this.pending, this.fence.lang) : renderInline(this.pending);
      lines.push(...wordWrap(this.style(p), this.contentWidth));
    }
    const res = lines.map((l, idx) => (!saved.emittedAny && idx === 0 ? this.firstPrefix : this.indent) + l);
    return res;
  }

  flushTable() {
    if (!this.table.length) return [];
    const rows = renderTable(this.table, this.contentWidth);
    this.table = [];
    this.lastBlank = false;
    return this.prefix(rows);
  }

  line(raw) {
    const out = [];
    const w = this.contentWidth;
    if (this.fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(raw);
      if (close && close[1][0] === this.fence.marker[0] && close[1].length >= this.fence.marker.length) {
        this.fence = null;
        return out;
      }
      const code = raw.replace(/\t/g, '    ');
      out.push(...this.prefix(wrapLine(highlightCode(code, this.fence.lang), w)));
      return out;
    }
    const tableLike = /^\s*\|.*\|\s*$/.test(raw) || (this.table.length > 0 && /^\s*\|/.test(raw));
    if (tableLike) { this.table.push(raw); return out; }
    if (this.table.length) out.push(...this.flushTable());

    const open = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(raw);
    if (open) { this.fence = { marker: open[1], lang: open[2] || '' }; return out; }

    if (!raw.trim()) {
      if (!this.lastBlank && this.emittedAny) out.push(...this.prefix(['']));
      this.lastBlank = true;
      return out;
    }
    this.lastBlank = false;

    let m;
    if ((m = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw))) {
      const text = renderInline(m[2]);
      const styled = m[1].length === 1 ? c.bold(c.underline(text)) : m[1].length === 2 ? c.bold(text) : c.bold(c.italic(text));
      out.push(...this.prefix(wordWrap(this.style(styled), w)));
      return out;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push(...this.prefix([c.gray('─'.repeat(Math.min(w, 60)))]));
      return out;
    }
    if ((m = /^(\s*)>\s?(.*)$/.exec(raw))) {
      const lines = wordWrap(c.italic(renderInline(m[2])), w - 2).map((l) => c.gray('▎ ') + c.dim(l));
      out.push(...this.prefix(lines));
      return out;
    }
    if ((m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(raw))) {
      const depth = Math.floor(m[1].replace(/\t/g, '  ').length / 2);
      const ordered = /\d/.test(m[2]);
      let bullet = ordered ? m[2] : depth % 2 === 0 ? '•' : '◦';
      if (m[3]) bullet = /x/i.test(m[3]) ? c.green('☒') : '☐';
      const lead = '  '.repeat(depth) + bullet + ' ';
      const leadW = stringWidth(lead);
      const wrapped = wordWrap(this.style(renderInline(m[4])), Math.max(10, w - leadW));
      out.push(...this.prefix(wrapped.map((l, idx) => (idx === 0 ? lead : ' '.repeat(leadW)) + l)));
      return out;
    }
    out.push(...this.prefix(wordWrap(this.style(renderInline(raw.replace(/\t/g, '    '))), w)));
    return out;
  }
}

// Render a complete markdown string at once.
export function renderMarkdown(text, opts) {
  const s = new MarkdownStream(opts);
  return [...s.write(text), ...s.end()];
}

