import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseArgs, buildArgs, cleanEnv, readUserPrompt } from '../src/launcher.js';
import { PRO_SYSTEM_PROMPT } from '../src/pro-prompt.js';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'claude-pro.js');

test('own flags are separated from the arguments forwarded to claude', () => {
  const { opts, passthrough } = parseArgs(['--safe', '-p', 'hi', '--keep-env', '--model', 'opus']);
  assert.deepEqual([...opts], ['--safe', '--keep-env']);
  assert.deepEqual(passthrough, ['-p', 'hi', '--model', 'opus']);
});

test('pro defaults: skip permissions and append the pro prompt', () => {
  const args = buildArgs(['-p', 'hi'], new Set());
  assert.deepEqual(args, ['--dangerously-skip-permissions', '--append-system-prompt', PRO_SYSTEM_PROMPT, '-p', 'hi']);
});

test('the user can opt out of each default or override it', () => {
  assert.deepEqual(buildArgs(['-c'], new Set(['--safe', '--no-prompt'])), ['-c']);
  // An explicit permission mode or system prompt from the user wins over the defaults.
  assert.deepEqual(buildArgs(['--permission-mode', 'plan', '--append-system-prompt', 'mine'], new Set()), ['--permission-mode', 'plan', '--append-system-prompt', 'mine']);
  assert.deepEqual(buildArgs(['--system-prompt=x'], new Set(['--safe'])), ['--system-prompt=x']);
});

test('personal instructions are appended after the pro prompt', () => {
  const args = buildArgs([], new Set(['--safe']), { extraPrompt: '  Always answer in Chinese.\n' });
  assert.equal(args[0], '--append-system-prompt');
  assert.ok(args[1].startsWith(PRO_SYSTEM_PROMPT));
  assert.match(args[1], /# User instructions for claude-pro\nAlways answer in Chinese\.$/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-'));
  assert.equal(readUserPrompt(path.join(dir, 'missing.md')), '');
});

test('third-party endpoint, key and model variables are removed unless --keep-env', () => {
  const env = {
    PATH: '/bin', HOME: '/home/u',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k',
    ANTHROPIC_MODEL: 'm', ANTHROPIC_DEFAULT_OPUS_MODEL: 'o', ANTHROPIC_SMALL_FAST_MODEL: 's', CLAUDE_CODE_SUBAGENT_MODEL: 'x',
    ANTHROPIC_CUSTOM_HEADERS: 'h', CLAUDE_CODE_EFFORT_LEVEL: 'high',
  };
  assert.deepEqual(cleanEnv(env), { PATH: '/bin', HOME: '/home/u', CLAUDE_CODE_EFFORT_LEVEL: 'high' });
  assert.deepEqual(cleanEnv(env, { keep: true }), env);
});

test('bin: --pro-help works and --which finds a claude executable that is not claude-pro', () => {
  const help = spawnSync(process.execPath, [bin, '--pro-help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: claude-pro/);
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-bin-')), process.platform === 'win32' ? 'claude.exe' : 'claude');
  fs.writeFileSync(fake, '');
  const which = spawnSync(process.execPath, [bin, '--which'], { encoding: 'utf8', env: { ...process.env, CLAUDE_PRO_BIN: fake } });
  assert.equal(which.status, 0);
  assert.equal(which.stdout.trim(), fake);
});
