import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GrepTool, globToRegExp } from '../src/tools/search.js';
import { ripgrepPath } from '../src/utils/shell.js';
import { Config } from '../src/config.js';

function fixture(files, { git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-grep-'));
  if (git) fs.mkdirSync(path.join(dir, '.git'));
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  return dir;
}

// CLAUDE_PRO_RIPGREP_PATH=off forces the built-in scanner, so these tests behave the same
// whether or not ripgrep is installed.
const grep = (dir, input) => GrepTool.call({ path: dir, ...input }, { cwd: dir, projectRoot: dir, config: { env: { CLAUDE_PRO_RIPGREP_PATH: 'off' } } });
const rel = (dir, text) => text.split(dir + path.sep).join('').replace(/\\/g, '/');
const files = (dir, r) => rel(dir, r.content).split('\n').filter((l) => l && !l.startsWith('Found ') && !l.startsWith('(') && l !== 'No files found').sort();
const lines = (dir, r) => rel(dir, r.content).split('\n').filter(Boolean);

test('Grep scanner: globs that only exclude keep every other file (they used to match nothing)', async () => {
  const dir = fixture({ 'src/a.js': 'needle\n', 'README.md': 'needle\n', 'node_modules/x.js': 'needle\n', 'build/o.js': 'needle\n' });
  assert.deepEqual(files(dir, await grep(dir, { pattern: 'needle', glob: '!*.md' })), ['build/o.js', 'src/a.js']);
  assert.deepEqual(files(dir, await grep(dir, { pattern: 'needle', glob: '!{node_modules,build}/**' })), ['README.md', 'src/a.js']);
  assert.deepEqual(files(dir, await grep(dir, { pattern: 'needle', glob: '!build/**,!*.md' })), ['src/a.js']);
});

test('Grep scanner: ripgrep\'s inline flags (?i) and (?s) work (a JS RegExp refused them as an invalid group)', async () => {
  const dir = fixture({ 'a.js': 'Sub-Agent here\n', 'b.js': 'begin\nmiddle\nend\n', 'c.js': 'nothing\n' });
  assert.deepEqual(files(dir, await grep(dir, { pattern: '(?i)sub-agent' })), ['a.js']);
  assert.deepEqual(files(dir, await grep(dir, { pattern: '(?is)BEGIN.*END', multiline: true })), ['b.js']);
  assert.deepEqual(files(dir, await grep(dir, { pattern: '(?s)begin.*end', multiline: true })), ['b.js']);
  assert.match((await grep(dir, { pattern: '(?i' })).content, /Grep failed/, 'a pattern that is really invalid still says so');
});

test('Grep takes file_path for path and grep\'s -l / -c flags as output modes', async () => {
  const dir = fixture({ 'a.js': 'needle\nneedle\n', 'b.js': 'needle\n' });
  const norm = (input) => GrepTool.normalizeInput({ ...input });
  const one = norm({ pattern: 'needle', file_path: path.join(dir, 'a.js'), '-c': true, '-r': true });
  assert.deepEqual([one.path, one.output_mode], [path.join(dir, 'a.js'), 'count']);
  assert.match((await GrepTool.call(one, { cwd: os.tmpdir(), config: { env: { CLAUDE_PRO_RIPGREP_PATH: 'off' } } })).content, /:2/);
  assert.equal(norm({ pattern: 'x', '-l': true }).output_mode, 'files_with_matches');
  assert.equal(norm({ pattern: 'x', '-c': true, output_mode: 'content' }).output_mode, 'content', 'an output_mode given wins');
  assert.equal(norm({ pattern: 'x', path: 'p', file_path: 'f' }).path, 'p');
});

test('Grep scanner: glob forms behave like ripgrep --glob', async () => {
  const dir = fixture({
    'src/a.js': 'needle\n', 'src/b.ts': 'needle\n', 'src/deep/c.js': 'needle\n', 'top.js': 'needle\n', 'node_modules/pkg/i.js': 'needle\n',
  });
  const run = async (glob) => files(dir, await grep(dir, { pattern: 'needle', glob }));
  assert.deepEqual(await run('*.js'), ['src/a.js', 'src/deep/c.js', 'top.js']);
  assert.deepEqual(await run('src/*.js'), ['src/a.js']);
  assert.deepEqual(await run('src/**/*.js'), ['src/a.js', 'src/deep/c.js']);
  assert.deepEqual(await run('*.{js,ts}'), ['src/a.js', 'src/b.ts', 'src/deep/c.js', 'top.js']);
  assert.deepEqual(await run('*.js,*.ts'), ['src/a.js', 'src/b.ts', 'src/deep/c.js', 'top.js']);
  assert.deepEqual(await run('*.js,!c.js'), ['src/a.js', 'top.js']);
  assert.deepEqual(await run('node_modules/**/*.js'), ['node_modules/pkg/i.js']);
  assert.deepEqual(files(dir, await grep(dir, { pattern: 'needle' })), ['src/a.js', 'src/b.ts', 'src/deep/c.js', 'top.js']);
});

test('Grep scanner: ^ and $ anchor at line boundaries, also in CRLF files', async () => {
  const dir = fixture({ 'a.txt': 'alpha\nbeta needle\nneedle gamma\n', 'w.txt': 'one needle\r\ntwo\r\n' });
  assert.deepEqual(lines(dir, await grep(dir, { pattern: '^needle', output_mode: 'content' })), ['a.txt:3:needle gamma']);
  assert.deepEqual(lines(dir, await grep(dir, { pattern: 'needle$', output_mode: 'content' })).sort(), ['a.txt:2:beta needle', 'w.txt:1:one needle']);
});

test('Grep scanner: multiline matches report every line they span', async () => {
  const dir = fixture({ 'a.js': 'foo(\n  bar)\nnothing\nfoo(\nbar)\n' });
  const pattern = 'foo\\(\\s*\\n\\s*bar';
  assert.deepEqual(lines(dir, await grep(dir, { pattern, multiline: true, output_mode: 'content' })),
    ['a.js:1:foo(', 'a.js:2:  bar)', 'a.js:4:foo(', 'a.js:5:bar)']);
  assert.match((await grep(dir, { pattern, multiline: true, output_mode: 'count' })).content, /a\.js:4/);
  assert.deepEqual(files(dir, await grep(dir, { pattern, multiline: true })), ['a.js']);
});

test('Grep scanner: context lines use - and a -- separator only where there is a gap', async () => {
  const dir = fixture({ 'c.txt': 'x\nneedle\nneedle\ny\nz\nneedle\n' });
  assert.deepEqual(lines(dir, await grep(dir, { pattern: 'needle', output_mode: 'content', '-A': 1 })),
    ['c.txt:2:needle', 'c.txt:3:needle', 'c.txt-4-y', '--', 'c.txt:6:needle']);
  assert.deepEqual(lines(dir, await grep(dir, { pattern: 'needle', output_mode: 'content', '-C': 1 })),
    ['c.txt-1-x', 'c.txt:2:needle', 'c.txt:3:needle', 'c.txt-4-y', 'c.txt-5-z', 'c.txt:6:needle']);
  assert.deepEqual(lines(dir, await grep(dir, { pattern: 'y', output_mode: 'content', '-n': false })), ['c.txt:y']);
});

test('Grep scanner: .gitignore only counts inside a git work tree, .ignore always does', async () => {
  const tree = {
    '.gitignore': 'build/\n*.log\n!keep.log\n/root.txt\n', '.ignore': 'dot.txt\n', 'dot.txt': 'needle\n',
    'build/o.js': 'needle\n', 'x.log': 'needle\n', 'keep.log': 'needle\n', 'root.txt': 'needle\n', 'sub/root.txt': 'needle\n', 'src/a.js': 'needle\n',
    'src/.gitignore': 'secret.js\n', 'src/secret.js': 'needle\n',
  };
  const repo = fixture(tree, { git: true });
  assert.deepEqual(files(repo, await grep(repo, { pattern: 'needle' })), ['keep.log', 'src/a.js', 'sub/root.txt']);
  // a search root inside the repository still honours the ignore files above it
  const inner = path.join(repo, 'sub');
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.txt\n');
  assert.deepEqual(files(inner, await grep(inner, { pattern: 'needle' })), []);
  const plain = fixture(tree);
  assert.deepEqual(files(plain, await grep(plain, { pattern: 'needle' })),
    ['build/o.js', 'keep.log', 'root.txt', 'src/a.js', 'src/secret.js', 'sub/root.txt', 'x.log']);
});

test('Grep scanner: type filter, binary files, UTF-16 and over-long lines', async () => {
  const dir = fixture({ 'a.js': 'needle\n', 'b.py': 'needle\n', 'long.txt': `${'x'.repeat(300)} needle ${'y'.repeat(400)}\n` });
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.concat([Buffer.from('needle'), Buffer.alloc(8)]));
  fs.writeFileSync(path.join(dir, 'u16.txt'), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('needle in utf16\n', 'utf16le')]));
  assert.deepEqual(files(dir, await grep(dir, { pattern: 'needle', type: 'js' })), ['a.js']);
  assert.deepEqual(files(dir, await grep(dir, { pattern: 'needle', type: 'py' })), ['b.py']);
  assert.deepEqual(files(dir, await grep(dir, { pattern: 'needle' })), ['a.js', 'b.py', 'long.txt', 'u16.txt']);
  const long = await grep(dir, { pattern: 'needle', output_mode: 'content', glob: 'long.txt' });
  assert.match(long.content, /omitted end of long line/);
  assert.ok(long.content.length < 700, `expected a clipped line, got ${long.content.length} characters`);
  const bad = await grep(dir, { pattern: 'needle', type: 'nosuchtype' });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /unrecognized file type/);
  assert.equal((await grep(dir, { pattern: '(' })).isError, true);
});

