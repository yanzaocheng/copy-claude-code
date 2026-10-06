// The agent loop: send the conversation, stream the reply, run requested tools,
// feed results back, repeat until the model stops asking for tools.

import fs from 'node:fs';
import path from 'node:path';
import { streamMessage, contextTokens, isAbort } from './api.js';
import { compactPrompt, continuationMessage, PLAN_MODE_REMINDER, SUMMARY_SYSTEM } from './prompts.js';
import { toolResultsDir } from './session.js';
import { rebuildFileState } from './filestate.js';
import { CacheStats } from './cache.js';
import { resolvePath } from './utils/paths.js';

export const INTERRUPT_MESSAGE = '[Request interrupted by user]';
export const INTERRUPT_TOOL_MESSAGE = '[Request interrupted by user for tool use]';

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

// Automatic compactions that may fail in a row before it is left off for the conversation (until a /compact
// succeeds or /clear): one that cannot succeed would otherwise cost its requests again on every prompt.
const MAX_COMPACT_FAILURES = 3;

const IMAGE_TOKENS = 1600; // roughly what a 1568px image costs; its base64 is not text

export function estimateTokens(value) {
  let images = 0;
  const s = typeof value === 'string' ? value : JSON.stringify(value, (k, v) => {
    if (v && typeof v === 'object' && v.type === 'image') { images++; return undefined; }
    return v;
  });
  let ascii = 0, other = 0;
  for (let i = 0; i < (s || '').length; i++) (s.charCodeAt(i) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 4 + other * 0.8) + images * IMAGE_TOKENS;
}

const PREVIEW_CHARS = 2000;

