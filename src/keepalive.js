// Keeping the conversation's prompt cache warm while the user is away.
//
// With the 1-hour TTL, a request after more than an hour of pause writes the whole conversation into the cache
// again: on Opus through the gateway $8 per million tokens instead of the $0.20 a cache read costs (about $1.20
// for 150k tokens). A read refreshes the TTL, so a request that reads the cached prefix shortly before it runs out
// keeps it for another hour, for 1/40 of a rewrite. That request is the conversation's last request again (the same
// system prompt, tools, effort and messages, so the same cache entry) with max_tokens 1. Measured on Opus 5.5
// through the gateway (2026-10-25): it read all 19,440 cached tokens, wrote none and produced one output token, and
// the next turn read the cache as usual.
//
// Only for Claude models: GPT through the gateway is cached upstream for hours anyway (traces 2026-10-15..25:
// 8 of 9 requests after a 2-4 hour pause read the cache), and a miss there costs plain input, not a write.
// The pause it covers is limited (Config.cacheKeepAliveHours, 8 by default): for a conversation that is not
// continued, the 8 refreshes of 8 hours cost a fifth of the one rewrite they would have saved.

import { buildParams } from './api.js';
import { fingerprint, TTL_MS } from './cache.js';
import { formatUsd } from './gateway.js';

const LEAD_MS = 5 * 60_000; // refresh this long before the cache would run out
const SAFETY_MS = 60_000; // ... and not at all once it is closer than this to running out (the computer slept)
const MIN_TOKENS = 20_000; // a smaller conversation is cheap to write again: not worth a request an hour

const sameFingerprint = (a, b) => Boolean(a && b) && ['model', 'system', 'tools', 'effort', 'thinking'].every((k) => a[k] === b[k]);

export class CacheKeepAlive {
  constructor(agent) {
    this.agent = agent;
    this.timer = null;
    this.inflight = null; // the AbortController of a refresh being sent
    this.pauseStart = 0; // when the conversation's last real request started: the pause counts from there
    this.done = { count: 0, cost: 0, failed: null }; // over the session, for /cost
  }

  get hours() { return this.agent.config.cacheKeepAliveHours; }

  // Whether there is a cache to keep warm now: the main conversation, idle, on a Claude model with the 1-hour TTL,
  // with a warm cache of some size, and a next request that will use the same entry.
  applies(now = Date.now()) {
    const a = this.agent;
    const cfg = a.config;
    if (a.isSubagent || a.busy > 0 || !(this.hours > 0)) return false;
    const id = a.model?.id || '';
    if (!/^claude-/i.test(id) || cfg.promptCachingDisabled()) return false;
    if (!a.cache.isWarm(now) || a.cache.ttl !== '1h' || (a.cache.expected || 0) < MIN_TOKENS) return false;
    // A raised effort ends with the next user request, and with it this entry (the effort is part of its key).
    if (cfg.effortBoost && !cfg.effortBoostKeepNext) return false;
    return true;
  }

  // A real request of the conversation started at `at`: a pause, if one comes, counts from there.
  noteRequest(at = Date.now()) {
    this.pauseStart = at;
  }

  // Plan the next refresh: LEAD_MS before the cache runs out, while the pause is within the hours it covers.
  plan() {
    this.clearTimer();
    if (!this.applies()) return;
    const cache = this.agent.cache;
    const due = cache.expiresAt - LEAD_MS;
    // Not known (a state saved without it): from the request that left the cache, the latest it can be.
    this.pauseStart ||= cache.expiresAt - TTL_MS[cache.ttl];
    if (due - this.pauseStart > this.hours * 3_600_000) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh().catch(() => { /* reported inside */ });
    }, Math.max(1000, due - Date.now()));
    this.timer.unref?.(); // a print-mode run, or an exit, does not wait for it
  }

  // The user is back (a turn starts), or the conversation changed: no refresh now, and none in flight.
  stop() {
    this.clearTimer();
    if (this.inflight) this.inflight.abort('user');
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async refresh() {
    const a = this.agent;
    const now = Date.now();
    // Too late (a computer that slept, a timer that ran late): the cache is gone or about to go, and a request now
    // would write it all.
    if (!this.applies(now) || now > a.cache.expiresAt - SAFETY_MS) return;
    const request = a.keepAliveRequest();
    if (!request) return;
    // The entry the last request left, or nothing: with another system prompt, tool list or effort the refresh
    // would write the whole conversation, and the next request would not use it either.
    if (!sameFingerprint(fingerprint(buildParams(a.config, request)), a.cache.prev)) return;
    const expected = a.cache.expected;
    const ac = new AbortController();
    this.inflight = ac;
    // Not sent again (retried) once the cache could have run out: then it would be a rewrite, not a refresh.
    const deadline = setTimeout(() => ac.abort('deadline'), Math.max(0, a.cache.expiresAt - SAFETY_MS - now));
    deadline.unref?.();
    try {
      const res = await a.streamAgentRequest(request, { signal: ac.signal, kind: 'keepalive', waitForRateLimit: false });
      this.done.count++;
      this.done.cost += res.cost || 0;
      const read = res.usage?.cache_read_input_tokens || 0;
      if (read < expected * 0.5) {
        const wrote = res.usage?.cache_creation_input_tokens || 0;
        this.done.failed = `missed the cache (wrote ${wrote} tokens)`;
        a.io.notice?.(`Refreshing the prompt cache missed it (it wrote ${Math.round(wrote / 1000)}k tokens again); no more refreshes until your next message.`, 'warn');
        return;
      }
      this.plan();
    } catch (err) {
      if (ac.signal.reason === 'user') return; // the next request reads the cache itself
      this.done.failed = ac.signal.reason === 'deadline' ? 'took too long' : err.message;
      const until = new Date(a.cache.expiresAt).toTimeString().slice(0, 5);
      a.io.notice?.(`Could not refresh the prompt cache (${this.done.failed}); it runs out at ${until}.`, 'warn');
    } finally {
      clearTimeout(deadline);
      if (this.inflight === ac) this.inflight = null;
    }
  }

  // For /cost: null when nothing was done.
  describe() {
    const d = this.done;
    if (!d.count && !d.failed) return null;
    return `kept warm while idle: ${d.count} refresh${d.count === 1 ? '' : 'es'}${d.cost ? ` (${formatUsd(d.cost)})` : ''}${d.failed ? `, last failure: ${d.failed}` : ''}`;
  }
}