test('Grep scanner yields to the event loop while it searches', async () => {
  const many = {};
  for (let i = 0; i < 300; i++) many[`d${i % 10}/f${i}.txt`] = `line ${i}\nneedle ${i}\n`;
  const dir = fixture(many);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const r = await grep(dir, { pattern: 'needle' });
  clearInterval(timer);
  assert.match(r.content, /Found 300 files/);
  assert.ok(ticks > 0, 'timers must be able to fire during the search');
});

test('globToRegExp', () => {
  const m = (glob, p) => globToRegExp(glob).test(p);
  assert.ok(m('*.js', 'a.js'));
  assert.ok(!m('*.js', 'a/b.js'));
  assert.ok(m('**/*.js', 'a.js'));
  assert.ok(m('**/*.js', 'x/y/a.js'));
  assert.ok(m('src/**', 'src/a/b'));
  assert.ok(!m('src/**', 'srcx/a'));
  assert.ok(m('a/**/b', 'a/b'));
  assert.ok(m('a/**/b', 'a/x/y/b'));
  assert.ok(m('*.{js,ts}', 'a.ts'));
  assert.ok(!m('*.{js,ts}', 'a.md'));
  assert.ok(m('file?.txt', 'file1.txt'));
  assert.ok(!m('file?.txt', 'file/.txt'));
  assert.ok(m('[ab].js', 'a.js'));
  assert.ok(!m('[!ab].js', 'a.js'));
  assert.ok(m('[!ab].js', 'c.js'));
  assert.ok(m('a\\*b', 'a*b'));
  assert.ok(!m('a\\*b', 'axb'));
  assert.ok(m('.hidden/*', '.hidden/x'));
  assert.ok(globToRegExp('*.JS', true).test('a.js'));
  assert.throws(() => globToRegExp('{a,b'), /unclosed/);
});

