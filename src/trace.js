// Low-overhead runtime telemetry. Trace records are deliberately structural: they keep
// fingerprints, counts and sizes, never prompts, tool arguments or tool output bodies.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectDir } from './session.js';

const TRACE_VERSION = 1;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_RECENT = 200;
const MAX_KEYS = 64;

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const positive = (value, fallback = 0) => Math.max(0, finite(value, fallback));
const short = (value, max = 160) => String(value ?? '').slice(0, max);

export function fingerprintText(value) {
  return crypto.createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 16);
}

// This is intentionally a shape, not a redacted copy. A password value or a file body must
// never reach the trace even if a future tool adds a new parameter.
export function inputShape(value, depth = 0) {
  if (value === null) return { type: 'null' };
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'string') return { type: 'string', chars: value.length };
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    const result = { type: 'object', keys: keys.slice(0, MAX_KEYS), key_count: keys.length };
    if (depth < 1) {
      // Nested values are represented only by their type/size. This helps diagnose malformed
      // requests without retaining a nested token, cookie, command or file body.
      result.fields = Object.fromEntries(keys.slice(0, 16).map((key) => [key, inputShape(value[key], depth + 1)]));
    }
    return result;
  }
  return { type: typeof value };
}

export function errorShape(error) {
  if (!error) return null;
  return {
    name: short(error.name || 'Error', 80),
    status: Number.isFinite(error.status) ? error.status : undefined,
    retryable: typeof error.retryable === 'boolean' ? error.retryable : undefined,
    overloaded: typeof error.overloaded === 'boolean' ? error.overloaded : undefined,
    prompt_too_long: typeof error.promptTooLong === 'boolean' ? error.promptTooLong : undefined,
  };
}

function outputStats(content) {
  if (typeof content === 'string') return { chars: content.length, tokens_estimate: Math.ceil(content.length / 4) };
  if (content == null) return { chars: 0, tokens_estimate: 0 };
  if (Array.isArray(content)) {
    const chars = content.reduce((n, block) => n + (typeof block?.text === 'string' ? block.text.length : 0), 0);
    return { chars, tokens_estimate: Math.ceil(chars / 4), blocks: content.length };
  }
  return { chars: 0, tokens_estimate: 0 };
}

function emptyTool(name) {
  return {
    name,
    calls: 0,
    successes: 0,
    failures: 0,
    validation_errors: 0,
    aborts: 0,
    skipped: 0,
    parallel_calls: 0,
    duration_ms: 0,
    output_chars: 0,
    output_tokens_estimate: 0,
    large_output_persisted: 0,
  };
}

function cloneTool(tool) { return { ...tool }; }

export class RuntimeTrace {
  constructor({ cwd = process.cwd(), sessionId = '', enabled = true, file = null, dir = null, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.cwd = cwd;
    this.enabled = enabled !== false;
    this.dir = dir ? path.resolve(dir) : path.join(projectDir(cwd), 'traces');
    this.maxBytes = Math.max(100_000, finite(maxBytes, DEFAULT_MAX_BYTES));
    this._explicitFile = file ? path.resolve(file) : null;
    this._file = this._explicitFile;
    this.sessionId = '';
    this.sequence = 0;
    this.turnSequence = 0;
    this.requestSequence = 0;
    this.toolSequence = 0;
    this.turns = new Map();
    this.requests = new Map();
    this.tools = new Map();
    this.recentEvents = [];
    this.stats = this.newStats();
    if (sessionId) this.setSessionId(sessionId);
  }

  newStats() {
    return {
      turns: 0,
      requests: 0,
      request_successes: 0,
      request_failures: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cache_hits: 0,
      cache_misses: 0,
      compactions: 0,
      compaction_failures: 0,
      verification_runs: 0,
      verification_passes: 0,
      verification_failures: 0,
      verification_aborts: 0,
    };
  }

  setSessionId(sessionId) {
    const next = String(sessionId || '').trim();
    if (next === this.sessionId && (this._file || !next)) return this.file;
    this.sessionId = next;
    this._file = this._explicitFile || (next ? path.join(this.dir, `${next}.jsonl`) : null);
    this.turns.clear();
    this.requests.clear();
    this.tools.clear();
    this.recentEvents = [];
    this.stats = this.newStats();
    return this.file;
  }

  get file() { return this.enabled ? this._file : null; }

  // All writes are best effort. Telemetry must not turn a successful agent request into a
  // failed request because a project directory is read-only or has been removed.
  append(type, fields = {}) {
    if (!this.enabled) return null;
    const record = {
      schema_version: TRACE_VERSION,
      type,
      time: new Date().toISOString(),
      session_id: this.sessionId,
      ...fields,
    };
    this.recentEvents.push(record);
    if (this.recentEvents.length > MAX_RECENT) this.recentEvents.shift();
    if (!this._file) return record;
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      this.rotateIfNeeded();
      fs.appendFileSync(this._file, JSON.stringify(record) + '\n');
    } catch {
      // A trace is observability, never a dependency of the coding agent.
    }
    return record;
  }

