// REPL: runs code in a Python or Node.js process that stays alive for the session, so that imports, variables and
// loaded data are there for the next call. The model loads a log or a JSON file once and asks it questions in small
// steps, and only what the code prints comes back: no quoting through Bash, no reloading for every question.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { killTree, killTreeSync } from '../utils/shell.js';
import { OutputDecoder } from '../utils/encoding.js';
import { stripAnsi } from '../ui/ansi.js';
import { childEnv, truncateOutput, saveFullOutput } from './bash.js';

export const replLimits = { defaultTimeoutMs: 120_000, maxTimeoutMs: 600_000, outputChars: 20_000 };
// A run's output kept in memory: past OUTPUT_MAX characters only the newest OUTPUT_KEEP stay, as in Bash.
const OUTPUT_MAX = 10_000_000;
const OUTPUT_KEEP = 5_000_000;

// The driver each interpreter runs: it reads one JSON request per line on stdin ({id, code, cwd}), runs the code in
// one namespace that lives as long as the process, and after what the code printed writes a line that starts with
// the process's random token and carries {id, error}. The value of a last expression is printed, as in a notebook.
const PYTHON_DRIVER = String.raw`import sys, os, json, ast, traceback, pprint
TOKEN = sys.argv[1]
_proto_in = sys.stdin
sys.stdin = open(os.devnull)
ns = {'__name__': '__main__', '__builtins__': __builtins__}

def run(code, cwd):
    if cwd:
        try:
            os.chdir(cwd)
        except OSError:
            pass
    try:
        tree = ast.parse(code, '<cell>', 'exec')
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        exec(compile(tree, '<cell>', 'exec'), ns)
        if last is not None:
            value = eval(compile(last, '<cell>', 'eval'), ns)
            if value is not None:
                print(pprint.pformat(value, width=120, compact=True, sort_dicts=False))
        return None
    except SyntaxError as e:
        return ''.join(traceback.format_exception_only(type(e), e))
    except BaseException as e:
        return ''.join(traceback.format_exception(type(e), e, e.__traceback__.tb_next))
    finally:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass

while True:
    line = _proto_in.readline()
    if not line:
        break
    req = json.loads(line)
    error = run(req['code'], req.get('cwd'))
    sys.stdout.write('\n' + TOKEN + json.dumps({'id': req['id'], 'error': error}) + '\n')
    sys.stdout.flush()
`;

