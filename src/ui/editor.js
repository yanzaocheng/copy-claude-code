// The prompt input: multi-line editing, history, paste handling and Tab completion.

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
// body, col, g: the character there}; no g: a newline or the end). A long line wraps onto more rows; every index
// has exactly one stop (one where a row wraps is at the start of the next row, the end of a line is where its
// newline is). The input box draws these rows, and up and down move between them, so that they move through a
// long wrapped line too.
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
      r.stops.push({ i: idx, col: r.width, g });
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

// A history entry's text: an entry is the text, or {text, parts} when it had placeholders (see Editor.submit).
export const historyText = (entry) => (typeof entry === 'string' ? entry : entry?.text);

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
    this.pendingSubmit = null;
    this.lastEscape = 0;
    this.onDoubleEscape = onDoubleEscape;
    this.textW = 76; // the width of the text in the box, as last drawn: up and down move by the rows shown
    this.goalCol = null; // the column up and down aim for, kept while they are pressed in a row
    this.completing = false; // Tab opened the completion list: it follows what is typed until it is closed
  }

  get mode() {
    if (this.text.startsWith('!')) return 'bash';
    if (this.text.startsWith('#')) return 'memory';
    return 'prompt';
  }

  set(text, cursor = text.length) {
    this.text = text;
    this.cursor = Math.max(0, Math.min(cursor, text.length));
    if (this.completing) this.refreshSuggestions();
    this.onChange?.();
  }

  clear() {
    this.closeSuggestions();
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

  // The rows the text is shown in (see layoutRows), and the row and column of the cursor among them. The rows are
  // laid out again only when the text or the width changed: this runs for every frame (a 3000-line draft took 64 ms
  // a frame, laid out and searched whole), and the cursor's row is found by bisection.
  place() {
    const offset = this.mode === 'prompt' ? 0 : 1; // the ! or # is drawn as the prompt sign, not as text
    const L = this.layout;
    let rows;
    if (L && L.text === this.text && L.textW === this.textW && L.offset === offset) rows = L.rows;
    else {
      rows = layoutRows(this.text.slice(offset), this.textW);
      this.layout = { text: this.text, textW: this.textW, offset, rows };
    }
    const at = Math.max(0, this.cursor - offset);
    let r = 0; // the last row that starts at or before the cursor (every row has a stop)
    for (let hi = rows.length - 1; r < hi;) {
      const mid = (r + hi + 1) >> 1;
      if (rows[mid].stops[0].i <= at) r = mid; else hi = mid - 1;
    }
    let col = 0;
    for (const st of rows[r].stops) if (st.i <= at) col = st.col;
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

  // What the draft is made of besides its text, for the next process of a restart: the pasted text, images and
  // quotes its placeholders stand for (those still in it), and the numbers the next ones get. Without them the draft
  // came back as bare placeholders, and "[Pasted text #1 +40 lines]" was what the model got.
  draftParts() {
    const inText = (m) => [...m].filter(([label]) => this.text.includes(label));
    return { pastes: inText(this.pastes), images: inText(this.images), quotes: inText(this.quotes), pasteCounter: this.pasteCounter, imageCounter: this.imageCounter, quoteCounter: this.quoteCounter };
  }

  restoreDraft(text, cursor, parts) {
    const pairs = (v) => (Array.isArray(v) ? v.filter((p) => Array.isArray(p) && typeof p[0] === 'string' && p[1] != null) : []);
    this.pastes = new Map(pairs(parts?.pastes));
    this.images = new Map(pairs(parts?.images));
    this.quotes = new Map(pairs(parts?.quotes));
    for (const key of ['pasteCounter', 'imageCounter', 'quoteCounter']) if (Number.isFinite(parts?.[key])) this[key] = parts[key];
    this.set(text, cursor);
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

  // The completion list again for the text as it is now (while it is open: see complete). It closes when nothing
  // matches any more.
  refreshSuggestions() {
    if (!this.completing || !this.getSuggestions) return;
    const s = this.getSuggestions(this.text, this.cursor, { quiet: true });
    this.suggestions = s && s.items.length ? s : null;
    if (!this.suggestions) this.completing = false;
    if (!this.suggestions || this.selected >= this.suggestions.items.length) this.selected = 0;
  }

  closeSuggestions() {
    this.completing = false;
    this.suggestions = null;
    this.selected = 0;
  }

  // Tab, as in a shell: one match is put in at once; several put in what they all start with and open the list,
  // which Tab and down then go through (Enter takes the one selected, Esc closes it).
  complete() {
    if (this.suggestions) { this.selected = (this.selected + 1) % this.suggestions.items.length; this.onChange?.(); return; }
    const s = this.getSuggestions?.(this.text, this.cursor);
    // nothing (yet: the file list may still be loading, see App's FileIndex, which then completes again)
    this.lastMiss = s?.items.length ? null : { text: this.text, cursor: this.cursor, at: Date.now() };
    if (!s?.items.length) return;
    const typed = this.text.slice(s.from, s.to);
    // what starts with what is typed counts first ("/he": /help, not /bashes, which only contains it)
    const starting = s.items.filter((item) => item.value.toLowerCase().startsWith(typed.toLowerCase()));
    if (starting.length && starting.length < s.items.length) s.items = starting;
    if (s.items.length === 1) { this.suggestions = s; this.selected = 0; this.acceptSuggestion(); return; }
    let common = s.items[0].value;
    for (const item of s.items) while (!item.value.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1);
    this.completing = true;
    if (common.length > typed.length && common.toLowerCase().startsWith(typed.toLowerCase())) {
      this.set(this.text.slice(0, s.from) + common + this.text.slice(s.to), s.from + common.length); // reopens the list
    } else {
      this.suggestions = s;
      this.selected = 0;
      this.onChange?.();
    }
  }

  acceptSuggestion() {
    const s = this.suggestions;
    if (!s) return null;
    const item = s.items[this.selected];
    const before = this.text.slice(0, s.from);
    const after = this.text.slice(s.to);
    const value = item.value + (item.noSpace ? '' : ' ');
    this.closeSuggestions();
    this.set(before + value + after.replace(/^ /, ''), before.length + value.length);
    return item;
  }

  submit() {
    const value = this.expanded();
    const raw = this.text;
    // `display`: how the message shows in the transcript, when that is not `value` (a quote shows its first lines)
    const display = [...this.quotes.keys()].some((label) => raw.includes(label)) ? this.displayed() : undefined;
    // Only images whose placeholder is still in the text are sent.
    const images = [...this.images].filter(([label]) => raw.includes(label)).map(([, img]) => img);
    // The history keeps what the placeholders stand for: up brought back "[Pasted text #1 +20 lines]" alone, and
    // sending it again sent those words.
    const parts = this.draftParts();
    const entry = parts.pastes.length || parts.images.length || parts.quotes.length ? { text: raw, parts } : raw;
    if (raw.trim() && historyText(this.history[this.history.length - 1]) !== raw) this.history.push(entry);
    this.clear();
    this.onSubmit?.(value, raw, images, display, typeof entry === 'string' ? null : parts);
  }

  // Returns true when the key was consumed.
  handleKey(str, key = {}) {
    // A return key immediately followed by more input in the same tick is part of a paste.
    if (this.pendingSubmit) {
      clearImmediate(this.pendingSubmit);
      this.pendingSubmit = null;
      this.insert('\n');
    }
    // A bracketed paste never gets here: App.onKey takes it whole and calls insertPaste.
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
      this.complete();
      return true;
    }
    if (name === 'tab' && this.suggestions) { // shift+tab: back up the list
      this.selected = (this.selected - 1 + this.suggestions.items.length) % this.suggestions.items.length;
      this.onChange?.();
      return true;
    }
    if (name === 'escape') {
      if (this.completing) { this.closeSuggestions(); this.onChange?.(); return true; }
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

  // Up and down through the history. The draft is kept with what its placeholders stand for, since an entry brings
  // its own (see submit), and comes back whole after the newest entry.
  historyPrev() {
    this.goalCol = null;
    if (!this.history.length) return true;
    if (this.historyIndex === null) { this.draft = { text: this.text, cursor: this.cursor, parts: this.draftParts() }; this.historyIndex = this.history.length; }
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.recall(this.history[this.historyIndex]);
    }
    return true;
  }

  historyNext() {
    this.goalCol = null;
    if (this.historyIndex === null) return true;
    this.historyIndex++;
    if (this.historyIndex >= this.history.length) {
      this.historyIndex = null;
      this.restoreDraft(this.draft.text, this.draft.cursor, this.draft.parts);
    } else {
      this.recall(this.history[this.historyIndex]);
    }
    return true;
  }

  recall(entry) {
    if (typeof entry === 'string') this.restoreDraft(entry, entry.length, null);
    else this.restoreDraft(entry.text, entry.text.length, entry.parts);
  }

  // Draw the input without a box: "> " before its first row, two spaces before the others (the ! or # of bash and
  // memory mode take the place of ">"). Returns {lines, cursor: {row, col}}.
  // `maxRows`: the most rows of text to show. A longer text shows a window of them that follows the cursor (from
  // viewTop), and a line under it says how many rows are above and below.
  render(width, { placeholder = '', active = true, maxRows = Infinity } = {}) {
    const textW = Math.max(10, width - 1 - 2);
    const mode = this.mode;
    const color = mode === 'bash' ? c.magenta : mode === 'memory' ? c.blue : c.claude;
    const promptCh = mode === 'bash' ? '!' : mode === 'memory' ? '#' : '>';
    const body = mode === 'prompt' ? this.text : this.text.slice(1);
    this.textW = textW;
    const { rows: laid, r, col } = this.place();
    const shown = Math.max(1, Math.min(laid.length, Math.floor(maxRows)));
    let top = Math.min(this.viewTop || 0, laid.length - shown); // the window moves only as far as the cursor needs
    if (r < top) top = r;
    else if (r >= top + shown) top = r - shown + 1;
    this.viewTop = top = Math.max(0, top);

    const lines = [];
    for (let i = top; i < top + shown; i++) {
      let content = laid[i].text;
      if (!body && i === 0 && placeholder) content = c.dim(truncate(placeholder, textW));
      lines.push((i === 0 ? color(promptCh) + ' ' : '  ') + content);
    }
    const below = laid.length - top - shown;
    const hidden = [top ? `↑ ${top} more rows` : '', below ? `↓ ${below} more rows` : ''].filter(Boolean).join(' · ');
    if (hidden) lines.push(c.dim(`  ${hidden}`));
    return { lines, cursor: active ? { row: r - top, col: 2 + col } : null };
  }

  // The completion list (Tab): a window of 8 items around the selected one.
  renderSuggestions(width) {
    if (!this.suggestions) return [];
    const items = this.suggestions.items;
    const max = 8;
    const start = Math.max(0, Math.min(this.selected - Math.floor(max / 2), items.length - max));
    const shown = items.slice(start, start + max);
    const labelW = Math.min(30, Math.max(...shown.map((i) => stringWidth(i.label))) + 2);
    const lines = shown.map((item, k) => {
      const sel = start + k === this.selected;
      const label = padEnd(truncate(item.label, labelW - 2), labelW);
      const desc = item.description ? truncate(item.description, Math.max(10, width - labelW - 6)) : '';
      return sel ? '  ' + c.permission(label) + c.permission(desc) : '  ' + c.gray(label) + c.dim(desc);
    });
    if (items.length > max) lines.push(c.dim(`  ${this.selected + 1}/${items.length} · tab/↓ next · ⏎ choose · esc close`));
    return lines;
  }
}
