import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Config } from '../src/config.js';
import { ModeManager } from '../src/modes.js';
import { Agent } from '../src/agent.js';
import { HookRunner } from '../src/hooks.js';
import { ReadTool } from '../src/tools/files.js';
import { NotebookEditTool } from '../src/tools/notebook.js';
import { makeBashTool } from '../src/tools/bash.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-pro-'));
const makeConfig = (cwd, hooks = {}) => new Config({ ANTHROPIC_MODEL: 'mock' }, {}, { mcpServers: {}, hooks }, cwd);
const hookEntry = (matcher, command) => [{ matcher, hooks: [{ type: 'command', command }] }];

test('hooks: exit 2 blocks, exit 0 keeps stdout, other codes warn', async () => {
  const dir = tmp();
  const runner = new HookRunner(makeConfig(dir, {
    PreToolUse: [
      ...hookEntry('Bash', 'echo "no rm please" >&2; exit 2'),
      ...hookEntry('Read', 'echo seen; exit 0'),
      ...hookEntry('Glob', 'exit 1'),
    ],
  }));
  const blocked = await runner.run('PreToolUse', { tool_name: 'Bash', tool_input: {} }, { cwd: dir });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.message, /no rm please/);
  const ok = await runner.run('PreToolUse', { tool_name: 'Read', tool_input: {} }, { cwd: dir });
  assert.equal(ok.blocked, false);
  assert.deepEqual(ok.context, ['seen']);
  const warn = await runner.run('PreToolUse', { tool_name: 'Glob', tool_input: {} }, { cwd: dir });
  assert.equal(warn.blocked, false);
  assert.equal(warn.warnings.length, 1);
  const none = await runner.run('PreToolUse', { tool_name: 'Write', tool_input: {} }, { cwd: dir });
  assert.deepEqual(none, { blocked: false, message: '', context: [], warnings: [] });
});

test('hooks: payload is passed in CLAUDE_PRO_HOOK_INPUT', async () => {
  const dir = tmp();
  const runner = new HookRunner(makeConfig(dir, {
    PostToolUse: hookEntry('.*', 'node -e "const p=JSON.parse(process.env.CLAUDE_PRO_HOOK_INPUT);console.log(p.hook_event_name+\':\'+p.tool_name)"'),
  }));
  const r = await runner.run('PostToolUse', { tool_name: 'Edit', tool_input: {} }, { cwd: dir });
  assert.deepEqual(r.context, ['PostToolUse:Edit']);
});

test('agent: a PreToolUse hook blocks the tool and the model sees why', async () => {
  const dir = tmp();
  const cfg = makeConfig(dir, { PreToolUse: hookEntry('Bash', 'echo "blocked by policy" >&2; exit 2') });
  const agent = new Agent({
    config: cfg, modes: new ModeManager(), tools: [makeBashTool(cfg)],
    systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: dir, hooks: new HookRunner(cfg),
  });
  let calls = 0;
  agent.callModel = async () => {
    calls++;
    if (calls === 1) return { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo ran > ran.txt' } }] }, stopReason: 'tool_use' };
    const result = agent.messages[agent.messages.length - 1].content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /blocked by policy/);
    return { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, stopReason: 'end_turn' };
  };
  await agent.run('go');
  assert.equal(fs.existsSync(path.join(dir, 'ran.txt')), false);
});

test('agent: a Stop hook can ask the model to keep working', async () => {
  const dir = tmp();
  const marker = path.join(dir, 'stopped-once');
  const cfg = makeConfig(dir, {
    Stop: hookEntry('', `if [ -f "${marker.replace(/\\/g, '/')}" ]; then exit 0; fi; touch "${marker.replace(/\\/g, '/')}"; echo "run the tests first" >&2; exit 2`),
  });
  const agent = new Agent({
    config: cfg, modes: new ModeManager(), tools: [], systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: dir, hooks: new HookRunner(cfg),
  });
  let calls = 0;
  agent.callModel = async () => {
    calls++;
    return { message: { role: 'assistant', content: [{ type: 'text', text: calls === 1 ? 'done?' : 'really done' }] }, stopReason: 'end_turn' };
  };
  const r = await agent.run('go');
  assert.equal(calls, 2);
  assert.equal(r.text, 'really done');
  assert.match(JSON.stringify(agent.messages), /run the tests first/);
});

test('NotebookEdit: replace, insert, delete, and read-first rule', async () => {
  const dir = tmp();
  const file = path.join(dir, 'a.ipynb');
  const nb = {
    nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: [
      { cell_type: 'code', id: 'c1', metadata: {}, source: ['print(1)\n'], execution_count: 3, outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }] },
      { cell_type: 'markdown', id: 'c2', metadata: {}, source: ['# hi'] },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(nb));
  const fileState = new Map();
  const ctx = { cwd: dir, projectRoot: dir, fileState };

  const early = await NotebookEditTool.call({ notebook_path: file, cell_id: 'c1', new_source: 'x' }, ctx);
  assert.equal(early.isError, true, 'must read the notebook first');

  await ReadTool.call({ file_path: file }, ctx);
  const r1 = await NotebookEditTool.call({ notebook_path: file, cell_id: 'c1', new_source: 'a = 1\nprint(a)' }, ctx);
  assert.ok(!r1.isError, r1.content);
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.cells[0].source, ['a = 1\n', 'print(a)']);
  assert.deepEqual(saved.cells[0].outputs, [], 'stale outputs are cleared');

  const r2 = await NotebookEditTool.call({ notebook_path: file, cell_id: 'c1', new_source: '## new', cell_type: 'markdown', edit_mode: 'insert' }, ctx);
  assert.ok(!r2.isError, r2.content);
  saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.cells.length, 3);
  assert.equal(saved.cells[1].cell_type, 'markdown');

  const r3 = await NotebookEditTool.call({ notebook_path: file, cell_id: 'c2', new_source: '', edit_mode: 'delete' }, ctx);
  assert.ok(!r3.isError, r3.content);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cells.length, 2);

  const missing = await NotebookEditTool.call({ notebook_path: file, cell_id: 'nope', new_source: 'x' }, ctx);
  assert.equal(missing.isError, true);
});
