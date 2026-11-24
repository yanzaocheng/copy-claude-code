#!/usr/bin/env node
// Release claude-pro in one command (what was done by hand at every "发布"):
//
//   npm run release -- <patch|minor|major|x.y.z> [--dry-run] [--node22] [--no-gateway] [--no-wait]
//
//   1. checks: on main, nothing uncommitted (untracked files aside), not behind origin, the version free on npm
//   2. the version in package.json and package-lock.json
//   3. the self-check (and with --node22 under Node 22, the lowest supported); what the package holds (no secrets,
//      the files it needs); any failure puts the version back and stops
//   4. "Release x.y.z" committed and pushed, npm publish
//   5. 7bit.fun's copies of install.sh / install.ps1 (../codex-gateway/src/claude-pro-install.*): copied, committed,
//      deployed and pushed when they differ (--no-gateway: not)
//   6. waits until npm serves the version (--no-wait: not)
//
// --dry-run: 1–3 only, and the version put back: nothing committed, published or deployed.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { npmInvocation } from '../src/utils/shell.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY = path.resolve(ROOT, '..', 'codex-gateway');
const isWin = process.platform === 'win32';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const bumpArg = args.find((a) => !a.startsWith('--'));
const dryRun = flag('--dry-run');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const step = (s) => console.log(`\n${bold(`==> ${s}`)}`);
const fail = (s) => { console.error(`\x1b[31m✘ ${s}\x1b[0m`); process.exit(1); };

// a command, its output shown (or captured); npm as npmInvocation runs it (this node's npm, no shell)
function run(cmd, cmdArgs, { cwd = ROOT, capture = false, allowFail = false } = {}) {
  const inv = cmd === 'npm' ? npmInvocation(cmdArgs) : { file: cmd, args: cmdArgs, shell: false };
  const r = spawnSync(inv.file, inv.args, { cwd, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', shell: inv.shell, windowsHide: true });
  if (r.error) { if (allowFail) return { ok: false, out: '', err: r.error.message }; fail(`${cmd} ${cmdArgs.join(' ')}: ${r.error.message}`); }
  const res = { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  if (!res.ok && !allowFail) fail(`${cmd} ${cmdArgs.join(' ')} failed${capture ? `:\n${res.err || res.out}` : ''}`);
  return res;
}
const git = (a, opts) => run('git', a, opts);

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const writeJson = (f, v) => fs.writeFileSync(path.join(ROOT, f), `${JSON.stringify(v, null, 2)}\n`);

function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [ma, mi, pa] = current.split('.').map(Number);
  if (bump === 'patch') return `${ma}.${mi}.${pa + 1}`;
  if (bump === 'minor') return `${ma}.${mi + 1}.0`;
  if (bump === 'major') return `${ma + 1}.0.0`;
  return null;
}
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

// ---------------------------------------------------------------- 1. checks
const pkg = readJson('package.json');
const current = pkg.version;
const version = nextVersion(current, bumpArg);
if (!version) fail('用法：npm run release -- <patch|minor|major|x.y.z> [--dry-run] [--node22] [--no-gateway] [--no-wait]');
if (!newer(version, current)) fail(`新版本 ${version} 要大于现在的 ${current}`);

step(`检查（${current} → ${version}${dryRun ? '，--dry-run' : ''}）`);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }).out;
if (branch !== 'main') fail(`当前分支是 ${branch}，要在 main 上发布`);
const dirty = git(['status', '--porcelain', '--untracked-files=no'], { capture: true }).out;
if (dirty) fail(`有未提交的改动，先提交：\n${dirty}`);
git(['fetch', '--quiet', 'origin', 'main']);
const behind = Number(git(['rev-list', '--count', 'HEAD..origin/main'], { capture: true }).out);
if (behind) fail(`本地落后 origin/main ${behind} 个提交，先合并`);
const taken = run('npm', ['view', `${pkg.name}@${version}`, 'version', '--prefer-online'], { capture: true, allowFail: true });
if (taken.ok && taken.out) fail(`npm 上已经有 ${pkg.name}@${version}`);
const notes = git(['log', '--format=%h %s', 'origin/main..HEAD'], { capture: true }).out;
console.log(notes ? `这次发布的提交：\n${notes.split('\n').map((l) => `  ${l}`).join('\n')}` : '（origin/main 之后没有新提交：只发版本号）');

// ---------------------------------------------------------------- 2. the version
step(`版本号改为 ${version}`);
const lock = readJson('package-lock.json');
const restore = () => { writeJson('package.json', pkg); writeJson('package-lock.json', lock); };
writeJson('package.json', { ...pkg, version });
writeJson('package-lock.json', { ...lock, version, packages: { ...lock.packages, '': { ...lock.packages[''], version } } });

