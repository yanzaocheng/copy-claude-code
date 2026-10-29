// Glob and Grep tools. Grep uses ripgrep when available and otherwise a JS scanner that follows
// ripgrep's rules: .gitignore files are honoured, --glob overrides win (last match, "!" excludes),
// ^ and $ anchor at line boundaries, hidden files are searched and binary files are skipped.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolvePath, displayPath } from '../utils/paths.js';
import { ripgrepPath } from '../utils/shell.js';
import { decodeText as decodeFile } from '../utils/encoding.js';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'dist-newstyle']);

export const GlobTool = {
  name: 'Glob',
  readOnly: true,
  description: `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time (most recent first)
- Use this tool when you need to find files by name patterns`,
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The glob pattern to match files against' },
      path: { type: 'string', description: 'The directory to search in. If not specified, the current working directory will be used. Omit this field to use the default directory; do not pass "undefined" or "null".' },
    },
    required: ['pattern'],
  },
  summarize(input, ctx) {
    return input.path ? `pattern: "${input.pattern}", path: "${displayPath(resolvePath(input.path, ctx.cwd), ctx.cwd)}"` : `pattern: "${input.pattern}"`;
  },
  async call(input, ctx) {
    const base = resolvePath(input.path && input.path !== 'undefined' && input.path !== 'null' ? input.path : ctx.cwd, ctx.cwd);
    if (!fs.existsSync(base)) return { isError: true, content: `Directory does not exist: ${base}` };
    let pattern = String(input.pattern || '').replace(/\\/g, '/');
    // Absolute patterns inside the base dir become relative.
    if (path.isAbsolute(pattern)) {
      const rel = path.relative(base, pattern).replace(/\\/g, '/');
      if (!rel.startsWith('..')) pattern = rel;
    }
    const explicit = [...IGNORED_DIRS].filter((d) => pattern.includes(d));
    const exclude = (p) => {
      const name = path.basename(p);
      return IGNORED_DIRS.has(name) && !explicit.includes(name);
    };
    const files = [];
    const start = Date.now();
    try {
      for (const abs of await globFiles(base, pattern, { skip: exclude, signal: ctx.signal, max: 20_000 })) {
        try { files.push({ abs, mtime: fs.statSync(abs).mtimeMs }); } catch { /* vanished */ }
      }
    } catch (e) {
      return { isError: true, content: `Glob failed: ${e.message}` };
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const limit = 1000;
    const shown = files.slice(0, limit).map((f) => f.abs);
    let content = shown.length ? shown.join('\n') : 'No files found';
    if (files.length > limit) content += `\n(Results are truncated: showing ${limit} of ${files.length}. Consider using a more specific path or pattern.)`;
    return { content, display: { summary: `Found ${files.length} file${files.length === 1 ? '' : 's'} in ${Date.now() - start}ms` } };
  },
};

// The files under `base` that `pattern` matches, as fs.glob finds them (in any case on Windows) but with dotfiles and
// dot directories too: fs.glob leaves those out of * and ** and has no option for them, so "**/*.yml" missed
// .github/workflows/ci.yml, which Grep (searching hidden files) found. `skip(name)`: a directory not to go into. The
// walk starts at the pattern's fixed leading directories, and goes no deeper than its segments without a "**". A
// linked directory is not entered (it can make a loop).
async function globFiles(base, pattern, { skip, signal, max }) {
  const parts = pattern.replace(/^(?:\.\/)+/, '').split('/');
  const fixed = [];
  while (parts.length > 1 && !/[*?[\]{}]/.test(parts[0])) fixed.push(parts.shift());
  const rest = parts.join('/');
  const re = globToRegExp(rest, process.platform === 'win32');
  const maxDepth = /\*\*|[{}]/.test(rest) ? Infinity : parts.length;
  const found = [];
  const walk = async (dir, rel, depth) => {
    if (signal?.aborted || found.length >= max) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.length >= max) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      let isFile = e.isFile();
      if (e.isSymbolicLink()) { try { isFile = (await fs.promises.stat(abs)).isFile(); } catch { /* a broken link */ } }
      if (isFile) { if (re.test(r)) found.push(abs); }
      else if (e.isDirectory() && depth < maxDepth && !skip(e.name)) await walk(abs, r, depth + 1);
    }
  };
  await walk(path.join(base, ...fixed), '', 1);
  return found;
}

