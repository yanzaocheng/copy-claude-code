// Tests for the loosened limits: generous defaults, max_tokens auto-clamp, Bash stdin,
// bigger reads, WebFetch raw mode, nested sub-agents.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { Config } from '../src/config.js';
import { parseMaxTokensLimit, buildParams } from '../src/api.js';
import { makeBashTool } from '../src/tools/bash.js';
import { ReadTool } from '../src/tools/files.js';
import { makeWebFetchTool } from '../src/tools/web.js';
import { buildTools, toolsForSubagent } from '../src/tools/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-limits-'));
const makeConfig = (env = {}) => new Config({ CLAUDE_PRO_GATEWAY_MODEL: 'mock', ...env }, {}, { mcpServers: {}, hooks: {} }, process.cwd());

test('defaults are generous', () => {
  const cfg = makeConfig();
  assert.equal(cfg.maxOutputTokens, 48_000);
  assert.equal(cfg.bashDefaultTimeout, 600_000);
  assert.equal(cfg.bashMaxTimeout, 3_600_000);
  assert.equal(cfg.bashMaxOutput, 60_000);
  assert.equal(cfg.maxToolResultChars, 100_000);
  assert.equal(cfg.maxSubagentDepth, 2);
  assert.equal(makeConfig({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' }).maxOutputTokens, 8192, 'still configurable');
  // A big max_tokens must not eat the context window: the compaction reserve is capped at 64k.
  assert.equal(cfg.autoCompactThreshold(cfg.resolveModel('x[1m]')), 1_000_000 - 48_000);
  const params = buildParams(cfg, { model: cfg.mainModel, system: 's', messages: [] });
  assert.equal(params.max_tokens, 48_000);
});

test('parseMaxTokensLimit understands the usual "max_tokens too large" errors', () => {
  assert.equal(parseMaxTokensLimit('max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-4-5'), 64000);
  assert.equal(parseMaxTokensLimit('Invalid max_tokens value, the valid range of max_tokens is [1, 8192]'), 8192);
  assert.equal(parseMaxTokensLimit('max_tokens must be less than or equal to 16384'), 16384);
  assert.equal(parseMaxTokensLimit('prompt is too long: 250000 tokens > 200000 maximum'), null, 'an overlong prompt is not a max_tokens problem');
  assert.equal(parseMaxTokensLimit('Overloaded'), null);
  assert.equal(parseMaxTokensLimit(undefined), null);
});

test('Bash can feed text to stdin; without it stdin is closed', async () => {
  const dir = tmp();
  const bash = makeBashTool(makeConfig());
  const ctx = { cwd: dir, projectRoot: dir, setCwd() {}, fileState: new Map() };
  let r = await bash.call({ command: 'cat', stdin: 'hello from stdin\nline two' }, ctx);
  assert.equal(r.content, 'hello from stdin\nline two');
  r = await bash.call({ command: 'cat; echo done' }, ctx); // stdin is closed, so cat returns at once
  assert.equal(r.content, 'done');
  r = await bash.call({ command: 'read -r a; read -r b; echo "$b-$a"', stdin: 'x\ny\n' }, ctx);
  assert.equal(r.content, 'y-x');
});

test('Read returns up to 10000 lines and 20000-character lines in one go', async () => {
  const dir = tmp();
  const ctx = { cwd: dir, projectRoot: dir, fileState: new Map() };
  const big = path.join(dir, 'big.txt');
  fs.writeFileSync(big, `${Array.from({ length: 6000 }, (_, i) => `line ${i + 1}`).join('\n')}\n`);
  const r = await ReadTool.call({ file_path: big }, ctx);
  assert.ok(!r.isError, r.content);
  assert.match(r.content, /\n\s*6000\tline 6000$/);
  assert.doesNotMatch(r.content, /showing lines/);
  const wide = path.join(dir, 'wide.txt');
  fs.writeFileSync(wide, `${'x'.repeat(15_000)}\n`);
  const w = await ReadTool.call({ file_path: wide }, ctx);
  assert.ok(w.content.length > 15_000 && !/line truncated/.test(w.content));
});

test('WebFetch: raw mode returns the converted page; plain http is used as given', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><head><title>T</title></head><body><h1>Hello</h1><p>Some <b>bold</b> text and <code>code()</code>.</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const tool = makeWebFetchTool(makeConfig());
    const r = await tool.call({ url: `http://127.0.0.1:${server.address().port}/page`, raw: true }, {});
    assert.ok(!r.isError, r.content);
    assert.match(r.content, /# T/);
    assert.match(r.content, /# Hello/);
    assert.match(r.content, /\*\*bold\*\*/);
    assert.match(r.content, /`code\(\)`/);
    assert.equal(tool.input_schema.required.includes('prompt'), false, 'the prompt is optional');
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test('sub-agents get the Task tool only while below the nesting limit', () => {
  const cfg = makeConfig();
  const agents = new Map([['general-purpose', { name: 'general-purpose', description: 'd', tools: '*', prompt: 'p' }]]);
  const all = buildTools(cfg, { agents });
  const names = (tools) => tools.map((t) => t.name);
  const def = agents.get('general-purpose');
  assert.ok(!names(toolsForSubagent(all, def)).includes('Task'), 'at the limit there is no Task tool');
  assert.ok(names(toolsForSubagent(all, def, { allowTask: true })).includes('Task'));
  for (const n of ['TaskOutput', 'TaskStop', 'TodoWrite', 'AskUserQuestion']) {
    assert.ok(!names(toolsForSubagent(all, def, { allowTask: true })).includes(n), `${n} stays main-agent only`);
  }
  const explore = { name: 'Explore', description: 'd', tools: ['Glob', 'Grep', 'Read'], prompt: 'p' };
  assert.deepEqual(names(toolsForSubagent(all, explore, { allowTask: true })).sort(), ['Glob', 'Grep', 'Read'], 'agent types with a tool list keep it');
});
