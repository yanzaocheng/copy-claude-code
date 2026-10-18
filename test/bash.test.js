import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBashTool, BashOutputTool, appendOutput } from '../src/tools/bash.js';
import { Config } from '../src/config.js';

const cwd = process.cwd();
const config = (env = {}) => new Config(env, {}, { hooks: {}, mcpServers: {} }, cwd);
const ctx = (extra = {}) => ({ cwd, projectRoot: cwd, setCwd() {}, ...extra });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Bash keeps multi-byte characters intact when a chunk boundary falls inside one', async () => {
  const bash = makeBashTool(config({ BASH_MAX_OUTPUT_LENGTH: '10000000' }));
  const text = '你好世界'.repeat(150_000); // 1.8 MB of 3-byte characters: several pipe chunks
  const r = await bash.call({ command: `node -e "process.stdout.write('你好世界'.repeat(150000))"` }, ctx());
  assert.ok(!r.isError, r.content);
  assert.equal(r.display.output.length, text.length);
  assert.equal(r.display.output, text);
});

test('Bash returns when the command leaves a background process running', async () => {
  const bash = makeBashTool(config());
  const started = Date.now();
  const r = await bash.call({ command: 'sleep 3 & echo started' }, ctx());
  const elapsed = Date.now() - started;
  assert.ok(!r.isError, r.content);
  assert.equal(r.content, 'started');
  assert.ok(elapsed < 2500, `took ${elapsed} ms: the call waited for the background process`);
});

test('a process left running by a command is not killed by the early return', async () => {
  const bash = makeBashTool(config());
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-bash-')), 'done.txt').replace(/\\/g, '/');
  // It writes to the (now unread) pipe after the call has returned, then proves it is still alive.
  const r = await bash.call({ command: `(sleep 1.5; echo late-output; echo alive > "${marker}") & echo started` }, ctx());
  assert.equal(r.content, 'started');
  assert.equal(fs.existsSync(marker), false, 'it must still be running when the call returns');
  for (let i = 0; i < 40 && !fs.existsSync(marker); i++) await sleep(100);
  assert.ok(fs.existsSync(marker), 'the background process was killed (broken pipe?)');
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'alive');
});

test('a large output is returned completely, ending with its last line', async () => {
  const bash = makeBashTool(config({ BASH_MAX_OUTPUT_LENGTH: '100000' }));
  const r = await bash.call({ command: `node -e "for (let i = 0; i < 100000; i++) console.log('line ' + i); console.log('END-MARKER')"` }, ctx());
  assert.ok(!r.isError, r.content);
  assert.match(r.content, /END-MARKER/);
  assert.match(r.content, /lines truncated/);
});

test('exit codes and timeouts still work', async () => {
  const bash = makeBashTool(config());
  const failed = await bash.call({ command: 'echo oops; exit 3' }, ctx());
  assert.equal(failed.isError, true);
  assert.match(failed.content, /oops/);
  assert.match(failed.content, /Exit code 3/);
  const slow = await bash.call({ command: 'sleep 20', timeout: 1000 }, ctx());
  assert.equal(slow.isError, true);
  assert.match(slow.content, /timed out after 1000ms/);
});

test('appendOutput trims the buffer and keeps readPos pointing at the same text', () => {
  const bg = { output: '', readPos: 0 };
  appendOutput(bg, '0123456789', 20, 10);
  bg.readPos = bg.output.length; // everything so far was read
  appendOutput(bg, 'ABCDEFGHIJ', 20, 10);
  assert.equal(bg.output.slice(bg.readPos), 'ABCDEFGHIJ');

  // 22 characters is over the limit: the oldest 12 go, and the unread text is what is left of it
  appendOutput(bg, 'KL', 20, 10);
  assert.equal(bg.output, 'CDEFGHIJKL');
  assert.equal(bg.output.slice(bg.readPos), 'CDEFGHIJKL');

  // text that was already read stays marked as read
  const b2 = { output: '', readPos: 0 };
  appendOutput(b2, '0123456789ABCDE', 20, 10); // 15 characters
  b2.readPos = 15;
  appendOutput(b2, 'FGHIJ', 20, 10); // exactly 20: no trimming yet
  assert.equal(b2.output.slice(b2.readPos), 'FGHIJ');
  appendOutput(b2, 'KL', 20, 10); // 22: trimmed to the newest 10
  assert.equal(b2.output, 'CDEFGHIJKL');
  assert.equal(b2.readPos, 3, 'readPos moved back by the 12 characters that were removed');
  assert.equal(b2.output.slice(b2.readPos), 'FGHIJKL');
});

test('BashOutput delivers new output of a background shell after its buffer was trimmed', async () => {
  const bash = makeBashTool(config());
  const started = await bash.call({ command: `node -e "console.log('first'); setTimeout(() => console.log('second'), 2000)"`, run_in_background: true }, ctx());
  const id = /bash_\d+/.exec(started.content)[0];
  // read until the output comes (a fixed wait was too short when the whole suite runs at once)
  const readUntil = async (re) => {
    for (let t = 0; t < 15_000; t += 50) {
      const r = await BashOutputTool.call({ bash_id: id }, ctx());
      if (re.test(r.content)) return r;
      await sleep(50);
    }
    throw new Error(`no ${re} in the output`);
  };
  const one = await readUntil(/first/);
  assert.doesNotMatch(one.content, /second/);
  const two = await readUntil(/second/);
  assert.doesNotMatch(two.content, /first/);
});
