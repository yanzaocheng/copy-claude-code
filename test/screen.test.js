import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import xterm from '@xterm/headless';
import { PassThrough } from 'node:stream';
import { Screen, mouseFilter } from '../src/ui/screen.js';

// The screen manager against a headless xterm, which re-flows its contents when it is resized like a real
// terminal does. (The Windows pipeline, a ConPTY in front of the terminal, is harsher still; this checks the
// behaviour the manager itself is responsible for.)

const { Terminal } = xterm;

function setup({ cols = 60, rows = 14 } = {}) {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  const out = new EventEmitter();
  Object.assign(out, { columns: cols, rows, isTTY: true });
  const writes = [];
  out.write = (s) => { writes.push(s); term.write(s); return true; };
  const screen = new Screen(out);
  // an input box like the real one: a border as wide as the screen minus one, the prompt, a footer
  screen.setLive((width) => {
    const w = width - 1;
    return {
      lines: ['╭' + '─'.repeat(w - 2) + '╮', '│ > ' + 'x'.repeat(5) + ' '.repeat(w - 10) + '│', '╰' + '─'.repeat(w - 2) + '╯', '  ? for shortcuts'],
      cursor: { row: 1, col: 9 },
    };
  });
  const flush = () => new Promise((r) => term.write('', r));
  const api = {
    term, out, screen, writes, flush,
    async settle() { while (screen.resizing || screen.scheduled) await new Promise((r) => setTimeout(r, 10)); await flush(); },
    // Resize like a window drag: the terminal re-flows first, then the program is told.
    async resize(c, r = term.rows) {
      term.resize(c, r);
      out.columns = c;
      out.rows = r;
      out.emit('resize');
      await api.settle();
    },
    async rows({ all = false } = {}) {
      await flush();
      const buf = term.buffer.active;
      const lines = [];
      for (let i = all ? 0 : buf.baseY; i < (all ? buf.length : buf.baseY + term.rows); i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
      return lines;
    },
    log(n, prefix = 'line') { for (let i = 1; i <= n; i++) screen.log(`${prefix} ${i}`); },
  };
  return api;
}

const boxRows = (rows) => rows.map((r, i) => [r, i]).filter(([r]) => /^│ >/.test(r)).map(([, i]) => i);

test('a screen full of output: after narrowing, one box at the new width at the bottom, nothing left of the old one', async () => {
  const t = setup({ cols: 80, rows: 14 });
  t.log(40);
  await t.settle();
  await t.resize(50);
  const rows = await t.rows();
  assert.deepEqual(boxRows(rows), [rows.length - 3], 'one box, its prompt row the third from the bottom');
  assert.equal(rows.at(-1).trim(), '? for shortcuts', 'the footer is the last row of the screen');
  assert.equal(rows.at(-4), '╭' + '─'.repeat(47) + '╮', 'the top border is exactly the new width minus one, in one piece');
  assert.equal(rows.at(-2), '╰' + '─'.repeat(47) + '╯');
  // the output above it is the newest output, in order, with nothing missing or repeated
  const lines = rows.slice(0, -4).filter((r) => r.trim());
  assert.deepEqual(lines, Array.from({ length: lines.length }, (_, i) => `line ${40 - lines.length + 1 + i}`));
  assert.ok(lines.length >= 9, `the screen is filled with output, not left empty: ${lines.length} lines`);
  // and there is no second box anywhere, scrollback included
  assert.equal(boxRows(await t.rows({ all: true })).length, 1);
});

test('narrowing, widening and narrowing again leaves a single box every time', async () => {
  const t = setup({ cols: 100, rows: 12 });
  t.log(30);
  await t.settle();
  for (const width of [70, 45, 90, 30, 100, 60]) {
    await t.resize(width);
    const all = await t.rows({ all: true });
    assert.equal(boxRows(all).length, 1, `after resizing to ${width}: ${boxRows(all).length} boxes\n${all.slice(-14).join('\n')}`);
    const rows = await t.rows();
    assert.equal(rows.at(-1).trim(), '? for shortcuts');
    assert.equal(rows.at(-4).length, width - 1, `the border fits the screen at ${width}`);
  }
});

test('the cursor ends up in the input box, where the user types', async () => {
  const t = setup({ cols: 80, rows: 14 });
  t.log(30);
  await t.settle();
  await t.resize(55);
  const buf = t.term.buffer.active;
  assert.equal(buf.cursorY, t.term.rows - 3, 'on the prompt row');
  assert.equal(buf.cursorX, 9);
});

test('a drag is one repaint, made once the size has stopped changing, and nothing is drawn in between', async () => {
  const t = setup({ cols: 100, rows: 12 });
  t.log(30);
  await t.settle();
  const before = t.writes.length;
  for (const width of [95, 90, 85, 80, 75, 70, 65, 60]) {
    t.term.resize(width, 12);
    t.out.columns = width;
    t.out.emit('resize');
    await new Promise((r) => setTimeout(r, 5));
    t.screen.schedule(); // a spinner frame, a streamed token: ordinary redraws that must wait
    t.screen.log('output during the drag');
  }
  assert.equal(t.writes.length, before, 'no write while the size is still changing');
  assert.equal(t.screen.resizing, true);
  await t.settle();
  const repaints = t.writes.slice(before).filter((w) => w.includes('\x1b[H'));
  assert.equal(t.writes.length - before, 1, 'one write for the whole drag');
  assert.equal(repaints.length, 1);
  // the output logged during the drag is on screen once each, in order
  const rows = (await t.rows({ all: true })).filter((r) => r === 'output during the drag');
  assert.equal(rows.length, 8);
});

test('a drag that goes on and on is repainted now and then, not only at the end', async () => {
  const t = setup({ cols: 100, rows: 12 });
  t.log(30);
  await t.settle();
  const before = t.writes.length;
  const began = Date.now();
  let width = 100;
  while (Date.now() - began < 800) {
    width = width > 60 ? width - 1 : 100;
    t.term.resize(width, 12);
    t.out.columns = width;
    t.out.emit('resize');
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(t.writes.length - before >= 2, `a drag of 0.8 s was repainted ${t.writes.length - before} times: the screen must not stay broken for its whole length`);
  await t.settle();
  assert.equal(boxRows(await t.rows({ all: true })).length, 1);
});

test('output logged while resizing is not lost, whichever way the repaint is reached', async () => {
  const t = setup({ cols: 80, rows: 12 });
  t.log(20);
  await t.settle();
  t.term.resize(50, 12);
  t.out.columns = 50;
  t.out.emit('resize');
  t.screen.log('printed in the middle of the resize');
  await t.settle();
  const all = await t.rows({ all: true });
  assert.equal(all.filter((r) => r === 'printed in the middle of the resize').length, 1);
  assert.equal(all.indexOf('printed in the middle of the resize') > all.indexOf('line 20'), true, 'after the earlier output');
  // and later output carries on normally below it
  t.screen.log('and afterwards');
  await t.settle();
  const rows = await t.rows();
  assert.equal(rows.at(-5), 'and afterwards');
  assert.equal(boxRows(rows).length, 1);
});

test('a short session: the output stays at the top, the box on the last rows of the window, blank rows between', async () => {
  const t = setup({ cols: 80, rows: 20 });
  t.log(3);
  await t.settle();
  await t.resize(40);
  const rows = await t.rows();
  assert.deepEqual(rows.slice(0, 3), ['line 1', 'line 2', 'line 3']);
  assert.equal(rows.slice(3, 16).every((r) => r === ''), true, 'blank between the output and the box');
  assert.deepEqual(boxRows(rows), [17]);
  assert.equal(rows.at(-1).trim(), '? for shortcuts', 'the footer is the last row of the window');
  // new output takes the place of the blank rows, and the box stays where it is
  t.log(2, 'more');
  await t.settle();
  const after = await t.rows();
  assert.deepEqual(after.slice(0, 5), ['line 1', 'line 2', 'line 3', 'more 1', 'more 2']);
  assert.deepEqual(boxRows(after), [17]);
});

test('pinned from the row the terminal reports: the box goes to the bottom without pushing the output above off the screen', async () => {
  const t = setup({ cols: 60, rows: 14 });
  t.term.write('$ claude-pro\r\n');
  await t.flush();
  t.screen.pinFrom(t.term.buffer.active.cursorY + 1);
  t.log(2);
  await t.settle();
  let rows = await t.rows();
  assert.deepEqual(rows.slice(0, 3), ['$ claude-pro', 'line 1', 'line 2']);
  assert.equal(rows.at(-1).trim(), '? for shortcuts');
  // more output than there is room: it scrolls, and the box is still on the last rows
  t.log(20, 'later');
  await t.settle();
  rows = await t.rows();
  assert.equal(rows.at(-1).trim(), '? for shortcuts');
  assert.equal(rows.at(-5), 'later 20');
  // closing takes the blank rows away: what comes next (the shell) goes on right below the output
  t.screen.close();
  await t.flush();
  assert.equal(t.term.buffer.active.cursorY, rows.length - 4, 'the cursor is right below the last output');
});

test('a taller or shorter window is repainted too', async () => {
  const t = setup({ cols: 70, rows: 12 });
  t.log(40);
  await t.settle();
  for (const rowsNow of [20, 8, 16]) {
    await t.resize(70, rowsNow);
    const rows = await t.rows();
    assert.equal(rows.length, rowsNow);
    assert.equal(rows.at(-1).trim(), '? for shortcuts', `footer on the last row of a ${rowsNow}-row window`);
    assert.equal(boxRows(await t.rows({ all: true })).length, 1);
  }
});

test('closing while the size is changing ends cleanly: no box left behind, no timer left running', async () => {
  const t = setup({ cols: 80, rows: 12 });
  t.log(20);
  await t.settle();
  t.term.resize(50, 12);
  t.out.columns = 50;
  t.out.emit('resize');
  assert.equal(t.screen.resizing, true);
  t.screen.close();
  assert.equal(t.screen.resizing, false);
  await t.flush();
  const rows = await t.rows({ all: true });
  assert.equal(boxRows(rows).length, 0, 'the input box is gone');
  assert.equal(rows.filter((r) => r === 'line 20').length, 1);
  const writes = t.writes.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(t.writes.length, writes, 'nothing is written after close');
});

test('/clear forgets what was logged: a repaint afterwards does not bring it back', async () => {
  const t = setup({ cols: 80, rows: 12 });
  t.log(30, 'old');
  await t.settle();
  t.screen.clearScreen();
  t.log(2, 'new');
  await t.settle();
  await t.resize(60);
  const all = await t.rows({ all: true });
  assert.equal(all.filter((r) => r.startsWith('old')).length, 0, 'cleared output stays cleared');
  assert.deepEqual((await t.rows()).filter((r) => r.startsWith('new')), ['new 1', 'new 2']);
});

test('very long lines and long outputs: only a bounded history is kept, and a line wider than the screen counts for its rows', async () => {
  const t = setup({ cols: 40, rows: 10 });
  for (let i = 0; i < 3000; i++) t.screen.log(`row ${i}`);
  assert.ok(t.screen.history.length <= 1200, `history holds ${t.screen.history.length} lines`);
  t.screen.log('w'.repeat(100)); // three rows at 40 columns
  t.screen.log('last line');
  await t.settle();
  await t.resize(40, 10);
  const rows = await t.rows();
  assert.equal(rows.at(-5), 'last line');
  assert.equal(rows.at(-6), 'w'.repeat(100).slice(80), 'the wrapped line takes its three rows, its last piece directly above');
  assert.equal(rows.at(-8), 'w'.repeat(40));
});

test('fullscreen: the box on the last rows of the alternate screen, the conversation scrolled inside, new output counted while scrolled up', async () => {
  const t = setup({ cols: 60, rows: 14 });
  t.term.write('$ the shell\r\n');
  t.log(3, 'before');
  await t.settle();
  t.screen.setFull(true);
  t.log(40);
  await t.settle();
  assert.equal(t.term.buffer.active.type, 'alternate');
  let rows = await t.rows();
  assert.equal(rows.length, 14);
  assert.equal(rows.at(-1).trim(), '? for shortcuts');
  assert.equal(rows.at(-5), 'line 40', 'the newest output right above the box');
  t.screen.scrollBy(5);
  rows = await t.rows();
  assert.equal(rows.at(-6), 'line 34');
  assert.match(rows.at(-5), /Jump to bottom \(ctrl\+End\) ↓/);
  t.log(2, 'new');
  await t.settle();
  rows = await t.rows();
  assert.equal(rows.at(-6), 'line 34', 'the view stays where it was');
  assert.match(rows.at(-5), /2 new lines/);
  t.screen.scrollBy('top');
  assert.equal((await t.rows())[0], 'before 1', 'the top is the start of the conversation');
  t.screen.scrollBy('bottom');
  rows = await t.rows();
  assert.equal(rows.at(-5), 'new 2');
  // a resize redraws at the new width, the box still at the bottom
  await t.resize(40, 10);
  rows = await t.rows();
  assert.equal(rows.length, 10);
  assert.equal(rows.at(-1).trim(), '? for shortcuts');
  assert.equal(rows.at(-5), 'new 2');
  // closing gives the terminal its normal screen back, the shell's output on it
  t.screen.close();
  await t.flush();
  assert.equal(t.term.buffer.active.type, 'normal');
  assert.ok((await t.rows({ all: true })).includes('$ the shell'));
});

test('fullscreen: mouse reports are taken out of the keys, also when a report comes in two pieces', async () => {
  const stdin = new PassThrough();
  const mouse = [];
  const keys = mouseFilter(stdin, (m) => mouse.push(m));
  let text = '';
  keys.on('data', (d) => { text += d; });
  stdin.write('ab\x1b[<64;10;5Mc');
  stdin.write('\x1b[<65;1');
  stdin.write('0;5Md\x1b');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(text, 'abcd\x1b', 'the keys, an Esc at the end included');
  assert.deepEqual(mouse.map((m) => m.button), [64, 65]);
});
