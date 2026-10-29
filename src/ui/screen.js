// Terminal screen manager. Output is split into:
//   - a static log that scrolls up normally (finished messages, tool results), and
//   - a live region at the bottom (streaming text, spinner, input box, dialogs) that is
//     erased and redrawn in place.
// Every live line is pre-wrapped to (columns - 1) so we always know how many rows it uses.
//
// Resizing. A terminal re-flows what is on screen when its width changes: a live row that was
// 99 columns wide becomes two rows at 80, and where the cursor ends up afterwards differs between
// terminals (and between a terminal and the ConPTY that Windows puts in front of it). Finding the top
// of the live region again by moving the cursor up a computed number of rows is therefore a guess,
// and a wrong guess leaves half of the old input box on screen. So once the resizing has paused, the
// whole viewport is written again from its top-left corner (see repaint), the last static lines taken
// from memory and the live region below them, which needs no knowledge of where the cursor was.
// Nothing is drawn while the size is still changing: a redraw made between two re-flows works from a
// screen that is about to change again.
//
// Fullscreen (setFull), as Claude Code's fullscreen rendering: the program draws on the terminal's alternate
// screen like vim, the input box fixed on the last rows, the conversation in the rows above it. The terminal's own
// scrollback is not used: the conversation is kept here (history) and scrolled here, with the mouse wheel (mouse
// reporting on, see mouseFilter), PgUp/PgDn and ctrl+Home/End. Scrolled up, new output does not move the view and a
// "Jump to bottom" bar counts what arrived. Each draw writes only the rows that changed since the last one.
//
// Pinned to the bottom. As in Claude Code the input box sits on the last rows of the window, also when the
// output so far does not fill it: blank rows at the top of the live region fill the space between the last
// output and the box. New output takes their place first and only then scrolls. This needs to know where on the
// screen the live region starts: at start-up the terminal is asked (queryCursorRow), after a repaint or a clear
// it is known. `pinned` is how many rows the live region reaches down to the bottom of the screen (null: not
// known, and nothing is pinned until it is). Closing removes the blank rows, so that the shell (or the process
// of a restart) goes on right below the output.

import { PassThrough } from 'node:stream';
import { ESC, wrapLine, termWidth, truncate, stringWidth, stripAnsi, graphemes, graphemeWidth } from './ansi.js';

const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

const RESIZE_QUIET_MS = 80; // repaint once the size has not changed for this long ...
const RESIZE_MAX_WAIT_MS = 300; // ... or at the latest this long after it started changing
const HISTORY_KEEP = 600; // static lines remembered for repainting (a screen shows far fewer)
const HISTORY_LINE_CHARS = 20_000;

