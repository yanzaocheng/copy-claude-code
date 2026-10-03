// Glob and Grep tools. Grep uses ripgrep when available and falls back to a JS scanner.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolvePath, displayPath } from '../utils/paths.js';
import { hasRipgrep } from '../utils/shell.js';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'dist-newstyle']);

export const GlobTool = {
  name: 'Glob',
  readOnly: true,
  description: `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time (most recent first)
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Task tool instead
- You can call multiple tools in a single response. It is always better to speculatively perform multiple searches in parallel if they are potentially useful.`,
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
      for await (const f of fs.promises.glob(pattern, { cwd: base, exclude })) {
        if (ctx.signal?.aborted) break;
        const abs = path.resolve(base, f);
        try {
          const st = fs.statSync(abs);
          if (st.isFile()) files.push({ abs, mtime: st.mtimeMs });
        } catch { /* vanished */ }
        if (files.length >= 20_000) break;
      }
    } catch (e) {
      return { isError: true, content: `Glob failed: ${e.message}` };
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const limit = 100;
    const shown = files.slice(0, limit).map((f) => f.abs);
    let content = shown.length ? shown.join('\n') : 'No files found';
    if (files.length > limit) content += `\n(Results are truncated: showing ${limit} of ${files.length}. Consider using a more specific path or pattern.)`;
    return { content, display: { summary: `Found ${files.length} file${files.length === 1 ? '' : 's'} in ${Date.now() - start}ms` } };
  },
};

const TYPE_EXT = {
  js: ['js', 'jsx', 'mjs', 'cjs'], ts: ['ts', 'tsx', 'mts', 'cts'], py: ['py', 'pyi'], rust: ['rs'], go: ['go'],
  java: ['java'], c: ['c', 'h'], cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'h'], cs: ['cs'], rb: ['rb'], php: ['php'],
  swift: ['swift'], kotlin: ['kt', 'kts'], css: ['css', 'scss', 'less'], html: ['html', 'htm'], json: ['json'],
  md: ['md', 'markdown'], yaml: ['yaml', 'yml'], sh: ['sh', 'bash'], sql: ['sql'], vue: ['vue'], xml: ['xml'], toml: ['toml'],
};

function runRg(args, cwd, signal) {
  return new Promise((resolve) => {
    const child = spawn('rg', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { if (out.length < 20_000_000) out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code) => { signal?.removeEventListener('abort', onAbort); resolve({ code, out, err }); });
    child.on('error', (e) => resolve({ code: 2, out: '', err: e.message }));
  });
}

// JS fallback when ripgrep isn't installed.
async function jsGrep(input, base, mode) {
  let flags = input['-i'] ? 'i' : '';
  if (input.multiline) flags += 's';
  const re = new RegExp(input.pattern, flags + 'g');
  const exts = input.type ? TYPE_EXT[input.type] : null;
  const results = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name)) walk(abs); continue; }
      if (!e.isFile()) continue;
      if (exts && !exts.includes(path.extname(e.name).slice(1))) continue;
      if (input.glob) {
        const rel = path.relative(base, abs).replace(/\\/g, '/');
        const globs = input.glob.split(/[ ,]+(?![^{]*})/).filter(Boolean);
        if (!globs.some((g) => path.matchesGlob(g.includes('/') ? rel : e.name, g))) continue;
      }
      results.push(abs);
    }
  };
  const st = fs.statSync(base);
  if (st.isFile()) results.push(base); else walk(base);
  const out = [];
  const before = input['-B'] ?? input['-C'] ?? 0, after = input['-A'] ?? input['-C'] ?? 0;
  for (const file of results) {
    let text;
    try {
      const buf = fs.readFileSync(file);
      if (buf.subarray(0, 8000).includes(0)) continue;
      text = buf.toString('utf8');
    } catch { continue; }
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    if (mode === 'files_with_matches') { out.push(file); continue; }
    const lines = text.split(/\r?\n/);
    const lineRe = new RegExp(input.pattern, flags);
    const hits = lines.map((l, i) => (lineRe.test(l) ? i : -1)).filter((i) => i >= 0);
    if (mode === 'count') { out.push(`${file}:${hits.length}`); continue; }
    const shown = new Set();
    for (const h of hits) for (let i = Math.max(0, h - before); i <= Math.min(lines.length - 1, h + after); i++) shown.add(i);
    for (const i of [...shown].sort((a, b) => a - b)) {
      const sep = hits.includes(i) ? ':' : '-';
      out.push(`${file}${sep}${input['-n'] === false ? '' : `${i + 1}${sep}`}${lines[i]}`);
    }
  }
  return out;
}

export const GrepTool = {
  name: 'Grep',
  readOnly: true,
  description: `A powerful search tool built on ripgrep

Usage:
- ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
- Use Task tool for open-ended searches requiring multiple rounds
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
      head_limit: { type: 'number', description: 'Limit output to first N lines/entries. Defaults to 250; pass 0 for unlimited.' },
      offset: { type: 'number', description: 'Skip first N lines/entries before applying head_limit.' },
      multiline: { type: 'boolean', description: 'Enable multiline mode where . matches newlines and patterns can span lines. Default: false.' },
    },
    required: ['pattern'],
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
    let lines;
    if (hasRipgrep()) {
      const args = ['--no-config', '--hidden', '--glob', '!.git', '--max-columns', '500', '--max-columns-preview', '--color', 'never'];
      if (input['-i']) args.push('-i');
      if (input.multiline) args.push('-U', '--multiline-dotall');
      if (input.type) args.push('--type', input.type);
      if (input.glob) for (const g of input.glob.split(/[ ,]+(?![^{]*})/).filter(Boolean)) args.push('--glob', g);
      if (mode === 'files_with_matches') args.push('-l');
      else if (mode === 'count') args.push('-c');
      else {
        if (input['-n'] !== false) args.push('-n');
        if (input['-C'] != null) args.push('-C', String(input['-C']));
        if (input['-A'] != null) args.push('-A', String(input['-A']));
        if (input['-B'] != null) args.push('-B', String(input['-B']));
      }
      args.push('-e', input.pattern, '--', base);
      const r = await runRg(args, ctx.cwd, ctx.signal);
      if (r.code === 2 && !r.out) return { isError: true, content: `ripgrep error: ${r.err.trim()}` };
      lines = r.out.split(/\r?\n/).filter(Boolean);
    } else {
      try { lines = await jsGrep(input, base, mode); } catch (e) { return { isError: true, content: `Grep failed: ${e.message}` }; }
    }
    if (mode === 'files_with_matches') {
      lines = lines.map((f) => ({ f, t: (() => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })() }))
        .sort((a, b) => b.t - a.t).map((x) => x.f);
    }
    const total = lines.length;
    const offset = Math.max(0, input.offset || 0);
    const limit = input.head_limit === 0 ? Infinity : (input.head_limit || 250);
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
    return { content, display: { summary } };
  },
};
