// Tests for large-output persistence, auto memory, the verify loop and background agents.
// CONFIG_DIR is fixed when config.js is first imported, so point it at a temp dir first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAUDE_PRO_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-config-'));

const { Config } = await import('../src/config.js');
const { Agent, persistLargeOutput } = await import('../src/agent.js');
const { makeBashTool } = await import('../src/tools/bash.js');
const { WriteTool } = await import('../src/tools/files.js');
const { makeTaskTool, TaskOutputTool } = await import('../src/tools/task.js');
const { BackgroundTasks, taskNotification } = await import('../src/tasks.js');
const { autoMemorySection } = await import('../src/prompts.js');
const { loadAutoMemoryIndex } = await import('../src/context.js');
const { toolResultsDir } = await import('../src/session.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-feat-'));
const makeConfig = (cwd, env = {}) => new Config({ ANTHROPIC_MODEL: 'mock', ...env }, {}, { mcpServers: {}, hooks: {} }, cwd);
const reply = (content, stopReason = 'end_turn') => ({ message: { role: 'assistant', content }, stopReason });
const toolUse = (id, name, input) => reply([{ type: 'tool_use', id, name, input }], 'tool_use');
const lastUser = (agent) => agent.messages[agent.messages.length - 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('large tool results are saved to a file and only a preview is sent', async () => {
  const dir = tmp();
  const cfg = Object.defineProperty(makeConfig(dir), 'maxToolResultChars', { value: 5000 }); // the limit is 100000
  const big = 'x'.repeat(4000) + '\n' + 'y'.repeat(4000) + '\nEND';
  const BigTool = { name: 'Big', readOnly: true, description: 'd', input_schema: { type: 'object', properties: {} }, async call() { return { content: big }; } };
  const agent = new Agent({ config: cfg, tools: [BigTool], systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: dir });
  let calls = 0;
  agent.callModel = async () => {
    calls++;
    if (calls === 1) return toolUse('toolu_big1', 'Big', {});
    const block = lastUser(agent).content[0];
    assert.match(block.content, /<persisted-output>/);
    assert.ok(block.content.length < 3000, 'only a preview goes to the model');
    const file = /Full output saved to: (.+)/.exec(block.content)[1].trim();
    assert.equal(fs.readFileSync(file, 'utf8'), big, 'the full text is on disk');
    return reply([{ type: 'text', text: 'ok' }]);
  };
  await agent.run('go');
  assert.equal(calls, 2);
  // Small results are untouched.
  assert.equal(persistLargeOutput(dir, 'id', 'short').includes('short'), true);
});

test('Bash keeps the full text of truncated output in a file', async () => {
  const dir = tmp();
  const cfg = makeConfig(dir, { BASH_MAX_OUTPUT_LENGTH: '1000' });
  const bash = makeBashTool(cfg);
  const r = await bash.call({ command: 'for i in $(seq 1 600); do echo "line $i"; done' }, { cwd: dir, projectRoot: dir, setCwd() {}, fileState: new Map() });
  assert.match(r.content, /\[\d+ lines truncated\]/);
  const file = /full output is saved at (.+?);/.exec(r.content)?.[1];
  assert.ok(file, r.content.slice(-300));
  assert.ok(path.resolve(file).startsWith(path.resolve(toolResultsDir(dir))));
  const full = fs.readFileSync(file, 'utf8');
  assert.match(full, /^line 1\n/);
  assert.match(full, /line 600$/);
});

test('auto memory: the index is loaded into the prompt, capped at 200 lines', () => {
  const memDir = tmp();
  assert.equal(loadAutoMemoryIndex(memDir), '');
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [Prefers pnpm](pnpm.md) — use pnpm, not npm\n');
  const section = autoMemorySection({ dir: memDir, index: loadAutoMemoryIndex(memDir) });
  assert.ok(section.includes(memDir));
  assert.match(section, /Prefers pnpm/);
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), Array.from({ length: 250 }, (_, i) => `- line ${i}`).join('\n'));
  const capped = loadAutoMemoryIndex(memDir);
  assert.match(capped, /- line 199\n/);
  assert.doesNotMatch(capped, /- line 200\b/);
  assert.match(capped, /50 more lines not loaded/);
});

test('verify loop: a failing check after edits is sent back until it passes', async () => {
  const dir = tmp();
  const cfg = makeConfig(dir, { CLAUDE_PRO_VERIFY_COMMAND: 'test -f ok.txt || { echo "ok.txt is missing"; exit 1; }' });
  const agent = new Agent({
    config: cfg, tools: [makeBashTool(cfg), WriteTool],
    systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: dir,
  });
  let calls = 0;
  agent.callModel = async () => {
    calls++;
    if (calls === 1) return toolUse('w1', 'Write', { file_path: path.join(dir, 'a.txt'), content: 'a' });
    if (calls === 2) return reply([{ type: 'text', text: 'done' }]);
    if (calls === 3) {
      const t = lastUser(agent).content[0].text;
      assert.match(t, /failed \(attempt 1 of 3\)/);
      assert.match(t, /ok\.txt is missing/);
      return toolUse('w2', 'Write', { file_path: path.join(dir, 'ok.txt'), content: 'ok' });
    }
    return reply([{ type: 'text', text: 'fixed' }]);
  };
  const r = await agent.run('make it pass');
  assert.equal(calls, 4, 'verification passed after the fix, so the turn ended');
  assert.equal(r.text, 'fixed');

  // A turn without edits does not run the verify command at all.
  calls = 0;
  fs.rmSync(path.join(dir, 'ok.txt'));
  agent.callModel = async () => { calls++; return reply([{ type: 'text', text: 'just talking' }]); };
  await agent.run('hi');
  assert.equal(calls, 1);
});

