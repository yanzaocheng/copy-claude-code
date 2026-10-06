// Prompt caching, the way Claude Code does it (https://code.claude.com/docs/en/prompt-caching):
//   - cache_control markers go on the tools, the system prompt and the newest message (see api.js);
//   - there are two TTL buckets: "main" is the conversation itself, "other" is everything else
//     (sub-agents, compaction, side queries). Each is 5 minutes by default, or 1 hour when asked for;
//   - the whole thing can be switched off;
//   - what the API reports (cache_read_input_tokens, cache_creation_input_tokens) is tracked here, so
//     that /cost can say how much of the input came from the cache and why a request missed it.

import crypto from 'node:crypto';

export const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 };

// A TTL setting is "5m" or "1h"; Claude Code ignores any other value, and so does this.
export function normalizeTtl(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '5m' || v === '1h' ? v : null;
}

// The 5-minute TTL is the API's default, so it is sent without a ttl field: the request is then the same as
// it always was, and endpoints that do not know the field are not bothered by it.
export function cacheControl(ttl) {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

const sha = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

// What decides whether two requests can share a cache: the model, the system prompt, the tool definitions and
// the parameters that are part of the key. (The messages are compared by the caller's own notes: see noteRewrite.)
export function fingerprint(params) {
  const system = (params.system || []).map((b) => b.text).join('\n');
  const tools = JSON.stringify((params.tools || []).map(({ cache_control, ...rest }) => rest));
  return {
    model: params.model,
    system: sha(system),
    tools: sha(tools),
    effort: params.output_config?.effort || null,
    thinking: JSON.stringify(params.thinking || null),
  };
}

// The TTL a request ended up with, and whether it carries any marker at all.
export function cachePlanOf(params) {
  const marks = [
    ...(params.system || []).map((b) => b.cache_control),
    ...(params.tools || []).map((t) => t.cache_control),
    ...(params.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content.map((b) => b.cache_control) : [])),
  ].filter(Boolean);
  return { caching: marks.length > 0, ttl: marks.some((m) => m.ttl === '1h') ? '1h' : '5m' };
}

// Below this size the API does not cache anything (the smallest minimum of any model).
const MIN_CACHED = 1024;
// A request that read less than this share of what the previous one left in the cache missed.
const MISS_BELOW = 0.5;

const human = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export class CacheStats {
  constructor() {
    this.requests = 0; // requests recorded (compaction included)
    this.input = 0; // input tokens that were not cached
    this.read = 0; // input tokens read from the cache
    this.write = 0; // input tokens written to the cache
    this.write1h = 0; // ... of which with the 1-hour TTL
    this.misses = 0;
    this.lastMiss = null; // {n, cause, expected, read}
    this.newConversation();
  }

  // The next request starts a conversation: there is nothing that it should find in the cache.
  newConversation() {
    this.expected = null; // tokens the previous request left cached; the next one should read about that many
    this.prev = null; // fingerprint of the previous request
    this.expiresAt = 0; // when what the previous request left in the cache runs out
    this.ttl = '5m';
    this.model = null; // the model that answered the last request
    this.effort = null;
  }

  // The history was cut or replaced (compaction, /rewind, /resume): the next request will not find the old
  // one in the cache, and that is expected, not a miss.
  noteRewrite() {
    this.expected = null;
  }

  // One finished request. `at` is when it started: the TTL counts from there, not from the end of the reply.
  record({ usage, fingerprint: fp = null, ttl = '5m', caching = true, at = Date.now() }) {
    const u = usage || {};
    const input = u.input_tokens || 0;
    const read = u.cache_read_input_tokens || 0;
    const write = u.cache_creation_input_tokens || 0;
    this.requests++;
    this.input += input;
    this.read += read;
    this.write += write;
    this.write1h += u.cache_creation?.ephemeral_1h_input_tokens || 0;
    if (caching && this.expected != null && this.expected >= MIN_CACHED && read < this.expected * MISS_BELOW) {
      this.misses++;
      this.lastMiss = { n: this.requests, cause: this.causeOf(fp, at), expected: this.expected, read };
    }
    // Whatever this request read or wrote is a prefix of the next one.
    this.expected = caching ? read + write : null;
    this.expiresAt = at + TTL_MS[ttl];
    this.ttl = ttl;
    if (fp) {
      this.prev = fp;
      this.model = fp.model;
      this.effort = fp.effort;
    }
  }

  causeOf(fp, at) {
    const p = this.prev;
    if (p && fp) {
      if (p.model !== fp.model) return `the model changed (${p.model} → ${fp.model})`;
      if (p.system !== fp.system) return 'the system prompt changed';
      if (p.tools !== fp.tools) return 'the tool definitions changed';
      if (p.effort !== fp.effort) return `the effort changed (${p.effort || 'auto'} → ${fp.effort || 'auto'})`;
      if (p.thinking !== fp.thinking) return 'the thinking settings changed';
    }
    if (at >= this.expiresAt) return `the cache had expired (${human(at - (this.expiresAt - TTL_MS[this.ttl]))} since the previous request, TTL ${this.ttl})`;
    return 'earlier messages changed, or the endpoint does not cache';
  }

  // Is there something worth keeping in the cache right now? Not when nothing was cached, or it has expired.
  isWarm(now = Date.now()) {
    return this.expected != null && this.expected >= MIN_CACHED && now < this.expiresAt;
  }

  get hitRatio() {
    const total = this.input + this.read + this.write;
    return total > 0 ? this.read / total : null;
  }

  // The lines /cost shows for this conversation's cache.
  describe(now = Date.now()) {
    if (!this.requests) return [];
    if (!this.read && !this.write) return ['Prompt cache:  nothing reported (the endpoint does not report cache use, or does not cache)'];
    const pct = this.hitRatio == null ? '–' : `${Math.round(this.hitRatio * 100)}%`;
    const state = this.isWarm(now) ? `warm for ${human(this.expiresAt - now)} more` : 'cold';
    const lines = [`Prompt cache:  ${pct} of the input came from the cache · ${this.misses} miss${this.misses === 1 ? '' : 'es'} · ${state} (TTL ${this.ttl})`];
    if (this.lastMiss) lines.push(`  last miss: request ${this.lastMiss.n}, probably because ${this.lastMiss.cause}`);
    return lines;
  }
}