// A line as the terminal would show it, so that what is drawn is what was measured: a tab becomes the 4 spaces
// stringWidth counts it as (the terminal moved to its next 8-column stop instead, past what was measured, and a
// fullscreen row's erase left old glyphs in the cells it skipped), only what follows the last carriage return
// stays (a progress bar's "40%\r80%" shows 80%, and no longer overwrites the prefix drawn before it), and other
// control characters (BEL, backspace...) go. ANSI escapes stay.
const CONTROLS = /[\x00-\x08\x09\x0b-\x1a\x1c-\x1f\x7f\r]/;
export function cleanLine(line) {
  if (!CONTROLS.test(line)) return line;
  let s = line.replace(/\r+$/, '');
  const cr = s.lastIndexOf('\r');
  if (cr >= 0) s = s.slice(cr + 1);
  return s.replace(/\t/g, '    ').replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, '');
}
const FULL_KEEP = 20_000; // fullscreen: lines of the conversation kept to scroll back through
// The alternate screen, and the mouse reported (SGR): buttons, the wheel, and moves while a button is held (a drag).
const ALT_ON = '\x1b[?1049h\x1b[?1002h\x1b[?1006h';
const ALT_OFF = '\x1b[?1002l\x1b[?1006l\x1b[?1049l';
const MULTI_CLICK_MS = 450;
// A search (ctrl+f): the matches, the current one, and how many are looked for at most.
const FIND_MATCH = '\x1b[30;43m';
const FIND_CURRENT = '\x1b[30;48;5;208m';
const FIND_MAX = 10_000;
// A line that starts a part of the conversation: a tool call or a reply ("⏺ …"), a message of the user ("> …"), a
// command of bash mode ("! …"), a message of another session ("✉ …"). What a quote is from (see selectionQuote).
const HEADING = /^(?:⏺|>|!|✉) /;
const SOURCE_REACH = 5000; // lines looked back for it
// A row that fills the rest of its width with its background (the user's messages, see renderUserMessage) ends in an
// erase to the end of the line made while that background is on. Nothing may erase after it: an erase does not move
// the cursor, so a second one, made after the colours are reset, would wipe the band out again from the same column.
const FILL = '\x1b[K';
const LEAD = /^(?:\x1b\[[0-9;]*m)+/; // the colours a row starts in
const endRow = (row) => row + (row.includes(FILL) ? '\x1b[0m' : '\x1b[0m\x1b[K');

// The part of `plain` (no escape codes) between columns `from` (included) and `to` (not).
function sliceCols(plain, from, to) {
  let out = '';
  let col = 0;
  for (const g of graphemes(plain)) {
    if (col >= to) break;
    if (col >= from) out += g;
    col += graphemeWidth(g);
  }
  return out;
}

// The text of a selection without the indentation the conversation is drawn with: the first line from where the
// selection starts, the others less the indentation they all have (a reply's, a tool result's, whose "⎿" counts as
// a space). Blank lines at either end go.
export function dedent(text) {
  const lines = String(text).split('\n').map((l) => l.replace(/^(\s*)⎿(?=\s)/, '$1 ').trimEnd());
  let cut = Infinity;
  for (const l of lines.slice(1)) if (l) cut = Math.min(cut, /^ */.exec(l)[0].length);
  if (cut === Infinity) cut = 0;
  return [lines[0].trimStart(), ...lines.slice(1).map((l) => l.slice(cut))].join('\n').replace(/^\n+|\n+$/g, '');
}

const before = (a, b) => a.line < b.line || (a.line === b.line && (a.sub < b.sub || (a.sub === b.sub && a.col <= b.col)));
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

// The keys of `stdin` without the mouse reports in it (SGR: ESC [ < b ; x ; y M/m), which go to
// `onMouse({button, x, y, release})` instead: a stream to read keys from. A report split between two chunks is
// put together; the rest passes through as it came.
export function mouseFilter(stdin, onMouse) {
  const out = new PassThrough();
  let pending = '';
  let timer = null;
  const pass = (text) => { if (text) out.write(text); };
  stdin.on('data', (d) => {
    clearTimeout(timer);
    let text = pending + (typeof d === 'string' ? d : d.toString('utf8'));
    pending = '';
    text = text.replace(MOUSE, (_, b, x, y, kind) => {
      try { onMouse({ button: Number(b), x: Number(x), y: Number(y), release: kind === 'm' }); } catch { /* the listener's problem */ }
      return '';
    });
    const partial = /\x1b\[<[\d;]*$/.exec(text);
    if (partial) {
      pending = partial[0];
      text = text.slice(0, partial.index);
      timer = setTimeout(() => { const p = pending; pending = ''; pass(p); }, 50); // not a report after all
    }
    pass(text);
  });
  return out;
}
const CPR = /\x1b\[(\d+);(\d+)R/; // the terminal's answer to DSR 6: row;column

// Ask the terminal where the cursor is (DSR 6): resolves with its row (1-based), or null when it does not answer
// within `timeout`. Run before anything else reads `stdin`, with the terminal in raw mode; what else arrives
// meanwhile (keys typed during start-up) is put back for the key reader.
export function queryCursorRow(stdin, out, timeout = 300) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let timer = null;
    const done = (row) => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.pause();
      const m = CPR.exec(buf.toString('latin1')); // latin1: one character a byte, so the index is a byte index
      const rest = m ? Buffer.concat([buf.subarray(0, m.index), buf.subarray(m.index + m[0].length)]) : buf;
      if (rest.length) stdin.unshift(rest);
      resolve(row);
    };
    const onData = (d) => {
      buf = Buffer.concat([buf, Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8')]);
      const m = CPR.exec(buf.toString('latin1'));
      if (m) done(Number(m[1]));
    };
    timer = setTimeout(() => done(null), timeout);
    stdin.on('data', onData);
    try { out.write('\x1b[6n'); } catch { done(null); }
  });
}

// How many rows a static line takes when the terminal wraps it at `cols`.
function rowsOf(line, cols) {
  return wrapLine(line, cols).length;
}

const TITLE_MAX_WIDTH = 100;
const TITLE_PUSH = '\x1b[22;0t'; // xterm title stack: remember the title the shell had ...
const TITLE_POP = '\x1b[23;0t'; // ... and bring it back (terminals without a stack ignore both)

// Text that is safe inside an OSC title: no control characters (one could end the sequence early and
// run on as escape codes), single spaces, not too long.
export function cleanTitle(text) {
  // eslint-disable-next-line no-control-regex
  const flat = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return truncate(flat, TITLE_MAX_WIDTH).replace(/\x1b\[0m$/, '');
}

export class Screen {
  // pin: keep the live region on the last rows of the screen (see the top of this file).
  constructor(out = process.stdout, { pin = true } = {}) {
    this.out = out;
    this.pin = pin;
    this.pinned = null; // rows from the top of the live region to the bottom of the screen; null: not known
    this.full = false; // fullscreen: see the top of this file
    this.scroll = 0; // fullscreen: rows the view is scrolled up from the end of the conversation (0: following it)
    this.unseen = 0; // fullscreen: rows that arrived while scrolled up
    this.frame = []; // fullscreen: the rows on screen, as last written
    this.wrapped = []; // fullscreen: history[i] wrapped to wrapCols - 1, made when first needed
    this.wrapCols = 0;
    this.lastArea = 0; // fullscreen: rows the conversation had on screen at the last draw
    this.scrollLiveRows = null; // fullscreen: keep the live region's height fixed while the user is scrolled up
    this.viewMap = []; // fullscreen: what each row of the conversation area shows, {line, sub} (null: blank)
    this.barRow = null; // fullscreen: the row of the "Jump to bottom" bar, when it is shown
    this.finding = null; // fullscreen: a search in the conversation (ctrl+f), see openFind
    this.dropped = 0; // fullscreen: lines dropped from the top of the history so far (the first one's number)
    this.selection = null; // fullscreen: {anchor, focus}, points {line, sub, col} of the conversation (history line, wrapped row, column)
    this.dragging = false;
    this.dragFrom = null; // fullscreen: where a drag in the conversation started, {line, sub, col}
    this.lastClick = { at: 0, x: 0, y: 0, count: 0 };
    this.inputBox = null; // fullscreen: where the input box's text is on screen, {top, rows, col} (see inputAt)
    this.inputDrag = null; // fullscreen: the mouse button held down on the input box's text: the cell it is over, {x, y, moved}
    this.cursorRow = 0; // row of the terminal cursor, relative to the top of the live region
    this.staticQueue = [];
    this.history = []; // the most recent static lines, for repainting after a resize
    this.renderLive = () => ({ lines: [] });
    this.scheduled = null;
    this.resizeTimer = null;
    this.resizeSince = 0;
    this.closed = false;
    this.onLog = null;
    this.titleProvider = null; // () => the terminal title (tab label) to show now
    this.title = null; // what was last sent
    this.titleInherited = false; // the process before this one in the session already saved the shell's title
    this.exitTitle = '';
    out.on('resize', () => this.onResize());
  }

  // Keep the terminal's title (the label of its tab or window) following `provider()`. `exitTitle` is what
  // it shows once we are gone and the shell is back, for terminals that cannot restore the previous one.
  setTitle(provider, exitTitle = '', { inherited = false } = {}) {
    this.titleProvider = provider;
    this.exitTitle = exitTitle;
    this.titleInherited = inherited;
    this.schedule();
  }

  // The escape sequence that brings the title up to date: nothing when it has not changed.
  titleUpdate() {
    if (!this.titleProvider) return '';
    let text;
    try { text = cleanTitle(this.titleProvider()); } catch { return ''; }
    if (!text || text === this.title) return '';
    const first = this.title === null && !this.titleInherited;
    this.title = text;
    return (first ? TITLE_PUSH : '') + `\x1b]0;${text}\x07`;
  }

  get width() { return Math.max(20, this.out.columns || termWidth()); }
  get height() { return Math.max(10, this.out.rows || 30); }
  // True from a size change until the repaint that follows it.
  get resizing() { return this.resizeTimer !== null; }

  setLive(fn) { this.renderLive = fn; this.schedule(); }

  // ------------------------------------------------------------ fullscreen

  // Go to (true) or leave the alternate screen. Leaving puts the newest output back on the normal screen, so that
  // the classic renderer goes on below it.
  setFull(on) {
    if (on === this.full || this.closed) return;
    if (this.scheduled) { clearTimeout(this.scheduled); this.scheduled = null; }
    this.takeStatic();
    if (on) {
      this.out.write('\r' + ESC.up(this.cursorRow) + ESC.clearDown); // the live region off the normal screen
      this.cursorRow = 0;
      this.full = true;
      this.scroll = 0;
      this.unseen = 0;
      this.frame = [];
      this.out.write(ALT_ON + '\x1b[2J');
      this.draw();
      return;
    }
    this.full = false;
    this.frame = [];
    this.out.write(ALT_OFF + ESC.showCursor);
    const tail = this.history.slice(-Math.max(1, this.height - 1));
    if (tail.length) this.out.write(tail.map((l) => l + '\x1b[0m').join('\r\n') + '\r\n');
    this.cursorRow = 0;
    this.pinned = null;
    this.flush();
  }

  wrappedAt(i, cols) {
    if (this.wrapCols !== cols) { this.wrapped = []; this.wrapCols = cols; this.selection = null; this.dragFrom = null; } // its rows are other rows now
    if (this.wrapped[i]) return this.wrapped[i];
    let rows = wrapLine(this.history[i], Math.max(1, cols - 1));
    // a band now wider than the window: each of its rows starts in its colours and fills the rest of the row
    if (rows.length > 1 && this.history[i].includes(FILL)) {
      const lead = LEAD.exec(this.history[i])?.[0] || '';
      rows = rows.map((r, k) => (k ? lead : '') + r.replaceAll(FILL, '') + lead + FILL);
    }
    return (this.wrapped[i] = rows);
  }

  // Rows of the whole conversation at this width (for the scrolling to stop at its top).
  totalRows(cols) {
    let n = 0;
    for (let i = 0; i < this.history.length; i++) n += this.wrappedAt(i, cols).length;
    return n;
  }

  // `rows` rows of the conversation, ending `this.scroll` rows above its end, as {text, line, sub}; padded below
  // with null when it is shorter.
  view(rows, cols) {
    const need = rows + this.scroll;
    const chunks = [];
    let count = 0;
    for (let i = this.history.length - 1; i >= 0 && count < need; i--) {
      const w = this.wrappedAt(i, cols);
      chunks.push(w.map((text, sub) => ({ text, line: i, sub })));
      count += w.length;
    }
    const got = chunks.reverse().flat();
    const end = Math.max(0, got.length - this.scroll);
    const shown = got.slice(Math.max(0, end - rows), end);
    while (shown.length < rows) shown.push(null);
    return shown;
  }

  // ------------------------------------------------------------ selecting with the mouse (fullscreen)

  // The selection in order: [start, end].
  ordered() {
    const { anchor, focus } = this.selection;
    return before(anchor, focus) ? [anchor, focus] : [focus, anchor];
  }

  // The columns of row {line, sub} that are selected: [from, to), or null.
  selectedCols(e) {
    if (!this.selection) return null;
    const [a, b] = this.ordered();
    const row = { line: e.line, sub: e.sub, col: 0 };
    if (before(row, { ...a, col: -1 }) || !before({ ...row, col: 0 }, { ...b, col: Infinity })) return null;
    const from = e.line === a.line && e.sub === a.sub ? a.col : 0;
    const to = e.line === b.line && e.sub === b.sub ? b.col + 1 : Infinity;
    return to > from ? [from, to] : null;
  }

  // A row of the conversation as drawn: the selection in reverse video, the matches of a search highlighted (the
  // current one apart). Such a row loses its own colours, except the band of a row that fills its width.
  paintRow(e) {
    const sel = this.selectedCols(e);
    const hits = this.finding?.byRow.get(`${e.line}:${e.sub}`);
    if (!sel && !hits) return e.text;
    const fill = e.text.includes(FILL);
    const base = fill ? LEAD.exec(e.text)?.[0] || '' : '';
    const style = (col) => {
      if (sel && col >= sel[0] && col < sel[1]) return '\x1b[7m';
      const hit = hits?.find((h) => col >= h.from && col < h.to);
      return !hit ? base : hit.match === this.finding.matches[this.finding.index] ? FIND_CURRENT : FIND_MATCH;
    };
    let out = '';
    let open = '';
    let col = 0;
    for (const g of graphemes(stripAnsi(e.text))) {
      const s = style(col);
      if (s !== open) { out += '\x1b[0m' + s; open = s; }
      out += g;
      col += graphemeWidth(g);
    }
    if (fill) return out + '\x1b[0m' + base + FILL;
    return out + (open ? '\x1b[0m' : '');
  }

  // ------------------------------------------------------------ finding text (fullscreen, ctrl+f)
  //
  // `finding`: {query, matches, byRow, index, anchor, key}. Matches are newest first (from the bottom of the
  // conversation up): {abs, offset, line, sub, col, fromEnd}, `abs` the line counted from the first line ever
  // printed (so that it survives lines dropped from the top), `offset` where it starts in the line's text, and
  // `fromEnd` the rows from its first row to the end of the conversation. `byRow` maps "line:sub" to the column
  // ranges to highlight, {from, to, match}. A match may go on over the rows a long line was wrapped onto.

  // Start finding: the first match shown is the nearest one above the bottom of the view as it is now.
  openFind() {
    this.takeStatic();
    this.finding = { query: '', matches: [], byRow: new Map(), index: -1, anchor: this.scroll, cols: 0, dropped: -1, scanned: -1 };
  }

  closeFind() {
    if (!this.finding) return;
    this.finding = null;
    this.draw();
  }

  // Look for `query` as typed, in any case; shows the first match (see openFind). {index, total}: index is 0 for
  // the newest match.
  setFind(query) {
    const f = this.finding;
    if (!f) return null;
    f.query = query;
    f.cols = 0; // all of it again
    f.index = -1;
    this.refreshFind();
    if (f.matches.length) {
      const at = f.matches.findIndex((m) => m.fromEnd >= f.anchor);
      f.index = at >= 0 ? at : f.matches.length - 1;
      this.revealMatch();
    }
    this.draw();
    return this.findStatus();
  }

  // The next match up (`dir` 1: older) or down (-1: newer), round from either end.
  findStep(dir) {
    const f = this.finding;
    if (!f) return null;
    this.refreshFind();
    const n = f.matches.length;
    if (n) {
      f.index = ((f.index < 0 ? 0 : f.index + dir) % n + n) % n;
      this.revealMatch();
    }
    this.draw();
    return this.findStatus();
  }

  findStatus() {
    const f = this.finding;
    if (!f) return null;
    this.refreshFind();
    return { query: f.query, index: f.index, total: f.matches.length };
  }

  // The matches again when the conversation or the width changed since they were found; the current one stays.
  // Lines added at the end (output while the search is open) are searched on their own.
  refreshFind() {
    const f = this.finding;
    const cols = this.width;
    if (!f || (f.cols === cols && f.dropped === this.dropped && f.scanned === this.history.length)) return;
    if (!f.query) {
      Object.assign(f, { matches: [], byRow: new Map(), index: -1, cols, dropped: this.dropped, scanned: this.history.length });
      return;
    }
    if (f.cols === cols && f.dropped === this.dropped && f.scanned < this.history.length) {
      const added = this.scanFind(f, f.scanned, this.history.length, cols);
      for (const m of f.matches) m.fromEnd += added.rows;
      f.matches = [...added.matches, ...f.matches];
      if (f.index >= 0) f.index += added.matches.length;
      f.scanned = this.history.length;
      return;
    }
    const current = f.matches[f.index];
    f.byRow = new Map();
    f.matches = this.scanFind(f, 0, this.history.length, cols).matches;
    Object.assign(f, { cols, dropped: this.dropped, scanned: this.history.length });
    const same = current ? f.matches.findIndex((m) => m.abs === current.abs && m.offset === current.offset) : -1;
    f.index = same >= 0 ? same : Math.min(f.index, f.matches.length - 1);
  }

  // The matches of f.query in history lines [from, to), newest first, entered in f.byRow; `rows`: the rows those
  // lines take (fromEnd counts from the end of line to - 1).
  scanFind(f, from, to, cols) {
    const re = new RegExp(f.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    const matches = [];
    let rowsAfter = 0;
    for (let line = to - 1; line >= from; line--) {
      const rows = this.wrappedAt(line, cols);
      if (matches.length < FIND_MAX) {
        const plains = rows.map((r) => stripAnsi(r));
        const text = plains.join('');
        const starts = [];
        for (let k = 0, at = 0; k < plains.length; at += plains[k].length, k++) starts.push(at);
        // offset -> {sub, col}: the row it falls on, and the column there (`end`: an end offset belongs to the row before)
        const place = (offset, end = false) => {
          let sub = plains.length - 1;
          while (sub > 0 && (end ? starts[sub] >= offset : starts[sub] > offset)) sub--;
          return { sub, col: stringWidth(plains[sub].slice(0, offset - starts[sub])) };
        };
        const found = [];
        for (const m of text.matchAll(re)) {
          if (!m[0]) continue;
          const a = place(m.index);
          const b = place(m.index + m[0].length, true);
          const match = { abs: this.dropped + line, offset: m.index, line, sub: a.sub, col: a.col, fromEnd: rowsAfter + rows.length - 1 - a.sub };
          for (let sub = a.sub; sub <= b.sub; sub++) {
            const k = `${line}:${sub}`;
            if (!f.byRow.has(k)) f.byRow.set(k, []);
            f.byRow.get(k).push({ from: sub === a.sub ? a.col : 0, to: sub === b.sub ? b.col : Infinity, match });
          }
          found.push(match);
        }
        matches.push(...found.reverse());
      }
      rowsAfter += rows.length;
    }
    return { matches, rows: rowsAfter };
  }

  // Scroll so that the current match is on screen: where it is if it is already in view, else in the middle.
  revealMatch() {
    const m = this.finding?.matches[this.finding.index];
    if (!m || !this.full) return;
    const area = Math.max(1, this.lastArea || this.height - 6);
    const lowest = this.scroll + (this.scroll > 0 ? 1 : 0); // the "Jump to bottom" bar covers the last row
    if (m.fromEnd >= lowest && m.fromEnd < this.scroll + area) return;
    const max = Math.max(0, this.totalRows(this.width) - area);
    this.scroll = Math.max(0, Math.min(max, m.fromEnd - Math.floor(area / 2)));
    if (!this.scroll) this.unseen = 0;
  }

  // The text selected, as it was printed: rows a long line was wrapped onto are joined again.
  selectedText() {
    if (!this.selection) return '';
    const cols = this.width;
    const [a, b] = this.ordered();
    const lines = [];
    for (let line = a.line; line <= b.line && line < this.history.length; line++) {
      const rows = this.wrappedAt(line, cols);
      let text = '';
      rows.forEach((row, sub) => {
        const range = this.selectedCols({ line, sub });
        if (range) text += sliceCols(stripAnsi(row), range[0], range[1]);
      });
      lines.push(text.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }

  // What is selected, to quote in a message (see App.quoteSelection): {text, source}. `text` without the indentation
  // the conversation is drawn with (see dedent); `source` the line that starts the part of the conversation where the
  // selection begins, a tool call, a reply or a message of the user (see HEADING), so that the model knows where the
  // quote is from: '' when there is none, or when the quote starts with that line itself.
  selectionQuote() {
    if (!this.selection) return null;
    const text = dedent(this.selectedText());
    const [a] = this.ordered();
    let source = '';
    for (let i = Math.min(a.line, this.history.length - 1), n = 0; i >= 0 && n < SOURCE_REACH; i--, n++) {
      const plain = stripAnsi(this.history[i]).trim();
      if (HEADING.test(plain)) { source = plain; break; }
    }
    if (source && text.split('\n', 1)[0] === source) source = '';
    if (source.length > 300) source = source.slice(0, 299) + '…';
    return { text, source };
  }

  clearSelection() {
    if (!this.selection) return false;
    this.selection = null;
    this.dragging = false;
    this.draw();
    return true;
  }

  // The cell of the input box's text at screen cell (x, y), 1-based: {row, col}, the row among the rows of the text
  // and the column in it (negative left of it). null when (x, y) is not on a row of the text shown; `clamp` (a drag
  // that left the box): the start of its first row on screen above it, the end of the text below it.
  inputAt(x, y, clamp = false) {
    const b = this.inputBox;
    if (!b) return null;
    const first = Math.max(0, this.lastArea - b.top); // rows the conversation covers (the box taller than the screen)
    const row = y - 1 - b.top;
    if (row >= first && row < b.rows) return { row, col: x - 1 - b.col };
    if (!clamp) return null;
    return row < first ? { row: first, col: -1 } : { row: b.rows - 1, col: Infinity };
  }

  // The point of the conversation at screen cell (x, y), 1-based: the nearest row that shows some of it.
  pointAt(x, y) {
    let i = Math.max(0, Math.min(this.lastArea - 1, y - 1));
    while (i > 0 && !this.viewMap[i]) i--;
    const e = this.viewMap[i];
    return e ? { line: e.line, sub: e.sub, col: Math.max(0, x - 1) } : null;
  }

  // Word (`whole`: the whole line) around point `p`.
  expand(p, whole) {
    const rows = this.wrappedAt(p.line, this.width);
    if (whole) return { anchor: { line: p.line, sub: 0, col: 0 }, focus: { line: p.line, sub: rows.length - 1, col: Infinity } };
    const cells = [];
    for (const g of graphemes(stripAnsi(rows[p.sub] || ''))) {
      for (let k = 0; k < Math.max(1, graphemeWidth(g)); k++) cells.push(g);
    }
    const word = (g) => g !== undefined && !/\s/.test(g);
    if (!word(cells[p.col])) return null;
    let from = p.col;
    let to = p.col;
    while (word(cells[from - 1])) from--;
    while (word(cells[to + 1])) to++;
    return { anchor: { ...p, col: from }, focus: { ...p, col: to } };
  }

  // A mouse report (fullscreen). Mouse selection only highlights text; Ctrl+C copies it. Drag to select (the view
  // scrolls at its edges), double-click a word, triple-click a line; a click clears the selection; a click on the
  // "Jump to bottom" bar goes there. On the input box's text it returns {input: {kind, row, col, count}}, for the
  // editor (Editor.mouse): a press there, then a drag (once for each cell the mouse moves to) and the release, from
  // wherever the mouse is by then.
  mouse({ button, x, y, release }) {
    if (!this.full || this.closed) return null;
    if (button & 64) return null; // the wheel: the caller scrolls
    const left = (button & 3) === 0;
    if (!left) return null;
    const motion = Boolean(button & 32);
    if (!motion && !release) { // a press
      const now = Date.now();
      const c = this.lastClick;
      const count = now - c.at < MULTI_CLICK_MS && Math.abs(c.x - x) <= 1 && c.y === y ? c.count + 1 : 1;
      this.lastClick = { at: now, x, y, count };
      this.inputDrag = null;
      this.dragFrom = null;
      if (this.barRow !== null && y - 1 === this.barRow) { this.selection = null; this.scrollBy('bottom'); return null; }
      const cell = this.inputAt(x, y);
      if (cell) {
        this.clearSelection();
        this.dragging = false;
        if (count === 1) this.inputDrag = { x, y, moved: false };
        return { input: { kind: 'press', ...cell, count } };
      }
      if (y - 1 >= this.lastArea) { this.clearSelection(); return null; } // the input box's border, the footer
      const p = this.pointAt(x, y);
      if (!p) { this.clearSelection(); return null; }
      if (count >= 2) {
        this.selection = this.expand(p, count >= 3);
        this.dragging = false;
        this.draw();
        return null;
      }
      // where a drag starts: the selection is made once the mouse moves, so that a click selects nothing (it showed
      // a cell in reverse video while the button was down, and cleared the footer's message)
      this.clearSelection();
      this.dragFrom = p;
      this.dragging = true;
      return null;
    }
    const d = this.inputDrag;
    if (d) {
      if (motion && d.x === x && d.y === y) return null; // still the same cell
      const cell = this.inputAt(x, y, true);
      if (release) {
        this.inputDrag = null;
        if (d.moved) this.lastClick.count = 0; // a drag: the next click starts a count of its own
        return cell && { input: { kind: 'release', ...cell } };
      }
      if (!motion) return null;
      Object.assign(d, { x, y, moved: true });
      return cell && { input: { kind: 'drag', ...cell } };
    }
    if (!this.dragging || !this.dragFrom) return null;
    if (motion) {
      // past the top or the bottom of the conversation: it scrolls, and the selection goes on with it
      if (y <= 1) this.scrollBy(1);
      else if (y - 1 >= this.lastArea - 1 && this.scroll > 0) this.scrollBy(-1);
      const p = this.pointAt(x, y);
      if (p) {
        if (this.selection) this.selection.focus = p;
        else this.selection = { anchor: { ...this.dragFrom }, focus: p };
      }
      this.draw();
      return null;
    }
    // released
    this.dragging = false;
    this.dragFrom = null;
    if (this.selection) this.lastClick.count = 0; // a drag: the next click starts a count of its own
    return null;
  }

  // Scroll the conversation up (`rows` > 0) or down. 'top' and 'bottom' go to its ends.
  scrollBy(rows) {
    if (!this.full) return;
    this.takeStatic();
    const cols = this.width;
    const max = Math.max(0, this.totalRows(cols) - this.lastArea);
    const to = rows === 'top' ? max : rows === 'bottom' ? 0 : Math.max(0, Math.min(max, this.scroll + rows));
    if (to === this.scroll) return;
    this.scroll = to;
    if (!to) this.unseen = 0;
    this.draw();
  }

  get scrolledUp() { return this.full && this.scroll > 0; }

  // The bar over the last row of the conversation while it is scrolled up.
  jumpBar(cols) {
    const label = ` Jump to bottom (ctrl+End) ↓${this.unseen ? ` · ${this.unseen} new line${this.unseen === 1 ? '' : 's'}` : ''} `;
    const pad = Math.max(0, Math.floor((cols - 1 - stringWidth(label)) / 2));
    return ' '.repeat(pad) + '\x1b[7m' + label + '\x1b[27m';
  }

  // While the user is scrolled up, keep the live region at the height it had when scrolling started. Streaming
  // text otherwise grows and shrinks that region, moving every visible conversation row on every token. That is
  // especially conspicuous through PowerShell/ConPTY, where the cursor moves in the terminal before the whole
  // frame has been painted. The new output remains available behind the jump bar; returning to the bottom releases
  // the lock and lays out the complete live region again.
  keepScrolledLiveHeight(layout, rows) {
    const current = layout.rows.length;
    if (current < rows) {
      const gap = rows - current;
      layout.rows.unshift(...Array(gap).fill(''));
      if (layout.cursorRow !== null) layout.cursorRow += gap;
      if (layout.box) layout.box.top += gap;
      return layout;
    }
    if (current > rows) {
      const dropped = current - rows;
      layout.rows.splice(0, dropped);
      if (layout.box) layout.box.top -= dropped;
      if (layout.cursorRow !== null) {
        layout.cursorRow -= dropped;
        if (layout.cursorRow < 0) layout.cursorRow = null;
      }
    }
    return layout;
  }

  // Draw the screen: the conversation above, the live region on the last rows, the cursor in the input box.
  draw({ full = false } = {}) {
    if (this.closed || !this.full) return;
    if (this.scheduled) { clearTimeout(this.scheduled); this.scheduled = null; }
    const cols = this.width;
    const screenRows = Math.max(1, this.out.rows || this.height);
    if (!this.scroll) this.scrollLiveRows = null;
    else if (full) this.scrollLiveRows = null; // a resize changes wrapping; capture the new live layout below
    let layout = this.layoutLive(cols);
    if (this.scroll > 0) {
      if (this.scrollLiveRows === null) this.scrollLiveRows = Math.max(1, layout.rows.length);
      layout = this.keepScrolledLiveHeight(layout, this.scrollLiveRows);
    }
    const area = Math.max(0, screenRows - layout.rows.length);
    this.lastArea = area;
    this.inputBox = layout.box && { ...layout.box, top: area + layout.box.top };
    if (this.finding) this.refreshFind();
    const shown = this.view(area, cols);
    this.viewMap = shown;
    const top = shown.map((e) => (e ? this.paintRow(e) : ''));
    this.barRow = this.scroll > 0 && area > 0 ? area - 1 : null;
    if (this.barRow !== null) top[this.barRow] = this.jumpBar(cols);
    const frame = [...top, ...layout.rows];
    let buf = SYNC_START + ESC.hideCursor + this.titleUpdate();
    if (full) { buf += '\x1b[2J'; this.frame = []; }
    frame.forEach((row, i) => {
      if (this.frame[i] !== row) buf += `\x1b[${i + 1};1H` + endRow(row);
    });
    if (frame.length < this.frame.length) buf += `\x1b[${frame.length + 1};1H` + ESC.clearDown;
    this.frame = frame;
    if (layout.cursorRow !== null) buf += `\x1b[${area + layout.cursorRow + 1};${layout.cursorCol + 1}H` + ESC.showCursor;
    buf += SYNC_END;
    this.out.write(buf);
  }

  // The live region starts on screen row `row` (1-based, as the terminal reports it): from now on it fills the
  // screen down to its last row.
  pinFrom(row) {
    if (!this.pin || !Number.isFinite(row) || row < 1) return;
    this.pinned = Math.max(0, this.height - row + 1);
  }

  // Blank rows before the live region's own rows so that it reaches the bottom of the screen, `above` rows of
  // output being written first.
  gapFor(above, liveRows) {
    if (!this.pin || this.pinned === null) return 0;
    return Math.max(0, Math.min(this.pinned, this.height) - above - liveRows);
  }

  // Append lines (strings, may contain \n) to the static log. `onLog(items)` is told about each call (the remote
  // control mirrors what the terminal prints).
  log(...items) {
    this.queueLog(items);
    this.flush();
  }

  // As log(), drawn with the next frame (within 16 ms) instead of at once: for streamed text, where a line comes
  // with nearly every delta and drawing each at once rewrote the whole screen (fullscreen) for every line.
  logSoon(...items) {
    this.queueLog(items);
    this.schedule();
  }

  queueLog(items) {
    if (this.onLog) { try { this.onLog(items); } catch { /* the listener's problem */ } }
    for (const item of items) {
      if (Array.isArray(item)) this.staticQueue.push(...item);
      else this.staticQueue.push(String(item));
    }
  }

  schedule() {
    if (this.scheduled || this.closed) return;
    this.scheduled = setTimeout(() => { this.scheduled = null; this.flush(); }, 16);
  }

  // Take the queued static output as lines, remembering them for a later repaint.
  takeStatic() {
    if (!this.staticQueue.length) return [];
    const lines = this.staticQueue.join('\n').split(/\r?\n/).map(cleanLine);
    this.staticQueue = [];
    const first = this.history.length;
    for (const line of lines) this.history.push(line.length > HISTORY_LINE_CHARS ? line.slice(0, HISTORY_LINE_CHARS) : line);
    if (this.full && this.scroll > 0) {
      // keep showing what is shown: the view moves up with the conversation
      let rows = 0;
      for (let i = first; i < this.history.length; i++) rows += this.wrappedAt(i, this.width).length;
      this.scroll += rows;
      this.unseen += rows;
    }
    const keep = this.full ? FULL_KEEP : HISTORY_KEEP;
    if (this.history.length > keep * (this.full ? 1.25 : 2)) {
      const drop = this.history.length - keep;
      this.history.splice(0, drop);
      this.wrapped.splice(0, drop);
      this.dropped += drop;
      if (this.selection) {
        for (const p of [this.selection.anchor, this.selection.focus]) p.line -= drop;
        if (this.selection.anchor.line < 0 || this.selection.focus.line < 0) this.selection = null;
      }
      if (this.dragFrom) {
        this.dragFrom.line -= drop;
        if (this.dragFrom.line < 0) this.dragFrom = null;
      }
    }
    return lines;
  }

  // The live region as rows (pre-wrapped to cols-1, capped to fit the viewport) and where the cursor goes. `box`:
  // where the input box's text is among the rows, {top, rows, col}, from what renderLive says (`input`: its first
  // line, how many, the column the text starts at); null when its rows did not stay one row each.
  layoutLive(cols) {
    let live;
    try {
      live = this.renderLive(cols) || {};
    } catch (e) {
      live = { lines: [`\x1b[31mrender error: ${e.message}\x1b[0m`] };
    }
    const { lines = [], cursor = null, input = null } = live;
    const rows = [];
    const starts = []; // the row each line starts on
    let cursorRow = null, cursorCol = 0;
    lines.forEach((line, i) => {
      starts.push(rows.length);
      const wrapped = wrapLine(cleanLine(line), cols - 1);
      if (cursor && cursor.row === i) {
        const col = cursor.col;
        const extra = Math.floor(col / (cols - 1));
        cursorRow = rows.length + Math.min(extra, wrapped.length - 1);
        cursorCol = col - extra * (cols - 1);
      }
      rows.push(...wrapped);
    });
    starts.push(rows.length);
    const end = input ? starts[input.row + input.rows] : undefined;
    const box = end !== undefined && end - starts[input.row] === input.rows ? { top: starts[input.row], rows: input.rows, col: input.col } : null;
    // Cap to the terminal height so there is always a way back to the top.
    const maxRows = Math.max(1, Math.min(this.height, this.out.rows || this.height) - 1);
    if (rows.length > maxRows) {
      const dropped = rows.length - maxRows;
      rows.splice(0, dropped);
      if (cursorRow !== null) cursorRow = Math.max(0, cursorRow - dropped);
      if (box) box.top -= dropped;
    }
    return { rows, cursorRow, cursorCol, box };
  }

  // Escape sequence that leaves the cursor where the user types, and the bookkeeping for the next redraw.
  settleCursor({ rows, cursorRow, cursorCol }) {
    const last = Math.max(0, rows.length - 1);
    let buf = '';
    if (cursorRow !== null && rows.length) {
      buf = ESC.up(last - cursorRow) + '\r' + ESC.right(cursorCol) + ESC.showCursor;
      this.cursorRow = cursorRow;
    } else {
      this.cursorRow = last;
    }
    return buf;
  }

  onResize() {
    if (this.closed) return;
    const now = Date.now();
    if (!this.resizeSince) this.resizeSince = now;
    clearTimeout(this.resizeTimer);
    const wait = Math.max(0, Math.min(RESIZE_QUIET_MS, this.resizeSince + RESIZE_MAX_WAIT_MS - now));
    this.resizeTimer = setTimeout(() => this.settleResize(), wait);
  }

  settleResize() {
    this.resizeTimer = null;
    this.resizeSince = 0;
    this.repaint();
  }

  // Write the whole viewport again after a resize: the newest static lines that fit, then the live region,
  // so that the last row of the live region is the last row of the screen (when there is enough output to
  // fill it). Absolute positioning only, no cursor-relative moves: a relative move computed for one width
  // lands in the wrong place when the terminal has already re-flowed to another, which is exactly what
  // happens when the size keeps changing.
  //
  // What was on screen above our output (a short session: the shell that started us) is overwritten.
  repaint() {
    if (this.closed) return;
    if (this.full) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
      this.resizeSince = 0;
      this.takeStatic();
      this.draw({ full: true });
      return;
    }
    if (this.scheduled) { clearTimeout(this.scheduled); this.scheduled = null; }
    clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.resizeSince = 0;
    const cols = this.width;
    const screenRows = Math.max(1, this.out.rows || this.height);
    this.takeStatic();
    const layout = this.layoutLive(cols);
    const room = Math.max(0, screenRows - layout.rows.length);
    const tail = [];
    for (let used = 0, i = this.history.length - 1; i >= 0; i--) {
      const n = rowsOf(this.history[i], cols);
      if (used + n > room) break;
      tail.unshift(this.history[i]);
      used += n;
    }
    // Every row is overwritten (EL clears what the new text does not cover) and what is left below is
    // erased, so no old text survives, wherever the terminal put it when it re-flowed.
    if (this.pin) {
      const used = tail.reduce((n, line) => n + rowsOf(line, cols), 0);
      this.pinned = screenRows;
      const gap = this.gapFor(used, layout.rows.length);
      layout.rows.unshift(...Array(gap).fill(''));
      if (layout.cursorRow !== null) layout.cursorRow += gap;
    }
    const all = [...tail, ...layout.rows];
    let buf = SYNC_START + ESC.hideCursor + this.titleUpdate() + '\x1b[H';
    buf += all.map(endRow).join('\r\n');
    buf += ESC.clearDown;
    buf += this.settleCursor(layout);
    buf += SYNC_END;
    this.out.write(buf);
    if (this.pinned !== null) this.pinned = layout.rows.length;
  }

  flush() {
    if (this.closed) return;
    if (this.resizing) return; // the repaint after the resize writes everything that is waiting
    if (this.full) { this.takeStatic(); this.draw(); return; }
    if (this.scheduled) { clearTimeout(this.scheduled); this.scheduled = null; }
    const cols = this.width;
    let buf = SYNC_START + ESC.hideCursor + this.titleUpdate() + '\r' + ESC.up(this.cursorRow) + ESC.clearDown;
    const lines = this.takeStatic();
    if (lines.length) {
      // Explicit CRLF: not every terminal translates a bare LF into CR+LF.
      buf += lines.map((l) => l + '\x1b[0m').join('\r\n') + '\r\n';
    }
    const layout = this.layoutLive(cols);
    const gap = this.gapFor(lines.reduce((n, line) => n + rowsOf(line, cols), 0), layout.rows.length);
    if (gap) {
      layout.rows.unshift(...Array(gap).fill(''));
      if (layout.cursorRow !== null) layout.cursorRow += gap;
    }
    buf += layout.rows.map((r) => r + '\x1b[0m').join('\r\n');
    buf += this.settleCursor(layout);
    buf += SYNC_END;
    this.out.write(buf);
    // the region now ends on the last row of the screen (it did before, or the output scrolled it there)
    if (this.pinned !== null) this.pinned = layout.rows.length;
  }

  // Erase the live region (used before exiting or handing the terminal to a child).
  clearLive() {
    if (this.resizing) this.repaint();
    if (this.scheduled) { clearTimeout(this.scheduled); this.scheduled = null; }
    this.out.write('\r' + ESC.up(this.cursorRow) + ESC.clearDown + ESC.showCursor);
    this.cursorRow = 0;
    this.pinned = null; // whatever is written now (a child process) moves the cursor where we cannot see
  }

  clearScreen() {
    if (this.full) {
      this.dropped += this.history.length;
      this.history = [];
      this.wrapped = [];
      this.selection = null;
      this.scroll = 0;
      this.unseen = 0;
      this.staticQueue = [];
      this.draw({ full: true });
      return;
    }
    this.out.write(ESC.clearScreen);
    this.cursorRow = 0;
    this.history = [];
    if (this.pin) this.pinned = this.height; // from the top row
    this.flush();
  }

  // Print any pending output, then remove the live region (input box etc.) for good.
  // `keepTitle`: another process takes the terminal over at once (a restart), so the tab keeps its title.
  // `after`: lines to leave on the terminal (the exit's usage and resume hint). In fullscreen they are written after
  // the alternate screen is gone: logged before, they were drawn on it and vanished with it.
  close({ keepTitle = false, after = [] } = {}) {
    if (this.closed) return;
    if (this.resizing) this.repaint(); // the cursor is not where the last draw left it: put things in order first
    this.renderLive = () => ({ lines: [] });
    this.pinned = null; // no blank rows left behind: the shell, or the next process, goes on right below the output
    if (this.full) {
      this.takeStatic();
      this.full = false;
      this.out.write(ALT_OFF); // the shell's screen comes back as it was
      if (after.length) this.out.write(`${after.map((l) => `${l}\x1b[0m`).join('\r\n')}\r\n`);
    } else {
      this.staticQueue.push(...after);
      this.flush();
    }
    this.closed = true;
    clearTimeout(this.resizeTimer);
    // Give the tab back its old label: a terminal with a title stack restores it, and one without is
    // left with a neutral one rather than a title that still looks like a program that is running.
    let restore = '';
    if (this.title !== null && !keepTitle) {
      const neutral = cleanTitle(this.exitTitle);
      restore = (neutral ? `\x1b]0;${neutral}\x07` : '') + TITLE_POP;
    }
    this.out.write(restore + ESC.showCursor);
  }
}
