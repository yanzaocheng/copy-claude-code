// Discover a conservative project verification command when the user has not configured one.

import fs from 'node:fs';
import path from 'node:path';

function exists(cwd, name) {
  try { return fs.statSync(path.join(cwd, name)).isFile(); } catch { return false; }
}

function directoryExists(cwd, name) {
  try { return fs.statSync(path.join(cwd, name)).isDirectory(); } catch { return false; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function packageRunner(cwd) {
  if (exists(cwd, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(cwd, 'yarn.lock')) return 'yarn';
  return 'npm';
}

function meaningfulTestScript(script) {
  if (typeof script !== 'string' || !script.trim()) return false;
  // Skip npm init's placeholder because it intentionally exits with an error.
  return !/(?:error:\s*)?no test specified/i.test(script);
}

function packageCommand(cwd) {
  const pkg = readJson(path.join(cwd, 'package.json'));
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== 'object') return null;
  const runner = packageRunner(cwd);
  if (meaningfulTestScript(scripts.test)) return runner === 'npm' ? 'npm test' : `${runner} test`;
  for (const name of ['check', 'verify', 'lint']) {
    if (typeof scripts[name] === 'string' && scripts[name].trim()) return `${runner} run ${name}`;
  }
  return null;
}

function makefileCommand(cwd) {
  if (!exists(cwd, 'Makefile')) return null;
  try {
    const text = fs.readFileSync(path.join(cwd, 'Makefile'), 'utf8');
    return /^(?:\.PHONY\s+)?test\s*(?::|;)/m.test(text) ? 'make test' : null;
  } catch { return null; }
}

export function discoverVerifyCommand(cwd) {
  const root = path.resolve(cwd || process.cwd());
  return packageCommand(root)
    || (exists(root, 'pyproject.toml') && (directoryExists(root, 'tests') || directoryExists(root, 'test')) ? 'python -m pytest -q' : null)
    || (exists(root, 'Cargo.toml') ? 'cargo test' : null)
    || (exists(root, 'go.mod') ? 'go test ./...' : null)
    || makefileCommand(root);
}
