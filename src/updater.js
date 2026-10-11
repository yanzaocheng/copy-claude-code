// Auto-update, as in Claude Code: an interactive session installed with `npm i -g claude-pro` looks for a newer
// version on the npm registry (when it starts and every few minutes while it runs; the sessions of a machine share
// the interval), installs it in the background, and the session then loads it with a restart once it is idle (the
// conversation carries over). The other sessions of the machine see the files change and restart too (see
// App.startSourceWatch). A git checkout (the
// development copy) is never touched. Off with CLAUDE_PRO_AUTO_UPDATE=0 or DISABLE_AUTOUPDATER=1.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { CONFIG_DIR, INSTALL_DIR, VERSION } from './config.js';

// The name on npm (scoped: npm refused plain `claude-pro` as too close to another package's name).
export const PACKAGE_NAME = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8')).name;
const STATE_FILE = path.join(CONFIG_DIR, 'update-check.json');
export const CHECK_EVERY_MS = 5 * 60_000; // a release reaches the running sessions within minutes
const RETRY_FAILED_MS = 60_000; // a release's tarball can take minutes to be downloadable after it is published

export function autoUpdateEnabled(env = process.env) {
  if (/^(1|true|yes)$/i.test(env.DISABLE_AUTOUPDATER || '')) return false;
  return !/^(0|false|no|off)$/i.test(env.CLAUDE_PRO_AUTO_UPDATE || '');
}

// The node_modules directory a package is installed in: one level up, or two for a scoped (@scope/name) package.
export function modulesDir(dir = INSTALL_DIR) {
  const up = path.dirname(dir);
  return path.basename(up).startsWith('@') ? path.dirname(up) : up;
}

// Installed by npm (a package in some node_modules), not run from a source checkout.
export function installedByNpm(dir = INSTALL_DIR) {
  return path.basename(modulesDir(dir)) === 'node_modules' && !fs.existsSync(path.join(dir, '.git')) && !/[\\/]_npx[\\/]/.test(dir);
}

// 1.2.10 > 1.2.9; a prerelease (1.3.0-beta) is never taken for newer.
export function isNewer(latest, current) {
  if (!/^\d+\.\d+\.\d+$/.test(String(latest))) return false;
  const a = latest.split('.').map(Number);
  const b = String(current).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > (b[i] || 0);
  return false;
}

function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch { /* ignore */ } }

export function latestVersion({ timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    // past the registry's CDN cache, which can answer with the version before the one just published
    const url = `https://registry.npmjs.org/${PACKAGE_NAME.replace('/', '%2f')}/latest?t=${Date.now()}`;
    const req = https.get(url, { headers: { accept: 'application/json', 'cache-control': 'no-cache' }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`npm registry: HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body).version); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('npm registry did not answer')));
    req.on('error', reject);
  });
}

function runNpm(args, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.trim() }); });
  });
}

// Look for a newer version and install it. Resolves with {status: 'disabled'|'dev'|'skipped'|'current'|'updated'|'failed', version, error}.
// `force`: check now, whatever the last check was (the /update command).
export async function checkForUpdate({ force = false, env = process.env, onInstalling } = {}) {
  if (!force && !autoUpdateEnabled(env)) return { status: 'disabled' };
  if (!installedByNpm()) return { status: 'dev' };
  const state = readState();
  if (!force && state.checkedAt && Date.now() - state.checkedAt < CHECK_EVERY_MS) return { status: 'skipped' };
  writeState({ ...state, checkedAt: Date.now() });
  const latest = await latestVersion();
  if (!isNewer(latest, VERSION)) return { status: 'current', version: latest };
  // Only a global install is updated by `npm i -g`: one in a project's node_modules belongs to that project.
  const root = await runNpm(['root', '-g'], { timeoutMs: 30_000 });
  if (!root.ok || path.resolve(root.output.split(/\r?\n/).pop()) !== path.resolve(modulesDir())) {
    return { status: 'failed', version: latest, error: `this copy (${INSTALL_DIR}) is not the global npm install; update it with npm yourself` };
  }
  onInstalling?.(latest);
  // --prefer-online: not npm's own cache of the package's versions, which may not know this one yet
  const r = await runNpm(['install', '-g', '--prefer-online', `${PACKAGE_NAME}@${latest}`]);
  if (!r.ok) {
    writeState({ ...readState(), checkedAt: Date.now() - CHECK_EVERY_MS + RETRY_FAILED_MS }); // again in a minute
    return { status: 'failed', version: latest, error: r.output.split('\n').slice(-5).join('\n') };
  }
  writeState({ checkedAt: Date.now(), installed: latest });
  return { status: 'updated', version: latest };
}