// Save a tool's output to a file of the project's tool-results directory. Returns its path, or null.
function saveToolOutput(root, id, text) {
  try {
    const dir = toolResultsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${String(id).replace(/[^\w-]/g, '_')}.txt`);
    fs.writeFileSync(file, text);
    return file;
  } catch { return null; }
}

// A tool result too large to send in full is saved to a file; the model gets a preview and the
// path, and can page through the file with Read/Grep. Returns the text to send instead.
export function persistLargeOutput(root, id, text) {
  const file = saveToolOutput(root, id, text);
  const kb = (text.length / 1024).toFixed(1);
  const preview = text.slice(0, PREVIEW_CHARS);
  if (!file) return `${text.slice(0, 20_000)}\n\n[Output truncated: ${kb}KB total; it could not be saved to a file.]`;
  return `<persisted-output>\nOutput too large (${kb}KB). Full output saved to: ${file}\nUse Read with offset/limit, or Grep, on that file to see what you need.\n\nPreview (first ${PREVIEW_CHARS / 1000}KB):\n${preview}\n...\n</persisted-output>`;
}

// Coming back after a long pause, the prompt cache has expired and the next request writes the whole conversation
// again anyway. Claude Code then clears the results of all but the last few tool calls, and so does this program,
// with the same numbers: more than 65 minutes away, the last 5 results kept, at least 20k tokens to gain. Only
// what the model can get again is cleared (what a file, a command or a search showed); a sub-agent's report, the
// user's answers and the like stay whatever their age.
export const IDLE_CLEARING = { idleMs: 65 * 60_000, keep: 5, atLeast: 20_000 };
export const CLEARED = '[Old tool result content cleared]';
const CLEARABLE_TOOLS = new Set(['Read', 'Bash', 'BashOutput', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Edit', 'Write']);
const MIN_CLEAR_TOKENS = 100; // a smaller result is left as it is: clearing it gains next to nothing

const isThinking = (b) => b.type === 'thinking' || b.type === 'redacted_thinking';
const resultText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');

// Clear the results of all but the last `keep` clearable tool calls, if that takes out at least `atLeast` tokens
// (else null). The thinking goes too, all of it: once a tool result before it has changed, the API takes earlier
// thinking for tampered with, and rejects the request. `save(id, text)` keeps a cleared output in a file and
// returns its path, so that what a command printed can still be looked up; a file read is read again instead.
// Returns {messages (a new list: the old one is not changed), results (how many were cleared), tokens (about
// how many went, thinking included), forget (the files whose Read results went, and of which no Read is left)}.
export function clearOldToolResults(messages, { keep = IDLE_CLEARING.keep, atLeast = IDLE_CLEARING.atLeast, save = () => null, cwd = process.cwd() } = {}) {
  const uses = new Map(); // tool_use id -> the tool_use block
  for (const m of messages) if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use') uses.set(b.id, b);
  const results = messages.flatMap((m) => (m.role === 'user' && Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === 'tool_result' && CLEARABLE_TOOLS.has(uses.get(b.tool_use_id)?.name));
  const clear = new Set();
  let tokens = 0;
  for (const b of results.slice(0, Math.max(0, results.length - keep))) {
    const text = resultText(b.content);
    if (text.startsWith(CLEARED) || text.startsWith('<persisted-output>')) continue; // cleared already, or short already
    const t = estimateTokens(b.content);
    if (t < MIN_CLEAR_TOKENS) continue;
    clear.add(b);
    tokens += t;
  }
  if (tokens < atLeast) return null;
  const fileOf = (b) => {
    const p = uses.get(b.tool_use_id)?.input?.file_path;
    return typeof p === 'string' && p.trim() ? resolvePath(p, cwd) : null;
  };
  const placeholder = (b) => {
    if (uses.get(b.tool_use_id).name === 'Read') return `${CLEARED} Read the file again if you need it.`;
    const text = resultText(b.content);
    const file = text && save(b.tool_use_id, text);
    return file ? `${CLEARED} The full output was saved to ${file}; read it there if you need it.` : CLEARED;
  };
  const gone = new Set();
  const shown = new Set();
  const out = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    if (m.role === 'assistant') {
      if (!m.content.some(isThinking)) return m;
      for (const b of m.content) if (isThinking(b)) tokens += estimateTokens(b.thinking ?? b.data ?? '');
      const content = m.content.filter((b) => !isThinking(b));
      return { ...m, content: content.length ? content : [{ type: 'text', text: '(no content)' }] };
    }
    for (const b of m.content) {
      if (b.type !== 'tool_result' || uses.get(b.tool_use_id)?.name !== 'Read' || !fileOf(b)) continue;
      if (clear.has(b)) gone.add(fileOf(b));
      else if (!b.is_error && !resultText(b.content).startsWith(CLEARED)) shown.add(fileOf(b));
    }
    if (!m.content.some((b) => clear.has(b))) return m;
    return { ...m, content: m.content.map((b) => (clear.has(b) ? { ...b, content: placeholder(b) } : b)) };
  });
  return { messages: out, results: clear.size, tokens, forget: [...gone].filter((f) => !shown.has(f)) };
}

const notificationBlocks = (notes) => notes.map((n) => ({ type: 'text', text: n.text }));

// Queued input may arrive as plain strings or as ready-made content blocks (text + images).
const toQueuedBlocks = (items) => items.map((q) => (typeof q === 'string' ? { type: 'text', text: q } : q));

function toBlocks(content) {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

// Merge consecutive same-role messages and drop empties so the API always sees a valid sequence.
export function normalizeMessages(messages) {
  const out = [];
  for (const m of messages) {
    const blocks = toBlocks(m.content).filter((b) => !(b.type === 'text' && !b.text));
    if (!blocks.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content = [...prev.content, ...blocks];
    else out.push({ role: m.role, content: blocks });
  }
  // tool_result blocks must come first in a user message.
  for (const m of out) {
    if (m.role === 'user' && m.content.some((b) => b.type === 'tool_result')) {
      m.content = [...m.content.filter((b) => b.type === 'tool_result'), ...m.content.filter((b) => b.type !== 'tool_result')];
    }
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// Minimal JSON-schema check for required fields and primitive types.
function validateInput(schema, input) {
  if (!schema || typeof input !== 'object' || input === null) return 'Input must be an object';
  for (const key of schema.required || []) {
    if (input[key] === undefined || input[key] === null) return `The required parameter \`${key}\` is missing`;
  }
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    const v = input[key];
    if (v === undefined || v === null || !spec.type) continue;
    const t = Array.isArray(v) ? 'array' : typeof v;
    const ok = spec.type === t || (spec.type === 'integer' && t === 'number') || (spec.type === 'number' && t === 'string' && !isNaN(+v));
    if (!ok) return `The parameter \`${key}\` type is expected as \`${spec.type}\` but provided as \`${t}\``;
    if (spec.type === 'number' && t === 'string') input[key] = +v;
  }
  return null;
}

