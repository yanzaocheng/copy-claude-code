import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findShell, spawnShell, killTree, parsePsRows, msysTree, pruneStaleShellFiles } from '../src/utils/shell.js';
import { makeBashTool } from '../src/tools/bash.js';
import { Config } from '../src/config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `ps -W` as Git for Windows prints it: MSYS ids first, then the Windows id; a launcher and other
// native programs show up with the Windows id + 65536 and no parent.
const PS_OUTPUT = `      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
   106344       0       0      40808  ?              0 21:17:16 C:\\Program Files\\Git\\bin\\bash.exe
      683       1     683       8896  ?         197609 21:17:15 /usr/bin/bash
      684     683     683      58392  ?         197609 21:17:15 /usr/bin/bash
      686     684     683      44432  ?         197609 21:17:15 /usr/bin/sleep
      687     684     683      37788  ?         197609 Oct  3 /usr/bin/sleep
`;

test('parsePsRows reads the ids of every row and skips the header and garbage', () => {
  const rows = parsePsRows(`${PS_OUTPUT}\nnot a row\n  12 x 3 4 ?\n`);
  assert.deepEqual(rows.map((r) => [r.pid, r.ppid, r.pgid, r.winpid]), [
    [106344, 0, 0, 40808], [683, 1, 683, 8896], [684, 683, 683, 58392], [686, 684, 683, 44432], [687, 684, 683, 37788],
  ]);
  assert.deepEqual(parsePsRows(''), []);
  assert.deepEqual(parsePsRows(undefined), []);
});

test('msysTree finds everything under a shell, also what its parent links no longer reach', () => {
  const rows = [
    { pid: 100, ppid: 1, pgid: 100, winpid: 1000 }, // the shell
    { pid: 101, ppid: 100, pgid: 100, winpid: 1001 }, // a child
    { pid: 102, ppid: 101, pgid: 100, winpid: 1002 }, // a grandchild
    { pid: 103, ppid: 102, pgid: 103, winpid: 1003 }, // in a group of its own, but still linked
    { pid: 104, ppid: 1, pgid: 100, winpid: 1004 }, // its parent exited: only the process group still says it belongs
    { pid: 200, ppid: 1, pgid: 200, winpid: 2000 }, // another shell
    { pid: 201, ppid: 200, pgid: 200, winpid: 2001 }, // its child
    { pid: 65536 + 3000, ppid: 0, pgid: 0, winpid: 3000 }, // a native program
    { pid: 65536 + 3001, ppid: 0, pgid: 0, winpid: 3001 },
  ];
  assert.deepEqual(msysTree(rows, 100).sort(), [1000, 1001, 1002, 1003, 1004]);
  assert.deepEqual(msysTree(rows, 200).sort(), [2000, 2001]);
  assert.deepEqual(msysTree(rows, 999), [], 'an unknown shell');
  // a shell whose group id is not meaningful (0 or 1) must not pull in every process that has that id
  const odd = [{ pid: 5, ppid: 1, pgid: 1, winpid: 50 }, { pid: 6, ppid: 1, pgid: 1, winpid: 60 }, { pid: 7, ppid: 5, pgid: 1, winpid: 70 }];
  assert.deepEqual(msysTree(odd, 5).sort((a, b) => a - b), [50, 70]);
  // a parent link that loops does not hang
  assert.deepEqual(msysTree([{ pid: 8, ppid: 9, pgid: 8, winpid: 80 }, { pid: 9, ppid: 8, pgid: 8, winpid: 90 }], 8).sort(), [80, 90]);
});

const onWindows = process.platform === 'win32';

// Windows ids of MSYS processes, looked up by the MSYS pid the script printed ($!). This is the
// oracle: it does not depend on the tree walking that killTree uses.
function winpidsOf(shell, msysPids) {
  const ps = path.resolve(path.dirname(shell.path), '..', 'usr', 'bin', 'ps.exe');
  const rows = parsePsRows(spawnSync(ps, ['-W'], { encoding: 'utf8', windowsHide: true }).stdout);
  return msysPids.map((pid) => rows.find((r) => r.pid === pid)?.winpid);
}
const alive = (winpid) => spawnSync('tasklist', ['/FI', `PID eq ${winpid}`, '/NH'], { encoding: 'utf8', windowsHide: true }).stdout.includes(` ${winpid} `);
const fwd = (p) => p.replace(/\\/g, '/');