// rg --type names (plus a few aliases) → file extensions, for the JS scanner.
const TYPE_EXT = {
  js: ['js', 'jsx', 'mjs', 'cjs'], ts: ['ts', 'tsx', 'mts', 'cts'], py: ['py', 'pyi'], rust: ['rs'], go: ['go'],
  java: ['java'], c: ['c', 'h'], cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'h'], cs: ['cs'], csharp: ['cs'], rb: ['rb'], ruby: ['rb'],
  php: ['php'], swift: ['swift'], kotlin: ['kt', 'kts'], css: ['css', 'scss', 'less'], html: ['html', 'htm'], json: ['json'],
  md: ['md', 'markdown'], markdown: ['md', 'markdown'], yaml: ['yaml', 'yml'], sh: ['sh', 'bash'], sql: ['sql'], vue: ['vue'],
  xml: ['xml'], toml: ['toml'], txt: ['txt'], lua: ['lua'], dart: ['dart'], scala: ['scala', 'sc'], svelte: ['svelte'],
  ps: ['ps1', 'psm1', 'psd1'], bat: ['bat', 'cmd'],
};

const MAX_COLUMNS = 500; // same as the rg flags below: --max-columns 500 --max-columns-preview
const MAX_FILE_BYTES = 20 * 1024 * 1024; // the JS scanner reads whole files, so huge ones are skipped
const CONCURRENCY = 16;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Compile a gitignore/ripgrep glob: `*` and `?` stay inside one path segment, a whole `**`
// segment spans directories, `{a,b}` and `[...]` work, and dotfiles are not special.
export function globToRegExp(glob, ignoreCase = false) {
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      const segmentStart = i === 0 || glob[i - 1] === '/';
      if (segmentStart && glob[i + 1] === '*' && (i + 2 === glob.length || glob[i + 2] === '/')) {
        if (i + 2 === glob.length) { re += '.*'; i += 1; } else { re += '(?:.*/)?'; i += 2; }
      } else {
        while (glob[i + 1] === '*') i++;
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '[') {
      let j = i + 1;
      const negate = glob[j] === '!' || glob[j] === '^';
      if (negate) j++;
      const bodyStart = j;
      if (glob[j] === ']') j++;
      while (j < glob.length && glob[j] !== ']') j++;
      if (j >= glob.length) { re += '\\['; continue; }
      const body = glob.slice(bodyStart, j).replace(/[\\\][^]/g, '\\$&');
      re += negate ? `[^/${body}]` : `[${body}]`;
      i = j;
    } else if (ch === '{') {
      braces++;
      re += '(?:';
    } else if (ch === '}' && braces) {
      braces--;
      re += ')';
    } else if (ch === ',' && braces) {
      re += '|';
    } else if (ch === '\\' && i + 1 < glob.length) {
      re += escapeRegExp(glob[++i]);
    } else {
      re += escapeRegExp(ch);
    }
  }
  if (braces) throw new Error(`unclosed alternate group in glob: ${glob}`);
  return new RegExp(`^${re}$`, ignoreCase ? 'i' : '');
}

// A .gitignore line or a --glob override. "!" flips it, a trailing "/" limits it to directories,
// and any other "/" anchors it to its base directory instead of matching basenames at any depth.
function parseRule(text, ignoreCase = false) {
  let pattern = text;
  const negate = pattern.startsWith('!');
  if (negate) pattern = pattern.slice(1);
  else if (pattern.startsWith('\\!') || pattern.startsWith('\\#')) pattern = pattern.slice(1);
  const dirOnly = pattern.endsWith('/');
  pattern = pattern.replace(/\/+$/, '');
  const anchored = pattern.includes('/');
  pattern = pattern.replace(/^(?:\.\/|\/)/, '');
  if (!pattern) return null;
  return { source: text, negate, dirOnly, anchored, re: globToRegExp(pattern, ignoreCase) };
}

// The last matching rule decides, as in .gitignore files and rg --glob.
function lastRule(rules, rel, name, isDir) {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if ((!r.dirOnly || isDir) && r.re.test(r.anchored ? rel : name)) return r;
  }
  return null;
}

// "*.js,*.ts" or "*.js *.ts" are two globs; commas inside {...} are not separators.
function splitGlobs(glob) {
  if (!glob) return [];
  const globs = String(glob).split(/[ ,]+(?![^{]*})/).filter(Boolean);
  return process.platform === 'win32' ? globs.map((g) => g.replace(/\\/g, '/')) : globs;
}

const IGNORE_FILES = ['.gitignore', '.ignore', '.rgignore']; // lowest precedence first

async function readIgnoreFile(dir, name) {
  let text;
  try { text = await fs.promises.readFile(path.join(dir, name), 'utf8'); } catch { return null; }
  const ignoreCase = name === '.gitignore' && process.platform === 'win32'; // git for Windows defaults to core.ignorecase
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    try {
      const rule = parseRule(line, ignoreCase);
      if (rule) rules.push(rule);
    } catch { /* git skips patterns it cannot parse */ }
  }
  return rules.length ? { dir, rules } : null;
}