export class Agent {
  constructor({ config, modes, tools, systemPrompt, io, model, isSubagent = false, cwd, name = 'main', spawnSubagent, hooks, tasks, checkpoints, depth = 0, refreshSystemPrompt, beforeTurn }) {
    this.config = config;
    this.depth = depth; // 0 for the main agent, +1 for every level of sub-agent
    this.hooks = hooks;
    this.tasks = tasks; // background tasks (sub-agents started with run_in_background)
    this.notifications = []; // {taskId, text} waiting to be shown to the model
    this.editsThisRun = 0; // successful file edits since the last verification
    this.modes = modes; // session mode: full access, or read-only plan mode
    this.checkpoints = checkpoints; // snapshots of files before they are edited, per user prompt
    this.tools = tools;
    this.systemPrompt = systemPrompt; // string or () => string
    this.io = io;
    this.modelFn = typeof model === 'function' ? model : () => model;
    this.isSubagent = isSubagent;
    this.name = name;
    this.spawnSubagent = spawnSubagent;
    this.messages = [];
    this.todos = [];
    this.fileState = new Map();
    this.projectRoot = cwd;
    this.cwd = cwd;
    this.lastContextTokens = 0;
    this.tokensSinceUsage = 0;
    // What this agent's own requests used. `requests` counts the turns' requests; the summary requests of
    // compactions are counted apart (`compactions`) and their tokens are in the totals like any others.
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, requests: 0, compactions: 0 };
    // What the sub-agents this agent started used (they bill like everything else); only the main agent has any.
    this.subUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, requests: 0, compactions: 0, runs: 0 };
    this.cache = new CacheStats(); // how much of the input came from the prompt cache, and why a request missed
    this.refreshSystemPrompt = refreshSystemPrompt; // called when the conversation starts over from a summary
    this.beforeTurn = beforeTurn; // called at the start of each of the main agent's turns (the date note, see runtime.js)
    this.recordedSystem = null; // the system prompt last reported to the io (see callModel)
    this.reminders = []; // texts for the next user message, as <system-reminder>s (the main agent's only)
    this.toolUseCount = 0;
    this.postCompactTokens = undefined; // undefined: never compacted; null: compacted, awaiting measurement
    this.compactFailures = 0; // automatic compactions that failed in a row
    this.lastActivityAt = 0; // when the last message was added (ms since epoch; 0: unknown), see clearAfterIdle
  }

  get model() { return this.modelFn(); }
  get toolMap() { return new Map(this.tools.map((t) => [t.name, t])); }

  toolSchemas() {
    return this.tools.map((t) => ({ name: t.name, description: typeof t.description === 'function' ? t.description() : t.description, input_schema: t.input_schema }));
  }

  get contextEstimate() { return this.lastContextTokens + this.tokensSinceUsage; }

  pushMessage(msg) {
    this.messages.push(msg);
    this.lastActivityAt = Date.now();
    if (msg.role === 'user') this.tokensSinceUsage += estimateTokens(msg.content);
    this.io.messageAdded?.(msg, this);
  }

  replaceMessages(messages) {
    this.messages = messages;
    this.cache.noteRewrite(); // the old conversation is no longer a prefix of the next request: not a cache miss
    this.io.messagesReplaced?.(messages, this);
  }

  // The system prompt for the next request: this agent's own, built when it is first needed.
  currentSystem() {
    return typeof this.systemPrompt === 'function' ? this.systemPrompt() : this.systemPrompt;
  }

  // A note for the model that goes with the next user message (as a <system-reminder>), after the part of the
  // request that is already cached.
  addReminder(text) {
    if (text) this.reminders.push(text);
  }

  // Everything this agent and the sub-agents it started have used so far.
  totalUsage() {
    const a = this.usage;
    const b = this.subUsage;
    const sum = (k) => a[k] + b[k];
    return {
      input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), cacheWrite1h: sum('cacheWrite1h'),
      requests: sum('requests'), compactions: sum('compactions'),
    };
  }

  // Count a finished sub-agent's usage as this agent's (whatever happened to it, it was billed).
  addSubUsage(u) {
    const b = this.subUsage;
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'requests', 'compactions']) b[k] += u[k] || 0;
    b.runs++;
  }

  // Count one finished request. `kind` is "turn" for the conversation's own requests and "summary" for the
  // request that compacts it; both go into the prompt cache statistics.
  recordUsage(res, kind = 'turn') {
    const u = res.usage || {};
    this.usage.input += u.input_tokens || 0;
    this.usage.output += u.output_tokens || 0;
    this.usage.cacheRead += u.cache_read_input_tokens || 0;
    this.usage.cacheWrite += u.cache_creation_input_tokens || 0;
    this.usage.cacheWrite1h += u.cache_creation?.ephemeral_1h_input_tokens || 0;
    if (kind === 'summary') this.usage.compactions++;
    else this.usage.requests++;
    this.cache.record({ usage: u, ...res.cache });
    this.io.usage?.(u, this);
  }

  // After resuming a conversation: drop what the previous one had read and rebuild the map from the
  // restored transcript, so files the model remembers reading can be edited without a re-read.
  restoreFileState(messages, times) {
    this.fileState.clear();
    for (const [file, state] of rebuildFileState(messages, times, this.cwd)) this.fileState.set(file, state);
  }

  // The text the assistant has written so far (newest last, clipped to `limit` characters). A
  // sub-agent that fails part-way hands this back so its work is not lost with the error.
  assistantText(limit = 6000) {
    const text = this.messages
      .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
      .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text.trim()))
      .filter(Boolean)
      .join('\n\n');
    return text.length > limit ? `…${text.slice(-limit)}` : text;
  }

  // Take pending background-task notifications as content blocks.
  drainNotifications() {
    return notificationBlocks(this.notifications.splice(0));
  }

  // Start over with an empty conversation, to move to another session (/clear, /resume). The
  // session being left is deliberately not told (no messagesReplaced): an "empty conversation" record
  // appended to it would make it load as empty, and it would vanish from the list of conversations
  // that can be resumed.
  resetConversation() {
    this.messages = [];
    this.todos = [];
    this.fileState.clear();
    this.lastContextTokens = 0;
    this.tokensSinceUsage = 0;
    this.postCompactTokens = undefined;
    this.cache.newConversation();
    this.reminders = [];
    this.compactFailures = 0;
    this.lastActivityAt = 0;
    this.recordedSystem = null; // the next conversation's session file has to get the system prompt too, even if it is the same text
    this.checkpoints?.reset();
  }

  // Back after more than an hour away (IDLE_CLEARING): clear old tool results, see clearOldToolResults. The main
  // conversation only, where Config.clearAfterIdle has it on. Not after a turn that stopped in the middle of its
  // tool calls: the thinking of an unfinished tool call is to be sent back as it was, and it cannot stay once a
  // result before it has changed. Returns what clearOldToolResults did, or null.
  clearAfterIdle(now = Date.now()) {
    if (this.isSubagent || !this.config.clearAfterIdle || !this.lastActivityAt) return null;
    const idle = now - this.lastActivityAt;
    if (idle <= IDLE_CLEARING.idleMs) return null;
    const last = this.messages.findLast((m) => m.role === 'assistant');
    if (Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_use')) return null;
    const out = clearOldToolResults(this.messages, { save: (id, text) => saveToolOutput(this.projectRoot, id, text), cwd: this.cwd });
    if (!out) return null;
    this.replaceMessages(out.messages); // into the session file too: a resumed conversation goes on with the short one
    for (const file of out.forget) this.fileState.delete(file); // the model no longer sees it: Read before Edit/Write
    this.lastContextTokens = Math.max(0, this.lastContextTokens - out.tokens);
    this.io.notice?.(`Back after ${Math.round(idle / 60_000)} minutes, with the prompt cache expired: cleared ${out.results} old tool results and the earlier thinking (about ${Math.round(out.tokens / 1000)}k tokens). The last ${IDLE_CLEARING.keep} results are kept; files are read again when needed.`);
    return out;
  }

  // Run one user turn to completion. Returns {text, interrupted}.
  async run(userContent, { signal } = {}) {
    if (!this.isSubagent) this.beforeTurn?.();
    this.clearAfterIdle();
    let content = toBlocks(userContent);
    if (this.modes.mode === 'plan' && !this.isSubagent) content = [...content, { type: 'text', text: PLAN_MODE_REMINDER }];
    if (this.hooks?.has('UserPromptSubmit') && !this.isSubagent) {
      const prompt = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const h = await this.hooks.run('UserPromptSubmit', { prompt }, { cwd: this.cwd, signal });
      for (const w of h.warnings) this.io.notice?.(w, 'warn');
      if (h.blocked) {
        this.io.notice?.(`Prompt blocked by hook: ${h.message}`, 'warn');
        return { text: '', interrupted: false, rejected: true };
      }
      if (h.context.length) content = [...content, { type: 'text', text: `<system-reminder>${h.context.join('\n')}</system-reminder>` }];
    }
    if (!this.isSubagent) content = [...content, ...this.drainNotifications()];
    if (this.reminders.length) content = [...content, ...this.reminders.splice(0).map((text) => ({ type: 'text', text: `<system-reminder>${text}</system-reminder>` }))];
    if (!this.isSubagent && this.checkpoints) {
      const prompt = content.find((b) => b.type === 'text' && !b.text.startsWith('<system-reminder>') && !b.text.startsWith('<task-notification>'))?.text;
      this.checkpoints.beginTurn({ label: prompt || '(background agent report)', messageIndex: this.messages.length });
    }
    this.pushMessage({ role: 'user', content });

    this.editsThisRun = 0;
    let verifyRounds = 0;
    let stopHookRounds = 0;
    let continuations = 0;
    let compactedForError = false;
    let finalText = '';
    for (;;) {
      if (signal?.aborted) return this.handleInterrupt(null);
      if (this.shouldAutoCompact()) {
        const outcome = await this.compactOnTheWay(signal);
        if (outcome?.interrupted) return outcome;
        if (outcome?.failed) compactedForError = true; // it has just failed: a too-long prompt in this turn is not tried again
      }

      let res;
      try {
        res = await this.callModel(signal);
      } catch (err) {
        if (isAbort(err) || signal?.aborted) {
          // Keep whatever text the user already saw so the model knows what it said.
          if (err.partial?.length) this.pushMessage({ role: 'assistant', content: err.partial });
          return this.handleInterrupt(null);
        }
        if (err.promptTooLong && !compactedForError && this.messages.length > 2) {
          compactedForError = true;
          this.io.notice?.('Context limit reached; compacting conversation…', 'warn');
          const outcome = await this.compactOnTheWay(signal, { required: true });
          if (outcome?.interrupted) return outcome;
          continue;
        }
        throw err;
      }
      const { message, stopReason } = res;
      if (!message.content.length) message.content.push({ type: 'text', text: '(no content)' });
      this.pushMessage(message);
      this.io.assistantMessage?.(message, this);

      const toolUses = message.content.filter((b) => b.type === 'tool_use');
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (text) finalText = text;

      if (!toolUses.length) {
        if (stopReason === 'max_tokens' && continuations < 3) {
          continuations++;
          this.io.notice?.('Response hit the output token limit; asking the model to continue…', 'warn');
          this.pushMessage({ role: 'user', content: [{ type: 'text', text: '<system-reminder>Your previous response was cut off because it reached the maximum output length. Continue exactly where you left off, without repeating what you already wrote.</system-reminder>' }] });
          continue;
        }
        const queued = [...toQueuedBlocks(this.io.takeQueued?.() || []), ...(this.isSubagent ? [] : this.drainNotifications())];
        if (queued.length) {
          this.pushMessage({ role: 'user', content: queued });
          continue;
        }
        const verify = this.config.verifyCommand;
        if (verify && !this.isSubagent && this.editsThisRun > 0) {
          this.editsThisRun = 0;
          const v = await this.runVerify(verify, signal);
          if (signal?.aborted) return this.handleInterrupt(null);
          if (!v.ok) {
            if (verifyRounds < this.config.verifyMaxRounds) {
              verifyRounds++;
              this.pushMessage({ role: 'user', content: [{ type: 'text', text: `<system-reminder>You edited files, so the verification command \`${verify}\` was run automatically, and it failed (attempt ${verifyRounds} of ${this.config.verifyMaxRounds}). Fix the cause and do not stop until it passes; if the failure is unrelated to your change or cannot be fixed, explain why.\n\n${v.output}</system-reminder>` }] });
              continue;
            }
            this.io.notice?.(`Verification still failing after ${verifyRounds} fix attempts: ${verify}`, 'warn');
          }
        }
        if (this.hooks?.has('Stop') && !this.isSubagent && stopHookRounds < 3) {
          const h = await this.hooks.run('Stop', { stop_reason: stopReason }, { cwd: this.cwd, signal });
          for (const w of h.warnings) this.io.notice?.(w, 'warn');
          if (h.blocked) {
            stopHookRounds++;
            this.pushMessage({ role: 'user', content: [{ type: 'text', text: `<system-reminder>A Stop hook asked you to keep working:\n${h.message}</system-reminder>` }] });
            continue;
          }
        }
        return { text: finalText, interrupted: false };
      }

      const outcome = await this.runTools(toolUses, signal);
      const resultContent = [...outcome.results];
      const queued = this.io.takeQueued?.() || [];
      resultContent.push(...toQueuedBlocks(queued));
      if (!this.isSubagent) resultContent.push(...this.drainNotifications());
      if (outcome.interrupted) {
        resultContent.push({ type: 'text', text: INTERRUPT_TOOL_MESSAGE });
        this.pushMessage({ role: 'user', content: resultContent });
        return { text: finalText, interrupted: true };
      }
      this.pushMessage({ role: 'user', content: resultContent });
      if (outcome.stop) return { text: finalText, interrupted: false, rejected: true };
    }
  }

  shouldAutoCompact() {
    if (!this.config.autoCompactEnabled || this.messages.length <= 2) return false;
    if (this.compactFailures >= MAX_COMPACT_FAILURES) return false;
    const threshold = this.config.autoCompactThreshold(this.model);
    if (this.contextEstimate < threshold) return false;
    // Right after a compaction the base context (system prompt, tools, summary) may itself be
    // near a very small window; require real growth so we don't compact on every step.
    if (this.postCompactTokens != null && this.contextEstimate - this.postCompactTokens < threshold * 0.1) return false;
    return true;
  }

  handleInterrupt() {
    this.pushMessage({ role: 'user', content: [{ type: 'text', text: INTERRUPT_MESSAGE }] });
    return { text: '', interrupted: true };
  }

  // Compact in the middle of a turn. The user can interrupt this like any other request (Esc during a
  // pause for a rate limit, say), and that ends the turn as an interruption rather than an error: the
  // result to return from run() is given back, or null when the compaction went through.
  // A compaction that fails does not fail the turn when the request still fits (the threshold leaves room
  // below the model's limit): the turn goes on without it, and {failed: true} is returned. After
  // MAX_COMPACT_FAILURES in a row it is left off (see shouldAutoCompact). `required`: the request is already
  // too long, so there is nothing to go on with, and the error is thrown.
  async compactOnTheWay(signal, { required = false } = {}) {
    try {
      await this.compact({ signal, auto: true });
      return null;
    } catch (err) {
      if (isAbort(err) || signal?.aborted) return this.handleInterrupt();
      this.compactFailures++;
      if (required) throw err;
      this.io.notice?.(this.compactFailures >= MAX_COMPACT_FAILURES
        ? `Auto-compaction failed ${this.compactFailures} times in a row (${err.message}). It is off for this conversation until /compact succeeds or /clear.`
        : `Auto-compaction failed (${err.message}); continuing without it.`, 'warn');
      return { failed: true };
    }
  }

  // Run the verification command in the project root with the Bash tool. Returns {ok, output}.
  async runVerify(command, signal) {
    const bash = this.tools.find((t) => t.name === 'Bash');
    if (!bash) return { ok: true, output: '' };
    const tool = { name: 'Verify', summarize: () => command };
    const input = { command, timeout: this.config.bashMaxTimeout };
    const handle = this.io.toolStart?.({ id: `verify_${Date.now()}`, name: 'Verify', input }, tool, input, this) || {};
    const ctx = { ...this.makeCtx(signal), cwd: this.projectRoot, setCwd() {} };
    ctx.onProgress = (p) => handle.progress?.(p);
    let result;
    try {
      result = await bash.call(input, ctx);
    } catch (err) {
      handle.done?.({ isError: true, content: 'Interrupted', interrupted: true });
      if (isAbort(err) || signal?.aborted) return { ok: true, output: '' };
      return { ok: false, output: `Error: ${err.message}` };
    }
    const output = typeof result.content === 'string' ? result.content : '';
    const ok = !result.isError;
    handle.done?.({ ...result, display: { summary: ok ? 'Verification passed' : undefined } });
    return { ok, output: output.length > 15_000 ? `${output.slice(0, 3000)}\n...\n${output.slice(-12_000)}` : output };
  }

  async callModel(signal) {
    const system = this.currentSystem();
    // The system prompt is kept with the conversation, so that a resumed one can continue behind the same
    // prompt (and so with the cache it has) instead of a freshly built one.
    if (!this.isSubagent && system !== this.recordedSystem) {
      this.recordedSystem = system;
      this.io.systemPrompt?.(system, this);
    }
    const res = await streamMessage(this.config, {
      model: this.model,
      system,
      messages: normalizeMessages(this.messages),
      tools: this.toolSchemas(),
      cacheBucket: this.isSubagent ? 'other' : 'main',
    }, { signal, onEvent: (ev) => this.io.streamEvent?.(ev, this) });
    this.lastContextTokens = contextTokens(res.usage);
    this.tokensSinceUsage = 0;
    if (this.postCompactTokens === null) this.postCompactTokens = this.lastContextTokens;
    this.recordUsage(res);
    return res;
  }

  makeCtx(signal, onProgress) {
    const agent = this;
    return {
      get cwd() { return agent.cwd; },
      setCwd(dir) { agent.cwd = dir; },
      projectRoot: this.projectRoot,
      config: this.config,
      signal,
      fileState: this.fileState,
      modes: this.modes,
      checkpoints: this.checkpoints,
      agent: this,
      io: this.io,
      onProgress,
      spawnSubagent: this.spawnSubagent,
      tasks: this.tasks,
    };
  }

  // Consecutive read-only tools run concurrently; everything else runs in order.
  async runTools(toolUses, signal) {
    const map = this.toolMap;
    const results = new Map();
    let stop = false;
    let interrupted = false;
    const batches = [];
    for (const tu of toolUses) {
      const tool = map.get(tu.name);
      const safe = !!tool?.readOnly && tool.name !== 'ExitPlanMode' && tool.name !== 'AskUserQuestion';
      const last = batches[batches.length - 1];
      if (safe && last?.parallel) last.items.push(tu);
      else batches.push({ parallel: safe, items: [tu] });
    }
    this.io.toolBatchStart?.(toolUses, this);
    for (const batch of batches) {
      if (stop || interrupted) break;
      const run = async (tu) => {
        try {
          const r = await this.runOne(tu, signal, map);
          results.set(tu.id, r.block);
          if (r.stop) stop = true;
        } catch (err) {
          if (isAbort(err) || signal?.aborted) {
            interrupted = true;
            results.set(tu.id, { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Interrupted by user' });
          } else {
            results.set(tu.id, { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `Error: ${err.message}` });
          }
        }
      };
      if (batch.parallel) await Promise.all(batch.items.map(run));
      else for (const tu of batch.items) { if (stop || interrupted) break; await run(tu); }
      if (signal?.aborted) interrupted = true;
    }
    const blocks = toolUses.map((tu) => results.get(tu.id) || {
      type: 'tool_result', tool_use_id: tu.id, is_error: true,
      content: interrupted ? 'Interrupted by user' : 'Skipped: the user rejected an earlier tool call in this batch.',
    });
    return { results: blocks, stop, interrupted };
  }

  async runOne(tu, signal, map) {
    const fail = (content, extra = {}) => ({ block: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content }, ...extra });
    const tool = map.get(tu.name);
    if (!tool) return fail(`Error: No such tool available: ${tu.name}`);
    const input = tu.input || {};
    if (input.__invalid_json !== undefined) {
      return fail('Error: the tool input was not valid JSON (it may have been truncated by the output token limit). Try again with a smaller input, e.g. write large files in several steps.');
    }
    const schemaErr = validateInput(tool.input_schema, input);
    if (schemaErr) return fail(`InputValidationError: ${tool.name} failed due to the following issue:\n${schemaErr}`);

    const ctx = this.makeCtx(signal);
    const invalid = tool.validate?.(input, ctx);
    if (invalid) {
      this.io.toolRejected?.(tu, tool, invalid, this);
      return fail(invalid);
    }

    // Nothing is ever asked: tools run right away. The only gate is plan mode (read-only research).
    const decision = this.modes.check(tool, input);
    if (decision.behavior === 'deny') {
      this.io.toolRejected?.(tu, tool, decision.message, this);
      return fail(decision.message);
    }

    if (this.hooks?.has('PreToolUse')) {
      const h = await this.hooks.run('PreToolUse', { tool_name: tool.name, tool_input: input }, { cwd: this.cwd, signal });
      for (const w of h.warnings) this.io.notice?.(w, 'warn');
      if (signal?.aborted) throw abortError();
      if (h.blocked) {
        this.io.toolRejected?.(tu, tool, h.message, this);
        return fail(`Blocked by PreToolUse hook: ${h.message}`);
      }
    }

    // Remember what the file looked like before this edit, so /rewind can put it back.
    if (tool.editsFiles && this.checkpoints) {
      try { const file = tool.filePath?.(input, ctx); if (file) this.checkpoints.track(file); } catch { /* never block an edit on bookkeeping */ }
    }

    this.toolUseCount++;
    const handle = this.io.toolStart?.(tu, tool, input, this) || {};
    ctx.onProgress = (p) => handle.progress?.(p);
    let result;
    try {
      result = await tool.call(input, ctx);
    } catch (err) {
      if (isAbort(err) || signal?.aborted) {
        handle.done?.({ isError: true, content: 'Interrupted', interrupted: true, display: err.partialOutput ? { output: err.partialOutput } : undefined });
        throw abortError();
      }
      result = { isError: true, content: `Error: ${err.message}` };
    }
    handle.done?.(result);
    let content = typeof result.content === 'string' ? (result.content || '(no output)') : result.content;
    if (this.hooks?.has('PostToolUse')) {
      const h = await this.hooks.run('PostToolUse', { tool_name: tool.name, tool_input: input, tool_response: typeof content === 'string' ? content.slice(0, 20_000) : '[non-text result]' }, { cwd: this.cwd, signal });
      for (const w of h.warnings) this.io.notice?.(w, 'warn');
      const extra = [...(h.blocked ? [h.message] : []), ...h.context].join('\n');
      if (extra && typeof content === 'string') content += `\n\n<system-reminder>PostToolUse hook:\n${extra}</system-reminder>`;
    }
    if (typeof content === 'string' && tool.name !== 'Read' && content.length > this.config.maxToolResultChars) {
      content = persistLargeOutput(this.projectRoot, tu.id, content);
    }
    if (tool.editsFiles && !result.isError) this.editsThisRun++;
    return {
      block: { type: 'tool_result', tool_use_id: tu.id, content, ...(result.isError ? { is_error: true } : {}) },
      stop: !!result.stopTurn,
    };
  }

  // The summary in a summary request's reply: what is inside <summary>, else the text without its <analysis>.
  // A reply that stops to call a tool has none, whatever text comes before the call ("Let me look at the file
  // first."): that is a few words of preamble, and taking it for the summary would throw the conversation away.
  // A reply that the output limit cut off before the summary was closed is no summary either: it would end in
  // the middle of a sentence and the rest of the conversation would be gone.
  static summaryOf(res) {
    if (res.stopReason === 'tool_use' || res.message.content.some((b) => b.type === 'tool_use')) return '';
    const text = res.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (res.stopReason === 'max_tokens' && !/<\/summary>/.test(text)) return '';
    const summary = /<summary>([\s\S]*?)(<\/summary>|$)/.exec(text)?.[1]?.trim() || text.replace(/<analysis>[\s\S]*?<\/analysis>/, '').trim();
    return summary.replace(/<\/?(?:summary|analysis)>/g, '').trim();
  }

  // Ask the model for the summary. The request is the conversation's own request with the summary instruction
  // at its end: the same model, system prompt, tools and effort, so that the API reads the conversation from the
  // cache the turns have been filling instead of processing it all again (this is what Claude Code does; it is
  // the biggest request there is). Only if that does not give a summary (the model went on calling tools, or
  // the request is too long by the size of the instruction) the plainer request is made: a short system prompt
  // and no effort, which cannot share the cache, but is smaller and cannot be led astray by the main prompt.
  async requestSummary(messages, { signal, onEvent }) {
    const call = (request) => streamMessage(this.config, { model: this.model, tools: this.toolSchemas(), messages, cacheBucket: 'other', ...request }, { signal, onEvent });
    try {
      const res = await call({ system: this.currentSystem() });
      this.recordUsage(res, 'summary');
      if (Agent.summaryOf(res)) return res;
    } catch (err) {
      if (isAbort(err) || signal?.aborted || !err.promptTooLong) throw err;
    }
    const res = await call({ system: SUMMARY_SYSTEM, effort: null });
    this.recordUsage({ ...res, cache: { ...res.cache, caching: false } }, 'summary'); // made to miss: not a miss to report
    return res;
  }

  // Summarise the conversation and replace it with the summary.
  async compact({ signal, auto = false, instructions = '' } = {}) {
    if (this.messages.length === 0) return null;
    this.io.compactStart?.(auto, this);
    const messages = normalizeMessages([...this.messages, { role: 'user', content: [{ type: 'text', text: compactPrompt(instructions) }] }]);
    // If the last assistant turn has unanswered tool calls, the sequence is invalid; drop it.
    let res;
    try {
      res = await this.requestSummary(messages, { signal, onEvent: (ev) => this.io.compactProgress?.(ev, this) });
    } catch (err) {
      this.io.compactEnd?.(null, this, err);
      throw err;
    }
    const summary = Agent.summaryOf(res);
    if (!summary) {
      const err = new Error(res.stopReason === 'max_tokens' ? 'Compaction failed: the summary was cut off by the output token limit.' : 'Compaction failed: the model returned an empty summary.');
      this.io.compactEnd?.(null, this, err);
      throw err;
    }
    const todoNote = this.todos.length ? `\n\n<system-reminder>Current todo list:\n${this.todos.map((t) => `- [${t.status}] ${t.content}`).join('\n')}</system-reminder>` : '';
    this.replaceMessages([{ role: 'user', content: [{ type: 'text', text: continuationMessage(summary, { auto }) + todoNote }] }]);
    this.refreshSystemPrompt?.(); // the conversation starts over: it may start from a freshly built system prompt
    this.fileState.clear();
    if (!this.isSubagent) this.checkpoints?.markConversationStale(); // the checkpoints are the main conversation's: a sub-agent's own compaction does not end them
    this.lastContextTokens = estimateTokens(summary) + estimateTokens(this.toolSchemas()) + 2000;
    this.tokensSinceUsage = 0;
    this.postCompactTokens = null; // measured on the next request
    this.compactFailures = 0;
    this.io.compactEnd?.(summary, this);
    return summary;
  }
}