async function readPids(files) {
  for (let i = 0; i < 60; i++) {
    const values = files.map((f) => { try { return Number(fs.readFileSync(f, 'utf8').trim()); } catch { return NaN; } });
    if (values.every(Number.isFinite)) return values;
    await sleep(100);
  }
  throw new Error(`the script did not write its pids to ${files.join(', ')}`);
}

test('killTree kills what a command started through MSYS fork, which taskkill /T alone leaves running', { skip: !onWindows }, async (t) => {
  const shell = findShell(null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-killtree-'));
  const first = path.join(dir, 'first');
  const second = path.join(dir, 'second');
  // one sleep directly under the shell, one inside a subshell
  const command = `sleep 66 & echo $! > "${fwd(first)}"; (sleep 67 & echo $! > "${fwd(second)}"; wait) & wait`;
  const child = spawnShell(shell, command, { cwd: process.cwd(), env: process.env });
  let victims = [];
  t.after(() => { for (const pid of victims) if (pid && alive(pid)) spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }); fs.rmSync(dir, { recursive: true, force: true }); });

  victims = winpidsOf(shell, await readPids([first, second]));
  assert.ok(victims.every(Boolean), `could not find the sleeps in ps: ${victims}`);
  assert.deepEqual(victims.map(alive), [true, true], 'both are running before the kill');
  assert.ok(fs.existsSync(child.claudeProPidFile), 'the shell wrote its pid file');

  killTree(child);
  await sleep(600);
  assert.deepEqual(victims.map(alive), [false, false], 'killTree must leave nothing behind');
  assert.equal(fs.existsSync(child.claudeProPidFile), false, 'the pid file is removed once the shell is gone');
});

test('the Bash tool leaves nothing running after a timeout', { skip: !onWindows }, async (t) => {
  const shell = findShell(null);
  const bash = makeBashTool(new Config({}, {}, { hooks: {}, mcpServers: {} }, process.cwd()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-killtree-'));
  const file = path.join(dir, 'pid');
  let victims = [];
  t.after(() => { for (const pid of victims) if (pid && alive(pid)) spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }); fs.rmSync(dir, { recursive: true, force: true }); });

  const started = Date.now();
  const pending = bash.call({ command: `sleep 68 & echo $! > "${fwd(file)}"; wait`, timeout: 1000 }, { cwd: process.cwd(), projectRoot: process.cwd(), setCwd() {} });
  victims = winpidsOf(shell, await readPids([file]));
  assert.ok(victims[0], 'the sleep is running');
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(result.content, /timed out after 1000ms/);
  assert.ok(Date.now() - started < 5000, 'returned promptly');
  await sleep(300);
  assert.equal(alive(victims[0]), false, 'the sleep started by the command is gone');
});

test('pruneStaleShellFiles removes old pid and cwd files and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-prune-'));
  const old = Date.now() - 10 * 24 * 3600_000;
  const make = (name, mtime) => { const f = path.join(dir, name); fs.writeFileSync(f, '1'); fs.utimesSync(f, new Date(mtime), new Date(mtime)); return f; };
  const stalePid = make('claude-pro-pid-1-2-abc', old);
  const staleCwd = make('claude-pro-cwd-1-2-abc', old);
  const freshPid = make('claude-pro-pid-3-4-def', Date.now());
  const other = make('somebody-elses-file', old);
  assert.equal(pruneStaleShellFiles(dir), 2);
  assert.equal(fs.existsSync(stalePid) || fs.existsSync(staleCwd), false);
  assert.equal(fs.existsSync(freshPid), true, 'the file of a shell that may still be running stays');
  assert.equal(fs.existsSync(other), true);
  assert.equal(pruneStaleShellFiles(path.join(dir, 'does-not-exist')), 0);
});

test('a command that finishes by itself leaves no pid file behind', { skip: !onWindows }, async () => {
  const shell = findShell(null);
  const child = spawnShell(shell, 'echo done', { cwd: process.cwd(), env: process.env });
  const file = child.claudeProPidFile;
  await new Promise((resolve) => child.once('close', resolve));
  await sleep(200);
  assert.equal(fs.existsSync(file), false);
});