// Ignore files of one directory, lowest precedence first. Like ripgrep, .gitignore only counts
// inside a git work tree; .ignore and .rgignore always count.
async function ignoreScopes(dir, inRepo) {
  const names = IGNORE_FILES.filter((n) => inRepo || n !== '.gitignore');
  return (await Promise.all(names.map((n) => readIgnoreFile(dir, n)))).filter(Boolean);
}

// Ignore files above the search root apply too, up to the top of the git work tree.
async function ancestorScopes(base) {
  const above = [];
  for (let d = base; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) {
      const scopes = [];
      for (const dir of above.reverse()) scopes.push(...await ignoreScopes(dir, true));
      return { inRepo: true, scopes };
    }
    const parent = path.dirname(d);
    if (parent === d) return { inRepo: false, scopes: [] };
    above.push(parent);
  }
}

// Deeper .gitignore files take precedence over the ones above them.
function isIgnored(scopes, abs, name, isDir) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const rule = lastRule(scopes[i].rules, path.relative(scopes[i].dir, abs).replace(/\\/g, '/'), name, isDir);
    if (rule) return !rule.negate;
  }
  return false;
}

async function collectFiles(base, globs, exts, signal) {
  if (!(await fs.promises.stat(base)).isDirectory()) return [base];
  const overrides = globs.map((g) => parseRule(g)).filter(Boolean);
  const whitelist = overrides.some((r) => !r.negate);
  // A directory that is skipped by default (node_modules, ...) is searched when a glob names it.
  const named = new Set([...IGNORED_DIRS].filter((d) => d !== '.git' && overrides.some((r) => !r.negate && r.source.includes(d))));
  const files = [];
  const walk = async (dir, scopes, inRepo) => {
    if (signal?.aborted) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    inRepo ||= entries.some((e) => e.name === '.git');
    if (entries.some((e) => IGNORE_FILES.includes(e.name))) scopes = [...scopes, ...await ignoreScopes(dir, inRepo)];
    for (const e of entries) {
      const isDir = e.isDirectory();
      if ((!isDir && !e.isFile()) || e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      const override = lastRule(overrides, path.relative(base, abs).replace(/\\/g, '/'), e.name, isDir);
      if (override?.negate) continue;
      if (isDir) {
        const skip = !override && !named.has(e.name) && (IGNORED_DIRS.has(e.name) || isIgnored(scopes, abs, e.name, true));
        if (!skip) await walk(abs, scopes, inRepo);
      } else if (override || (!whitelist && !isIgnored(scopes, abs, e.name, false))) {
        if (!exts || exts.includes(path.extname(e.name).slice(1).toLowerCase())) files.push(abs);
      }
    }
  };
  const above = await ancestorScopes(base);
  await walk(base, above.scopes, above.inRepo);
  return files;
}

// Text of a file, or null for binary files: UTF-16 with a BOM as ripgrep does it, and GBK files as Read shows them
// (so that a Chinese word is found in them too).
const decodeText = (buf) => decodeFile(buf, { writable: false })?.text ?? null;

const clip = (line) => (line.length > MAX_COLUMNS ? `${line.slice(0, MAX_COLUMNS)} [... omitted end of long line]` : line);

function runRg(bin, args, cwd, signal) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    // Decoded as a stream (a Chinese path or line can be split between two chunks), and rg is stopped once
    // there is more than will ever be shown instead of scanning on.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (out.length >= 20_000_000) return;
      out += d;
      if (out.length >= 20_000_000) { out = out.slice(0, out.lastIndexOf('\n') + 1); child.kill(); }
    });
    child.stderr.on('data', (d) => { if (err.length < 100_000) err += d; });
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code) => { signal?.removeEventListener('abort', onAbort); resolve({ code, out, err }); });
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); resolve({ code: 2, out: '', err: e.message, spawnError: true }); });
  });
}

// ripgrep takes inline flags at the start of a pattern, `(?i)` or `(?is)`; a JS RegExp does not, so they become
// flags. `m` is dropped: ^ and $ are line anchors here anyway, as in ripgrep.
export function inlineFlags(pattern) {
  const m = /^\(\?([ims]+)\)/.exec(pattern);
  return m ? { pattern: pattern.slice(m[0].length), i: m[1].includes('i'), s: m[1].includes('s') } : { pattern, i: false, s: false };
}

