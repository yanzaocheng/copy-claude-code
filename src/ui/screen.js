// Terminal screen manager. Output is split into:
//   - a static log that scrolls up normally (finished messages, tool results), and
//   - a live region at the bottom (streaming text, spinner, input box, dialogs) that is
//     erased and redrawn in place.
// Every live line is pre-wrapped to (columns - 1) so we always know how many rows it uses.

import { ESC, stringWidth, wrapLine, termWidth } from './ansi.js';

const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

export class Screen {
  constructor(out = process.stdout) {
    this.out = out;
    this.cursorRow = 0; // row of the terminal cursor, relative to the top of the live region
    this.prevWidths = []; // printed width of each live row (for resize handling)
    this.staticQueue = [];
    this.renderLive = () => ({ lines: [] });
    this.scheduled = null;
    this.lastCols = this.width;
    this.closed = false;
    out.on('resize', () => this.onResize());
  }

  get width() { return Math.max(20, this.out.columns || termWidth()); }
  get height() { return Math.max(10, this.out.rows || 30); }

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

  onResize() {
    // Estimate how the terminal re-flowed our live rows at the new width so we can find the top again.
    const cols = this.width;
    if (cols !== this.lastCols) {
      let rows = 0;
      for (let i = 0; i < this.cursorRow && i < this.prevWidths.length; i++) rows += Math.max(1, Math.ceil(this.prevWidths[i] / cols));
      this.cursorRow = rows;
      this.lastCols = cols;
    }
    this.flush();
  }

  flush() {
    if (this.closed) return;
    if (this.scheduled) { clearTimeout(this.scheduled); this.scheduled = null; }
    const cols = this.width;
    let buf = SYNC_START + ESC.hideCursor + '\r' + ESC.up(this.cursorRow) + ESC.clearDown;
    if (this.staticQueue.length) {
      // Explicit CRLF: not every terminal translates a bare LF into CR+LF.
      buf += this.staticQueue.join('\n').split(/\r?\n/).map((l) => l + '\x1b[0m').join('\r\n') + '\r\n';
      this.staticQueue = [];
    }
    let live;
    try {
      live = this.renderLive(cols) || {};
    } catch (e) {
      live = { lines: [`\x1b[31mrender error: ${e.message}\x1b[0m`] };
    }
    const { lines = [], cursor = null } = live;
    // Wrap to cols-1 and cap to the terminal height so we can always move back to the top.
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
    const maxRows = this.height - 1;
    let dropped = 0;
    if (rows.length > maxRows) {
      dropped = rows.length - maxRows;
      rows.splice(0, dropped);
      if (cursorRow !== null) cursorRow = Math.max(0, cursorRow - dropped);
    }
    buf += rows.map((r) => r + '\x1b[0m').join('\r\n');
    const last = Math.max(0, rows.length - 1);
    if (cursorRow !== null && rows.length) {
      buf += ESC.up(last - cursorRow) + '\r' + ESC.right(cursorCol) + ESC.showCursor;
      this.cursorRow = cursorRow;
    } else {
      this.cursorRow = last;
    }
    this.prevWidths = rows.map((r) => stringWidth(r));
    buf += SYNC_END;
    this.out.write(buf);
  }

  // Erase the live region (used before exiting or handing the terminal to a child).
  clearLive() {
    if (this.scheduled) { clearTimeout(this.scheduled); this.scheduled = null; }
    this.out.write('\r' + ESC.up(this.cursorRow) + ESC.clearDown + ESC.showCursor);
    this.cursorRow = 0;
    this.prevWidths = [];
  }

  clearScreen() {
    this.out.write(ESC.clearScreen);
    this.cursorRow = 0;
    this.prevWidths = [];
    this.flush();
  }

  // Print any pending output, then remove the live region (input box etc.) for good.
  close() {
    if (this.closed) return;
    this.renderLive = () => ({ lines: [] });
    this.flush();
    this.closed = true;
    this.out.write(ESC.showCursor);
  }
}
