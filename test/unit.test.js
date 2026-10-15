import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDotEnv, Config } from '../src/config.js';
import { applyEdit, ReadTool, EditTool, WriteTool } from '../src/tools/files.js';
import { diffLines, makeHunks, countChanges } from '../src/utils/diff.js';
import { stringWidth, wrapLine, stripAnsi } from '../src/ui/ansi.js';
import { renderMarkdown, renderInline } from '../src/ui/markdown.js';
import { normalizeMessages, Agent, estimateTokens } from '../src/agent.js';
import { Editor } from '../src/ui/editor.js';
import { makeBashTool } from '../src/tools/bash.js';
import { GlobTool, GrepTool } from '../src/tools/search.js';
import { McpManager } from '../src/mcp.js';
import { resolvePath } from '../src/utils/paths.js';
import { costOf, priceOf } from '../src/pricing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-test-'));
const makeConfig = (env = {}, cwd = process.cwd(), settings = {}) => new Config(env, {}, { mcpServers: {}, hooks: {}, ...settings }, cwd);
const ctxFor = (cwd, extra = {}) => {
  let dir = cwd;
  return { get cwd() { return dir; }, setCwd(d) { dir = d; }, projectRoot: cwd, fileState: new Map(), ...extra };
};

test('parseDotEnv handles quotes, comments and export', () => {
  const env = parseDotEnv('# c\nA=1\nexport B="two words"\nC=\'x=y\'\nD=val # trailing\n\nE=');
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'x=y', D: 'val', E: '' });
});

test('model resolution: [1m] suffix, aliases, sub-agent model, compaction window', () => {
  const cfg = makeConfig({
    CLAUDE_PRO_GATEWAY_MODEL: 'deepseek-flash[1m]',
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
  });
  assert.equal(cfg.mainModel.id, 'deepseek-flash');
  assert.equal(cfg.mainModel.contextWindow, 1_000_000);
  assert.equal(cfg.smallModel.id, 'claude-haiku-5-5');
  assert.equal(cfg.subagentModel.id, 'deepseek-flash');
  assert.equal(cfg.subagentModel.contextWindow, 1_000_000);
  assert.equal(cfg.resolveModel('opus').id, 'claude-opus-5-5');
  assert.equal(cfg.resolveModel('opus').contextWindow, 1_000_000);
  assert.equal(cfg.effort, 'max');
  assert.equal(cfg.compactWindow(), 786432);
  assert.ok(cfg.autoCompactThreshold() < 786432 && cfg.autoCompactThreshold() > 700_000);
  cfg.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '50';
  assert.equal(cfg.autoCompactThreshold(), 393216);
  // The window is capped by the model's real context size.
  assert.equal(makeConfig({ CLAUDE_PRO_GATEWAY_MODEL: 'x', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '999999' }).compactWindow(), 200_000);
});

test('applyEdit: uniqueness, replace_all, not found, curly quotes', () => {
  assert.equal(applyEdit('a b a', 'a', 'x', false).error.startsWith('Found 2 matches'), true);
  assert.equal(applyEdit('a b a', 'a', 'x', true).result, 'x b x');
  assert.match(applyEdit('abc', 'zzz', 'y', false).error, /not found/);
  assert.equal(applyEdit('say “hi”', 'say "hi"', 'bye', false).result, 'bye');
  assert.match(applyEdit('x', 'x', 'x', false).error, /No changes/);
});

test('diff hunks', () => {
  const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd', 'e']);
  assert.deepEqual(countChanges(ops), { added: 2, removed: 1 });
  // With 1 line of context the two changes' contexts touch, so they merge into one hunk.
  assert.equal(makeHunks(ops, 1).length, 1);
  const hunks = makeHunks(ops, 0);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].lines.map((l) => l.op + l.line), ['-b', '+B']);
  assert.deepEqual(hunks[1].lines.map((l) => `${l.op}${l.line}:${l.newNo}`), ['+e:5']);
});