// JS scanner used when ripgrep isn't available. Returns output lines in rg's format.
async function jsGrep(input, base, mode, signal) {
  const exts = input.type ? TYPE_EXT[String(input.type).toLowerCase()] : null;
  if (input.type && !exts) throw new Error(`unrecognized file type: ${input.type} (known types: ${Object.keys(TYPE_EXT).join(', ')})`);
  const inline = inlineFlags(input.pattern);
  const flags = input['-i'] || inline.i ? 'i' : '';
  const dotAll = input.multiline || inline.s ? 's' : '';
  // ripgrep treats ^ and $ as line anchors, so whole-file matching needs the m flag.
  const anyRe = new RegExp(inline.pattern, `${flags}m${dotAll}`);
  const allRe = new RegExp(inline.pattern, `${flags}gm${dotAll}`);
  const lineRe = new RegExp(inline.pattern, flags);
  const content = mode === 'content';
  const before = content ? Math.max(0, Number(input['-B'] ?? input['-C'] ?? 0) || 0) : 0;
  const after = content ? Math.max(0, Number(input['-A'] ?? input['-C'] ?? 0) || 0) : 0;
  const files = await collectFiles(base, splitGlobs(input.glob), exts, signal);
  let skipped = 0;

  const searchFile = async (file) => {
    let text;
    try {
      if ((await fs.promises.stat(file)).size > MAX_FILE_BYTES) { skipped++; return null; }
      text = decodeText(await fs.promises.readFile(file));
    } catch { return null; }
    if (text === null) return null;
    if (text.includes('\r')) text = text.replace(/\r\n/g, '\n');
    // Cheap whole-file check first; it can only over-match, so lines are checked below.
    if (!anyRe.test(text)) return null;
    const lines = text.split('\n');
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    let hits;
    if (input.multiline) {
      const starts = [0];
      for (let i = text.indexOf('\n'); i !== -1 && i + 1 < text.length; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
      const lineAt = (pos) => {
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
        }
        return lo;
      };
      const set = new Set();
      for (const m of text.matchAll(allRe)) {
        const last = lineAt(m.index + Math.max(0, m[0].length - 1));
        for (let i = lineAt(m.index); i <= last; i++) set.add(i);
      }
      hits = [...set];
    } else {
      hits = [];
      for (let i = 0; i < lines.length; i++) if (lineRe.test(lines[i])) hits.push(i);
    }
    if (!hits.length) return null;
    if (mode === 'files_with_matches') return [file];
    if (mode === 'count') return [`${file}:${hits.length}`];
    const isHit = new Set(hits);
    const out = [];
    let end = -1;
    for (const h of hits) {
      const from = Math.max(0, h - before, end + 1);
      const to = Math.min(lines.length - 1, h + after);
      if ((before || after) && out.length && from > end + 1) out.push('--');
      for (let i = from; i <= to; i++) {
        const sep = isHit.has(i) ? ':' : '-';
        out.push(`${file}${sep}${input['-n'] === false ? '' : `${i + 1}${sep}`}${clip(lines[i])}`);
      }
      end = Math.max(end, to);
    }
    return out;
  };

  const results = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length && !signal?.aborted) {
      const i = next++;
      results[i] = await searchFile(files[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  const lines = [];
  for (const r of results) {
    if (!r) continue;
    if ((before || after) && lines.length) lines.push('--');
    for (const l of r) lines.push(l);
  }
  return { lines, skipped };
}

export const GrepTool = {
  name: 'Grep',
  readOnly: true,
  description: `A powerful search tool built on ripgrep

Usage:
- Use this tool to search file contents rather than \`grep\` or \`rg\` through Bash (rg may not be installed on the machine).
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\``,
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regular expression pattern to search for in file contents' },
      path: { type: 'string', description: 'File or directory to search in. Defaults to current working directory.' },
      glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Output mode. Defaults to "files_with_matches".' },
      '-B': { type: 'number', description: 'Lines to show before each match. Requires output_mode "content".' },
      '-A': { type: 'number', description: 'Lines to show after each match. Requires output_mode "content".' },
      '-C': { type: 'number', description: 'Lines to show before and after each match. Requires output_mode "content".' },
      '-n': { type: 'boolean', description: 'Show line numbers in output. Requires output_mode "content". Defaults to true.' },
      '-i': { type: 'boolean', description: 'Case insensitive search' },
      type: { type: 'string', description: 'File type to search (rg --type). Common types: js, py, rust, go, java, etc.' },
      head_limit: { type: 'number', description: 'Limit output to first N lines/entries. Defaults to 1000; pass 0 for unlimited.' },
      offset: { type: 'number', description: 'Skip first N lines/entries before applying head_limit.' },
      multiline: { type: 'boolean', description: 'Enable multiline mode where . matches newlines and patterns can span lines. Default: false.' },
    },
    required: ['pattern'],
  },
  // What a model used to grep (or to the Read tool) sometimes sends, taken as meant, as Claude Code does, instead of
  // searching the working directory when it named a file_path: -l and -c pick the output mode, -r is the default.
  normalizeInput(input) {
    if (input.path == null && typeof input.file_path === 'string') input.path = input.file_path;
    if (input.output_mode == null && input['-c']) input.output_mode = 'count';
    else if (input.output_mode == null && input['-l']) input.output_mode = 'files_with_matches';
    return input;
  },
  summarize(input, ctx) {
    let s = `pattern: "${input.pattern}"`;
    if (input.path) s += `, path: "${displayPath(resolvePath(input.path, ctx.cwd), ctx.cwd)}"`;
    if (input.glob) s += `, glob: "${input.glob}"`;
    if (input.type) s += `, type: "${input.type}"`;
    if (input.output_mode && input.output_mode !== 'files_with_matches') s += `, output_mode: "${input.output_mode}"`;
    return s;
  },
  async call(input, ctx) {
    const base = resolvePath(input.path || ctx.cwd, ctx.cwd);
    if (!fs.existsSync(base)) return { isError: true, content: `Path does not exist: ${base}` };
    const mode = input.output_mode || 'files_with_matches';
    let lines = null;
    let note = '';
    const rg = ripgrepPath(ctx.config);
    if (rg) {
      // --crlf lets `$` match before \r\n, so line-end anchors also work in Windows (CRLF) files.
      const args = ['--no-config', '--hidden', '--crlf', '--glob', '!.git', '--max-columns', String(MAX_COLUMNS), '--max-columns-preview', '--color', 'never'];
      if (input['-i']) args.push('-i');
      if (input.multiline) args.push('-U', '--multiline-dotall');
      if (input.type) args.push('--type', input.type);
      for (const g of splitGlobs(input.glob)) args.push('--glob', g);
      if (mode === 'files_with_matches') args.push('-l');
      else if (mode === 'count') args.push('-c');
      else {
        if (input['-n'] !== false) args.push('-n');
        if (input['-C'] != null) args.push('-C', String(input['-C']));
        if (input['-A'] != null) args.push('-A', String(input['-A']));
        if (input['-B'] != null) args.push('-B', String(input['-B']));
      }
      args.push('-e', input.pattern, '--', base);
      const r = await runRg(rg, args, ctx.cwd, ctx.signal);
      if (!r.spawnError) {
        if (r.code === 2 && !r.out) return { isError: true, content: `ripgrep error: ${r.err.trim()}` };
        lines = r.out.split(/\r?\n/).filter(Boolean);
      }
    }
    if (!lines) {
      try {
        const found = await jsGrep(input, base, mode, ctx.signal);
        lines = found.lines;
        if (found.skipped) note = `\n\n(${found.skipped} file${found.skipped === 1 ? '' : 's'} larger than ${MAX_FILE_BYTES / 1024 / 1024}MB not searched; install ripgrep to search them)`;
      } catch (e) {
        return { isError: true, content: `Grep failed: ${e.message}` };
      }
    }
    if (mode === 'files_with_matches') {
      lines = lines.map((f) => ({ f, t: (() => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })() }))
        .sort((a, b) => b.t - a.t).map((x) => x.f);
    }
    const total = lines.length;
    const offset = Math.max(0, input.offset || 0);
    const limit = input.head_limit === 0 ? Infinity : (input.head_limit || 1000);
    const page = lines.slice(offset, offset + limit);
    let content;
    let summary;
    if (mode === 'files_with_matches') {
      content = total ? `Found ${total} file${total === 1 ? '' : 's'}\n${page.join('\n')}` : 'No files found';
      summary = `Found ${total} file${total === 1 ? '' : 's'}`;
    } else if (mode === 'count') {
      const sum = lines.reduce((n, l) => n + (parseInt(l.split(':').pop(), 10) || 0), 0);
      content = total ? page.join('\n') + `\n\nFound ${sum} total occurrences across ${total} files.` : 'No matches found';
      summary = `Found ${sum} match${sum === 1 ? '' : 'es'} in ${total} file${total === 1 ? '' : 's'}`;
    } else {
      content = total ? page.join('\n') : 'No matches found';
      summary = `Found ${total} line${total === 1 ? '' : 's'}`;
    }
    if (total > offset + page.length) content += `\n\n(Showing ${page.length} of ${total} results. Use offset/head_limit to page, or narrow the search.)`;
    return { content: content + note, display: { summary } };
  },
};
