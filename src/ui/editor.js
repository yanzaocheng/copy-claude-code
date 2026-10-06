// The prompt input box: multi-line editing, history, paste handling and completions.

import { c, graphemes, graphemeWidth, stringWidth, truncate, padEnd } from './ansi.js';

const PASTE_THRESHOLD_CHARS = 800;
const PASTE_THRESHOLD_LINES = 8;

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

function wordRight(text, i) {
  let j = i;
  while (j < text.length && /\s/.test(text[j])) j++;
  while (j < text.length && !/\s/.test(text[j])) j++;
  return j;
}

export class Editor {
  constructor({ history = [], onSubmit, getSuggestions, onChange, imageFromPath } = {}) {
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
    this.imageFromPath = imageFromPath; // (path) => image | null, for pasted/dropped image files
    this.pasting = false;
    this.pasteBuf = '';
    this.pendingSubmit = null;
    this.lastEscape = 0;
    this.suggestionsDismissedFor = null;
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
    this.pastes.clear();
    this.images.clear();
    this.imageCounter = 0;
    this.historyIndex = null;
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
    // Only images whose placeholder is still in the text are sent.
    const images = [...this.images].filter(([label]) => raw.includes(label)).map(([, img]) => img);
    if (raw.trim() && this.history[this.history.length - 1] !== raw) this.history.push(raw);
    this.clear();
    this.onSubmit?.(value, raw, images);
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
      if (key.meta && this.text) { this.clear(); return true; } // ESC ESC arriving in one chunk
      const now = Date.now();
      if (this.text && now - this.lastEscape < 800) { this.clear(); this.lastEscape = 0; return true; }
      this.lastEscape = now;
      return false;
    }
    if (name === 'up' || (key.ctrl && name === 'p')) {
      if (this.suggestions) { this.selected = (this.selected - 1 + this.suggestions.items.length) % this.suggestions.items.length; this.onChange?.(); return true; }
      const lineStart = lineStartOf(this.text, this.cursor);
      if (lineStart > 0) {
        const col = this.cursor - lineStart;
        const prevStart = lineStartOf(this.text, lineStart - 1);
        this.set(this.text, Math.min(prevStart + col, lineStart - 1));
        return true;
      }
      return this.historyPrev();
    }
    if (name === 'down' || (key.ctrl && name === 'n')) {
      if (this.suggestions) { this.selected = (this.selected + 1) % this.suggestions.items.length; this.onChange?.(); return true; }
      const lineEnd = this.text.indexOf('\n', this.cursor);
      if (lineEnd >= 0) {
        const lineStart = lineStartOf(this.text, this.cursor);
        const col = this.cursor - lineStart;
        const nextEnd = this.text.indexOf('\n', lineEnd + 1);
        this.set(this.text, Math.min(lineEnd + 1 + col, nextEnd < 0 ? this.text.length : nextEnd));
        return true;
      }
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
    if (!this.history.length) return true;
    if (this.historyIndex === null) { this.draft = this.text; this.historyIndex = this.history.length; }
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.set(this.history[this.historyIndex]);
    }
    return true;
  }

  historyNext() {
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
  render(width, { placeholder = '', active = true, borderColor } = {}) {
    const boxW = Math.max(20, width - 1);
    const textW = boxW - 6;
    const mode = this.mode;
    const color = borderColor || (mode === 'bash' ? c.magenta : mode === 'memory' ? c.blue : c.gray);
    const promptCh = mode === 'bash' ? '!' : mode === 'memory' ? '#' : '>';
    const body = mode === 'prompt' ? this.text : this.text.slice(1);
    const offset = mode === 'prompt' ? 0 : 1;
    const cursorIdx = Math.max(0, this.cursor - offset);

    const rows = [''];
    const widths = [0];
    let cur = null;
    let idx = 0;
    for (const g of graphemes(body)) {
      if (idx === cursorIdx) cur = { row: rows.length - 1, col: widths[widths.length - 1] };
      if (g === '\n') {
        rows.push(''); widths.push(0);
      } else {
        const w = graphemeWidth(g);
        if (widths[widths.length - 1] + w > textW) { rows.push(''); widths.push(0); if (idx === cursorIdx) cur = { row: rows.length - 1, col: 0 }; }
        rows[rows.length - 1] += g === '\t' ? '    ' : g;
        widths[widths.length - 1] += w;
      }
      idx += g.length;
    }
    if (!cur) {
      cur = { row: rows.length - 1, col: widths[widths.length - 1] };
      if (cur.col >= textW) { rows.push(''); widths.push(0); cur = { row: rows.length - 1, col: 0 }; }
    }

    const lines = [color('╭' + '─'.repeat(boxW - 2) + '╮')];
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