// Node: the code is evaluated as the DevTools console does it, through the process's own inspector with replMode,
// which takes top-level await and lets let, const and class be declared again in a later call (node:repl's
// evaluator never calls back for that: "Identifier has already been declared" hung the call). require() resolves
// from the working directory. Code evaluated through the inspector has no dynamic import of its own ("A dynamic
// import callback was not specified", with any flag): its import(...) calls are rewritten (rewriteDynamicImports)
// to the driver's, which resolves from the working directory too.
const NODE_DRIVER = String.raw`const inspector = require('node:inspector');
const util = require('node:util');
const path = require('node:path');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');
const { createRequire, isBuiltin } = require('node:module');
const TOKEN = process.argv[2];
function importFrom(spec, options) {
  let target = spec;
  if (typeof spec === 'string') {
    if (/^[a-zA-Z]:[\\/]/.test(spec) || /^[\\/]/.test(spec) || /^\.\.?([\\/]|$)/.test(spec)) {
      target = pathToFileURL(path.resolve(process.cwd(), spec)).href;
    } else if (!isBuiltin(spec) && !/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
      try {
        const resolved = createRequire(path.join(process.cwd(), '[repl]')).resolve(spec);
        if (path.isAbsolute(resolved)) target = pathToFileURL(resolved).href;
      } catch {}
    }
  }
  return options === undefined ? import(target) : import(target, options);
}
Object.defineProperty(globalThis, '__claudeProImport', { value: importFrom });
const session = new inspector.Session();
session.connect();
const post = (method, params) => new Promise((resolve, reject) => session.post(method, params, (e, r) => (e ? reject(e) : resolve(r))));
const show = (v) => util.inspect(v, { depth: 4, maxArrayLength: 100, maxStringLength: 10000, breakLength: 120 });
Object.defineProperty(globalThis, '__claudeProShow', { value: show });
process.on('uncaughtException', (e) => process.stderr.write('Uncaught ' + ((e && e.stack) || e) + '\n'));
process.on('unhandledRejection', (e) => process.stderr.write('Unhandled rejection ' + ((e && e.stack) || e) + '\n'));
async function evaluate(code) {
  const r = await post('Runtime.evaluate', { expression: code, replMode: true, awaitPromise: true, objectGroup: 'cell' });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception;
    const text = (ex && (ex.description || String(ex.value))) || r.exceptionDetails.text || 'Error';
    // the stack down to the code's own frames: the rest is this driver and the inspector
    const lines = String(text).split('\n');
    const cut = lines.findIndex((l, i) => i > 0 && /node:inspector|claude-pro-repl-node/.test(l));
    return (cut > 0 ? lines.slice(0, cut) : lines).join('\n');
  }
  const v = r.result;
  if (v.type === 'undefined') return null;
  if (v.objectId) {
    const s = await post('Runtime.callFunctionOn', { objectId: v.objectId, functionDeclaration: 'function() { return globalThis.__claudeProShow(this); }', returnByValue: true });
    process.stdout.write(s.result.value + '\n');
  } else {
    process.stdout.write((v.unserializableValue !== undefined ? v.unserializableValue : show(v.value)) + '\n');
  }
  await post('Runtime.releaseObjectGroup', { objectGroup: 'cell' });
  return null;
}
const queue = [];
let busy = false;
readline.createInterface({ input: process.stdin }).on('line', (line) => { queue.push(JSON.parse(line)); next(); });
async function next() {
  if (busy || !queue.length) return;
  busy = true;
  const req = queue.shift();
  if (req.cwd) { try { process.chdir(req.cwd); } catch {} }
  globalThis.require = createRequire(path.join(process.cwd(), '[repl]'));
  let error = null;
  try { error = await evaluate(req.code); } catch (e) { error = String((e && e.stack) || e); }
  process.stdout.write('\n' + TOKEN + JSON.stringify({ id: req.id, error }) + '\n', () => { busy = false; next(); });
}
`;

// The code's dynamic import(...) calls, made calls of the Node driver's importFrom. Strings, template literals and
// comments are left alone; import.meta and a method named import are not calls of import().
export function rewriteDynamicImports(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    let end = -1;
    if (ch === '/' && code[i + 1] === '/') { end = code.indexOf('\n', i); if (end < 0) end = n; }
    else if (ch === '/' && code[i + 1] === '*') { end = code.indexOf('*/', i + 2); end = end < 0 ? n : end + 2; }
    else if (ch === '"' || ch === "'") {
      end = i + 1;
      while (end < n && code[end] !== ch && code[end] !== '\n') end += code[end] === '\\' ? 2 : 1;
      end = Math.min(n, end + 1);
    } else if (ch === '`') {
      end = i + 1;
      let depth = 0;
      while (end < n && (depth > 0 || code[end] !== '`')) {
        if (code[end] === '\\') { end += 2; continue; }
        if (code[end] === '$' && code[end + 1] === '{') { depth++; end += 2; continue; }
        if (depth > 0 && code[end] === '}') depth--;
        end++;
      }
      end = Math.min(n, end + 1);
    }
    if (end > i) { out += code.slice(i, end); i = end; continue; }
    if (ch === 'i' && code.startsWith('import', i) && !/[\w$.]/.test(code[i - 1] || '')) {
      let j = i + 6;
      while (j < n && /\s/.test(code[j])) j++;
      if (code[j] === '(') { out += '__claudeProImport('; i = j + 1; continue; }
    }
    out += ch;
    i++;
  }
  return out;
}

