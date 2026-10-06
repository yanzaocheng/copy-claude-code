import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// @file mentions in the prompt, in the real interactive App (headless terminal). No API request is
// made: what is tested is what the mention turns into, and what the agent is told it has read.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-mention-config-'));
Object.assign(process.env, {
  CLAUDE_PRO_CONFIG_DIR: configDir, CLAUDE_PRO_PROVIDER: 'api', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'test-token',
  ANTHROPIC_MODEL: 'mock', CLAUDE_PRO_DISABLE_AUTO_MEMORY: '1', CLAUDE_PRO_RIPGREP_PATH: 'off', CLAUDE_CODE_EFFORT_LEVEL: '', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
});
const { startTui } = await import('./tui-harness.js');
const { checkFreshness } = await import('../src/tools/files.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-mention-'));
  const write = (name, data) => { fs.writeFileSync(path.join(dir, name), data); return path.join(dir, name); };
  return {
    dir,
    small: write('small.txt', 'first line\nsecond line\n'),
    long: write('long.txt', Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'),
    binary: write('data.bin', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 1, 2, 3])),
    image: write('dot.png', PNG),
    huge: write('huge.log', 'x'.repeat(600 * 1024)),
    sub: (fs.mkdirSync(path.join(dir, 'sub')), write('sub/inner.txt', 'inner\n')) && path.join(dir, 'sub'),
  };
}

async function open(t, files) {
  const tui = await startTui({ cwd: files.dir });
  t.after(() => tui.close());
  return tui;
}

const textOf = (blocks) => blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

test('@file attaches what Read would show, and records the file as read', async (t) => {
  const files = project();
  const tui = await open(t, files);
  const blocks = await tui.app.attachments('please look at @small.txt');
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /Called the Read tool with the following input: \{"file_path":.*small\.txt.*\}/);
  assert.match(blocks[0].text, /\s1\tfirst line\n\s+2\tsecond line/);
  assert.deepEqual(tui.app.agent.fileState.get(files.small).partial, false);
  // read in full, so it can be edited and written without another Read
  assert.equal(checkFreshness(files.small, tui.app.agent.makeCtx(), { full: true }), null);
  assert.match(await tui.snapshot(), /Read 2 lines: small\.txt/);
});

test('@file of a long file attaches the first 2000 lines and says so; it is then only partly read', async (t) => {
  const files = project();
  const tui = await open(t, files);
  const blocks = await tui.app.attachments('check @long.txt');
  const text = textOf(blocks);
  assert.match(text, /line 2000\b/);
  assert.doesNotMatch(text, /line 2001\b/);
  assert.match(text, /File has 2500 lines total; showing lines 1-2000/, 'the model must be told the rest was not shown');
  assert.equal(tui.app.agent.fileState.get(files.long).partial, true);
  const ctx = tui.app.agent.makeCtx();
  assert.match(checkFreshness(files.long, ctx, { full: true }), /only partly read/, 'Write must not overwrite lines nobody saw');
  assert.equal(checkFreshness(files.long, ctx), null, 'an Edit of text that was shown is fine');
});

test('@file of a binary file is skipped with a message, not pasted into the prompt as garbage', async (t) => {
  const files = project();
  const tui = await open(t, files);
  const blocks = await tui.app.attachments('what is @data.bin');
  assert.deepEqual(blocks, []);
  assert.equal(tui.app.agent.fileState.has(files.binary), false);
  assert.match(await tui.snapshot(), /Skipped data\.bin: This appears to be a binary file/);
});

test('@image.png attaches the image itself', async (t) => {
  const files = project();
  const tui = await open(t, files);
  const blocks = await tui.app.attachments('describe @dot.png');
  const image = blocks.find((b) => b.type === 'image');
  assert.ok(image, JSON.stringify(blocks).slice(0, 300));
  assert.equal(image.source.media_type, 'image/png');
  assert.equal(Buffer.from(image.source.data, 'base64').equals(PNG), true);
  assert.match(textOf(blocks), /The user attached .*dot\.png/);
});

test('@file over 512KB is skipped and the user is told', async (t) => {
  const files = project();
  const tui = await open(t, files);
  const blocks = await tui.app.attachments('see @huge.log');
  assert.deepEqual(blocks, []);
  assert.match(await tui.snapshot(), /Skipped huge\.log: 600KB is too large to attach/);
});

test('@directory lists it; a missing file and a repeated mention are harmless', async (t) => {
  const files = project();
  const tui = await open(t, files);
  const blocks = await tui.app.attachments('look in @sub and @sub again, also @nothing.txt and @small.txt, @small.txt');
  const text = textOf(blocks);
  assert.match(text, /inner\.txt/);
  assert.equal(text.match(/Result:\ninner\.txt/g)?.length, 1, 'a directory mentioned twice is listed once');
  assert.equal(text.match(/first line/g)?.length, 1, 'a file mentioned twice is attached once');
  assert.doesNotMatch(text, /nothing\.txt/);
});

