// Tests for checkpoints and /rewind, full access through the agent, skills, hooks over stdin.
// CONFIG_DIR is fixed when config.js is first imported, so point it at a temp dir first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAUDE_PRO_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-config-'));

const { Config, CONFIG_DIR, loadConfig } = await import('../src/config.js');
const { Agent } = await import('../src/agent.js');
const { CheckpointStore, rewind, promptAt } = await import('../src/checkpoints.js');
const { ReadTool, WriteTool } = await import('../src/tools/files.js');
const { loadSkills, renderSkill } = await import('../src/agents.js');
const { makeSkillTool } = await import('../src/tools/skill.js');
const { HookRunner } = await import('../src/hooks.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-cp-'));
const makeConfig = (cwd, hooks = {}) => new Config({ CLAUDE_PRO_GATEWAY_MODEL: 'mock' }, {}, { mcpServers: {}, hooks }, cwd);
const reply = (content, stopReason = 'end_turn') => ({ message: { role: 'assistant', content }, stopReason });
const toolUse = (id, name, input) => reply([{ type: 'tool_use', id, name, input }], 'tool_use');
const read = (f) => fs.readFileSync(f, 'utf8');

// A stand-in for the parts of Agent that rewind() touches.
function fakeAgent(messages) {
  return {
    messages, todos: [{ content: 'x' }], fileState: new Map([['/some/file', { mtimeMs: 1 }]]), lastContextTokens: 99, tokensSinceUsage: 9,
    replaceMessages(m) { this.messages = m; },
    pushMessage(m) { this.messages.push(m); },
  };
}

test('checkpoints: files are restored to before the chosen prompt, the oldest snapshot wins', () => {
  const dir = tmp();
  const store = new CheckpointStore(path.join(dir, 'snaps'));
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  fs.writeFileSync(a, 'a0');

  store.beginTurn({ label: 'first prompt', messageIndex: 0 });
  store.track(a); fs.writeFileSync(a, 'a1');
  store.track(b); fs.writeFileSync(b, 'b1'); // b did not exist before
  store.beginTurn({ label: 'second prompt', messageIndex: 2 });
  store.track(a); fs.writeFileSync(a, 'a2');
  store.track(a); // a second track in the same prompt keeps the first snapshot
  assert.equal(store.get(2).files.length, 1);
  assert.deepEqual(store.filesSince(2), [a]);
  assert.deepEqual(store.filesSince(1).sort(), [a, b].sort());
  assert.deepEqual(store.list().map((e) => e.label), ['second prompt', 'first prompt']);

  let r = store.restoreCode(2);
  assert.deepEqual(r.restored, [a]);
  assert.equal(read(a), 'a1');
  assert.equal(read(b), 'b1');

  r = store.restoreCode(1);
  assert.equal(read(a), 'a0');
  assert.equal(fs.existsSync(b), false, 'a file created after the checkpoint is deleted');
  assert.deepEqual(r.removed, [b]);
});

test('checkpoints: a file created then edited in later prompts goes back step by step, then disappears', () => {
  const dir = tmp();
  const store = new CheckpointStore(path.join(dir, 'snaps'));
  const f = path.join(dir, 'new.txt');
  store.beginTurn({ label: 'create', messageIndex: 0 });
  store.track(f); fs.writeFileSync(f, 'v1');
  store.beginTurn({ label: 'edit', messageIndex: 2 });
  store.track(f); fs.writeFileSync(f, 'v2');
  store.restoreCode(2);
  assert.equal(read(f), 'v1');
  store.restoreCode(1);
  assert.equal(fs.existsSync(f), false);
  // The index on disk can be used for manual recovery.
  assert.ok(fs.existsSync(path.join(dir, 'snaps', 'index.json')));
});

