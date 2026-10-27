// The prompt input box: multi-line editing, history, paste handling and completions.

import { c, graphemes, graphemeWidth, stringWidth, truncate, padEnd } from './ansi.js';

const PASTE_THRESHOLD_CHARS = 800;
const PASTE_THRESHOLD_LINES = 8;
const QUOTE_PREVIEW_LINES = 3; // of a quote, shown in the transcript (see quotePreview)

// What the model gets for a quote (see Editor.insertQuote): the text, and the line of the conversation it is under.
export function quoteBlock(text, source = '') {
  return `<quote${source ? ` source="${source.replace(/"/g, '&quot;')}"` : ''}>\n${text}\n</quote>`;
}

// How a quote shows in the transcript: where it is from, then its first lines, each behind a bar.
export function quotePreview(text, source = '') {
  const lines = text.split('\n');
  const shown = lines.slice(0, QUOTE_PREVIEW_LINES).map((l) => `│ ${l.length > 200 ? `${l.slice(0, 199)}…` : l}`);
  if (lines.length > QUOTE_PREVIEW_LINES) shown.push(`│ … +${lines.length - QUOTE_PREVIEW_LINES} lines`);
  return [...(source ? [`Quoting ${source}${/[:：]$/.test(source) ? '' : ':'}`] : []), ...shown].join('\n');
}

// A message as it was sent, each quote in it (see quoteBlock) as the transcript shows it (see quotePreview): for a
// conversation shown again, resumed or on the web page.
export function shownQuotes(text) {
  return String(text).replace(/<quote(?: source="([^"]*)")?>\n([\s\S]*?)\n<\/quote>/g, (_, source = '', body) => quotePreview(body, source.replace(/&quot;/g, '"')));
}

