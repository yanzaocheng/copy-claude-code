import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config.js';
import { discoverVerifyCommand } from '../src/verify.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-verify-'));
const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);

test('discovers package test scripts and respects the package manager lockfile', () => {
  const npm = tmp();
  write(npm, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.equal(discoverVerifyCommand(npm), 'npm test');

  const pnpm = tmp();
  write(pnpm, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
  write(pnpm, 'pnpm-lock.yaml', 'lockfileVersion: 9');
  assert.equal(discoverVerifyCommand(pnpm), 'pnpm test');

  const fallback = tmp();
  write(fallback, 'package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', check: 'tsc --noEmit' } }));
  assert.equal(discoverVerifyCommand(fallback), 'npm run check');
});

test('discovers conventional non-JavaScript verification commands', () => {
  const python = tmp();
  write(python, 'pyproject.toml', '[tool.pytest.ini_options]\n');
  fs.mkdirSync(path.join(python, 'tests'));
  assert.equal(discoverVerifyCommand(python), 'python -m pytest -q');

  const rust = tmp();
  write(rust, 'Cargo.toml', '[package]\nname = "demo"\n');
  assert.equal(discoverVerifyCommand(rust), 'cargo test');

  const go = tmp();
  write(go, 'go.mod', 'module example.com/demo\n');
  assert.equal(discoverVerifyCommand(go), 'go test ./...');

  const make = tmp();
  write(make, 'Makefile', '.PHONY: test\ntest:\n\t@echo ok\n');
  assert.equal(discoverVerifyCommand(make), 'make test');
});

test('does not invent a command and supports explicit configuration and /verify off', () => {
  const dir = tmp();
  assert.equal(discoverVerifyCommand(dir), null);

  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  const auto = new Config({}, {}, {}, dir);
  assert.equal(auto.verifyCommand, 'npm test');
  assert.equal(auto.verifyCommandAuto, true);

  const off = new Config({ CLAUDE_PRO_VERIFY_COMMAND: 'off' }, {}, {}, dir);
  assert.equal(off.verifyCommand, null);
  assert.equal(off.verifyCommandAuto, false);

  const explicit = new Config({ CLAUDE_PRO_VERIFY_COMMAND: 'npm run targeted' }, {}, {}, dir);
  assert.equal(explicit.verifyCommand, 'npm run targeted');
  assert.equal(explicit.verifyCommandAuto, false);
});