test('rewind: both / code only / conversation only', () => {
  const dir = tmp();
  const f = path.join(dir, 'f.txt');
  fs.writeFileSync(f, 'old');
  const msgs = () => [
    { role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    { role: 'user', content: 'edit f' }, { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];
  const setup = () => {
    fs.writeFileSync(f, 'old');
    const store = new CheckpointStore(path.join(tmp(), 'snaps'));
    store.beginTurn({ label: 'hello', messageIndex: 0 });
    store.beginTurn({ label: 'edit f', messageIndex: 2 });
    store.track(f); fs.writeFileSync(f, 'new');
    return store;
  };

  // both: files back, conversation cut before the prompt, that checkpoint and later ones forgotten
  let store = setup(); let agent = fakeAgent(msgs());
  let out = rewind(agent, store, 2, 'both');
  assert.equal(read(f), 'old');
  assert.equal(agent.messages.length, 2);
  assert.deepEqual(agent.todos, []);
  assert.equal(agent.fileState.size, 0, 'the agent must read files again before editing');
  assert.equal(out.prompt, 'edit f');
  assert.equal(out.conversation, true);
  assert.deepEqual(store.list().map((e) => e.label), ['hello']);

  // code only: files back, conversation kept, the model is told, checkpoints kept for a later conversation rewind
  store = setup(); agent = fakeAgent(msgs());
  out = rewind(agent, store, 2, 'code');
  assert.equal(read(f), 'old');
  assert.equal(agent.messages.length, 5);
  assert.match(JSON.stringify(agent.messages[4]), /rewound the code/);
  assert.equal(store.list().length, 2);
  assert.equal(store.filesSince(2).length, 0);

  // conversation only: files stay, those turns stop being listed
  store = setup(); agent = fakeAgent(msgs());
  out = rewind(agent, store, 2, 'conversation');
  assert.equal(read(f), 'new');
  assert.equal(agent.messages.length, 2);
  assert.deepEqual(store.list().map((e) => e.label), ['hello']);
  // ...but rewinding further back still undoes that orphaned edit
  rewind(agent, store, 1, 'code');
  assert.equal(read(f), 'old');
});

test('rewind: after compaction only the code can be restored', () => {
  const dir = tmp();
  const f = path.join(dir, 'f.txt');
  fs.writeFileSync(f, 'old');
  const store = new CheckpointStore(path.join(dir, 'snaps'));
  store.beginTurn({ label: 'edit', messageIndex: 0 });
  store.track(f); fs.writeFileSync(f, 'new');
  store.markConversationStale();
  const agent = fakeAgent([{ role: 'user', content: 'summary' }]);
  assert.throws(() => rewind(agent, store, 1, 'both'), /compacted/);
  assert.equal(read(f), 'new', 'nothing happens when the rewind is refused');
  rewind(agent, store, 1, 'code');
  assert.equal(read(f), 'old');
});

test('agent: Write/Edit calls are checkpointed per prompt and /rewind undoes them', async () => {
  const dir = tmp();
  const f = path.join(dir, 'file.txt');
  fs.writeFileSync(f, 'old');
  const cfg = makeConfig(dir);
  const store = new CheckpointStore(path.join(dir, '.snaps'));
  const agent = new Agent({ config: cfg, checkpoints: store, tools: [ReadTool, WriteTool], systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: dir });
  let calls = 0;
  agent.callModel = async () => {
    calls++;
    if (calls === 1) return toolUse('r1', 'Read', { file_path: f });
    if (calls === 2) return toolUse('w1', 'Write', { file_path: f, content: 'new' });
    if (calls === 3) return toolUse('w2', 'Write', { file_path: path.join(dir, 'created.txt'), content: 'x' });
    return reply([{ type: 'text', text: 'done' }]);
  };
  await agent.run('change the file and add another');
  assert.equal(read(f), 'new');
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].label, 'change the file and add another');
  assert.equal(store.filesSince(1).length, 2);

  rewind(agent, store, 1, 'both');
  assert.equal(read(f), 'old');
  assert.equal(fs.existsSync(path.join(dir, 'created.txt')), false);
  assert.equal(agent.messages.length, 0);
});

