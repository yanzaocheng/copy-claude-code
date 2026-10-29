// `claude-pro --self-check`: start the program the way a session does, but in a fake terminal, and see that
// it comes up. A restart runs this first in a throwaway process, so that code which does not load or start
// is found out while the session that can still fix it is running.

import { PassThrough, Writable } from 'node:stream';

const STARTUP_LIMIT_MS = 30_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function check() {
  const problems = [];
  const fail = (text) => problems.push(text);
  // The App starts as a session does (the fullscreen renderer, ...), so that code only a real start runs is checked
  // too, but this process must not show up as a session or go online.
  Object.assign(process.env, { CLAUDE_PRO_PEERS: '0', CLAUDE_PRO_ONLINE: '0' });

  let App;
  try {
    ({ App } = await import('./ui/repl.js'));
    for (const file of ['./main.js', './print.js', './restart.js', './supervisor.js']) await import(file);
  } catch (e) {
    return [`A module does not load: ${e?.stack || e}`];
  }

  let screen = '';
  const stdout = new Writable({ write(chunk, _enc, cb) { screen += chunk; cb(); } });
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 30, getColorDepth: () => 8 });
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {} });

  const app = new App({ flags: { noMcp: true }, cwd: process.cwd(), stdin, stdout, selfCheck: true });
  let exited;
  try {
    exited = app.start('');
    exited.catch((e) => fail(`Starting failed: ${e?.stack || e}`));
    const began = Date.now();
    while (!(screen.includes('Welcome to') && screen.includes('for shortcuts'))) {
      if (problems.length) return problems;
      if (Date.now() - began > STARTUP_LIMIT_MS) return [`The interface did not come up within ${STARTUP_LIMIT_MS / 1000} seconds.\n${screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-800)}`];
      await sleep(25);
    }
    if (/render error/.test(screen)) fail(`The interface failed to render: ${screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').match(/render error[^\n]*/)?.[0]}`);

    const names = new Set();
    for (const tool of app.runtime.agent.toolSchemas()) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name || '')) fail(`Tool name ${JSON.stringify(tool.name)} is not valid.`);
      if (names.has(tool.name)) fail(`Tool ${tool.name} is defined twice.`);
      names.add(tool.name);
      if (typeof tool.description !== 'string' || !tool.description.trim()) fail(`Tool ${tool.name} has no description.`);
      if (tool.input_schema?.type !== 'object') fail(`Tool ${tool.name} has no object input_schema.`);
    }
    const prompt = app.runtime.systemPrompt();
    if (typeof prompt !== 'string' || prompt.length < 200) fail('The system prompt is empty.');
  } catch (e) {
    fail(`The check itself failed: ${e?.stack || e}`);
  } finally {
    try { app.exit(0); } catch { /* ignore */ }
  }
  return problems;
}

// Prints the result and ends the process (an interface that was started leaves timers and watchers around).
export async function selfCheck() {
  let problems;
  try {
    problems = await check();
  } catch (e) {
    problems = [`The check crashed: ${e?.stack || e}`];
  }
  const text = problems.length ? `Self-check failed:\n- ${problems.join('\n- ')}\n` : 'Self-check passed: every module loads and the interface starts.\n';
  const code = problems.length ? 1 : 0;
  process.stdout.write(text, () => process.exit(code));
  return code;
}