test('verify loop gives up after the configured number of rounds', async () => {
  const dir = tmp();
  const cfg = Object.defineProperty(makeConfig(dir, { CLAUDE_PRO_VERIFY_COMMAND: 'exit 1' }), 'verifyMaxRounds', { value: 2 }); // 3 in use
  const notices = [];
  const agent = new Agent({
    config: cfg, tools: [makeBashTool(cfg), WriteTool],
    systemPrompt: 's', io: { notice: (t) => notices.push(t) }, model: cfg.mainModel, cwd: dir,
  });
  let calls = 0, n = 0;
  agent.callModel = async () => {
    calls++;
    // Every "fix" edits a file and then claims to be done.
    if (calls % 2 === 1) return toolUse(`w${++n}`, 'Write', { file_path: path.join(dir, `f${n}.txt`), content: 'x' });
    return reply([{ type: 'text', text: 'done' }]);
  };
  await agent.run('go');
  assert.equal(calls, 6, '1 initial attempt + 2 fix rounds');
  assert.ok(notices.some((t) => /still failing after 2/.test(t)));
});

test('background tasks: run independently, notify on completion, can be stopped', async () => {
  const tasks = new BackgroundTasks();
  const done = [];
  tasks.onDone((t) => done.push(t.id));
  const a = tasks.start({ description: 'quick', subagentType: 'Explore', run: async () => { await sleep(20); return { text: 'found it' }; } });
  const b = tasks.start({ description: 'slow', subagentType: 'Explore', run: (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  assert.equal(tasks.running().length, 2);
  assert.equal((await tasks.waitAny()).id, a.id);
  assert.match(taskNotification(a), /<status>completed<\/status>[\s\S]*found it/);
  assert.equal(tasks.kill(b.id), true);
  await b.promise;
  assert.equal(b.status, 'killed');
  assert.deepEqual(done, [a.id, b.id]);
  assert.equal(tasks.running().length, 0);
});

test('agent: Task run_in_background returns at once and the report arrives as a notification', async () => {
  const dir = tmp();
  const cfg = makeConfig(dir);
  const tasks = new BackgroundTasks();
  const agents = new Map([['general-purpose', { name: 'general-purpose', description: 'd', tools: '*', prompt: 'p' }]]);
  let release;
  const gate = new Promise((r) => { release = r; });
  const agent = new Agent({
    config: cfg, tools: [makeTaskTool(agents), TaskOutputTool], systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: dir, tasks,
    spawnSubagent: async ({ prompt }) => { await gate; return { text: `report for: ${prompt}`, toolUses: 2, tokens: 100 }; },
  });
  tasks.onDone((t) => agent.notifications.push({ taskId: t.id, text: taskNotification(t) }));

  let calls = 0;
  agent.callModel = async () => {
    calls++;
    if (calls === 1) return toolUse('t1', 'Task', { description: 'scan repo', prompt: 'find TODOs', subagent_type: 'general-purpose', run_in_background: true });
    if (calls === 2) {
      assert.match(lastUser(agent).content[0].content, /Started background agent agent_1/);
      return reply([{ type: 'text', text: 'started it' }]);
    }
    const text = JSON.stringify(lastUser(agent).content);
    assert.match(text, /<task-notification>/);
    assert.match(text, /report for: find TODOs/);
    return reply([{ type: 'text', text: 'summarised the report' }]);
  };
  const first = await agent.run('look for TODOs in the background');
  assert.equal(first.text, 'started it');
  assert.equal(tasks.get('agent_1').status, 'running', 'the turn ended while the agent kept running');

  release();
  await tasks.waitAny();
  assert.equal(agent.notifications.length, 1);
  const second = await agent.run(agent.drainNotifications());
  assert.equal(second.text, 'summarised the report');
  assert.equal(calls, 3);
});

test('TaskOutput waits for the result and consumes the pending notification', async () => {
  const dir = tmp();
  const cfg = makeConfig(dir);
  const tasks = new BackgroundTasks();
  const agent = new Agent({ config: cfg, tools: [], systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: dir, tasks });
  tasks.onDone((t) => agent.notifications.push({ taskId: t.id, text: taskNotification(t) }));
  const t = tasks.start({ description: 'x', subagentType: 'Plan', run: async () => { await sleep(30); return { text: 'the plan' }; } });
  const r = await TaskOutputTool.call({ task_id: t.id }, agent.makeCtx());
  assert.match(r.content, /<status>completed<\/status>[\s\S]*the plan/);
  assert.equal(agent.notifications.length, 0, 'no duplicate notification after TaskOutput delivered the result');
  const missing = await TaskOutputTool.call({ task_id: 'agent_99' }, agent.makeCtx());
  assert.equal(missing.isError, true);
});
