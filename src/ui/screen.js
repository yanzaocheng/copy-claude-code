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
// Pinned to the bottom. As in Claude Code the input box sits on the last rows of the window, also when the
// output so far does not fill it: blank rows at the top of the live region fill the space between the last
// output and the box. New output takes their place first and only then scrolls. This needs to know where on the
// screen the live region starts: at start-up the terminal is asked (queryCursorRow), after a repaint or a clear
// it is known. `pinned` is how many rows the live region reaches down to the bottom of the screen (null: not
// known, and nothing is pinned until it is). Closing removes the blank rows, so that the shell (or the process
// of a restart) goes on right below the output.

import { ESC, wrapLine, termWidth, truncate, setTerminalWidths, ambiguousGroups } from './ansi.js';

const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

const RESIZE_QUIET_MS = 80; // repaint once the size has not changed for this long ...
const RESIZE_MAX_WAIT_MS = 300; // ... or at the latest this long after it started changing
const HISTORY_KEEP = 600; // static lines remembered for repainting (a screen shows far fewer)
const HISTORY_LINE_CHARS = 20_000;

// A line as the terminal would show it, so that what is drawn is what was measured: a tab becomes the 4 spaces
// stringWidth counts it as (the terminal moved to its next 8-column stop instead, past what was measured), only what
// follows the last carriage return
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
// A row that fills the rest of its width with its background (the user's messages, see renderUserMessage) ends in an
// erase to the end of the line made while that background is on: nothing may erase after it.
const FILL = '\x1b[K';
const endRow = (row) => row + (row.includes(FILL) ? '\x1b[0m' : '\x1b[0m\x1b[K');
const CPR = /\x1b\[(\d+);(\d+)R/g; // the terminal's answer to DSR 6: row;column
// Windows: the symbols the interface is drawn with are measured at start-up (see queryCursorRow), as its terminals
// do not agree on their widths. The first FONT_SIZED of them are East Asian Ambiguous characters: a terminal that
// draws one of those in two cells sizes all such characters by its font, and is asked about all of them.
const UI_PROBES = process.platform === 'win32' ? Array.from('·…↑↓←→↻⇣⏎◷⇄•◦⏺⎿✻✢✳✶✽✉⚠') : [];
const FONT_SIZED = 6;
const AMBIGUOUS_TIMEOUT_MS = 1500; // some 200 to 600 answers, each asked for after the one before: 0.3 ms each in the Windows 11 console, 0.5 in Windows 10's

// Ask the terminal where the cursor is (DSR 6): resolves with its row (1-based), or null when it does not answer
// within `timeout`. Run before anything else reads `stdin`, with the terminal in raw mode; what else arrives
// meanwhile (keys typed during start-up) is put back for the key reader, byte for byte.
//
// On Windows the widths of characters are measured too (setTerminalWidths): each one is written at the start of the
// cursor's row and the cursor's column asked for, and the row is erased afterwards. The interface's own symbols
// first; then, only where the terminal sizes ambiguous characters by its font (the console with a Chinese font: ·
// … “ ” — × ① in two cells), all of those: text with them in it was wrapped and padded as if they took one cell,
// which broke rows in two and left the footer on screen twice. Those are some 800 characters, so neighbours are
// written together first: one answer does for all of them when they are all one cell wide or all two, which most
// are, and only the others are then asked about one by one. A batch that is not answered whole in time is not used.
// Each text is written after the answer to the one before: the Windows 10 console (conhost 19041) answers with wrong
// columns when many of them come in one write, or in writes sent without waiting.
export function queryCursorRow(stdin, out, timeout = 300) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let timer = null, finished = false, batch = 0;
    const sent = []; // what was written to be measured (a character, or neighbours), in the order of the answers
    let answered = 0; // how many of them have an answer: counted when a whole batch is in
    let written = 0; // how many of them were written: the next one is, once all of those have an answer
    const replies = () => [...buf.toString('latin1').matchAll(CPR)];
    const cells = (matches, i) => Number(matches[1 + i][2]) - 1;
    // The width of each character of `text`, which took `n` cells: 0 when they are not all one or all two cells wide.
    const uniform = (text, n) => (n === text.length ? 1 : n === 2 * text.length ? 2 : 0);
    // What to measure next, decided by the answers so far.
    const next = (matches) => {
      batch++;
      if (batch === 1) return UI_PROBES.length && !(out.columns && out.columns < 3) ? UI_PROBES : [];
      if (batch === 2) {
        if (!UI_PROBES.slice(0, FONT_SIZED).some((_, i) => cells(matches, i) === 2)) return [];
        return ambiguousGroups(Math.max(1, Math.min(40, Math.floor(((out.columns || 80) - 2) / 2)))); // a piece fits the row at two cells each
      }
      if (batch === 3) return sent.flatMap((text, i) => (text.length > 1 && !uniform(text, cells(matches, i)) ? [...text] : []));
      return [];
    };
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.pause();
      const matches = replies();
      const first = matches[0];
      if (sent.length) {
        const answers = matches.slice(1, 1 + answered);
        // (an answer from another row: the screen moved meanwhile, and nothing that was measured is trusted)
        if (answers.every((m) => m[1] === first[1])) {
          const widths = [];
          answers.forEach((m, i) => {
            const width = uniform(sent[i], Number(m[2]) - 1);
            if (width) for (const char of sent[i]) widths.push([char, width]);
          });
          setTerminalWidths(widths);
        }
        try { out.write('\r' + ESC.right(Number(first[2]) - 1) + ESC.showCursor + SYNC_END); } catch { /* the terminal is gone */ }
      }
      // latin1 keeps a one-to-one mapping of bytes, including keys/pastes split in the middle of a UTF-8 character.
      const rest = Buffer.from(buf.toString('latin1').replace(CPR, ''), 'latin1');
      if (rest.length) stdin.unshift(rest);
      resolve(first ? Number(first[1]) : null);
    };
    const writeNext = () => {
      const start = written ? '' : SYNC_START + ESC.hideCursor;
      const text = sent[written++];
      try { out.write(start + '\r' + text + '\x1b[6n' + (written === sent.length ? '\r\x1b[K' : '')); } catch { done(); }
    };
    const measure = (texts, ms) => {
      sent.push(...texts);
      clearTimeout(timer);
      timer = setTimeout(done, ms);
      writeNext();
    };
    const onData = (d) => {
      buf = Buffer.concat([buf, Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8')]);
      const matches = replies();
      if (matches.length < 1 + sent.length) { // the first answer is the cursor's position
        if (written < sent.length && matches.length >= 1 + written) writeNext();
        return;
      }
      answered = sent.length;
      const more = next(matches);
      if (more.length) measure(more, batch === 1 ? timeout : AMBIGUOUS_TIMEOUT_MS);
      else done();
    };
    timer = setTimeout(done, timeout);
    stdin.on('data', onData);
    try { out.write('\x1b[6n'); } catch { done(); }
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
    this.dimensions = this.readSize();
    this.pin = pin;
    this.pinned = null; // rows from the top of the live region to the bottom of the screen; null: not known
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
    // RDP display changes can leave Node's columns/rows cache behind. Check the native size even while idle;
    // finding a change takes the same debounced full-repaint path as a normal resize event.
    if (process.platform === 'win32' && out.isTTY && out._handle?.getWindowSize) {
      this.sizeTimer = setInterval(() => this.checkSize(), 250);
      this.sizeTimer.unref();
    }
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

  readSize() {
    const fallback = [this.out.columns || this.dimensions?.[0] || termWidth(), this.out.rows || this.dimensions?.[1] || 30];
    if (process.platform === 'win32' && this.out.isTTY && this.out._handle?.getWindowSize) {
      try {
        const size = [0, 0];
        if (!this.out._handle.getWindowSize(size) && size.every((n) => Number.isInteger(n) && n > 0)) return size;
      } catch { /* closed or unsupported handle: keep the last valid size */ }
      return this.dimensions || fallback;
    }
    return fallback;
  }

  checkSize() {
    if (this.closed) return false;
    const size = this.readSize();
    if (size[0] === this.dimensions[0] && size[1] === this.dimensions[1]) return false;
    this.onResize(size);
    return true;
  }

  get width() { return Math.max(20, this.dimensions[0]); }
  get height() { return Math.max(10, this.dimensions[1]); }
  // True from a size change until the repaint that follows it.
  get resizing() { return this.resizeTimer !== null; }

  setLive(fn) { this.renderLive = fn; this.schedule(); }


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
  // with nearly every delta.
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
      const wrapped = wrapLine(cleanLine(line), cols - 1);
      if (cursor && cursor.row === i) {
        const col = cursor.col;
        const extra = Math.floor(col / (cols - 1));
        cursorRow = rows.length + Math.min(extra, wrapped.length - 1);
        cursorCol = col - extra * (cols - 1);
      }
      rows.push(...wrapped);
    });
    // Cap to the terminal height so there is always a way back to the top.
    const maxRows = Math.max(1, this.dimensions[1] - 1);
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

  onResize(size = this.readSize()) {
    if (this.closed) return;
    this.dimensions = size;
    const now = Date.now();
    if (!this.resizeSince) this.resizeSince = now;
    clearTimeout(this.resizeTimer);
    const wait = Math.max(0, Math.min(RESIZE_QUIET_MS, this.resizeSince + RESIZE_MAX_WAIT_MS - now));
    this.resizeTimer = setTimeout(() => this.settleResize(), wait);
  }

  settleResize() {
    this.resizeTimer = null;
    this.resizeSince = 0;
    if (!this.checkSize()) this.repaint();
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
    this.dimensions = this.readSize();
    if (this.scheduled) { clearTimeout(this.scheduled); this.scheduled = null; }
    clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.resizeSince = 0;
    const cols = this.width;
    const screenRows = Math.max(1, this.dimensions[1]);
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
    if (this.checkSize() || this.resizing) return; // the repaint after the resize writes everything that is waiting
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
    this.out.write(ESC.clearScreen);
    this.cursorRow = 0;
    this.history = [];
    if (this.pin) this.pinned = this.height; // from the top row
    this.flush();
  }

  // Print any pending output, then remove the live region (input box etc.) for good.
  // `keepTitle`: another process takes the terminal over at once (a restart), so the tab keeps its title.
  // `after`: lines to leave on the terminal (the exit's usage and resume hint).
  close({ keepTitle = false, after = [] } = {}) {
    if (this.closed) return;
    if (this.resizing) this.repaint(); // the cursor is not where the last draw left it: put things in order first
    this.renderLive = () => ({ lines: [] });
    this.pinned = null; // no blank rows left behind: the shell, or the next process, goes on right below the output
    this.staticQueue.push(...after);
    this.flush();
    this.closed = true;
    clearInterval(this.sizeTimer);
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
