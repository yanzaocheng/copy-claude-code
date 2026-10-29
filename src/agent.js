// The agent loop: send the conversation, stream the reply, run requested tools,
// feed results back, repeat until the model stops asking for tools.

import fs from 'node:fs';
import path from 'node:path';
import { streamMessage, contextTokens, isAbort } from './api.js';
import { loadGatewayModels } from './gateway.js';
import { compactPrompt, partialCompactPrompt, partialSummaryMessage, continuationMessage, keptUserMessagesIn, SUMMARY_SYSTEM } from './compaction.js';
import { toolResultsDir } from './session.js';
import { rebuildFileState } from './filestate.js';
import { CacheStats, TTL_MS } from './cache.js';
import { CacheKeepAlive } from './keepalive.js';
import { resolvePath } from './utils/paths.js';
import { fitImagesIn, lightenImagesIn } from './utils/images.js';
import { latestWorkState, workStateFromText } from './work-state.js';

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
const CLEARABLE_TOOLS = new Set(['Read', 'Bash', 'BashOutput', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Edit', 'MultiEdit', 'Write']);
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

// A summary request's messages with the older half of the turns left out: the first message (the task, or the
// summary of an earlier compaction) and the newer half stay, with a note in between. null when nothing is left
// to leave out.
function withoutOldestHalf(messages) {
  if (messages.length <= 4) return null;
  const cut = Math.floor((messages.length - 1) / 2);
  const note = { role: 'user', content: [{ type: 'text', text: '[Part of the conversation is left out here: with it the summary request did not fit in the context window.]' }] };
  return repairToolResults(normalizeMessages([messages[0], note, ...messages.slice(1 + cut)])).messages;
}

const notificationBlocks = (notes) => notes.map((n) => ({ type: 'text', text: n.text }));

// Queued input may arrive as plain strings or as ready-made content blocks (text + images).
const toQueuedBlocks = (items) => items.map((q) => (typeof q === 'string' ? { type: 'text', text: q } : q));

function toBlocks(content) {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

// How much of the user's own messages a compaction keeps word for word, in estimated tokens (Codex keeps 20k).
const KEPT_USER_TOKENS = 20_000;
// Text the program puts in a user message, not the user: notes for the model, reports of background agents and of
// other sessions, bash mode, interruptions. The summaries of earlier compactions are read for the messages they kept.
const PROGRAM_TEXT = /^(?:<(?:system-reminder|task-notification|peer-message|bash-input)\b|\[Request interrupted by user)/;
const SUMMARY_TEXT = /^(?:This session is being continued|\[Summarized conversation\])/;
// The note a restarted session goes on with (see restartNote), in front of what the user had queued meanwhile: not the
// user's either, and in a session that restarts often those notes took the room of what the user wrote.
const RESTART_NOTE = /^\[claude-pro restarted[\s\S]*?\](?:\n\n|$)/;

// The user's own messages in `messages`, oldest first, to keep word for word through a compaction as Codex does: what
// they typed ("[image]" for a picture) and what earlier summaries kept. The newest that fit in `budget` estimated
// tokens are kept whole, the next one shortened in the middle to what is left (when that is worth it), none older.
export function keptUserMessages(messages, budget = KEPT_USER_TOKENS) {
  const all = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const typed = [];
    for (const b of toBlocks(m.content)) {
      if (b.type === 'image') { typed.push('[image]'); continue; }
      if (b.type !== 'text') continue;
      const text = (b.text || '').replace(RESTART_NOTE, '');
      if (!text.trim() || PROGRAM_TEXT.test(text)) continue;
      if (SUMMARY_TEXT.test(text)) all.push(...keptUserMessagesIn(text));
      else typed.push(text);
    }
    if (typed.length) all.push(typed.join('\n'));
  }
  const kept = [];
  let left = budget;
  for (let i = all.length - 1; i >= 0 && left > 0; i--) {
    const text = all[i];
    const tokens = estimateTokens(text);
    if (tokens <= left) { kept.push(text); left -= tokens; continue; }
    if (left >= 200) {
      const half = Math.floor(text.length * left / tokens / 2);
      kept.push(`${text.slice(0, half)}\n[… ${text.length - 2 * half} characters left out …]\n${text.slice(text.length - half)}`);
    }
    break;
  }
  return kept.reverse();
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

const recoveredToolResult = (id) => ({
  type: 'tool_result',
  tool_use_id: id,
  is_error: true,
  content: '[Tool call did not complete before the session was interrupted.]',
});

// Repair a transcript before it reaches an API adapter. A process can die after the assistant
// tool_use was persisted but before the user tool_result was appended; gateway adapters reject
// that sequence as "No tool output found for function call". The repair is deterministic and
// only adds an explicit interrupted result (or drops an orphan result), never a successful one.
// `recovered`: the ids of the tool calls that got an interrupted result. Blocks are copied only where they
// change, so the others (images, which a 400 makes the request scale in place) are the conversation's own.
export function repairToolResults(messages) {
  const out = [];
  let pending = null;
  let changed = false;
  let recoveryIndex = 0;
  const recovered = [];
  const usedIds = new Set();
  const freshId = () => {
    let id;
    do { id = `toolu_recovered_${recoveryIndex++}`; } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };
  const interrupted = (id) => { recovered.push(id); return recoveredToolResult(id); };
  const flushPending = () => {
    if (!pending?.length) return;
    out.push({ role: 'user', content: pending.map(interrupted) });
    pending = null;
    changed = true;
  };

  for (const original of messages) {
    const source = Array.isArray(original.content) ? original.content : toBlocks(original.content);
    const m = { ...original, content: source.slice() };
    const uses = m.role === 'assistant' ? m.content.filter((b) => b.type === 'tool_use') : [];

    if (uses.length) {
      flushPending();
      const ids = [];
      for (const block of uses) {
        let id = typeof block.id === 'string' && block.id ? block.id : null;
        if (!id || usedIds.has(id)) {
          id = freshId();
          m.content[m.content.indexOf(block)] = { ...block, id };
          changed = true;
        } else usedIds.add(id);
        ids.push(id);
      }
      pending = ids;
      out.push(m);
      continue;
    }

    if (m.role === 'user' && pending?.length) {
      const expected = new Set(pending);
      const seen = new Set();
      const results = [];
      const rest = [];
      for (const block of m.content) {
        if (block.type !== 'tool_result') { rest.push(block); continue; }
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        if (!expected.has(id) || seen.has(id)) { changed = true; continue; }
        seen.add(id);
        if (block.content === undefined || block.content === null) {
          results.push({ ...block, content: '(no output)' });
          changed = true;
          continue;
        }
        results.push(block);
      }
      for (const id of pending) if (!seen.has(id)) { results.push(interrupted(id)); changed = true; }
      const content = [...results, ...rest];
      if (content.length !== m.content.length || content.some((b, i) => b !== m.content[i])) changed = true;
      out.push({ ...m, content });
      pending = null;
      continue;
    }

    // A tool_result without a directly preceding assistant tool_use is invalid too.
    if (m.role === 'user' && m.content.some((b) => b.type === 'tool_result')) {
      const content = m.content.filter((b) => b.type !== 'tool_result');
      if (content.length !== m.content.length) { changed = true; out.push({ ...m, content }); }
      else out.push(m);
    } else {
      if (pending) flushPending();
      out.push(m);
    }
  }
  flushPending();
  return { messages: out, changed, recovered };
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
  constructor({ config, tools, systemPrompt, io, model, isSubagent = false, cwd, name = 'main', spawnSubagent, hooks, tasks, checkpoints, depth = 0, refreshSystemPrompt, beforeTurn, effort, compactWindow = 0, trace = null }) {
    this.config = config;
    this.effort = effort || undefined; // a sub-agent's own effort level; undefined: the session's (config.effort)
    this.compactWindow = compactWindow; // a sub-agent's own auto-compact window (tokens); 0: the session's
    this.depth = depth; // 0 for the main agent, +1 for every level of sub-agent
    this.hooks = hooks;
    this.tasks = tasks; // background tasks (sub-agents started with run_in_background)
    this.notifications = []; // {taskId, text} waiting to be shown to the model
    this.editsThisRun = 0; // successful file edits since the last verification
    this.checkpoints = checkpoints; // snapshots of files before they are edited, per user prompt
    this.tools = tools;
    this.systemPrompt = systemPrompt; // string or () => string
    this.io = io;
    this.modelFn = typeof model === 'function' ? model : () => model;
    this.isSubagent = isSubagent;
    this.name = name;
    this.spawnSubagent = spawnSubagent;
    this.trace = trace;
    this.traceTurnId = null;
    this.messages = [];
    this.recoveredToolIds = new Set(); // tool calls already said to be recovered (see callModel)
    this.todos = [];
    this.workState = null; // last validated state emitted by compaction; the transcript remains the source on resume
    this.userTurns = 0; // turns the user started (see noteUserTurn)
    this.todosTurn = 0; // ... and the one in which the todo list was last written
    this.fileState = new Map();
    this.projectRoot = cwd;
    this.cwd = cwd;
    this.lastContextTokens = 0;
    this.usageModel = null; // the model whose usage report last set lastContextTokens (see shouldAutoCompact)
    this.tokensSinceUsage = 0;
    this.heldTokens = 0; // room taken by tool results not yet in the conversation (see takeContext)
    // What this agent's own requests used. `requests` counts the turns' requests; the summary requests of
    // compactions are counted apart (`compactions`) and their tokens are in the totals like any others.
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, requests: 0, compactions: 0, keepalives: 0 };
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
    this.busy = 0; // turns and summaries in progress: while there are any, the cache needs no refresh
    this.keepAlive = isSubagent ? null : new CacheKeepAlive(this); // the prompt cache kept warm while idle
  }

  get model() { return this.modelFn(); }
  get toolMap() { return new Map(this.tools.map((t) => [t.name, t])); }

  toolSchemas() {
    return this.tools.map((t) => ({ name: t.name, description: typeof t.description === 'function' ? t.description() : t.description, input_schema: t.input_schema }));
  }

  get contextEstimate() { return this.lastContextTokens + this.tokensSinceUsage; }

  // Tokens the context can still take before it reaches the auto-compaction threshold: what a Read with allow_large
  // may use (a larger one would be compacted away right after it was read).
  contextRoom() {
    return this.config.autoCompactThreshold(this.model, this.compactWindow) - this.contextEstimate - this.heldTokens;
  }

  // Claim room for a tool result that is about to be added. Read-only tools run in parallel, so what each one
  // took is held until their results are in the conversation. Returns {ok, tokens, room}.
  takeContext(value) {
    const tokens = estimateTokens(value);
    const room = this.contextRoom();
    if (tokens > room) return { ok: false, tokens, room };
    this.heldTokens += tokens;
    return { ok: true, tokens, room };
  }

  pushMessage(msg) {
    this.messages.push(msg);
    this.lastActivityAt = Date.now();
    if (msg.role === 'user') this.heldTokens = 0; // the results that held room are counted from here on
    if (msg.role === 'user') this.tokensSinceUsage += estimateTokens(msg.content);
    this.io.messageAdded?.(msg, this);
  }

  replaceMessages(messages) {
    this.keepAlive?.stop(); // what is cached is no longer the conversation's prefix
    this.messages = messages;
    this.cache.noteRewrite(); // the old conversation is no longer a prefix of the next request: not a cache miss
    this.io.messagesReplaced?.(messages, this);
  }

  // Screenshots that joined the conversation as heavy PNGs (before images were re-encoded, see utils/images.js)
  // go on as JPEGs: changed in place once, and kept so in the session file, at the price of one cache rewrite.
  async lightenImages() {
    if (await lightenImagesIn(this.messages)) this.replaceMessages(this.messages);
  }

  // The system prompt for the next request: this agent's own, built when it is first needed.
  currentSystem() {
    return typeof this.systemPrompt === 'function' ? this.systemPrompt() : this.systemPrompt;
  }

  traceRequestStart({ kind = 'turn', messages = this.messages, cacheBucket = 'main', cacheMessages = true, compactionId = null } = {}) {
    if (!this.trace?.enabled) return null;
    const model = this.model;
    return this.trace.requestStart({
      turnId: this.traceTurnId,
      agent: this.name,
      depth: this.depth,
      kind,
      model: model?.id || model,
      effort: this.effort || this.config.effort,
      context_tokens: this.contextEstimate,
      message_tokens: estimateTokens(messages),
      system_tokens: estimateTokens(this.currentSystem()),
      tool_tokens: estimateTokens(this.toolSchemas()),
      message_count: Array.isArray(messages) ? messages.length : 0,
      cache: {
        bucket: cacheBucket,
        messages: Boolean(cacheMessages),
        caching: !this.config.promptCachingDisabled(model?.id || model),
        ttl: this.config.cacheTtl(cacheBucket),
      },
      compaction_id: compactionId,
    });
  }

  async streamAgentRequest(request, { signal, kind = 'turn', cacheBucket = 'main', cacheMessages = true, cacheOverride = null, compactionId = null, onEvent = () => {}, waitForRateLimit = true } = {}) {
    const handle = this.traceRequestStart({ kind, messages: request.messages, cacheBucket, cacheMessages, compactionId });
    // A bug in what shows or traces the stream must not fail the request: it had no HTTP status, so it was taken
    // for a network error and the request was sent (and billed) again, up to the retry limit, failing the same way
    // each time. The reply is assembled without the display; the error is said once.
    let handlerError = null;
    const forward = (ev) => {
      try {
        this.trace?.requestEvent(handle, ev);
        onEvent(ev);
      } catch (e) {
        handlerError ??= e;
      }
    };
    try {
      const res = await streamMessage(this.config, request, { signal, onEvent: forward, waitForRateLimit });
      if (handlerError) this.io.notice?.(`Showing the reply failed (${handlerError.message}); the reply itself is complete.`, 'warn');
      const observed = cacheOverride ? { ...res, cache: { ...res.cache, ...cacheOverride } } : res;
      const recorded = this.recordUsage(observed, kind === 'summary' || kind === 'keepalive' ? kind : 'turn');
      this.trace?.requestEnd(handle, {
        usage: res.usage,
        cache: observed.cache,
        model: res.model || request.model?.id || request.model,
        stopReason: res.stopReason,
        context_tokens: contextTokens(res.usage),
        cacheMiss: recorded?.cacheMiss,
      });
      return res;
    } catch (err) {
      this.trace?.requestEnd(handle, { error: err, model: request.model?.id || request.model, context_tokens: this.contextEstimate });
      throw err;
    }
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
      requests: sum('requests'), compactions: sum('compactions'), keepalives: a.keepalives,
    };
  }

  // Count a finished sub-agent's usage as this agent's (whatever happened to it, it was billed).
  addSubUsage(u) {
    const b = this.subUsage;
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'requests', 'compactions']) b[k] += u[k] || 0;
    b.runs++;
  }

  // Count one finished request. `kind` is "turn" for the conversation's own requests, "summary" for the
  // request that compacts it and "keepalive" for a refresh of its cache while idle (keepalive.js); all go into
  // the prompt cache statistics.
  recordUsage(res, kind = 'turn') {
    const u = res.usage || {};
    this.usage.input += u.input_tokens || 0;
    this.usage.output += u.output_tokens || 0;
    this.usage.cacheRead += u.cache_read_input_tokens || 0;
    this.usage.cacheWrite += u.cache_creation_input_tokens || 0;
    this.usage.cacheWrite1h += u.cache_creation?.ephemeral_1h_input_tokens || 0;
    if (kind === 'summary') this.usage.compactions++;
    else if (kind === 'keepalive') this.usage.keepalives++;
    else {
      this.usage.requests++;
      this.keepAlive?.noteRequest(res.cache?.at);
    }
    const misses = this.cache.misses;
    this.cache.record({ usage: u, ...res.cache });
    const cacheMiss = this.cache.misses > misses ? this.cache.lastMiss : null;
    this.io.usage?.(u, this);
    return { usage: u, cacheMiss };
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
    this.keepAlive?.stop();
    if (this.keepAlive) this.keepAlive.pauseStart = 0;
    this.messages = [];
    this.todos = [];
    this.workState = null;
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
  // conversation only, where Config.clearAfterIdle has it on. A turn that stopped in the middle of its tool calls
  // (the request after a tool result failed or was interrupted) goes on from there. With manual thinking
  // (MAX_THINKING_TOKENS: thinking.type "enabled") the API wants its last assistant message to start with its
  // thinking, which cannot stay once a result before it has changed: then nothing is cleared. Adaptive thinking,
  // the default and the only mode of the 5.x models, has no such rule: all thinking may go, that turn's too.
  // Returns what clearOldToolResults did, or null.
  clearAfterIdle(now = Date.now()) {
    if (this.isSubagent || !this.config.clearAfterIdle || !this.lastActivityAt) return null;
    const idle = now - this.lastActivityAt;
    if (idle <= IDLE_CLEARING.idleMs) return null;
    // Kept warm through the pause (keepalive.js): clearing now would throw that cache away.
    if (!this.cacheExpired(now)) return null;
    const last = this.messages.findLast((m) => m.role === 'assistant');
    const unfinished = Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_use');
    if (unfinished && this.config.thinkingBudget > 0) return null;
    const out = clearOldToolResults(this.messages, { save: (id, text) => saveToolOutput(this.projectRoot, id, text), cwd: this.cwd });
    if (!out) return null;
    this.replaceMessages(out.messages); // into the session file too: a resumed conversation goes on with the short one
    for (const file of out.forget) this.fileState.delete(file); // the model no longer sees it: Read before Edit/Write
    this.lastContextTokens = Math.max(0, this.lastContextTokens - out.tokens);
    this.io.notice?.(`Back after ${Math.round(idle / 60_000)} minutes, with the prompt cache expired: cleared ${out.results} old tool results and the earlier thinking (about ${Math.round(out.tokens / 1000)}k tokens). The last ${IDLE_CLEARING.keep} results are kept; files are read again when needed.`);
    return out;
  }

  // Is the conversation's prompt cache known to have run out? From the last request of this process when there was
  // one, else (a resumed or restarted conversation) from when the last message was added, which is after its
  // request started: that guess errs towards warm. Not knowing counts as warm.
  cacheExpired(now = Date.now()) {
    if (this.cache.expected != null) return now >= this.cache.expiresAt;
    return this.lastActivityAt > 0 && now - this.lastActivityAt >= TTL_MS[this.config.cacheTtl('main')];
  }

  // The conversation's last request again, for a refresh of its cache entry (keepalive.js): the messages before
  // the last reply, the way callModel sent them then (normalizing and repairing give the same result for the same
  // messages), and max_tokens 1. null when there is no reply yet.
  keepAliveRequest() {
    const last = this.messages.findLastIndex((m) => m.role === 'assistant');
    if (last < 1) return null;
    const { messages } = repairToolResults(normalizeMessages(this.messages.slice(0, last)));
    if (messages[messages.length - 1]?.role !== 'user') return null;
    return { model: this.model, system: this.currentSystem(), messages, tools: this.toolSchemas(), cacheBucket: 'main', maxTokens: 1 };
  }

  // What the session file keeps of the cache for a restarted conversation (see CacheStats.snapshot); null: cold.
  cacheState() {
    const s = this.cache.snapshot();
    return s && { ...s, since: this.keepAlive?.pauseStart || 0 };
  }

  // A loaded conversation whose cache the session file says is still warm: refreshed from here on as well.
  restoreCacheState(state) {
    if (!this.cache.restore(state)) return false;
    this.keepAlive?.noteRequest(state.since || 0);
    this.keepAlive?.plan();
    return true;
  }

  // A new request from the user goes back to the effort the user chose, after the Effort tool changed it for
  // the one before. A request that a restart continues keeps it.
  endEffortBoost() {
    const cfg = this.config;
    if (cfg.effortBoostKeepNext) { cfg.effortBoostKeepNext = false; return; }
    if (!cfg.effortBoost) return;
    const was = cfg.effortBoost;
    cfg.effortBoost = null;
    this.io.notice?.(`Effort back to ${cfg.effort || 'the model default'} (it was raised to ${was} for the previous request).`);
  }

  // Run one user turn to completion. Returns {text, interrupted}.
  // A turn the user started (a message of theirs, or a task from another session; not only a report of a background
  // agent). The todo list belongs to a request: one that the whole turn before this one left as it was is done or
  // dropped (its last items never ticked off, or one waiting for the user left in it), so it is put away instead of
  // showing under the next task. The model writes a new one when it needs one.
  noteUserTurn(content) {
    const fromUser = toBlocks(content).some((b) => b.type === 'image' || (b.type === 'text' && !/^<(task-notification|system-reminder)>/.test(b.text)));
    if (!fromUser) return;
    this.userTurns++;
    if (this.todos.length && this.todosTurn < this.userTurns - 1) this.todos = [];
  }

  async run(userContent, { signal } = {}) {
    this.keepAlive?.stop(); // the user is back: this turn's requests read the cache themselves
    const previousTraceTurn = this.traceTurnId;
    const traceTurnId = this.trace?.turnStart({ agent: this.name, depth: this.depth, content: userContent });
    this.traceTurnId = traceTurnId;
    let traceResult = null;
    let traceError = null;
    const tracedReturn = (result) => { traceResult = result; return result; };
    this.busy++; // undone in the finally below
    try {
      if (!this.isSubagent) {
      await this.beforeTurn?.();
      this.endEffortBoost();
      this.noteUserTurn(userContent);
    }
    this.clearAfterIdle();
    let content = toBlocks(userContent);
    if (this.hooks?.has('UserPromptSubmit') && !this.isSubagent) {
      const prompt = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const h = await this.hooks.run('UserPromptSubmit', { prompt }, { cwd: this.cwd, signal });
      for (const w of h.warnings) this.io.notice?.(w, 'warn');
      if (h.blocked) {
        this.io.notice?.(`Prompt blocked by hook: ${h.message}`, 'warn');
        return tracedReturn({ text: '', interrupted: false, rejected: true });
      }
      if (h.context.length) content = [...content, { type: 'text', text: `<system-reminder>${h.context.join('\n')}</system-reminder>` }];
    }
    if (!this.isSubagent) content = [...content, ...this.drainNotifications()];
    if (this.reminders.length) content = [...content, ...this.reminders.splice(0).map((text) => ({ type: 'text', text: `<system-reminder>${text}</system-reminder>` }))];
    if (!this.isSubagent && this.checkpoints) {
      const prompt = content.find((b) => b.type === 'text' && !b.text.startsWith('<system-reminder>') && !b.text.startsWith('<task-notification>'))?.text;
      this.checkpoints.beginTurn({ label: prompt || '(background agent report)', messageIndex: this.messages.length, conversation: this.config.sessionId || null });
    }
    this.pushMessage({ role: 'user', content });

    this.editsThisRun = 0;
    let verifyRounds = 0;
    let stopHookRounds = 0;
    let continuations = 0;
    let silentEnds = 0;
    let compactedForError = false;
    let finalText = '';
    for (;;) {
      // The model's window may come from the gateway's model list (see Config.resolveModel): loaded before the check,
      // or a resumed conversation is measured against a guess (deepseek-v4.1-flash was compacted at 160k of its 1M).
      await loadGatewayModels(this.config, signal);
      if (signal?.aborted) return tracedReturn(this.handleInterrupt(null));
      if (this.shouldAutoCompact()) {
        const outcome = await this.compactOnTheWay(signal);
        if (outcome?.interrupted) return tracedReturn(outcome);
        if (outcome?.failed) compactedForError = true; // it has just failed: a too-long prompt in this turn is not tried again
      }

      let res;
      try {
        res = await this.callModel(signal);
      } catch (err) {
        if (isAbort(err) || signal?.aborted) {
          // Keep whatever text the user already saw so the model knows what it said.
          if (err.partial?.length) this.pushMessage({ role: 'assistant', content: err.partial });
          return tracedReturn(this.handleInterrupt(null));
        }
        if (err.promptTooLong && !compactedForError && this.messages.length > 2) {
          compactedForError = true;
          this.io.notice?.('Context limit reached; compacting conversation…', 'warn');
          const outcome = await this.compactOnTheWay(signal, { required: true });
          if (outcome?.interrupted) return tracedReturn(outcome);
          continue;
        }
        throw err;
      }
      const { message, stopReason } = res;
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (!message.content.length) message.content.push({ type: 'text', text: '(no content)' });
      this.pushMessage(message);
      this.io.assistantMessage?.(message, this);

      const toolUses = message.content.filter((b) => b.type === 'tool_use');
      if (text) finalText = text;

      if (!toolUses.length) {
        if (stopReason === 'max_tokens' && continuations < 3) {
          continuations++;
          this.io.notice?.('Response hit the output token limit; asking the model to continue…', 'warn');
          this.pushMessage({ role: 'user', content: [{ type: 'text', text: '<system-reminder>Your previous response was cut off because it reached the maximum output length. Continue exactly where you left off, without repeating what you already wrote.</system-reminder>' }] });
          continue;
        }
        const queued = [...toQueuedBlocks(this.io.takeQueued?.() || []), ...(this.isSubagent ? [] : this.drainNotifications())];
        await fitImagesIn(queued); // a pasted photo at full size: scaled now, not after the API refuses it
        if (queued.length) {
          this.pushMessage({ role: 'user', content: queued });
          continue;
        }
        // A response with nothing but thinking (or nothing at all) ends the turn with no reply on the screen: the user
        // cannot tell whether the work is done or stuck. The model is asked once, in a new user message (the
        // continuation Anthropic recommends for empty end_turn responses; the thinking-only message stays, so the
        // cached prefix does too, and the API takes it).
        if (!text && stopReason !== 'refusal' && silentEnds < 1) {
          silentEnds++;
          this.io.notice?.('The model ended its turn without a reply; asking it to go on…');
          this.pushMessage({ role: 'user', content: [{ type: 'text', text: '<system-reminder>Your previous response ended your turn without any text or tool call, so the user got no reply and cannot tell whether you are done. If the task is not finished, carry on with it; if it is, give the user your answer now.</system-reminder>' }] });
          continue;
        }
        const verify = this.config.verifyCommand;
        if (verify && !this.isSubagent && this.editsThisRun > 0) {
          this.editsThisRun = 0;
          const v = await this.runVerify(verify, signal, { attempt: verifyRounds + 1 });
          if (signal?.aborted) return tracedReturn(this.handleInterrupt(null));
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
        // A refusal (stop_reason "refusal") comes without text too, but the model did not just fall silent: it declined
        // the request, and the same request, or "go on" after it, is usually declined again. Said as such, with what
        // helps, as Claude Code does: the message reworded, or the context that led to it left out.
        if (!text) {
          this.io.notice?.(stopReason !== 'refusal' ? 'The model ended its turn without a reply.'
            : `The model declined this request (stop_reason: refusal) and gave no reply.${this.isSubagent ? '' : ' Press esc twice to go back and reword the message, or /compact or /clear to leave out the context that led to it.'}`, 'warn');
        }
        return tracedReturn({ text: finalText, interrupted: false });
      }

      const outcome = await this.runTools(toolUses, signal);
      const resultContent = [...outcome.results];
      const queued = toQueuedBlocks(this.io.takeQueued?.() || []);
      await fitImagesIn(queued);
      resultContent.push(...queued);
      if (!this.isSubagent) resultContent.push(...this.drainNotifications());
      if (outcome.interrupted) {
        resultContent.push({ type: 'text', text: INTERRUPT_TOOL_MESSAGE });
        this.pushMessage({ role: 'user', content: resultContent });
        return tracedReturn({ text: finalText, interrupted: true });
      }
      this.pushMessage({ role: 'user', content: resultContent });
      if (outcome.stop) return tracedReturn({ text: finalText, interrupted: false, rejected: true });
    }
    } catch (err) {
      traceError = err;
      throw err;
    } finally {
      this.trace?.turnEnd({
        turnId: traceTurnId,
        finalStatus: traceError ? 'error' : traceResult?.interrupted ? 'interrupted' : traceResult?.rejected ? 'rejected' : 'completed',
        interrupted: Boolean(traceResult?.interrupted),
        rejected: Boolean(traceResult?.rejected),
        error: traceError,
      });
      this.traceTurnId = previousTraceTurn;
      this.busy--;
      if (!this.busy) this.keepAlive?.plan(); // idle from here: keep what this turn cached warm
    }
  }

  shouldAutoCompact() {
    if (!this.config.autoCompactEnabled || this.messages.length <= 2) return false;
    if (this.compactFailures >= MAX_COMPACT_FAILURES) return false;
    // A count reported by another model (the user switched) is in another tokenizer's tokens: Opus counted 304k where
    // GPT had counted 207k of the same conversation, and GPT compacted at once. The next request measures it instead;
    // a conversation too long for this model is compacted on the error.
    if (this.usageModel && this.usageModel !== this.model.id) return false;
    const threshold = this.config.autoCompactThreshold(this.model, this.compactWindow);
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
  async runVerify(command, signal, { attempt = 1 } = {}) {
    const bash = this.tools.find((t) => t.name === 'Bash');
    if (!bash) return { ok: true, output: '' };
    const verifyStartedAt = Date.now();
    const tool = { name: 'Verify', summarize: () => command };
    const input = { command, timeout: this.config.bashMaxTimeout };
    const handle = this.io.toolStart?.({ id: `verify_${Date.now()}`, name: 'Verify', input }, tool, input, this) || {};
    const ctx = { ...this.makeCtx(signal), cwd: this.projectRoot, setCwd() {} };
    ctx.onProgress = (p, meta) => handle.progress?.(p, meta);
    let result;
    try {
      result = await bash.call(input, ctx);
    } catch (err) {
      handle.done?.({ isError: true, content: 'Interrupted', interrupted: true });
      const aborted = isAbort(err) || signal?.aborted;
      this.trace?.verification({ turnId: this.traceTurnId, agent: this.name, depth: this.depth, command, attempt, ok: false, aborted, duration_ms: Date.now() - verifyStartedAt, error: aborted ? null : err });
      if (aborted) return { ok: true, output: '' };
      return { ok: false, output: `Error: ${err.message}` };
    }
    const output = typeof result.content === 'string' ? result.content : '';
    const ok = !result.isError;
    handle.done?.({ ...result, display: { summary: ok ? 'Verification passed' : undefined } });
    this.trace?.verification({ turnId: this.traceTurnId, agent: this.name, depth: this.depth, command, attempt, ok, output, duration_ms: Date.now() - verifyStartedAt });
    return { ok, output: output.length > 15_000 ? `${output.slice(0, 3000)}\n...\n${output.slice(-12_000)}` : output };
  }

  async callModel(signal) {
    await this.lightenImages();
    const system = this.currentSystem();
    // The system prompt is kept with the conversation, so that a resumed one can continue behind the same
    // prompt (and so with the cache it has) instead of a freshly built one.
    if (!this.isSubagent && system !== this.recordedSystem) {
      this.recordedSystem = system;
      this.io.systemPrompt?.(system, this);
    }
    // The repair goes into the request only, done again (the same way) for every request: storing it in place of
    // the conversation merged and inserted messages, which moved the messages the checkpoints point at, so a
    // /rewind after a restart cut the conversation in the wrong place.
    const repaired = repairToolResults(normalizeMessages(this.messages));
    const fresh = repaired.recovered.filter((id) => !this.recoveredToolIds.has(id));
    if (fresh.length) {
      for (const id of fresh) this.recoveredToolIds.add(id);
      this.io.notice?.('Recovered an unfinished tool call in the conversation; continuing with an interrupted result.', 'warn');
    }
    const request = {
      model: this.model,
      system,
      messages: repaired.messages,
      tools: this.toolSchemas(),
      cacheBucket: this.isSubagent ? 'other' : 'main',
      ...(this.effort ? { effort: this.effort } : {}),
    };
    const res = await this.streamAgentRequest(request, {
      signal,
      kind: 'turn',
      cacheBucket: request.cacheBucket,
      onEvent: (ev) => this.io.streamEvent?.(ev, this),
    });
    this.lastContextTokens = contextTokens(res.usage);
    this.usageModel = request.model.id;
    this.tokensSinceUsage = 0;
    if (this.postCompactTokens === null) this.postCompactTokens = this.lastContextTokens;
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
      const safe = !!tool?.readOnly && tool.name !== 'AskUserQuestion';
      const last = batches[batches.length - 1];
      if (safe && last?.parallel) last.items.push(tu);
      else batches.push({ parallel: safe, items: [tu] });
    }
    this.io.toolBatchStart?.(toolUses, this);
    for (const batch of batches) {
      if (stop || interrupted) break;
      const run = async (tu) => {
        try {
          const r = await this.runOne(tu, signal, map, { parallel: batch.parallel });
          // Key by the tool-use object, not its provider id. A malformed provider response
          // can repeat an id; one duplicate must not overwrite the other result.
          results.set(tu, r.block);
          if (r.stop) stop = true;
        } catch (err) {
          if (isAbort(err) || signal?.aborted) {
            interrupted = true;
            results.set(tu, { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Interrupted by user' });
          } else {
            results.set(tu, { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `Error: ${err.message}` });
          }
        }
      };
      if (batch.parallel) await Promise.all(batch.items.map(run));
      else for (const tu of batch.items) { if (stop || interrupted) break; await run(tu); }
      if (signal?.aborted) interrupted = true;
    }
    for (const tu of toolUses) {
      if (results.has(tu)) continue;
      const skipped = this.trace?.toolStart({ turnId: this.traceTurnId, agent: this.name, depth: this.depth, name: tu.name, input: tu.input, parallel: false, toolUseId: tu.id });
      this.trace?.toolEnd(skipped, { skipped: true, aborted: interrupted, error: true, error_type: interrupted ? 'aborted' : 'skipped' });
    }
    const blocks = toolUses.map((tu) => results.get(tu) || {
      type: 'tool_result', tool_use_id: tu.id, is_error: true,
      content: interrupted ? 'Interrupted by user' : 'Skipped: the user rejected an earlier tool call in this batch.',
    });
    return { results: blocks, stop, interrupted };
  }

  async runOne(tu, signal, map, { parallel = false } = {}) {
    const tool = map.get(tu.name);
    const traceHandle = this.trace?.toolStart({ turnId: this.traceTurnId, agent: this.name, depth: this.depth, name: tu.name, input: tu.input, parallel, toolUseId: tu.id });
    const finish = (result, extra = {}) => {
      this.trace?.toolEnd(traceHandle, {
        ok: !result.block.is_error,
        error: Boolean(result.block.is_error),
        output: result.block.content,
        ...extra,
      });
      return result;
    };
    const fail = (content, extra = {}) => finish({ block: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content }, ...extra }, { error: true, ...extra });
    try {
      if (!tool) return fail(`Error: No such tool available: ${tu.name}`, { error_type: 'unknown_tool' });
      // A copy: validation turns numbers sent as strings into numbers, and the tool_use block must stay as it was sent
      // and saved, or a restarted session sends it differently and the prompt cache misses from there on.
      const own = tu.input && typeof tu.input === 'object' ? { ...tu.input } : (tu.input || {});
      const input = tool.normalizeInput && tu.input && typeof tu.input === 'object' ? tool.normalizeInput(own) : own;
      if (input.__invalid_json !== undefined) {
        return fail('Error: the tool input was not valid JSON (it may have been truncated by the output token limit). Try again with a smaller input, e.g. write large files in several steps.', { validation_error: true, error_type: 'invalid_json' });
      }
      const schemaErr = validateInput(tool.input_schema, input);
      if (schemaErr) return fail(`InputValidationError: ${tool.name} failed due to the following issue:\n${schemaErr}`, { validation_error: true, error_type: 'schema' });

      const ctx = this.makeCtx(signal);
      const invalid = tool.validate?.(input, ctx);
      if (invalid) {
        this.io.toolRejected?.(tu, tool, invalid, this);
        return fail(invalid, { validation_error: true, error_type: 'tool_validation' });
      }

      // Nothing is ever asked: tools run right away (a PreToolUse hook can still block one).
      if (this.hooks?.has('PreToolUse')) {
        const h = await this.hooks.run('PreToolUse', { tool_name: tool.name, tool_input: input }, { cwd: this.cwd, signal });
        for (const w of h.warnings) this.io.notice?.(w, 'warn');
        if (signal?.aborted) throw abortError();
        if (h.blocked) {
          this.io.toolRejected?.(tu, tool, h.message, this);
          return fail(`Blocked by PreToolUse hook: ${h.message}`, { error_type: 'pretooluse_blocked' });
        }
      }

      // Remember what the file looked like before this edit, so /rewind can put it back.
      if (tool.editsFiles && this.checkpoints) {
        try { const file = tool.filePath?.(input, ctx); if (file) this.checkpoints.track(file); } catch { /* never block an edit on bookkeeping */ }
      }

      this.toolUseCount++;
      const handle = this.io.toolStart?.(tu, tool, input, this) || {};
      ctx.onProgress = (p, meta) => handle.progress?.(p, meta);
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
      // Images from any tool (MCP servers, say) fit what the API takes before they join the conversation.
      if (Array.isArray(result.content)) await fitImagesIn(result.content);
      handle.done?.(result);
      let content = typeof result.content === 'string' ? (result.content || '(no output)') : result.content;
      if (content === undefined || content === null || (Array.isArray(content) && !content.length)) content = '(no output)';
      if (this.hooks?.has('PostToolUse')) {
        const h = await this.hooks.run('PostToolUse', { tool_name: tool.name, tool_input: input, tool_response: typeof content === 'string' ? content.slice(0, 20_000) : '[non-text result]' }, { cwd: this.cwd, signal });
        for (const w of h.warnings) this.io.notice?.(w, 'warn');
        const extra = [...(h.blocked ? [h.message] : []), ...h.context].join('\n');
        if (extra && typeof content === 'string') content += `\n\n<system-reminder>PostToolUse hook:\n${extra}</system-reminder>`;
      }
      let largeOutputPersisted = false;
      if (typeof content === 'string' && tool.name !== 'Read' && content.length > this.config.maxToolResultChars) {
        content = persistLargeOutput(this.projectRoot, tu.id, content);
        largeOutputPersisted = true;
      }
      if (tool.editsFiles && !result.isError) this.editsThisRun++;
      return finish({
        block: { type: 'tool_result', tool_use_id: tu.id, content, ...(result.isError ? { is_error: true } : {}) },
        stop: !!result.stopTurn,
      }, { error_type: result.isError ? 'tool_error' : null, large_output_persisted: largeOutputPersisted });
    } catch (err) {
      if (isAbort(err) || signal?.aborted) {
        this.trace?.toolEnd(traceHandle, { error: true, aborted: true, error_type: 'aborted' });
        throw abortError();
      }
      this.trace?.toolEnd(traceHandle, { error: true, error_type: err.name || 'tool_exception' });
      throw err;
    }
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

  static workStateOf(res) {
    const text = res.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return workStateFromText(text);
  }

  // Keep a valid state when the model emits one; if a legacy or malformed response is returned, retain the last
  // state from this process or the transcript instead of replacing it with unvalidated data.
  compactWorkState(res) {
    const parsed = Agent.workStateOf(res);
    if (parsed.present && !parsed.state) {
      const reason = parsed.errors.slice(0, 3).join('; ');
      this.io.notice?.(`Compaction returned an invalid structured work state${reason ? ` (${reason})` : ''}; keeping the narrative summary.`, 'warn');
    }
    if (parsed.state) this.workState = parsed.state;
    return {
      state: parsed.state || this.workState || latestWorkState(this.messages),
      warning: parsed.present && !parsed.state ? 'The structured work state failed validation during compaction. Verify the state below against the narrative summary before relying on it.' : '',
    };
  }

  // Ask the model for the summary. The request is the conversation's own request with the summary instruction
  // at its end: the same model, system prompt, tools and effort, so that the API reads the conversation from the
  // cache the turns have been filling instead of processing it all again (this is what Claude Code does; it is
  // the biggest request there is). Only if that does not give a summary (the model went on calling tools, or
  // the request is too long by the size of the instruction) the plainer request is made: a short system prompt
  // and no effort, which cannot share the cache, but is smaller and cannot be led astray by the main prompt.
  // The messages are marked for the cache only where that can be read: no request after the summary starts with
  // this history, so writing it (25% over the plain input price) pays only for reading what is already there.
  // When the cache is known to have run out, and in the plain request, only the tools and system prompt are marked.
  // While a summary is being written (compaction, /rewind's summaries) the cache needs no refresh either.
  async requestSummary(messages, options) {
    this.keepAlive?.stop();
    this.busy++;
    try {
      return await this.summaryRequest(messages, options);
    } finally {
      this.busy--;
      if (!this.busy) this.keepAlive?.plan(); // a compaction that failed left the cache as it was
    }
  }

  async summaryRequest(messages, { signal, onEvent, compactionId = null }) {
    const cacheMessages = !this.cacheExpired();
    const call = (request, options = {}) => {
      const useMessages = request.cacheMessages === undefined ? cacheMessages : request.cacheMessages;
      return this.streamAgentRequest({ model: this.model, tools: this.toolSchemas(), messages, cacheBucket: 'other', cacheMessages: useMessages, ...(this.effort ? { effort: this.effort } : {}), ...request }, {
        signal,
        kind: 'summary',
        cacheBucket: 'other',
        cacheMessages: useMessages,
        compactionId,
        onEvent,
        ...options,
      });
    };
    try {
      const res = await call({ system: this.currentSystem() });
      if (Agent.summaryOf(res)) return res;
    } catch (err) {
      if (isAbort(err) || signal?.aborted || !err.promptTooLong) throw err;
    }
    const plain = (msgs) => call({ system: SUMMARY_SYSTEM, effort: null, cacheMessages: false, messages: msgs }, { cacheOverride: { caching: false } });
    let tooLong;
    try {
      return await plain(messages);
    } catch (err) {
      if (isAbort(err) || signal?.aborted || !err.promptTooLong) throw err;
      tooLong = err;
    }
    // The history alone is over the window (one turn of very large results can do it): the summary is made from
    // less, old tool results first (as idle clearing does), then the oldest turns. Without this every later
    // request failed too, and only /clear or /rewind got the conversation going again.
    let smaller = clearOldToolResults(messages, { keep: 3, atLeast: 0, cwd: this.cwd })?.messages || messages;
    for (let i = 0; i < 4 && smaller; i++) {
      try {
        return await plain(smaller);
      } catch (err) {
        if (isAbort(err) || signal?.aborted || !err.promptTooLong) throw err;
      }
      smaller = withoutOldestHalf(smaller);
    }
    throw tooLong;
  }

  // Summarise part of the conversation, as /rewind's "Summarize from here" ('after': the messages from `index` on)
  // and "Summarize up to here" ('before': those before it) do: that part is replaced by its summary, the rest stays
  // word for word. `index` is where a prompt of the user starts a turn (a checkpoint's messageIndex); `label` is
  // that prompt, to tell the model where the part begins or ends. The request is the conversation's own with the
  // instruction at its end, so it reads the conversation from the cache (see requestSummary).
  async summarizePart(index, { part, label = '', instructions = '', signal } = {}) {
    const before = this.messages.slice(0, index);
    const after = this.messages.slice(index);
    if (!(part === 'before' ? before : after).length) throw new Error('There is nothing in that part of the conversation to summarize.');
    const compactionId = `compact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const compactionStartedAt = Date.now();
    const beforeContextTokens = this.contextEstimate;
    this.io.compactStart?.(false, this);
    await this.lightenImages(); // in place: `before` and `after` hold the same blocks
    const messages = repairToolResults(normalizeMessages([...this.messages, { role: 'user', content: [{ type: 'text', text: partialCompactPrompt(part, label, instructions) }] }])).messages;
    let res;
    try {
      res = await this.requestSummary(messages, { signal, compactionId, onEvent: (ev) => this.io.compactProgress?.(ev, this) });
    } catch (err) {
      this.trace?.compact({ turnId: this.traceTurnId, agent: this.name, depth: this.depth, part, before_context_tokens: beforeContextTokens, duration_ms: Date.now() - compactionStartedAt, error: err });
      this.io.compactEnd?.(null, this, err);
      throw err;
    }
    const summary = Agent.summaryOf(res);
    if (!summary) {
      const err = new Error(res.stopReason === 'max_tokens' ? 'The summary was cut off by the output token limit.' : 'The model returned an empty summary.');
      this.trace?.compact({ turnId: this.traceTurnId, agent: this.name, depth: this.depth, part, before_context_tokens: beforeContextTokens, duration_ms: Date.now() - compactionStartedAt, error: err });
      this.io.compactEnd?.(null, this, err);
      throw err;
    }
    const state = this.compactWorkState(res);
    const note = { role: 'user', content: [{ type: 'text', text: partialSummaryMessage(part, summary, state.state, keptUserMessages(part === 'before' ? before : after)) }] };
    this.replaceMessages(part === 'before' ? [note, ...after] : [...before, note]);
    if (part === 'before') this.cache.noteCompacted(); // from its first message on: nothing of it is cached (the start of "after" still is)
    if (part === 'after') this.todos = []; // what they were about may be summarized away; the model keeps them in the summary
    this.lastContextTokens = estimateTokens(this.messages) + estimateTokens(this.toolSchemas()) + 2000;
    this.tokensSinceUsage = 0;
    this.postCompactTokens = null;
    this.trace?.compact({ turnId: this.traceTurnId, agent: this.name, depth: this.depth, part, before_context_tokens: beforeContextTokens, after_context_tokens: this.contextEstimate, summary_chars: summary.length, work_state_valid: Boolean(state.state), duration_ms: Date.now() - compactionStartedAt });
    this.io.compactEnd?.(summary, this, null, { part });
    return summary;
  }

  // Summarise the conversation and replace it with the summary.
  async compact({ signal, auto = false, instructions = '' } = {}) {
    if (this.messages.length === 0) return null;
    const compactionId = `compact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const compactionStartedAt = Date.now();
    const beforeContextTokens = this.contextEstimate;
    this.io.compactStart?.(auto, this);
    await this.lightenImages();
    // A crash or forced restart can leave the last assistant tool_use without its result.
    // Send an explicit interrupted result in the summary request so compaction itself can recover.
    const messages = repairToolResults(normalizeMessages([...this.messages, { role: 'user', content: [{ type: 'text', text: compactPrompt(instructions) }] }])).messages;
    let res;
    try {
      res = await this.requestSummary(messages, { signal, compactionId, onEvent: (ev) => this.io.compactProgress?.(ev, this) });
    } catch (err) {
      this.trace?.compact({ turnId: this.traceTurnId, agent: this.name, depth: this.depth, auto, before_context_tokens: beforeContextTokens, duration_ms: Date.now() - compactionStartedAt, error: err });
      this.io.compactEnd?.(null, this, err);
      throw err;
    }
    const summary = Agent.summaryOf(res);
    if (!summary) {
      const err = new Error(res.stopReason === 'max_tokens' ? 'Compaction failed: the summary was cut off by the output token limit.' : 'Compaction failed: the model returned an empty summary.');
      this.trace?.compact({ turnId: this.traceTurnId, agent: this.name, depth: this.depth, auto, before_context_tokens: beforeContextTokens, duration_ms: Date.now() - compactionStartedAt, error: err });
      this.io.compactEnd?.(null, this, err);
      throw err;
    }
    const state = this.compactWorkState(res);
    const todoNote = this.todos.length ? `\n\n<system-reminder>Current todo list:\n${this.todos.map((t) => `- [${t.status}] ${t.content}`).join('\n')}</system-reminder>` : '';
    const userMessages = keptUserMessages(this.messages);
    this.replaceMessages([{ role: 'user', content: [{ type: 'text', text: continuationMessage(summary, { auto, workState: state.state, workStateWarning: state.warning, userMessages }) + todoNote }] }]);
    this.cache.noteCompacted();
    await this.refreshSystemPrompt?.(); // the conversation starts over: it may start from a freshly built system prompt
    this.fileState.clear();
    if (!this.isSubagent) this.checkpoints?.markConversationStale(); // the checkpoints are the main conversation's: a sub-agent's own compaction does not end them
    this.lastContextTokens = estimateTokens(this.messages) + estimateTokens(this.toolSchemas()) + 2000;
    this.tokensSinceUsage = 0;
    this.postCompactTokens = null; // measured on the next request
    this.compactFailures = 0;
    this.trace?.compact({ turnId: this.traceTurnId, agent: this.name, depth: this.depth, auto, before_context_tokens: beforeContextTokens, after_context_tokens: this.contextEstimate, summary_chars: summary.length, work_state_valid: Boolean(state.state), duration_ms: Date.now() - compactionStartedAt });
    this.io.compactEnd?.(summary, this);
    return summary;
  }
}