  rotateIfNeeded() {
    if (!this._file) return;
    let size = 0;
    try { size = fs.statSync(this._file).size; } catch { return; }
    if (size < this.maxBytes) return;
    const rotated = `${this._file}.1`;
    try { fs.rmSync(rotated, { force: true }); } catch { /* best effort */ }
    try { fs.renameSync(this._file, rotated); } catch { /* the next append may still work */ }
  }

  turnStart({ agent = 'main', depth = 0, content = null } = {}) {
    if (!this.enabled) return null;
    const id = `turn_${Date.now().toString(36)}_${(++this.turnSequence).toString(36)}`;
    const startedAt = Date.now();
    const state = {
      id,
      agent: short(agent, 80),
      depth: finite(depth),
      startedAt,
      requests: 0,
      tools: new Map(),
      compacted: false,
      compactions: 0,
      verifications: [],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    this.turns.set(id, state);
    this.stats.turns++;
    const blocks = Array.isArray(content) ? content : content == null ? [] : [content];
    const textChars = blocks.reduce((n, b) => n + (typeof b === 'string' ? b.length : typeof b?.text === 'string' ? b.text.length : 0), 0);
    this.append('turn_start', {
      turn_id: id,
      agent: state.agent,
      depth: state.depth,
      prompt_chars: textChars,
      prompt_blocks: blocks.length,
    });
    return id;
  }

  turnEnd({ turnId, finalStatus = 'completed', interrupted = false, rejected = false, error = null } = {}) {
    if (!this.enabled || !turnId) return null;
    const state = this.turns.get(turnId);
    if (!state) return null;
    const tools = [...state.tools.values()].map(cloneTool);
    const record = this.append('turn_end', {
      turn_id: turnId,
      agent: state.agent,
      depth: state.depth,
      duration_ms: Math.max(0, Date.now() - state.startedAt),
      final_status: short(finalStatus, 80),
      interrupted: Boolean(interrupted),
      rejected: Boolean(rejected),
      error: errorShape(error),
      requests: state.requests,
      input_tokens: state.usage.input_tokens,
      output_tokens: state.usage.output_tokens,
      cache_read_tokens: state.usage.cache_read_input_tokens,
      cache_write_tokens: state.usage.cache_creation_input_tokens,
      compacted: state.compacted,
      compactions: state.compactions,
      verification: state.verifications,
      tool_calls: tools,
    });
    this.turns.delete(turnId);
    return record;
  }

  requestStart({ turnId = null, agent = 'main', depth = 0, kind = 'turn', model = '', effort = null, context_tokens = 0, message_tokens = 0, system_tokens = 0, tool_tokens = 0, message_count = 0, cache = null, fingerprint = null, compaction_id = null } = {}) {
    if (!this.enabled) return null;
    const id = `request_${Date.now().toString(36)}_${(++this.requestSequence).toString(36)}`;
    const state = this.turns.get(turnId);
    const request = {
      id,
      turnId,
      startedAt: Date.now(),
      retries: 0,
      rate_limit_waits: 0,
      rate_limit_wait_ms: 0,
      agent: short(agent, 80),
      depth: finite(depth),
      kind: short(kind, 40),
    };
    this.requests.set(id, request);
    if (state) state.requests++;
    this.append('request_start', {
      request_id: id,
      turn_id: turnId,
      request_index: state?.requests || null,
      agent: request.agent,
      depth: request.depth,
      kind: request.kind,
      model: short(model, 160),
      effort: effort == null ? null : short(effort, 40),
      context_tokens: positive(context_tokens),
      message_tokens: positive(message_tokens),
      system_tokens: positive(system_tokens),
      tool_tokens: positive(tool_tokens),
      message_count: positive(message_count),
      cache: cache && typeof cache === 'object' ? {
        bucket: cache.bucket ? short(cache.bucket, 20) : undefined,
        messages: cache.messages === undefined ? undefined : Boolean(cache.messages),
        caching: cache.caching === undefined ? undefined : Boolean(cache.caching),
        ttl: cache.ttl ? short(cache.ttl, 8) : undefined,
      } : null,
      prompt_fingerprint: fingerprint && typeof fingerprint === 'object' ? { ...fingerprint } : null,
      compaction_id: compaction_id || null,
    });
    return request;
  }

  requestEvent(handle, event) {
    if (!this.enabled || !handle || !event) return;
    if (event.type === 'retry') handle.retries++;
    if (event.type === 'rate_limit_wait') {
      handle.rate_limit_waits++;
      handle.rate_limit_wait_ms += positive(event.delayMs || event.waitedMs);
    }
  }

  requestEnd(handle, { usage = {}, cache = null, model = '', stopReason = null, context_tokens = 0, error = null, cacheMiss = null } = {}) {
    if (!this.enabled || !handle) return null;
    const u = usage || {};
    const ok = !error;
    const read = positive(u.cache_read_input_tokens);
    const write = positive(u.cache_creation_input_tokens);
    const state = this.turns.get(handle.turnId);
    const miss = cacheMiss ? { cause: short(cacheMiss.cause, 180), expected: positive(cacheMiss.expected), read: positive(cacheMiss.read) } : null;
    const record = this.append('request_end', {
      request_id: handle.id,
      turn_id: handle.turnId,
      request_index: state?.requests || null,
      agent: handle.agent,
      depth: handle.depth,
      kind: handle.kind,
      duration_ms: Math.max(0, Date.now() - handle.startedAt),
      model: short(model, 160),
      ok,
      stop_reason: stopReason == null ? null : short(stopReason, 40),
      error: errorShape(error),
      retry_count: handle.retries,
      rate_limit_waits: handle.rate_limit_waits,
      rate_limit_wait_ms: handle.rate_limit_wait_ms,
      context_tokens: positive(context_tokens),
      input_tokens: positive(u.input_tokens),
      output_tokens: positive(u.output_tokens),
      cache_read_tokens: read,
      cache_write_tokens: write,
      cache_hit: read > 0,
      cache_miss: miss,
      cache: cache && typeof cache === 'object' ? {
        caching: Boolean(cache.caching),
        ttl: short(cache.ttl, 8),
        fingerprint: cache.fingerprint && typeof cache.fingerprint === 'object' ? { ...cache.fingerprint } : null,
      } : null,
    });
    this.requests.delete(handle.id);
    this.stats.requests++;
    if (ok) this.stats.request_successes++; else this.stats.request_failures++;
    this.stats.input_tokens += positive(u.input_tokens);
    this.stats.output_tokens += positive(u.output_tokens);
    this.stats.cache_read_tokens += read;
    this.stats.cache_write_tokens += write;
    if (read > 0) this.stats.cache_hits++;
    if (miss) this.stats.cache_misses++;
    if (state) {
      state.usage.input_tokens += positive(u.input_tokens);
      state.usage.output_tokens += positive(u.output_tokens);
      state.usage.cache_read_input_tokens += read;
      state.usage.cache_creation_input_tokens += write;
    }
    return record;
  }

  toolStart({ turnId = null, agent = 'main', depth = 0, name = '', input = null, parallel = false, toolUseId = null } = {}) {
    if (!this.enabled) return null;
    const id = `tool_${Date.now().toString(36)}_${(++this.toolSequence).toString(36)}`;
    const handle = { id, turnId, name: short(name, 120), startedAt: Date.now(), parallel: Boolean(parallel), agent: short(agent, 80), depth: finite(depth) };
    this.append('tool_start', {
      tool_id: id,
      tool_use_id: toolUseId || null,
      turn_id: turnId,
      agent: handle.agent,
      depth: handle.depth,
      tool: handle.name,
      parallel: handle.parallel,
      input: inputShape(input),
    });
    return handle;
  }

  toolEnd(handle, { ok = false, error = false, validation_error = false, aborted = false, skipped = false, output = null, large_output_persisted = false, error_type = null } = {}) {
    if (!this.enabled || !handle) return null;
    const stats = this.tools.get(handle.name) || emptyTool(handle.name);
    const out = outputStats(output);
    const success = Boolean(ok) && !error && !aborted && !skipped;
    stats.calls++;
    if (success) stats.successes++; else stats.failures++;
    if (validation_error) stats.validation_errors++;
    if (aborted) stats.aborts++;
    if (skipped) stats.skipped++;
    if (handle.parallel) stats.parallel_calls++;
    stats.duration_ms += Math.max(0, Date.now() - handle.startedAt);
    stats.output_chars += out.chars;
    stats.output_tokens_estimate += out.tokens_estimate;
    if (large_output_persisted) stats.large_output_persisted++;
    this.tools.set(handle.name, stats);
    const state = this.turns.get(handle.turnId);
    if (state) {
      const turnTool = state.tools.get(handle.name) || emptyTool(handle.name);
      turnTool.calls++;
      if (success) turnTool.successes++; else turnTool.failures++;
      if (validation_error) turnTool.validation_errors++;
      if (aborted) turnTool.aborts++;
      if (skipped) turnTool.skipped++;
      if (handle.parallel) turnTool.parallel_calls++;
      turnTool.duration_ms += Math.max(0, Date.now() - handle.startedAt);
      turnTool.output_chars += out.chars;
      turnTool.output_tokens_estimate += out.tokens_estimate;
      if (large_output_persisted) turnTool.large_output_persisted++;
      state.tools.set(handle.name, turnTool);
    }
    this.append('tool_end', {
      tool_id: handle.id,
      turn_id: handle.turnId,
      agent: handle.agent,
      depth: handle.depth,
      tool: handle.name,
      duration_ms: Math.max(0, Date.now() - handle.startedAt),
      ok: success,
      error: Boolean(error),
      validation_error: Boolean(validation_error),
      aborted: Boolean(aborted),
      skipped: Boolean(skipped),
      error_type: error_type ? short(error_type, 100) : null,
      output_chars: out.chars,
      output_tokens_estimate: out.tokens_estimate,
      large_output_persisted: Boolean(large_output_persisted),
    });
    return stats;
  }

  compact({ turnId = null, agent = 'main', depth = 0, auto = false, part = null, before_context_tokens = 0, after_context_tokens = 0, summary_chars = 0, work_state_valid = null, duration_ms = 0, error = null } = {}) {
    if (!this.enabled) return null;
    const state = this.turns.get(turnId);
    if (!error) {
      this.stats.compactions++;
      if (state) { state.compacted = true; state.compactions++; }
    } else this.stats.compaction_failures++;
    return this.append('compaction', {
      turn_id: turnId,
      agent: short(agent, 80),
      depth: finite(depth),
      auto: Boolean(auto),
      part: part || null,
      before_context_tokens: positive(before_context_tokens),
      after_context_tokens: positive(after_context_tokens),
      summary_chars: positive(summary_chars),
      work_state_valid: work_state_valid == null ? null : Boolean(work_state_valid),
      duration_ms: positive(duration_ms),
      ok: !error,
      error: errorShape(error),
    });
  }

  verification({ turnId = null, agent = 'main', depth = 0, command = '', attempt = 1, ok = false, aborted = false, output = '', duration_ms = 0, error = null } = {}) {
    if (!this.enabled) return null;
    const state = this.turns.get(turnId);
    const result = {
      attempt: positive(attempt, 1),
      ok: Boolean(ok) && !aborted,
      aborted: Boolean(aborted),
      duration_ms: positive(duration_ms),
      output_chars: typeof output === 'string' ? output.length : 0,
      output_tokens_estimate: outputStats(output).tokens_estimate,
      command_fingerprint: fingerprintText(command),
      command_chars: String(command || '').length,
      error: errorShape(error),
    };
    this.stats.verification_runs++;
    if (result.aborted) this.stats.verification_aborts++;
    else if (result.ok) this.stats.verification_passes++;
    else this.stats.verification_failures++;
    state?.verifications.push(result);
    return this.append('verification', { turn_id: turnId, agent: short(agent, 80), depth: finite(depth), ...result });
  }

  summary() {
    const tools = [...this.tools.values()].map((tool) => {
      const calls = tool.calls || 0;
      return { ...tool, success_rate: calls ? tool.successes / calls : null, avg_duration_ms: calls ? tool.duration_ms / calls : 0, avg_output_tokens_estimate: calls ? tool.output_tokens_estimate / calls : 0 };
    });
    const verificationTotal = this.stats.verification_runs;
    return {
      enabled: this.enabled,
      file: this.file,
      session_id: this.sessionId,
      ...this.stats,
      cache_hit_rate: this.stats.requests ? this.stats.cache_hits / this.stats.requests : null,
      verification_pass_rate: verificationTotal ? this.stats.verification_passes / verificationTotal : null,
      tools,
      recent_events: this.recentEvents.length,
    };
  }

  recent(limit = 20) {
    return this.recentEvents.slice(-Math.max(1, Math.min(200, Number(limit) || 20)));
  }
}
