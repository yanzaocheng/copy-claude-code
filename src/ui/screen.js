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

import { ESC, wrapLine, termWidth, truncate } from './ansi.js';

const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

const RESIZE_QUIET_MS = 80; // repaint once the size has not changed for this long ...
const RESIZE_MAX_WAIT_MS = 300; // ... or at the latest this long after it started changing
const HISTORY_KEEP = 600; // static lines remembered for repainting (a screen shows far fewer)
const HISTORY_LINE_CHARS = 20_000;

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
  constructor(out = process.stdout) {
    this.out = out;
    this.cursorRow = 0; // row of the terminal cursor, relative to the top of the live region
    this.staticQueue = [];
    this.history = []; // the most recent static lines, for repainting after a resize
    this.renderLive = () => ({ lines: [] });
    this.scheduled = null;
    this.resizeTimer = null;
    this.resizeSince = 0;
    this.closed = false;
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

  // Append lines (strings, may contain \n) to the static log.
  log(...items) {
    for (const item of items) {
      if (Array.isArray(item)) this.staticQueue.push(...item);
      else this.staticQueue.push(String(item));
    }
    this.flush();
  }

  schedule() {
    if (this.scheduled || this.closed) return;
    this.scheduled = setTimeout(() => { this.scheduled = null; this.flush(); }, 16);
  }

  // Take the queued static output as lines, remembering them for a later repaint.
  takeStatic() {
    if (!this.staticQueue.length) return [];
    const lines = this.staticQueue.join('\n').split(/\r?\n/);
    this.staticQueue = [];
    for (const line of lines) this.history.push(line.length > HISTORY_LINE_CHARS ? line.slice(0, HISTORY_LINE_CHARS) : line);
    if (this.history.length > HISTORY_KEEP * 2) this.history.splice(0, this.history.length - HISTORY_KEEP);
    return lines;
  }

  // The live region as rows (pre-wrapped to cols-1, capped to fit the viewport) and where the cursor goes.
  layoutLive(cols) {
    let live;
    try {
      live = this.renderLive(cols) || {};
    } catch (e) {
      live = { lines: [`\x1b[31mrender error: ${e.message}\x1b[0m`] };
    }
    const { lines = [], cursor = null } = live;
    const rows = [];
    let cursorRow = null, cursorCol = 0;
    lines.forEach((line, i) => {
      const wrapped = wrapLine(line, cols - 1);
      if (cursor && cursor.row === i) {
        const col = cursor.col;
        const extra = Math.floor(col / (cols - 1));
        cursorRow = rows.length + Math.min(extra, wrapped.length - 1);
        cursorCol = col - extra * (cols - 1);
      }
      rows.push(...wrapped);
    });
    // Cap to the terminal height so there is always a way back to the top.
    const maxRows = Math.max(1, Math.min(this.height, this.out.rows || this.height) - 1);
    if (rows.length > maxRows) {
      const dropped = rows.length - maxRows;
      rows.splice(0, dropped);
      if (cursorRow !== null) cursorRow = Math.max(0, cursorRow - dropped);
    }
    return { rows, cursorRow, cursorCol };
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
    const all = [...tail, ...layout.rows];
    let buf = SYNC_START + ESC.hideCursor + this.titleUpdate() + '\x1b[H';
    buf += all.map((row) => row + '\x1b[0m\x1b[K').join('\r\n');
    buf += ESC.clearDown;
    buf += this.settleCursor(layout);
    buf += SYNC_END;
    this.out.write(buf);
  }

  flush() {
    if (this.closed) return;
    if (this.resizing) return; // the repaint after the resize writes everything that is waiting
    if (this.scheduled) { clearTimeout(this.scheduled); this.scheduled = null; }
    const cols = this.width;
    let buf = SYNC_START + ESC.hideCursor + this.titleUpdate() + '\r' + ESC.up(this.cursorRow) + ESC.clearDown;
    const lines = this.takeStatic();
    if (lines.length) {
      // Explicit CRLF: not every terminal translates a bare LF into CR+LF.
      buf += lines.map((l) => l + '\x1b[0m').join('\r\n') + '\r\n';
    }
    const layout = this.layoutLive(cols);
    buf += layout.rows.map((r) => r + '\x1b[0m').join('\r\n');
    buf += this.settleCursor(layout);
    buf += SYNC_END;
    this.out.write(buf);
  }

  // Erase the live region (used before exiting or handing the terminal to a child).
  clearLive() {
    if (this.resizing) this.repaint();
    if (this.scheduled) { clearTimeout(this.scheduled); this.scheduled = null; }
    this.out.write('\r' + ESC.up(this.cursorRow) + ESC.clearDown + ESC.showCursor);
    this.cursorRow = 0;
  }

  clearScreen() {
    this.out.write(ESC.clearScreen);
    this.cursorRow = 0;
    this.history = [];
    this.flush();
  }

  // Print any pending output, then remove the live region (input box etc.) for good.
  // `keepTitle`: another process takes the terminal over at once (a restart), so the tab keeps its title.
  close({ keepTitle = false } = {}) {
    if (this.closed) return;
    if (this.resizing) this.repaint(); // the cursor is not where the last draw left it: put things in order first
    this.renderLive = () => ({ lines: [] });
    this.flush();
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
