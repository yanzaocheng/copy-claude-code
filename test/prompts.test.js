import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Prompt profiles are user-global, so never let this test import them with the real config directory.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-prompts-config-'));
process.env.CLAUDE_PRO_CONFIG_DIR = configDir;
process.env.CLAUDE_PRO_DISABLE_AUTO_MEMORY = '1';

const {
  PROMPTS_DIR,
  activePromptName,
  listPromptProfiles,
  loadActivePrompt,
  promptNameForText,
  savePrompt,
  setActivePrompt,
} = await import('../src/prompt-profiles.js');
const { buildCommands } = await import('../src/commands.js');
const { createRuntime } = await import('../src/runtime.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-prompts-'));

test('prompt profiles copy files, save literal text, and persist the active selection', () => {
  const cwd = tmp();
  const source = path.join(cwd, 'my-prompt.md');
  fs.writeFileSync(source, 'Use concise answers.\n');
  savePrompt('my-prompt.md', fs.readFileSync(source, 'utf8'));
  fs.writeFileSync(source, 'The source changed.\n');

  assert.equal(activePromptName(), 'my-prompt.md');
  assert.equal(loadActivePrompt().text, 'Use concise answers.\n');
  assert.deepEqual(listPromptProfiles().map((p) => p.name), ['my-prompt.md']);
  assert.equal(fs.readFileSync(path.join(PROMPTS_DIR, 'my-prompt.md'), 'utf8'), 'Use concise answers.\n');

  const name = promptNameForText('Always be brief');
  savePrompt(name, 'Always be brief');
  assert.equal(activePromptName(), name);
  assert.equal(loadActivePrompt().text, 'Always be brief');
});

test('the prompt and typo-compatible slash commands set and clear the persistent profile', async () => {
  const cwd = tmp();
  const source = path.join(cwd, 'from-file.txt');
  fs.writeFileSync(source, 'FILE PROMPT');
  const output = [];
  const app = {
    cwd,
    flags: {},
    screen: { log: (...lines) => output.push(lines) },
    runtime: { skills: new Map(), tools: [], invalidateSystemPrompt() {} },
    agent: { messages: [], cache: { isWarm: () => false } },
  };
  const commands = buildCommands(app);

  const byAlias = (alias) => [...commands.values()].find((command) => command.aliases?.includes(alias));
  await byAlias('promt').run(source);
  assert.equal(activePromptName(), 'from-file.txt');
  assert.equal(loadActivePrompt().text, 'FILE PROMPT');
  await byAlias('promits').run('default');
  assert.equal(activePromptName(), null);
  assert.match(output.flat(2).join('\n'), /kept for later sessions/);
});

test('new runtimes use the selected profile and fall back to the built-in prompt', async () => {
  const cwd = tmp();
  savePrompt('runtime.txt', 'RUNTIME CUSTOM PROMPT');
  const runtime = await createRuntime({ cwd, flags: { noMcp: true }, io: { notice() {} } });
  try {
    assert.equal(runtime.systemPrompt(), 'RUNTIME CUSTOM PROMPT');
    setActivePrompt(null);
    runtime.invalidateSystemPrompt();
    assert.match(runtime.systemPrompt(), /You are claude-pro/);
  } finally {
    runtime.mcp.close();
  }

  savePrompt('runtime.txt', 'RUNTIME CUSTOM PROMPT');
  const explicit = await createRuntime({ cwd, flags: { noMcp: true, systemPrompt: 'COMMAND LINE PROMPT' }, io: { notice() {} } });
  try {
    assert.equal(explicit.systemPrompt(), 'COMMAND LINE PROMPT');
  } finally {
    explicit.mcp.close();
  }
});
