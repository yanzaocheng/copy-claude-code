// Manual update support for `npm i -g claude-pro`: the interactive session checks npm and installs a release only
// when `/update` asks for it (App.updateFromNpm). Installation is serialized by a lock file and the session loads
// the new package with a restart (the conversation carries over). A git checkout (the development copy) is never
// touched.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { CONFIG_DIR, INSTALL_DIR, VERSION } from './config.js';
import { killTree, processAlive as alive } from './utils/shell.js';

// The name on npm (scoped: npm refused plain `claude-pro` as too close to another package's name).
const PACKAGE_NAME = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8')).name;
const LOCK_FILE = path.join(CONFIG_DIR, 'update.lock');
const LOCK_STALE_MS = 15 * 60_000;

// The node_modules directory a package is installed in: one level up, or two for a scoped (@scope/name) package.
function modulesDir(dir = INSTALL_DIR) {
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

// The version installed on disk now (another session may have updated it since this one started).
export function installedVersion(dir = INSTALL_DIR) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { return VERSION; }
}

// One session of the machine installs at a time. A lock left by a session that died, or one that is very old, is taken over.
function takeLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      let held = {};
      try { held = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { /* unreadable: stale */ }
      if (alive(held.pid) && Date.now() - (held.at || 0) < LOCK_STALE_MS) return false;
      try { fs.unlinkSync(LOCK_FILE); } catch { /* someone else took it over */ }
    }
  }
  return false;
}

function releaseLock() {
  try {
    const held = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (held.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* gone already */ }
}

function latestVersion({ timeoutMs = 10_000 } = {}) {
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
    const take = (d) => { out = (out + d).slice(-200_000); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    // With shell: true, child.kill() ends only cmd.exe: npm kept the pipes open, 'close' never came and the
    // timeout did nothing. The whole tree goes.
    const timer = setTimeout(() => { killTree(child); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.trim() }); });
  });
}

// Look for a newer version on npm. Resolves with {status: 'dev'|'current'|'available'|'installed', version}:
// 'available' to be installed (installUpdate), 'installed' when it is on disk already (another session installed
// it: a restart loads it). (The background checks every few minutes, with their state file and switches, are gone:
// /update is the only caller.)
export async function checkForUpdate() {
  if (!installedByNpm()) return { status: 'dev' };
  const latest = await latestVersion();
  if (!isNewer(latest, VERSION)) return { status: 'current', version: latest };
  if (!isNewer(latest, installedVersion())) return { status: 'installed', version: installedVersion() };
  return { status: 'available', version: latest };
}

// Install `version` with npm. Resolves with {status: 'updated'|'installed'|'locked'|'failed', version, error}:
// 'locked' while another session of the machine is installing.
export async function installUpdate(version) {
  if (!takeLock()) return { status: 'locked', version };
  try {
    if (!isNewer(version, installedVersion())) return { status: 'installed', version: installedVersion() };
    return await install(version);
  } finally {
    releaseLock();
  }
}

async function install(latest) {
  // Only a global install is updated by `npm i -g`: one in a project's node_modules belongs to that project.
  const root = await runNpm(['root', '-g'], { timeoutMs: 30_000 });
  if (!root.ok || path.resolve(root.output.split(/\r?\n/).pop()) !== path.resolve(modulesDir())) {
    return { status: 'failed', version: latest, error: `this copy (${INSTALL_DIR}) is not the global npm install; update it with npm yourself` };
  }
  // --prefer-online: not npm's own cache of the package's versions, which may not know this one yet
  const r = await runNpm(['install', '-g', '--prefer-online', `${PACKAGE_NAME}@${latest}`]);
  if (!r.ok) return { status: 'failed', version: latest, error: r.output.split('\n').slice(-5).join('\n') };
  return { status: 'updated', version: latest };
}
