// The first start with nothing logged in: the gateway is the default and its login is offered at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-tui-login-'));
Object.assign(process.env, { CLAUDE_PRO_CONFIG_DIR: configDir, CLAUDE_PRO_DISABLE_AUTO_MEMORY: '1', CLAUDE_PRO_RIPGREP_PATH: 'off', CLAUDE_PRO_GATEWAY_URL: 'http://127.0.0.1:9' });
const { startTui } = await import('./tui-harness.js');

test('a gateway with no login opens the login choice at start, the gateway first', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-tui-login-cwd-'));
  const tui = await startTui({ cwd, flags: { provider: 'gateway' } });
  t.after(() => tui.close());
  await tui.waitFor('Log in', { timeout: 20_000 });
  const screen = await tui.snapshot();
  assert.match(screen, /Not logged in to the gateway http:\/\/127\.0\.0\.1:9/);
  const gateway = screen.indexOf('Gateway http://127.0.0.1:9');
  const claude = screen.indexOf('Claude subscription');
  assert.ok(gateway > 0 && gateway < claude, screen);
});
