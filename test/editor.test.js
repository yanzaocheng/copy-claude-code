import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/ui/editor.js';

const key = (name, extra = {}) => ({ name, ...extra });

test('editor: up and down move between lines and keep the column; the first and last line use the history', () => {
  const e = new Editor({ history: ['older', 'newer'] });
  e.set('abcdef\nxy\nlonger line', 15); // in "longer line", column 4
  e.handleKey('', key('up'));
  assert.equal(e.cursor, 9, 'the shorter line is only 2 long: the cursor goes to its end');
  e.handleKey('', key('up'));
  assert.equal(e.cursor, 2, 'first line, column 2');
  assert.equal(e.text, 'abcdef\nxy\nlonger line');
  e.handleKey('', key('up')); // already on the first line: the history
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