// "╭─ left ───── right ─╮", the parts cut short to fit (the start of the directory goes first).
export function topBorder(boxW, color, title) {
  const plain = () => color('╭' + '─'.repeat(boxW - 2) + '╮');
  if (!title || (!title.left && !title.right)) return plain();
  const room = boxW - 6; // the corners, a dash at each end and a space each side of a part
  const right = title.right ? truncate(title.right, Math.max(0, Math.floor(room / 3))).replace(/\x1b\[0m$/, '') : '';
  const rightW = right ? stringWidth(right) + 2 : 0;
  let left = title.left || '';
  const leftRoom = room - rightW - (right && left ? 1 : 0) - 2;
  if (leftRoom < 4) left = '';
  else if (stringWidth(left) > leftRoom) {
    const chars = [...left];
    while (chars.length && stringWidth(chars.join('')) > leftRoom - 1) chars.shift();
    left = '…' + chars.join('');
  }
  if (!left && !right) return plain();
  const leftPart = left ? ` ${left} ` : '';
  const rightPart = right ? ` ${right} ` : '';
  const dashes = boxW - 4 - stringWidth(leftPart) - stringWidth(rightPart);
  if (dashes < 1) return plain();
  return color('╭─') + c.dim(leftPart) + color('─'.repeat(dashes)) + (right ? c.blue(rightPart) : '') + color('─╮');
}

// Start of the line the cursor is on. (lastIndexOf with a negative start still looks at index 0, so a
// text that begins with a newline made the cursor at 0 appear to be on its second line.)
function lineStartOf(text, cursor) {
  return cursor <= 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1;
}

function prevBoundary(text, i) {
  if (i <= 0) return 0;
  const gs = graphemes(text.slice(0, i));
  return i - gs[gs.length - 1].length;
}

function nextBoundary(text, i) {
  if (i >= text.length) return text.length;
  const g = graphemes(text.slice(i, i + 8))[0];
  return i + g.length;
}

function wordLeft(text, i) {
  let j = i;
  while (j > 0 && /\s/.test(text[j - 1])) j--;
  while (j > 0 && !/\s/.test(text[j - 1])) j--;
  return j;
}

// How `body` is shown in a box `textW` columns wide: its rows, each with the cursor stops on it ({i: index in
// body, col}). A long line wraps onto more rows; every index has exactly one stop (one where a row wraps is at the
// start of the next row, the end of a line is where its newline is). The input box draws these rows, and up and
// down move between them, so that they move through a long wrapped line too.
export function layoutRows(body, textW) {
  const row = () => ({ text: '', width: 0, stops: [] });
  const rows = [row()];
  let idx = 0;
  for (const g of graphemes(body)) {
    let r = rows[rows.length - 1];
    if (g === '\n') {
      r.stops.push({ i: idx, col: r.width });
      rows.push(row());
    } else {
      const w = graphemeWidth(g);
      if (r.width && r.width + w > textW) { r = row(); rows.push(r); }
      r.stops.push({ i: idx, col: r.width });
      r.text += g === '\t' ? '    ' : g;
      r.width += w;
    }
    idx += g.length;
  }
  let last = rows[rows.length - 1];
  if (last.width >= textW) { last = row(); rows.push(last); }
  last.stops.push({ i: body.length, col: last.width });
  return rows;
}

function wordRight(text, i) {
  let j = i;
  while (j < text.length && /\s/.test(text[j])) j++;
  while (j < text.length && !/\s/.test(text[j])) j++;
  return j;
}

export class Editor {
  // onDoubleEscape: esc esc on an empty prompt (the App opens the rewind menu, as Claude Code does).
  constructor({ history = [], onSubmit, getSuggestions, onChange, imageFromPath, onDoubleEscape } = {}) {
    this.text = '';
    this.cursor = 0;
    this.history = history; // oldest first
    this.historyIndex = null;
    this.draft = '';
    this.onSubmit = onSubmit;
    this.getSuggestions = getSuggestions;
    this.onChange = onChange;
    this.suggestions = null;
    this.selected = 0;
    this.pastes = new Map();
    this.pasteCounter = 0;
    this.images = new Map(); // "[Image #1]" -> {media_type, data}
    this.imageCounter = 0;
    this.quotes = new Map(); // "[Quote #1 +3 lines]" -> how it shows in the transcript (its text is in `pastes`)
    this.quoteCounter = 0;
    this.imageFromPath = imageFromPath; // (path) => image | null, for pasted/dropped image files
    this.pasting = false;
    this.pasteBuf = '';
    this.pendingSubmit = null;
    this.lastEscape = 0;
    this.suggestionsDismissedFor = null;
    this.onDoubleEscape = onDoubleEscape;
    this.textW = 76; // the width of the text in the box, as last drawn: up and down move by the rows shown
    this.goalCol = null; // the column up and down aim for, kept while they are pressed in a row
  }

  get mode() {
    if (this.text.startsWith('!')) return 'bash';
    if (this.text.startsWith('#')) return 'memory';
    return 'prompt';
  }

  set(text, cursor = text.length) {
    this.text = text;
    this.cursor = Math.max(0, Math.min(cursor, text.length));
    this.refreshSuggestions();
    this.onChange?.();
  }

  clear() {
    this.set('');
    this.pastes = new Map();
    this.images = new Map();
    this.imageCounter = 0;
    this.quotes = new Map();
    this.historyIndex = null;
  }

  // Clear a draft the user threw away (ctrl+c, esc esc), as Claude Code does: up on the empty prompt brings it back,
  // with its pasted text and images, even after other messages were sent meanwhile.
  discard() {
    if (this.text.trim()) {
      this.cleared = { text: this.text, cursor: this.cursor, pastes: this.pastes, images: this.images, imageCounter: this.imageCounter, quotes: this.quotes };
    }
    this.clear();
  }

  // The rows the text is shown in (see layoutRows), and the row and column of the cursor among them.
  place() {
    const offset = this.mode === 'prompt' ? 0 : 1; // the ! or # is drawn as the prompt sign, not as text
    const rows = layoutRows(this.text.slice(offset), this.textW);
    const at = Math.max(0, this.cursor - offset);
    let r = 0;
    let col = 0;
    rows.forEach((row, ri) => { for (const st of row.stops) if (st.i <= at) { r = ri; col = st.col; } });
    return { rows, r, col, offset };
  }

  // Up (-1) or down (1) a row shown, towards the column it started from. False on the first / last row.
  moveRow(dir) {
    const { rows, r, col, offset } = this.place();
    const target = r + dir;
    if (target < 0 || target >= rows.length) return false;
    this.goalCol ??= col;
    let best = rows[target].stops[0];
    for (const st of rows[target].stops) if (st.col <= this.goalCol) best = st;
    this.set(this.text, best.i + offset);
    return true;
  }

  restoreCleared() {
    const d = this.cleared;
    if (!d || this.text || this.historyIndex !== null) return false;
    this.cleared = null;
    this.pastes = d.pastes;
    this.images = d.images;
    this.imageCounter = d.imageCounter;
    this.quotes = d.quotes || new Map();
    this.set(d.text, d.cursor);
    return true;
  }

  // A part of the conversation quoted in the message (see App.quoteSelection), as ChatGPT's "Ask ChatGPT" does:
  // "[Quote #1 +12 lines]" on a line of its own, the cursor on the line after it, where the question goes. What is
  // sent has the text itself in a <quote>, with the line of the conversation it is under as its source (see
  // quoteBlock), so that the model knows which part is meant; the transcript shows its first lines (see displayed).
  // Deleted like a paste: one backspace takes the whole placeholder.
  insertQuote(text, source = '') {
    const lines = text.split('\n').length;
    const label = `[Quote #${++this.quoteCounter} +${lines} line${lines === 1 ? '' : 's'}]`;
    this.pastes.set(label, quoteBlock(text, source));
    this.quotes.set(label, quotePreview(text, source));
    const before = this.text.slice(0, this.cursor);
    const newline = this.text.slice(this.cursor).startsWith('\n');
    this.insert((before && !before.endsWith('\n') ? '\n' : '') + label + (newline ? '' : '\n'));
    if (newline) this.set(this.text, this.cursor + 1);
    return label;
  }

  insertImage(image) {
    const label = `[Image #${++this.imageCounter}]`;
    this.images.set(label, image);
    const before = this.text.slice(0, this.cursor);
    this.insert((before && !/\s$/.test(before) ? ' ' : '') + label + ' ');
    return label;
  }

  insert(s) {
    this.set(this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor), this.cursor + s.length);
  }

  insertPaste(raw) {
    const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // A pasted or drag-and-dropped image file path becomes an image attachment.
    const candidate = text.trim().replace(/^["']|["']$/g, '');
    if (this.imageFromPath && !candidate.includes('\n') && /\.(png|jpe?g|gif|webp)$/i.test(candidate)) {
      const image = this.imageFromPath(candidate);
      if (image) { this.insertImage(image); return; }
    }
    const lines = text.split('\n').length;
    if (text.length > PASTE_THRESHOLD_CHARS || lines > PASTE_THRESHOLD_LINES) {
      const id = ++this.pasteCounter;
      const label = `[Pasted text #${id} +${lines} lines]`;
      this.pastes.set(label, text);
      this.insert(label);
    } else {
      this.insert(text);
    }
  }

  // Text with paste placeholders expanded.
  expanded() {
    let t = this.text;
    for (const [label, content] of this.pastes) t = t.split(label).join(content);
    return t;
  }

  // The text as the transcript shows it: as expanded(), but each quote as its first lines (see quotePreview).
  displayed() {
    let t = this.text;
    for (const [label, content] of this.pastes) t = t.split(label).join(this.quotes.get(label) ?? content);
    return t;
  }

  refreshSuggestions() {
    if (!this.getSuggestions || this.suggestionsDismissedFor === this.text) { this.suggestions = null; return; }
    const s = this.getSuggestions(this.text, this.cursor);
    this.suggestions = s && s.items.length ? s : null;
    if (!this.suggestions || this.selected >= this.suggestions.items.length) this.selected = 0;
  }

  acceptSuggestion() {
    const s = this.suggestions;
    if (!s) return null;
    const item = s.items[this.selected];
    const before = this.text.slice(0, s.from);
    const after = this.text.slice(s.to);
    const value = item.value + (item.noSpace ? '' : ' ');
    this.set(before + value + after.replace(/^ /, ''), before.length + value.length);
    this.suggestions = null;
    return item;
  }

  submit() {
    const value = this.expanded();
    const raw = this.text;
    // `display`: how the message shows in the transcript, when that is not `value` (a quote shows its first lines)
    const display = [...this.quotes.keys()].some((label) => raw.includes(label)) ? this.displayed() : undefined;
    // Only images whose placeholder is still in the text are sent.
    const images = [...this.images].filter(([label]) => raw.includes(label)).map(([, img]) => img);
    if (raw.trim() && this.history[this.history.length - 1] !== raw) this.history.push(raw);
    this.clear();
    this.onSubmit?.(value, raw, images, display);
  }

  // Returns true when the key was consumed.
  handleKey(str, key = {}) {
    // A return key immediately followed by more input in the same tick is part of a paste.
    if (this.pendingSubmit) {
      clearImmediate(this.pendingSubmit);
      this.pendingSubmit = null;
      this.insert('\n');
    }
    if (key.name === 'paste-start') { this.pasting = true; this.pasteBuf = ''; return true; }
    if (key.name === 'paste-end') { this.pasting = false; this.insertPaste(this.pasteBuf); this.pasteBuf = ''; return true; }
    if (this.pasting) {
      if (key.name === 'return' || key.name === 'enter') this.pasteBuf += '\n';
      else if (str) this.pasteBuf += str;
      return true;
    }

    const name = key.name;
    if (!(name === 'up' || name === 'down' || (key.ctrl && (name === 'p' || name === 'n')))) this.goalCol = null;
    if (name === 'return' && !key.meta && !key.shift) {
      if (this.suggestions) {
        const item = this.acceptSuggestion();
        if (item?.submitOnEnter) { this.submit(); return true; }
        return true;
      }
      const before = this.text.slice(0, this.cursor);
      if (before.endsWith('\\')) {
        this.set(before.slice(0, -1) + '\n' + this.text.slice(this.cursor), this.cursor);
        return true;
      }
      this.pendingSubmit = setImmediate(() => { this.pendingSubmit = null; this.submit(); });
      return true;
    }
    if ((name === 'return' && (key.meta || key.shift)) || name === 'enter' || key.sequence === '\x1b[13;2u') {
      this.insert('\n');
      return true;
    }
    if (name === 'tab' && !key.shift) {
      if (this.suggestions) this.acceptSuggestion();
      return true;
    }
    if (name === 'escape') {
      if (this.suggestions) { this.suggestionsDismissedFor = this.text; this.suggestions = null; return true; }
      const now = Date.now();
      const twice = key.meta || now - this.lastEscape < 800; // meta: ESC ESC arriving in one chunk
      if (twice && this.text) { this.discard(); this.lastEscape = 0; return true; }
      if (twice && this.onDoubleEscape) { this.lastEscape = 0; this.onDoubleEscape(); return true; }
      this.lastEscape = now;
      return false;
    }
    // Up and down move through the rows shown, a long line's wrapped rows too. On the first row up goes to the
    // start of the text first (when there is more than one row), and only from there to the history; down likewise.
    if (name === 'up' || (key.ctrl && name === 'p')) {
      if (this.suggestions) { this.selected = (this.selected - 1 + this.suggestions.items.length) % this.suggestions.items.length; this.onChange?.(); return true; }
      if (this.moveRow(-1)) return true;
      if (this.cursor > 0 && this.place().rows.length > 1) { this.set(this.text, 0); return true; }
      return this.restoreCleared() || this.historyPrev();
    }
    if (name === 'down' || (key.ctrl && name === 'n')) {
      if (this.suggestions) { this.selected = (this.selected + 1) % this.suggestions.items.length; this.onChange?.(); return true; }
      if (this.moveRow(1)) return true;
      if (this.cursor < this.text.length && this.place().rows.length > 1) { this.set(this.text, this.text.length); return true; }
      return this.historyNext();
    }
    if (name === 'left' || (key.ctrl && name === 'b')) {
      this.set(this.text, key.ctrl || key.meta ? wordLeft(this.text, this.cursor) : prevBoundary(this.text, this.cursor));
      return true;
    }
    if (name === 'right' || (key.ctrl && name === 'f')) {
      this.set(this.text, key.ctrl || key.meta ? wordRight(this.text, this.cursor) : nextBoundary(this.text, this.cursor));
      return true;
    }
    if (key.meta && name === 'b') { this.set(this.text, wordLeft(this.text, this.cursor)); return true; }
    if (key.meta && name === 'f') { this.set(this.text, wordRight(this.text, this.cursor)); return true; }
    if (name === 'home' || (key.ctrl && name === 'a')) {
      this.set(this.text, lineStartOf(this.text, this.cursor));
      return true;
    }
    if (name === 'end' || (key.ctrl && name === 'e')) {
      const e = this.text.indexOf('\n', this.cursor);
      this.set(this.text, e < 0 ? this.text.length : e);
      return true;
    }
    if (name === 'backspace') {
      if (key.meta || key.ctrl) return this.handleKey('', { ctrl: true, name: 'w' });
      if (this.cursor === 0) return true;
      // Delete a whole paste/image placeholder at once.
      for (const [map, label] of [...[...this.pastes.keys()].map((l) => [this.pastes, l]), ...[...this.images.keys()].map((l) => [this.images, l])]) {
        if (this.text.slice(0, this.cursor).endsWith(label)) {
          map.delete(label);
          this.set(this.text.slice(0, this.cursor - label.length) + this.text.slice(this.cursor), this.cursor - label.length);
          return true;
        }
      }
      const p = prevBoundary(this.text, this.cursor);
      this.set(this.text.slice(0, p) + this.text.slice(this.cursor), p);
      return true;
    }
    if (name === 'delete' || (key.ctrl && name === 'd' && this.text)) {
      const n = nextBoundary(this.text, this.cursor);
      this.set(this.text.slice(0, this.cursor) + this.text.slice(n), this.cursor);
      return true;
    }
    if (key.ctrl && name === 'w') {
      const p = wordLeft(this.text, this.cursor);
      this.set(this.text.slice(0, p) + this.text.slice(this.cursor), p);
      return true;
    }
    if (key.ctrl && name === 'u') {
      const s = lineStartOf(this.text, this.cursor);
      this.set(this.text.slice(0, s) + this.text.slice(this.cursor), s);
      return true;
    }
    if (key.ctrl && name === 'k') {
      const e = this.text.indexOf('\n', this.cursor);
      this.set(this.text.slice(0, this.cursor) + (e < 0 ? '' : this.text.slice(e)), this.cursor);
      return true;
    }
    if (key.ctrl || (key.meta && name && name.length > 1)) return false;
    if (str && !/^[\x00-\x08\x0b-\x1f\x7f]$/.test(str) && !(str.startsWith('\x1b') && str.length > 1)) {
      const text = str.replace(/\r\n?/g, '\n');
      if (text.length > 1 && text.includes('\n')) this.insertPaste(text);
      else this.insert(text);
      return true;
    }
    return false;
  }

  historyPrev() {
    this.goalCol = null;
    if (!this.history.length) return true;
    if (this.historyIndex === null) { this.draft = this.text; this.historyIndex = this.history.length; }
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.set(this.history[this.historyIndex]);
    }
    return true;
  }

  historyNext() {
    this.goalCol = null;
    if (this.historyIndex === null) return true;
    this.historyIndex++;
    if (this.historyIndex >= this.history.length) {
      this.historyIndex = null;
      this.set(this.draft);
    } else {
      this.set(this.history[this.historyIndex]);
    }
    return true;
  }

  // Render as a rounded box. Returns {lines, cursor:{row,col}}.
  // `title`: {left, right}, shown in the top border (left: the directory; right: the session's name).
  render(width, { placeholder = '', active = true, borderColor, title = null } = {}) {
    const boxW = Math.max(20, width - 1);
    const textW = boxW - 6;
    const mode = this.mode;
    const color = borderColor || (mode === 'bash' ? c.magenta : mode === 'memory' ? c.blue : c.gray);
    const promptCh = mode === 'bash' ? '!' : mode === 'memory' ? '#' : '>';
    const body = mode === 'prompt' ? this.text : this.text.slice(1);
    this.textW = textW;
    const { rows: laid, r, col } = this.place();
    const rows = laid.map((row) => row.text);
    const cur = { row: r, col };

    const lines = [topBorder(boxW, color, title)];
    rows.forEach((r, i) => {
      let content = r;
      if (!body && i === 0 && placeholder) content = c.dim(truncate(placeholder, textW));
      const lead = i === 0 ? (mode === 'prompt' ? promptCh : color(promptCh)) + ' ' : '  ';
      lines.push(color('│') + ' ' + lead + padEnd(content, textW) + ' ' + color('│'));
    });
    lines.push(color('╰' + '─'.repeat(boxW - 2) + '╯'));
    return { lines, cursor: active ? { row: cur.row + 1, col: 4 + cur.col } : null };
  }

  renderSuggestions(width) {
    if (!this.suggestions) return [];
    const items = this.suggestions.items;
    const max = 8;
    const start = Math.max(0, Math.min(this.selected - Math.floor(max / 2), items.length - max));
    const shown = items.slice(start, start + max);
    const labelW = Math.min(30, Math.max(...shown.map((i) => stringWidth(i.label))) + 2);
    return shown.map((item, k) => {
      const sel = start + k === this.selected;
      const label = padEnd(truncate(item.label, labelW), labelW);
      const desc = item.description ? truncate(item.description, Math.max(10, width - labelW - 6)) : '';
      return sel ? '  ' + c.permission(label) + c.permission(desc) : '  ' + c.gray(label) + c.dim(desc);
    });
  }
}
