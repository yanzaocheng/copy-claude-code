import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/ui/editor.js';

const key = (name, extra = {}) => ({ name, ...extra });

test('editor: up and down move between lines and keep the column; the history only from the start or the end of the text', () => {
  const e = new Editor({ history: ['older', 'newer'] });
  e.set('abcdef\nxy\nlonger line', 15); // in "longer line", column 5
  e.handleKey('', key('up'));
  assert.equal(e.cursor, 9, 'the shorter line is only 2 long: the cursor goes to its end');
  e.handleKey('', key('up'));
  assert.equal(e.cursor, 5, 'first line, back at column 5, where it started from');
  assert.equal(e.text, 'abcdef\nxy\nlonger line');
  e.handleKey('', key('up')); // on the first line: to the start first
  assert.equal(e.cursor, 0);
  assert.equal(e.text, 'abcdef\nxy\nlonger line');
  e.handleKey('', key('up')); // at the start: the history
  assert.equal(e.text, 'newer');
  e.handleKey('', key('down'));
  assert.equal(e.text, 'abcdef\nxy\nlonger line', 'the draft comes back');
  e.set('one\ntwo', 1);
  e.handleKey('', key('down'));
  assert.equal(e.cursor, 5);
});

test('editor: a draft cleared with esc esc comes back with up, pasted text included, even after a sent message', () => {
  const sent = [];
  const e = new Editor({ history: ['older'], onSubmit: (value) => sent.push(value) });
  e.insert('fix this: ');
  e.insertPaste('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl');
  const draft = e.text;
  e.handleKey('', key('escape', { meta: true }));
  assert.equal(e.text, '');
  e.set('another message');
  e.submit();
  e.handleKey('', key('up'));
  assert.equal(e.text, draft, 'the cleared draft first');
  assert.match(e.expanded(), /fix this: a\nb\n/, 'with its pasted text');
  e.handleKey('', key('up'));
  assert.equal(e.text, 'another message', 'then the history');
  e.handleKey('', key('down'));
  assert.equal(e.text, draft);
  e.clear();
  e.handleKey('', key('up'));
  assert.equal(e.text, 'another message', 'brought back once');
});

test('editor: home, ctrl-a and ctrl-u work on the current line', () => {
  const e = new Editor();
  e.set('first\nsecond line', 9);
  e.handleKey('', key('home'));
  assert.equal(e.cursor, 6);
  e.set('first\nsecond line', 9);
  e.handleKey('', key('a', { ctrl: true }));
  assert.equal(e.cursor, 6);
  e.set('first\nsecond line', 9);
  e.handleKey('', key('u', { ctrl: true }));
  assert.equal(e.text, 'first\nond line');
  assert.equal(e.cursor, 6);
  e.set('single line', 6);
  e.handleKey('', key('home'));
  assert.equal(e.cursor, 0);
});

test('editor: a text that starts with a newline still has a first line', () => {
  const e = new Editor({ history: ['earlier prompt'] });
  e.set('\nsecond line', 0);
  e.handleKey('', key('a', { ctrl: true }));
  assert.equal(e.cursor, 0, 'home at position 0 stays there');
  e.handleKey('', key('u', { ctrl: true }));
  assert.equal(e.text, '\nsecond line', 'nothing before the cursor to delete');
  e.handleKey('', key('up'));
  assert.equal(e.text, 'earlier prompt', 'the cursor is on the first line, so up goes to the history');
  e.set('\nsecond line', 5); // on the second line: up goes to the first, which is empty
  e.handleKey('', key('up'));
  assert.equal(e.cursor, 0);
});

test('editor: up and down move through the rows of a long line that wraps, and left and right as usual', () => {
  const e = new Editor({ history: ['earlier message'] });
  e.render(30); // a box 29 wide: 23 columns of text
  const long = '这是一段很长的中文消息，会自动折成好几行显示在输入框里面，用来测试上下键。';
  e.set(long);
  const rows = e.render(30).lines.length - 2;
  assert.ok(rows >= 3, `the text is shown on ${rows} rows`);
  const end = e.cursor;
  e.handleKey('', key('up'));
  assert.ok(e.cursor < end && e.text === long, 'up moves a row up within the text, not to the history');
  const oneUp = e.cursor;
  e.handleKey('', key('left'));
  assert.equal(e.cursor, oneUp - 1);
  e.handleKey('', key('right'));
  e.handleKey('', key('down'));
  assert.equal(e.cursor, end, 'down comes back to the same place');
  for (let i = 0; i < rows - 1; i++) e.handleKey('', key('up'));
  assert.ok(e.cursor > 0 && e.cursor < 12, 'on the first row');
  e.handleKey('', key('up'));
  assert.equal(e.cursor, 0, 'then to the start');
  e.handleKey('', key('up'));
  assert.equal(e.text, 'earlier message', 'and only then the history');
});

test('editor: esc esc clears a text, and on an empty prompt asks for the rewind menu', () => {
  let asked = 0;
  const e = new Editor({ onDoubleEscape: () => { asked++; } });
  e.set('draft');
  e.handleKey('', key('escape'));
  e.handleKey('', key('escape'));
  assert.equal(e.text, '');
  assert.equal(asked, 0, 'clearing the text is all esc esc does then');
  e.handleKey('', key('escape'));
  e.handleKey('', key('escape'));
  assert.equal(asked, 1);
  e.handleKey('', key('escape', { meta: true })); // both in one chunk
  assert.equal(asked, 2);
});