test('string width and wrapping handle CJK and ANSI', () => {
  assert.equal(stringWidth('你好ab'), 6);
  assert.equal(stringWidth('\x1b[31mred\x1b[39m'), 3);
  assert.deepEqual(wrapLine('你好世界', 5).map(stripAnsi), ['你好', '世界']);
});

test('markdown: inline styles keep identifiers and tables align CJK', () => {
  assert.equal(stripAnsi(renderInline('call my_var_name and **bold**')), 'call my_var_name and bold');
  const lines = renderMarkdown('| 名称 | v |\n|---|---|\n| 中文字 | 1 |', { width: 40 }).map(stripAnsi);
  const widths = new Set(lines.map(stringWidth));
  assert.equal(widths.size, 1, `all table rows should be the same width: ${JSON.stringify(lines)}`);
});

test('normalizeMessages merges roles and orders tool results first', () => {
  const out = normalizeMessages([
    { role: 'user', content: 'a' },
    { role: 'user', content: [{ type: 'text', text: 'b' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'X', input: {} }] },
    { role: 'user', content: [{ type: 'text', text: 'note' }, { type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0].content.length, 2);
  assert.equal(out[2].content[0].type, 'tool_result');
});

test('editor: cursor, history, paste placeholder', async () => {
  let submitted = null;
  const ed = new Editor({ history: ['old'], onSubmit: (v) => { submitted = v; } });
  for (const ch of 'hello') ed.handleKey(ch, { name: ch });
  ed.handleKey(undefined, { name: 'left' });
  ed.handleKey('X', { name: 'x' });
  assert.equal(ed.text, 'hellXo');
  ed.handleKey(undefined, { name: 'home' });
  ed.handleKey(undefined, { name: 'up' });
  assert.equal(ed.text, 'old');
  ed.handleKey(undefined, { name: 'down' });
  assert.equal(ed.text, 'hellXo');
  ed.clear();
  ed.handleKey(undefined, { name: 'paste-start' });
  ed.handleKey('x'.repeat(900), {});
  ed.handleKey(undefined, { name: 'paste-end' });
  assert.match(ed.text, /^\[Pasted text #1 \+1 lines\]$/);
  ed.handleKey('\r', { name: 'return' });
  await new Promise((r) => setImmediate(r));
  assert.equal(submitted, 'x'.repeat(900));
  // backslash-enter inserts a newline
  for (const ch of 'a\\') ed.handleKey(ch, { name: ch });
  ed.handleKey('\r', { name: 'return' });
  assert.equal(ed.text, 'a\n');
});

test('editor: image placeholders are attached on submit and deleted as a unit', async () => {
  let got = null;
  const img = { media_type: 'image/png', data: 'AAAA' };
  const ed = new Editor({ onSubmit: (v, raw, images) => { got = { v, images }; }, imageFromPath: (p) => (p.endsWith('shot.png') ? img : null) });
  for (const ch of 'look') ed.handleKey(ch, { name: ch });
  assert.equal(ed.insertImage(img), '[Image #1]');
  assert.equal(ed.text, 'look [Image #1] ');
  // A pasted image path (e.g. drag and drop) becomes [Image #2]; other paths stay text.
  ed.insertPaste('"C:\\Users\\me\\shot.png"');
  ed.insertPaste('C:\\notes\\readme.png.txt');
  assert.equal(ed.text, 'look [Image #1] [Image #2] C:\\notes\\readme.png.txt');
  ed.set('look [Image #1] [Image #2] ');
  ed.handleKey(undefined, { name: 'backspace' }); // the trailing space
  ed.handleKey(undefined, { name: 'backspace' }); // the whole [Image #2]
  assert.equal(ed.text, 'look [Image #1] ');
  ed.handleKey('\r', { name: 'return' });
  await new Promise((r) => setImmediate(r));
  assert.equal(got.images.length, 1, 'only images still referenced in the text are sent');
  assert.equal(ed.images.size, 0);
});

test('token estimate counts images as ~1600 tokens, not their base64 size', () => {
  const big = { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(400_000) } }] };
  const est = estimateTokens(big);
  assert.ok(est > 1600 && est < 1700, `got ${est}`);
});

test('Read/Edit/Write tools enforce read-before-write and preserve CRLF', async () => {
  const dir = tmp();
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, 'one\r\ntwo\r\nthree\r\n');
  const ctx = ctxFor(dir);
  let r = await EditTool.call({ file_path: file, old_string: 'two', new_string: 'TWO' }, ctx);
  assert.ok(r.isError && /not been read/.test(r.content));
  r = await ReadTool.call({ file_path: file }, ctx);
  assert.match(r.content, /^ {5}1\tone\n {5}2\ttwo/);
  r = await EditTool.call({ file_path: file, old_string: 'two\nthree', new_string: 'TWO\nTHREE' }, ctx);
  assert.ok(!r.isError, r.content);
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\r\nTWO\r\nTHREE\r\n');
  // External modification invalidates the read.
  await new Promise((res) => setTimeout(res, 20));
  fs.writeFileSync(file, 'changed');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  r = await WriteTool.call({ file_path: file, content: 'x' }, ctx);
  assert.ok(r.isError && /modified since/.test(r.content));
  // New files need no read.
  r = await WriteTool.call({ file_path: path.join(dir, 'sub', 'new.txt'), content: 'hi\n' }, ctx);
  assert.ok(!r.isError);
  assert.equal(fs.readFileSync(path.join(dir, 'sub', 'new.txt'), 'utf8'), 'hi\n');
});

test('Bash tool: output, exit codes, cwd persistence, timeout', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'inner'));
  const bash = makeBashTool(makeConfig({}, dir));
  const ctx = ctxFor(dir);
  let r = await bash.call({ command: 'echo hello' }, ctx);
  assert.equal(r.content, 'hello');
  r = await bash.call({ command: 'echo oops >&2; exit 3' }, ctx);
  assert.ok(r.isError);
  assert.match(r.content, /oops[\s\S]*Exit code 3/);
  await bash.call({ command: 'cd inner' }, ctx);
  // The shell reports the real path: /private/var for /var on macOS, the long name for RUNNER~1 on Windows.
  assert.equal(fs.realpathSync.native(ctx.cwd), fs.realpathSync.native(path.join(dir, 'inner')));
  r = await bash.call({ command: 'sleep 5', timeout: 1000 }, ctx);
  assert.ok(r.isError && /timed out/.test(r.content));
});