test('ripgrepPath: "off" disables ripgrep and an unusable path is skipped', () => {
  assert.equal(ripgrepPath({ env: { CLAUDE_PRO_RIPGREP_PATH: 'off' } }), null);
  assert.equal(ripgrepPath({ env: { CLAUDE_PRO_RIPGREP_PATH: 'OFF' } }), null);
  const bogus = ripgrepPath({ env: { CLAUDE_PRO_RIPGREP_PATH: path.join(os.tmpdir(), 'definitely-not-ripgrep.exe') } });
  assert.ok(bogus === null || bogus === 'rg', `the bogus path must not be returned, got ${bogus}`);
});

test('configuredModelSpec follows the gateway setting and a /model override wins over it', () => {
  const cfg = new Config({ CLAUDE_PRO_GATEWAY_MODEL: 'deepseek-pro' }, {}, {}, process.cwd());
  assert.equal(cfg.provider, 'gateway');
  assert.equal(cfg.configuredModelSpec, 'deepseek-pro');
  cfg.modelOverride = 'haiku';
  assert.equal(cfg.modelSpec, 'haiku');
  assert.equal(cfg.configuredModelSpec, 'deepseek-pro');
  const fresh = new Config({}, {}, {}, process.cwd());
  assert.deepEqual([fresh.provider, fresh.configuredModelSpec], ['gateway', 'opus']);
});