// ---------------------------------------------------------------- 3. checks of what is released
try {
  step('启动自检');
  run('npm', ['run', 'check', '--silent']);
  if (flag('--node22')) {
    step('启动自检（Node 22）');
    run('npm', ['exec', '--yes', '--package=node@22', '--', 'node', 'bin/claude-pro.js', '--self-check']);
  }
  step('检查打包内容');
  const packed = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--silent'], { capture: true }).out)[0];
  const secret = packed.files.filter((f) => /(^|\/)(\.env(\..*)?|credentials\.json|\.npmrc|jar\.txt|[^/]*\.bundle|gateway\.json|providers\.json)$/i.test(f.path));
  const need = ['bin/claude-pro.js', 'src/main.js', 'src/web/page.html', 'src/web/js/main.js', 'src/web/logo.svg', 'src/web/icon.ico', 'README.md', 'LICENSE'];
  const missing = need.filter((n) => !packed.files.some((f) => f.path === n));
  if (packed.version !== version) throw new Error(`打包的版本是 ${packed.version}`);
  if (secret.length) throw new Error(`包里有不该发布的文件：${secret.map((f) => f.path).join(', ')}`);
  if (missing.length) throw new Error(`包里缺少：${missing.join(', ')}`);
  console.log(`${packed.entryCount} 个文件，${(packed.size / 1024).toFixed(0)} KB`);
} catch (e) {
  restore();
  fail(`${e.message}（版本号已还原）`);
}
if (dryRun) {
  restore();
  console.log(`\n${bold('--dry-run：检查都通过了，版本号已还原，什么都没提交、发布或部署')}`);
  process.exit(0);
}

// ---------------------------------------------------------------- 4. commit, push, publish
step('提交、推送到 GitHub');
git(['commit', '--quiet', '-m', `Release ${version}`, '--', 'package.json', 'package-lock.json']);
git(['push', 'origin', 'main']);
step('发布到 npm');
const pub = run('npm', ['publish', '--access', 'public'], { allowFail: true });
if (!pub.ok) fail(`npm publish 失败。版本已提交并推送（Release ${version}），修好后在仓库里运行 npm publish --access public`);

// ---------------------------------------------------------------- 5. 7bit.fun's copies of the installers
const copies = [['install.sh', 'claude-pro-install.sh'], ['install.ps1', 'claude-pro-install.ps1']];
if (!flag('--no-gateway') && fs.existsSync(path.join(GATEWAY, 'deploy', 'deploy.sh'))) {
  const stale = copies.filter(([from, to]) => {
    const target = path.join(GATEWAY, 'src', to);
    return !fs.existsSync(target) || !fs.readFileSync(path.join(ROOT, from)).equals(fs.readFileSync(target));
  });
  if (!stale.length) console.log('\n7bit.fun 上的安装脚本已是最新，不用部署');
  else {
    step(`同步安装脚本到 7bit.fun（${stale.map(([f]) => f).join('、')}）`);
    const gwDirty = git(['status', '--porcelain', '--untracked-files=no'], { cwd: GATEWAY, capture: true }).out;
    if (gwDirty) console.log(`网关仓库有未提交的改动，跳过同步，请手动处理：\n${gwDirty}`);
    else {
      for (const [from, to] of stale) fs.copyFileSync(path.join(ROOT, from), path.join(GATEWAY, 'src', to));
      git(['commit', '--quiet', '-m', `claude-pro installers: copies of claude-pro ${version}'s`, '--', ...stale.map(([, to]) => `src/${to}`)], { cwd: GATEWAY });
      const { findShell } = await import(new URL('../src/utils/shell.js', import.meta.url));
      run(isWin ? findShell(null).path : 'bash', ['deploy/deploy.sh'], { cwd: GATEWAY });
      git(['push', 'origin', 'main'], { cwd: GATEWAY });
    }
  }
}

// ---------------------------------------------------------------- 6. npm serving it
if (!flag('--no-wait')) {
  step('等 npm 生效');
  const name = pkg.name.replace('/', '%2f');
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    try {
      const meta = await (await fetch(`https://registry.npmjs.org/${name}?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } })).json();
      const tarball = meta.versions?.[version]?.dist?.tarball;
      ok = meta['dist-tags']?.latest === version && Boolean(tarball) && (await fetch(tarball, { method: 'HEAD' })).ok;
    } catch { /* next time */ }
    if (!ok) await new Promise((r) => setTimeout(r, 15_000));
  }
  console.log(ok ? `npm 上的最新版本是 ${version}，可以安装了` : 'npm 10 分钟内还没生效：稍后用 npm view 再看');
}
console.log(`\n${bold(`✔ claude-pro ${version} 已发布`)}`);
