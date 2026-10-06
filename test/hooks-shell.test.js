import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config.js';
import { HookRunner } from '../src/hooks.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-hooks-'));
const makeConfig = (cwd, hooks) => new Config({ ANTHROPIC_MODEL: 'mock' }, {}, { mcpServers: {}, hooks }, cwd);
const hook = (command, timeout) => [{ matcher: '*', hooks: [{ type: 'command', command, ...(timeout ? { timeout } : {}) }] }];

test('a hook that leaves a background process running returns at once instead of waiting for its timeout', async () => {
  const dir = tmp();
  const runner = new HookRunner(makeConfig(dir, { PreToolUse: hook('sleep 4 & echo started', 30) }));
  const started = Date.now();
  const r = await runner.run('PreToolUse', { tool_name: 'Bash', tool_input: {} }, { cwd: dir });
  const elapsed = Date.now() - started;
  assert.deepEqual(r.context, ['started']);
  assert.equal(r.blocked, false);
  assert.deepEqual(r.warnings, [], 'not reported as timed out');
  assert.ok(elapsed < 3000, `took ${elapsed} ms: waited for the background process`);
});

test('multi-byte characters in a hook\'s output survive chunk boundaries', async () => {
  const dir = tmp();
  const runner = new HookRunner(makeConfig(dir, {
    PreToolUse: hook(`node -e "process.stdout.write('你好世界'.repeat(100000))"`),
  }));
  const r = await runner.run('PreToolUse', { tool_name: 'Bash', tool_input: {} }, { cwd: dir });
  assert.equal(r.context.length, 1);
  assert.equal(r.context[0], '你好世界'.repeat(100000));
});

test('a blocking hook that also leaves a process behind still blocks, with its stderr', async () => {
  const dir = tmp();
  const runner = new HookRunner(makeConfig(dir, { PreToolUse: hook('sleep 3 & echo "not allowed" >&2; exit 2') }));
  const started = Date.now();
  const r = await runner.run('PreToolUse', { tool_name: 'Bash', tool_input: {} }, { cwd: dir });
  assert.equal(r.blocked, true);
  assert.match(r.message, /not allowed/);
  assert.ok(Date.now() - started < 3000);
});

test('a hook that runs too long is killed and reported', async () => {
  const dir = tmp();
  const runner = new HookRunner(makeConfig(dir, { PreToolUse: hook('echo working; sleep 20', 1) }));
  const started = Date.now();
  const r = await runner.run('PreToolUse', { tool_name: 'Bash', tool_input: {} }, { cwd: dir });
  assert.equal(r.blocked, false);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /exited with 1/);
  assert.match(r.warnings[0], /timed out after 1000ms/);
  assert.ok(Date.now() - started < 8000);
});