test('Glob and Grep tools', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const needle = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'nothing here\n');
  fs.writeFileSync(path.join(dir, 'node_modules', 'c.js'), 'needle\n');
  const ctx = ctxFor(dir);
  let r = await GlobTool.call({ pattern: '**/*.js' }, ctx);
  assert.equal(r.content.trim(), path.join(dir, 'src', 'a.js'));
  r = await GrepTool.call({ pattern: 'needle', glob: '*.js', path: path.join(dir, 'src') }, ctx);
  assert.match(r.content, /Found 1 file/);
  r = await GrepTool.call({ pattern: 'NEEDLE', '-i': true, output_mode: 'content', path: path.join(dir, 'src') }, ctx);
  assert.match(r.content, /1:const needle/);
});

test('resolvePath understands Git Bash style paths on Windows', () => {
  if (process.platform !== 'win32') return;
  assert.equal(resolvePath('/c/Users/x', 'D:\\'), 'C:\\Users\\x');
});

test('MCP stdio client lists and calls tools', async () => {
  const mgr = new McpManager({ echo: { command: 'node', args: [path.join(here, 'fixtures', 'mcp-echo-server.js')] } }, { cwd: here });
  await mgr.start();
  const tools = mgr.tools();
  assert.deepEqual(tools.map((t) => t.name), ['mcp__echo__echo', 'mcp__echo__add', 'mcp__echo__hang']);
  const r = await tools[1].call({ a: 2, b: 40 }, {});
  assert.equal(r.content, '42');
  mgr.close();
});