test('a prompt without mentions attaches nothing', async (t) => {
  const files = project();
  const tui = await open(t, files);
  assert.deepEqual(await tui.app.attachments('mail me at someone@example.com or use a decorator @ this'), []);
});

test('@file is looked for from the project root, as the autocomplete lists it, even after the shell moved elsewhere', async (t) => {
  const files = project();
  const tui = await open(t, files);
  tui.app.agent.cwd = files.sub; // what a `cd sub` in a Bash tool call does
  const blocks = await tui.app.attachments('look at @small.txt and @inner.txt');
  const text = textOf(blocks);
  assert.match(text, /first line/, 'small.txt is in the project root');
  assert.match(text, /inner/, 'inner.txt is only in the directory the shell is in, and is found there too');
  assert.equal(blocks.length, 2);
});

test('a file name with spaces is completed in quotes, and the quoted mention is attached', async (t) => {
  const files = project();
  fs.writeFileSync(path.join(files.dir, 'my notes.txt'), 'notes with a space in the name\n');
  const tui = await open(t, files);
  await tui.waitFor(() => tui.app.fileIndex.files.includes('my notes.txt'), { timeout: 10_000 });
  const suggestion = tui.app.suggest('read @my', 8);
  assert.deepEqual(suggestion.items.map((item) => item.value), ['@"my notes.txt"']);
  assert.equal(suggestion.items[0].label, 'my notes.txt', 'the list shows the plain name');
  const blocks = await tui.app.attachments(`read ${suggestion.items[0].value} please`);
  assert.match(textOf(blocks), /notes with a space in the name/);
  // names without spaces are inserted as before
  assert.equal(tui.app.suggest('@small', 6).items[0].value, '@small.txt');
});

test('Tab completes a file name with spaces into a quoted mention in the input box', async (t) => {
  const files = project();
  fs.writeFileSync(path.join(files.dir, 'my notes.txt'), 'x\n');
  const tui = await open(t, files);
  await tui.waitFor(() => tui.app.fileIndex.files.includes('my notes.txt'), { timeout: 10_000 });
  tui.send('read @my');
  await tui.waitFor('my notes.txt', { timeout: 10_000 }); // the suggestion list
  tui.send('\t');
  await tui.waitFor(() => tui.app.editor.text.startsWith('read @"my notes.txt"'), { timeout: 10_000 });
  assert.equal(tui.app.editor.text.trimEnd(), 'read @"my notes.txt"');
  const blocks = await tui.app.attachments(tui.app.editor.text);
  assert.equal(blocks.length, 1);
});

test('a name is attached as written, with its parentheses; punctuation after a plain mention is still dropped', async (t) => {
  const files = project();
  fs.writeFileSync(path.join(files.dir, 'report (final).txt'), 'the final report\n');
  fs.writeFileSync(path.join(files.dir, 'build(1)'), 'build one\n');
  fs.mkdirSync(path.join(files.dir, '(auth)'));
  fs.writeFileSync(path.join(files.dir, '(auth)', 'login.txt'), 'x\n');
  const tui = await open(t, files);
  const attach = async (prompt) => textOf(await tui.app.attachments(prompt));
  // a quoted name is exactly what is inside the quotes: the completion inserts these for names with spaces
  assert.match(await attach('read @"report (final).txt" now'), /the final report/);
  // a plain name that exists as written is that file, even when it ends like punctuation
  assert.match(await attach('read @build(1) now'), /build one/);
  assert.match(await attach('and @(auth)'), /login\.txt/);
  // prose punctuation after a mention is not part of the name
  assert.match(await attach('see @small.txt, then continue'), /first line/);
  assert.match(await attach('this is in @small.txt.'), /first line/);
  assert.match(await attach('(or @small.txt)'), /first line/);
  assert.match(await attach('really @small.txt?!'), /first line/);
  // nothing but punctuation is not a path: it used to mean the project root, whose listing was attached
  assert.deepEqual(await tui.app.attachments('wait @... and @, and @?'), []);
});