const LANGUAGES = {
  python: { label: 'Python', driver: PYTHON_DRIVER, ext: 'py' },
  node: { label: 'Node.js', driver: NODE_DRIVER, ext: 'cjs' },
};

// The driver as a file (named by its content, so that two versions of claude-pro do not overwrite each other's).
function driverFile(lang) {
  const { driver, ext } = LANGUAGES[lang];
  const hash = crypto.createHash('sha256').update(driver).digest('hex').slice(0, 12);
  const file = path.join(os.tmpdir(), `claude-pro-repl-${lang}-${hash}.${ext}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, driver);
  return file;
}

function pythonCommand(env) {
  const configured = String(env?.CLAUDE_PRO_PYTHON ?? process.env.CLAUDE_PRO_PYTHON ?? '').trim();
  if (configured) return configured;
  return process.platform === 'win32' ? 'python' : 'python3';
}

class Interpreter {
  constructor(lang, { cwd, env }) {
    this.lang = lang;
    this.token = `@@claude-pro-repl-${crypto.randomBytes(8).toString('hex')}@@`;
    this.clearOutput();
    this.waiting = null; // {resolve, id}
    this.nextId = 1;
    this.queue = Promise.resolve();
    this.exited = null;
    this.dead = false; // stopped by a timeout or an interrupt: never used again, whether or not it has exited yet
    const file = driverFile(lang);
    const cmd = lang === 'python' ? pythonCommand(env) : process.execPath;
    const args = lang === 'python' ? ['-u', file, this.token] : [file, this.token];
    const childEnvironment = { ...childEnv(), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' };
    this.child = spawn(cmd, args, { cwd, env: childEnvironment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.started = new Promise((resolve) => {
      this.child.once('spawn', () => resolve(null));
      this.child.once('error', (e) => resolve(e));
    });
    const out = new OutputDecoder();
    const err = new OutputDecoder();
    this.child.stdout.on('data', (c) => this.onStdout(out.write(c)));
    this.child.stderr.on('data', (c) => {
      this.stderr += err.write(c);
      if (this.stderr.length > OUTPUT_MAX) this.stderr = this.stderr.slice(-OUTPUT_KEEP);
    });
    this.child.on('close', (code, signal) => {
      this.exited = { code, signal };
      const w = this.waiting;
      this.waiting = null;
      w?.resolve({ died: true });
    });
    this.child.stdin.on('error', () => {}); // a dead interpreter: reported by 'close'
  }

  clearOutput() {
    this.stdout = '';
    this.stderr = '';
    this.carry = ''; // the end of stdout so far, the token's length less one: a token split between two chunks
    this.tokenAt = -1; // where the token is in stdout, once it came
    this.endAt = -1; // where the line after it ends
    this.droppedHead = false; // the start of the output was not kept (OUTPUT_MAX)
  }

  // What the code prints, then the end of the run: the token and a line of JSON. Each chunk is looked at once, with
  // the end of the one before it, and stdout itself is not touched until the run is over: searching all of it again
  // for every chunk was quadratic (160 MB of output took over a minute, with the program frozen).
  onStdout(text) {
    if (!text) return;
    const start = this.stdout.length; // where `text` goes in stdout
    this.stdout += text;
    if (this.tokenAt < 0) {
      const win = this.carry + text;
      const at = win.indexOf(this.token);
      if (at >= 0) this.tokenAt = start - this.carry.length + at;
      else {
        this.carry = win.slice(-(this.token.length - 1));
        if (this.stdout.length > OUTPUT_MAX) { this.stdout = this.stdout.slice(-OUTPUT_KEEP); this.droppedHead = true; }
        return;
      }
    }
    if (this.endAt < 0) { // the JSON line after the token has no newline of its own
      const nl = text.indexOf('\n', Math.max(0, this.tokenAt + this.token.length - start));
      if (nl >= 0) this.endAt = start + nl;
    }
    this.check();
  }

  check() {
    const w = this.waiting;
    if (!w || this.endAt < 0) return;
    const all = this.stdout;
    let meta = {};
    try { meta = JSON.parse(all.slice(this.tokenAt + this.token.length, this.endAt)); } catch { /* reported as no error */ }
    const output = all.slice(0, this.tokenAt).replace(/\n$/, '');
    const droppedHead = this.droppedHead;
    this.stdout = '';
    this.carry = '';
    this.tokenAt = -1;
    this.endAt = -1;
    this.waiting = null;
    // stderr comes on its own pipe: what the code wrote there before it finished arrives a moment later at most
    setTimeout(() => w.resolve({ output, error: meta.error || null, droppedHead }), 30);
  }

  get alive() { return !this.dead && !this.exited && this.child.exitCode === null; }

  // Stop the run in progress for good: the call returns now, and the process is killed behind it (with its
  // children; plain TerminateProcess when that did not work).
  stop() {
    this.dead = true;
    const w = this.waiting;
    this.waiting = null;
    w?.resolve({ died: true });
    killTree(this.child).then(() => { if (this.child.exitCode === null) { try { this.child.kill('SIGKILL'); } catch { /* gone */ } } });
  }

  // One run at a time (the main agent and sub-agents share an interpreter).
  run(code, opts) {
    const next = this.queue.then(() => this.runNow(code, opts));
    this.queue = next.catch(() => {});
    return next;
  }

  async runNow(code, { cwd, timeoutMs, signal }) {
    const failed = await this.started;
    if (failed) return { startError: failed };
    if (!this.alive) return { died: true };
    this.clearOutput();
    const id = this.nextId++;
    const done = new Promise((resolve) => { this.waiting = { resolve, id }; });
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => { timedOut = true; this.stop(); }, timeoutMs);
    const onAbort = () => { aborted = true; this.stop(); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      this.child.stdin.write(`${JSON.stringify({ id, code, cwd })}\n`);
      const r = await done;
      const stderr = this.stderr;
      this.stderr = '';
      if (r.died) return { died: true, timedOut, aborted, output: this.stdout, stderr, droppedHead: this.droppedHead };
      return { ...r, stderr };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  kill(sync = false) {
    this.dead = true;
    if (this.exited || this.child.exitCode !== null) return;
    if (sync) killTreeSync(this.child); else killTree(this.child);
  }
}

const interpreters = new Map(); // language -> Interpreter

export function shutdownInterpreters() {
  for (const i of interpreters.values()) i.kill(true); // the program is exiting
  interpreters.clear();
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function makeReplTool(config) {
  return {
    name: 'REPL',
    description: `Runs code in a persistent Python or Node.js process: imports, variables and loaded data stay between calls (one process per language, for the whole session; sub-agents share it). Only what the code prints comes back, and the value of a last expression, as in a notebook.

Use it to work with data: load a log, a JSON or CSV file, a database or an API response once, then ask it questions in small steps, printing only results (counts, a few matching records, a summary), instead of reading big files into the conversation or re-running a script through Bash for every question. Bash stays the tool for commands, builds and tests; Read for reading a file you need to see.

- It runs in the current working directory, with the user's own Python (CLAUDE_PRO_PYTHON picks another) or claude-pro's Node. Node takes top-level await and require(), and a later call may declare a let or const again.
- Print little: the output is cut at ${replLimits.outputChars} characters (the whole of it is saved to a file). Print with limits (df.head(), [:20], len()).
- A timeout (default ${replLimits.defaultTimeoutMs / 1000} s, timeout in ms up to ${replLimits.maxTimeoutMs / 1000} s) or an interrupt ends the process: its state is gone, and the next call starts a new one. reset: true does that on purpose.`,
    input_schema: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['python', 'node'] },
        code: { type: 'string', description: 'The code to run' },
        timeout: { type: 'number', description: `Optional timeout in milliseconds (default ${replLimits.defaultTimeoutMs}, max ${replLimits.maxTimeoutMs})` },
        reset: { type: 'boolean', description: 'Start a new process first (all variables are lost)' },
      },
      required: ['language'],
    },
    summarize(input) {
      const first = String(input.code || '').split('\n').find((l) => l.trim()) || '';
      return `${input.language === 'node' ? 'node' : 'python'}${input.reset ? ', reset' : ''}: ${first.trim().slice(0, 80)}`;
    },
    async call(input, ctx) {
      const lang = input.language === 'node' ? 'node' : input.language === 'python' ? 'python' : null;
      if (!lang) return { isError: true, content: 'language must be python or node' };
      const { label } = LANGUAGES[lang];
      const code = typeof input.code === 'string' ? input.code : '';
      let interp = interpreters.get(lang);
      const notes = [];
      if (input.reset && interp) {
        interp.kill();
        interpreters.delete(lang);
        interp = null;
        notes.push(`(a new ${label} process: the old one's variables are gone)`);
      } else if (interp && !interp.alive) {
        interpreters.delete(lang);
        interp = null;
        notes.push(`(the ${label} process had ended, so this is a new one: earlier variables are gone)`);
      }
      if (!code.trim()) {
        if (input.reset) return { content: notes.join('\n') || `Started a new ${label} process.` };
        return { isError: true, content: 'code is empty' };
      }
      const cwd = fs.existsSync(ctx.cwd) ? ctx.cwd : ctx.projectRoot;
      if (!interp) {
        interp = new Interpreter(lang, { cwd, env: ctx.config?.env });
        interpreters.set(lang, interp);
      }
      const timeoutMs = Math.min(Math.max(1000, Number(input.timeout) || replLimits.defaultTimeoutMs), replLimits.maxTimeoutMs);
      const started = Date.now();
      const r = await interp.run(lang === 'node' ? rewriteDynamicImports(code) : code, { cwd, timeoutMs, signal: ctx.signal });
      if (r.startError) {
        interpreters.delete(lang);
        const hint = lang === 'python' ? ` Is Python installed and on PATH? CLAUDE_PRO_PYTHON can name the interpreter (now: ${pythonCommand(ctx.config?.env)}).` : '';
        return { isError: true, content: `Cannot start ${label}: ${r.startError.message}.${hint}` };
      }
      if (r.aborted || ctx.signal?.aborted) {
        interpreters.delete(lang);
        throw Object.assign(new Error('aborted'), { name: 'AbortError', partialOutput: r.output });
      }
      let text = stripAnsi([r.output, r.stderr ? `[stderr]\n${r.stderr.replace(/\s+$/, '')}` : ''].filter(Boolean).join('\n')).replace(/\r\n/g, '\n').replace(/\s+$/, '');
      let isError = false;
      if (r.died) {
        interpreters.delete(lang);
        isError = true;
        const why = r.timedOut ? `timed out after ${timeoutMs / 1000} s and was stopped` : `ended (exit code ${interp.exited?.code ?? '?'})`;
        text += `${text ? '\n' : ''}The ${label} process ${why}: its variables are gone, and the next call starts a new one.`;
      } else if (r.error) {
        isError = true;
        text += `${text ? '\n' : ''}${String(r.error).replace(/\s+$/, '')}`;
      }
      if (text.length > replLimits.outputChars) {
        const saved = saveFullOutput(ctx.projectRoot, text);
        const size = text.length;
        text = truncateOutput(text, replLimits.outputChars);
        const kept = r.droppedHead ? `over ${OUTPUT_MAX.toLocaleString('en-US')} characters and has been cut${saved ? `; the last ${size} are in ${saved}` : ''}` : `${size} characters and has been cut${saved ? `; all of it is in ${saved}` : ''}`;
        text += `\n\n(The output was ${kept}. Print less: a count, the first rows, a summary.)`;
      }
      const lines = text ? text.split('\n').length : 0;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      return {
        isError,
        content: [...notes, text || '(no output)'].join('\n'),
        display: { summary: `${isError ? 'Failed' : 'Ran'} in ${secs} s${lines ? `, ${plural(lines, 'line')} of output` : ', no output'}` },
      };
    },
  };
}