test('agent loop runs tools and feeds results back (mock model)', async () => {
  const dir = tmp();
  const cfg = makeConfig({ CLAUDE_PRO_GATEWAY_MODEL: 'mock' }, dir);
  const agent = new Agent({ config: cfg, tools: [GlobTool], systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: dir });
  let calls = 0;
  agent.callModel = async () => {
    calls++;
    const last = agent.messages[agent.messages.length - 1];
    if (calls === 1) return { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Glob', input: { pattern: '*.none' } }] }, stopReason: 'tool_use' };
    assert.equal(last.content[0].type, 'tool_result');
    assert.equal(last.content[0].content, 'No files found');
    return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, stopReason: 'end_turn' };
  };
  const r = await agent.run('go');
  assert.equal(r.text, 'done');
  assert.equal(agent.messages.length, 4);
});

test('Effort tool: raises the effort for the current request, the next user message goes back', async () => {
  const { makeEffortTool } = await import('../src/tools/effort.js');
  const { toolsForSubagent, buildTools } = await import('../src/tools/index.js');
  const cfg = makeConfig({ CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_MODEL: 'opus' });
  const tool = makeEffortTool(cfg);
  assert.equal(cfg.effort, null);
  const res = await tool.call({ level: 'max', reason: 'hard bug' });
  assert.match(res.content, /from medium to max.*back to medium/);
  assert.equal(cfg.effort, 'max');
  const notices = [];
  const self = { config: cfg, io: { notice: (t) => notices.push(t) } };
  cfg.effortBoostKeepNext = true; // a restart continues the request
  Agent.prototype.endEffortBoost.call(self);
  assert.equal(cfg.effort, 'max');
  Agent.prototype.endEffortBoost.call(self);
  assert.equal(cfg.effort, null);
  assert.match(notices[0], /back to the model default/);
  cfg.effortOverride = 'high';
  assert.match((await tool.call({ level: 'high', reason: 'x' })).content, /already high/);
  assert.ok(!toolsForSubagent(buildTools(cfg, { agents: new Map() }), { tools: null }, {}).some((t) => t.name === 'Effort'));
});

test('costOf prices a request as the gateway bills it', () => {
  // a compaction on the gateway: $0.171991 (4 in, 7,169 out, 125,477 cache read, 700 written for 5 minutes)
  const compaction = { input_tokens: 4, output_tokens: 7169, cache_read_input_tokens: 125477, cache_creation_input_tokens: 700 };
  assert.equal(costOf('claude-opus-5-5', compaction).toFixed(6), '0.171991');
  // 1-hour writes at their own price: 434 of them at $8/M
  const turn = { input_tokens: 2, output_tokens: 221, cache_read_input_tokens: 124109, cache_creation_input_tokens: 434, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 434 } };
  assert.equal(costOf('claude-opus-5-5', turn).toFixed(6), '0.032722');
  // long context: Haiku 5.5 above 100K prompt tokens
  assert.equal(costOf('claude-haiku-5-5', { input_tokens: 1000 }), 0.0001);
  assert.equal(costOf('claude-haiku-5-5', { input_tokens: 200_000 }), 0.1);
  // names as they come: dated, [1m], a provider prefix, a dot in a GPT version; an older Claude model is its family's
  assert.equal(priceOf('anthropic/claude-sonnet-5-5-20261001[1m]').id, 'claude-sonnet-5-5');
  assert.equal(priceOf('gpt-6.1-sol').id, 'gpt-6-1-sol');
  assert.equal(priceOf('claude-opus-4-6').id, 'claude-opus-5-5');
  assert.equal(costOf('mock', { input_tokens: 1000 }), null);
  assert.equal(costOf('deepseek-chat', { input_tokens: 1000 }), null);
});