test('completing into a directory whose name has spaces keeps the quote open, so completion goes on inside it', async (t) => {
  const files = project();
  fs.mkdirSync(path.join(files.dir, 'my dir'));
  fs.writeFileSync(path.join(files.dir, 'my dir', 'inner file.txt'), 'deep\n');
  const tui = await open(t, files);
  await tui.waitFor(() => tui.app.fileIndex.files.includes('my dir/inner file.txt'), { timeout: 10_000 });
  const dir = tui.app.suggest('look @my', 8).items.find((item) => item.label === 'my dir/');
  assert.equal(dir.value, '@"my dir/', 'the closing quote is left for after the file name');
  assert.equal(dir.noSpace, true, 'and the cursor stays right behind the slash');
  // typing on from there lists what is inside, and completes to a closed quote
  const text = `look ${dir.value}`;
  const inside = tui.app.suggest(text, text.length);
  const file = inside.items.find((item) => item.label === 'my dir/inner file.txt');
  assert.equal(file?.value, '@"my dir/inner file.txt"', `what is inside the directory is offered: ${JSON.stringify(inside.items.map((item) => item.value))}`);
  assert.equal(inside.from, 5, 'the whole mention so far is replaced');
  const blocks = await tui.app.attachments(`look ${file.value}`);
  assert.match(textOf(blocks), /deep/);
  // a quote typed by hand opens the completion too
  assert.ok(tui.app.suggest('@"my', 4).items.some((item) => item.label === 'my dir/'));
  // and names without spaces are not quoted unless the user did
  assert.equal(tui.app.suggest('@small', 6).items[0].value, '@small.txt');
  assert.equal(tui.app.suggest('@"small', 7).items[0].value, '@"small.txt"');
});

test('without ripgrep a directory is offered once, with its slash, not also as a bare name', async (t) => {
  const files = project();
  const tui = await open(t, files);
  await tui.waitFor(() => tui.app.fileIndex.files.includes('sub/inner.txt'), { timeout: 10_000 });
  assert.ok(tui.app.fileIndex.files.includes('sub'), 'the glob really does list the directory as a plain name (this is the case being tested)');
  assert.deepEqual(tui.app.suggest('@su', 3).items.map((item) => item.label), ['sub/', 'sub/inner.txt']);
});

test('@directory with many entries says how many were left out', async (t) => {
  const files = project();
  const many = path.join(files.dir, 'many');
  fs.mkdirSync(many);
  for (let i = 0; i < 250; i++) fs.writeFileSync(path.join(many, `f${String(i).padStart(3, '0')}.txt`), '');
  const tui = await open(t, files);
  const text = textOf(await tui.app.attachments('what is in @many'));
  assert.equal(text.match(/\.txt/g).length, 200);
  assert.match(text, /\(50 more entries not shown\)/);
  const small = textOf(await tui.app.attachments('and @sub'));
  assert.doesNotMatch(small, /more entries/, 'nothing is said when nothing was left out');
});

// The methods below run outside any handler (nobody awaits them), so an error that escapes ends the program.

test('@directory that cannot be listed is skipped with the reason, the rest of the prompt still goes', async (t) => {
  const files = project();
  const tui = await open(t, files);
  const original = fs.readdirSync;
  fs.readdirSync = (dir, ...rest) => {
    if (path.resolve(String(dir)) === files.sub) throw Object.assign(new Error("EACCES: permission denied, scandir 'sub'"), { code: 'EACCES' });
    return original(dir, ...rest);
  };
  t.after(() => { fs.readdirSync = original; });
  const blocks = await tui.app.attachments('list @sub and read @small.txt');
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /first line/);
  assert.match(await tui.snapshot(), /Skipped sub: EACCES/);
});

test('a failure while preparing a turn is reported instead of escaping from startTurn', async (t) => {
  const files = project();
  const tui = await open(t, files);
  tui.app.attachments = async () => { throw new Error('the attachment step failed'); };
  await tui.app.startTurn('hello @small.txt'); // must resolve: callers do not await it
  assert.equal(tui.app.busy, false);
  assert.match(await tui.snapshot(), /the attachment step failed/);
});

test('# memory that cannot be saved says so instead of ending the program', async (t) => {
  const files = project();
  const tui = await open(t, files);
  const original = fs.appendFileSync;
  fs.appendFileSync = (file, ...rest) => {
    if (String(file).endsWith('CLAUDE.md')) throw Object.assign(new Error("EACCES: permission denied, open 'CLAUDE.md'"), { code: 'EACCES' });
    return original(file, ...rest);
  };
  t.after(() => { fs.appendFileSync = original; });
  const rejections = [];
  const onRejection = (e) => rejections.push(e);
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));

  tui.app.addMemory('always use tabs');
  await tui.waitFor('Where should this memory be saved?', { timeout: 10_000 });
  tui.send('\r'); // the first option: project memory, ./CLAUDE.md
  const screen = await tui.waitFor('Could not save the memory', { timeout: 10_000 });
  assert.match(screen, /EACCES/);
  await tui.wait(100);
  assert.deepEqual(rejections, []);
  assert.equal(fs.existsSync(path.join(files.dir, 'CLAUDE.md')), false);
});