test('rewind menu: summarize up to here or from here keeps the rest word for word, and the checkpoints follow', async () => {
  const dir = tmp();
  const cfg = makeConfig(dir);
  const store = new CheckpointStore(path.join(dir, '.snaps'));
  const agent = new Agent({ config: cfg, checkpoints: store, tools: [], systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: dir });
  const long = `third prompt ${'x'.repeat(300)}`;
  let n = 0;
  agent.callModel = async () => reply([{ type: 'text', text: `answer ${++n}` }]);
  for (const p of ['first prompt', 'second prompt', long]) await agent.run(p);
  assert.equal(agent.messages.length, 6);
  const [, second, third] = store.list().slice().reverse();
  assert.equal(promptAt(agent, third), long, 'the whole prompt, not the 200-character label');

  const asked = [];
  agent.requestSummary = async (messages) => {
    asked.push(messages.at(-1).content.at(-1).text);
    return reply([{ type: 'text', text: '<summary>the first exchange</summary>' }]);
  };
  await agent.summarizePart(second.messageIndex, { part: 'before', label: second.label });
  assert.match(asked[0], /BEFORE the user's message that begins "second prompt"/);
  assert.equal(agent.messages.length, 5);
  assert.match(agent.messages[0].content[0].text, /^\[Summarized conversation\] The earlier part[\s\S]*the first exchange$/);
  assert.equal(agent.messages[1].content[0].text, 'second prompt', 'the rest word for word');
  store.summarized(second.id, 'before', second.messageIndex);
  assert.equal(store.get(1).conversationValid, false, 'the summarized turn can no longer be rewound to');
  assert.equal(third.messageIndex, 3, 'the later turns moved up');
  assert.equal(promptAt(agent, third), long);

  agent.requestSummary = async () => reply([{ type: 'text', text: '<summary>the third exchange</summary>' }]);
  await agent.summarizePart(third.messageIndex, { part: 'after', label: third.label });
  assert.equal(agent.messages.length, 4);
  assert.equal(agent.messages[1].content[0].text, 'second prompt');
  assert.match(agent.messages[3].content[0].text, /The later part[\s\S]*the third exchange$/);
  store.summarized(third.id, 'after', third.messageIndex);
  assert.equal(store.get(third.id).conversationValid, false);
  assert.equal(store.get(second.id).conversationValid, true);
  rewind(agent, store, second.id, 'conversation');
  assert.equal(agent.messages.length, 1, 'only the summary of the first exchange is left');
});

test('full access: an edit through the agent runs at once, nothing is asked and nothing is added to the prompt', async () => {
  const dir = tmp();
  const cfg = makeConfig(dir);
  const agent = new Agent({ config: cfg, tools: [WriteTool], systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: dir });
  const target = path.join(dir, 'out.txt');
  let calls = 0;
  agent.callModel = async () => {
    calls++;
    if (calls === 1) return toolUse('w1', 'Write', { file_path: target, content: 'x' });
    const block = agent.messages[agent.messages.length - 1].content[0];
    assert.equal(block.is_error, undefined, block.content);
    return reply([{ type: 'text', text: 'ok' }]);
  };
  await agent.run('write it');
  assert.equal(fs.readFileSync(target, 'utf8'), 'x');
  assert.deepEqual(agent.messages[0].content, [{ type: 'text', text: 'write it' }], 'the prompt as it was typed');
});

test('skills: loaded from skills/<name>/SKILL.md, project overrides user, usable through the Skill tool', async () => {
  const cwd = tmp();
  const userDir = path.join(CONFIG_DIR, 'skills', 'release');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'SKILL.md'), '---\nname: release\ndescription: User-level release\n---\nuser version\n');
  const projDir = path.join(cwd, '.claude', 'skills', 'release');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'SKILL.md'), '---\nname: release\ndescription: Cut a release\n---\nRun the checks for $ARGUMENTS, then tag it.\n');
  const plain = path.join(cwd, '.claude', 'skills', 'notes');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'SKILL.md'), '# Notes\n\nKeep a changelog entry for every change.\n');
  fs.mkdirSync(path.join(cwd, '.claude', 'skills', 'empty'), { recursive: true }); // no SKILL.md: ignored

  const skills = loadSkills(cwd);
  assert.deepEqual([...skills.keys()].sort(), ['notes', 'release']);
  assert.equal(skills.get('release').description, 'Cut a release', 'project skill wins over user skill');
  assert.equal(skills.get('release').scope, 'project');
  assert.equal(skills.get('notes').description, 'Keep a changelog entry for every change.', 'description falls back to the first text line');

  const tool = makeSkillTool(skills);
  assert.match(tool.description(), /- release: Cut a release/);
  const r = await tool.call({ skill: 'release', args: 'v2.0' });
  assert.match(r.content, /Base directory for this skill: .*release/);
  assert.match(r.content, /Run the checks for v2\.0, then tag it\./);
  assert.match(renderSkill(skills.get('notes'), 'fast'), /ARGUMENTS: fast/, 'arguments are appended when there is no placeholder');
  const bad = await tool.call({ skill: 'nope' });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /Available skills: .*release/);
});

test('settings files may still carry "permissions": they are ignored', () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, '.claude-pro'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude-pro', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'], deny: ['Read(./.env)'], defaultMode: 'default' }, hooks: { Stop: [] } }));
  const cfg = loadConfig({ cwd });
  assert.equal(cfg.settings.permissions, undefined);
  assert.equal(cfg.settings.defaultMode, undefined);
});

test('hooks: the event JSON is written to stdin as well as $CLAUDE_PRO_HOOK_INPUT', async () => {
  const dir = tmp();
  const script = `let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>{const p=JSON.parse(s);console.log(p.hook_event_name+':'+p.tool_name+':'+p.tool_input.command)})`;
  const runner = new HookRunner(makeConfig(dir, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node -e "${script}"` }] }] }));
  const r = await runner.run('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }, { cwd: dir });
  assert.equal(r.blocked, false);
  assert.deepEqual(r.context, ['PreToolUse:Bash:ls']);
});

test('the todo list: kept while the next turn goes on with it, put away once a whole turn left it as it was', async () => {
  const { TodoWriteTool } = await import('../src/tools/interaction.js');
  const dir = tmp();
  const cfg = makeConfig(dir);
  const agent = new Agent({ config: cfg, tools: [TodoWriteTool], systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: dir });
  const list = [{ content: 'Build it', status: 'completed', activeForm: 'Building it' }, { content: 'Wait for the user', status: 'in_progress', activeForm: 'Waiting' }];
  let writes = true;
  let calls = 0;
  agent.callModel = async () => {
    calls++;
    if (writes && calls % 2 === 1) return toolUse(`t${calls}`, 'TodoWrite', { todos: list });
    return reply([{ type: 'text', text: 'ok' }]);
  };
  await agent.run('do the task'); // writes the list
  assert.equal(agent.todos.length, 2);
  writes = false;
  calls = 0;
  await agent.run('a follow-up'); // the turn right after: the list stays
  assert.equal(agent.todos.length, 2);
  await agent.run('<task-notification>a background agent finished</task-notification>'); // not the user's: not a turn of theirs
  assert.equal(agent.todos.length, 2);
  await agent.run('something else entirely'); // the whole turn before left it alone: put away
  assert.deepEqual(agent.todos, []);
});
