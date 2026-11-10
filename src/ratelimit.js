// Rate limits: reading when a limit resets from the response headers, deciding how long to wait
// before retrying, and the wording shown to the user.
//
// Gateway requests can be limited by rolling windows, 5 hours and 7 days. When one is used up the
// gateway answers 429, and the anthropic-ratelimit-unified-* headers say which window it was and when it
// resets (epoch seconds). Waiting for such a reset takes hours, so it is a pause that ends by itself
// rather than one of the few quick retries used for transient errors.

export const LONG_WAIT_MS = 30_000; // waits this long or longer are shown as "rate limit reached, resuming at ..."
export const MAX_RETRY_AFTER_MS = 5 * 60_000; // when waiting for limits is off, a longer Retry-After is reported instead
const RESUME_MARGIN_MS = 2_000; // wake a little after the announced reset (clock skew)
const RESUME_JITTER_MS = 8_000; // and spread out agents that were all waiting for the same reset
const SLEEP_TICK_MS = 15_000; // long sleeps are cut into pieces so a suspended computer is noticed on waking
const MIN_429_ATTEMPTS = 10; // quick retries for a 429 that announces a short wait

// Replaceable clock, so tests can run an hours-long wait instantly.
export const timing = {
  now: () => Date.now(),
  sleep: (ms, signal) => abortableSleep(ms, signal),
};

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (signal?.aborted) return reject(aborted());
    const onAbort = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Sleep until the wall clock reaches `deadline` (ms since epoch). The wait is made of short sleeps
// and the clock is checked after each one: timers do not advance while the computer is suspended,
// so a single long timeout could end hours after the limit was lifted.
export async function sleepUntil(deadline, signal) {
  for (;;) {
    const left = deadline - timing.now();
    if (left <= 0) return;
    await timing.sleep(Math.min(left, SLEEP_TICK_MS), signal);
  }
}

// Milliseconds a "Retry-After" header asks us to wait (delta-seconds or an HTTP date), or null.
export function parseRetryAfter(value, now = Date.now()) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

// Wait before quick retry number `attempt` (1-based): exponential backoff with jitter, or the
// server's Retry-After when that is longer.
export function retryDelay(attempt, retryAfterMs = null, rand = Math.random) {
  const backoff = Math.min(32_000, 1000 * 2 ** (attempt - 1)) + Math.floor(rand() * 500);
  return retryAfterMs == null ? backoff : Math.max(backoff, retryAfterMs);
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

// Epoch seconds, or milliseconds if the number is too big to be seconds. null if not a time.
function epochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? n : n * 1000;
}

const WINDOW_LABELS = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'weekly Opus limit',
  seven_day_sonnet: 'weekly Sonnet limit',
  overage: 'extra usage limit',
};

// What a 429's headers say about the limit:
//   {label, claim, status, waitMs, resetAt, source}
// waitMs is how long until a retry can succeed (null when the server did not say) and resetAt the
// moment that is (ms since epoch). When both a unified reset and a Retry-After are present the
// longer wait is taken: retrying early only gets rejected again.
export function parseRateLimit(headers, now = Date.now()) {
  const h = (name) => headerValue(headers, name) || null;
  const status = h('anthropic-ratelimit-unified-status');
  const overage = h('anthropic-ratelimit-unified-overage-status');
  const claim = h('anthropic-ratelimit-unified-representative-claim');
  const unifiedReset = epochMs(h('anthropic-ratelimit-unified-reset'));
  const retryAfter = parseRetryAfter(h('retry-after'), now);

  const found = [];
  // The official client only treats the reset as a wait when the window is rejected and extra
  // usage (overage) cannot take over.
  if (status === 'rejected' && (!overage || overage === 'rejected') && unifiedReset !== null) {
    found.push({ source: 'unified-reset', waitMs: Math.max(0, unifiedReset - now) });
  }
  if (retryAfter !== null) found.push({ source: 'retry-after', waitMs: retryAfter });
  const best = found.sort((a, b) => b.waitMs - a.waitMs)[0] || null;

  const label = WINDOW_LABELS[claim] || (claim?.startsWith('seven_day') ? 'weekly limit' : 'rate limit');
  return {
    label, claim, status,
    waitMs: best ? best.waitMs : null,
    resetAt: best ? now + best.waitMs : null,
    source: best ? best.source : null,
  };
}

// "45s", "12m 30s", "2h 13m", "5d 13h". From an hour up it is rounded to the nearest minute, so a
// reset 2h 59m 59.6s away reads "3h 0m", in line with the clock time shown next to it.
export function humanDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const m = Math.round(s / 60);
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// Local time of day, with the date when it is not today: "21:05", "tomorrow 02:15", "Oct 9 21:05".
export function formatClock(ms, now = Date.now()) {
  const d = new Date(ms);
  const hhmm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = (t) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(ms) - day(now)) / 86_400_000);
  if (days === 0) return hhmm;
  if (days === 1) return `tomorrow ${hhmm}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hhmm}`;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// The error text when waiting is not possible or not allowed. `why` is 'budget' (the wait is longer
// than rateLimitMaxWait) or 'off' (waiting for limits is switched off or not wanted here).
function limitMessage(err, rl, state, budget, now, why) {
  const base = err.message;
  if (rl?.waitMs == null || rl.waitMs < LONG_WAIT_MS) {
    return state.waitedMs > 0 ? `${base} (still rate limited after waiting ${humanDuration(state.waitedMs)})` : base;
  }
  if (err.status !== 429) return `${base} (the server asked to wait ${humanDuration(rl.waitMs)} before retrying)`;
  const reset = `${capitalize(rl.label)} reached; it resets at ${formatClock(rl.resetAt, now)} (in ${humanDuration(rl.waitMs)})`;
  if (why === 'budget') return `${base} (${reset}, beyond the ${humanDuration(budget)} this session may wait. CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS raises that.)`;
  return `${base} (${reset}${budget === 0 ? '. Set CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS above 0 to wait for it automatically' : ''}.)`;
}

// Decide what to do after a failed request. Returns
//   {action: 'throw', message?}                      give up (message replaces the error text)
//   {action: 'wait', kind, delayMs, resumeAt, ...}   wait, then try again
// kind is 'retry' for a quick retry and 'rate_limit' for a pause until a limit resets.
//
// `state` is {attempt, rateLimitHits, waitedMs}, kept across the attempts of one request.
// 429s are handled as follows (unless rateLimitMaxWait is 0, retries are off, or allowWait is false):
//  - the headers announce a wait of 30s or more (an exhausted 5-hour or weekly window): wait for
//    that reset, as long as it fits in the budget (rateLimitMaxWait, default 6 hours);
//  - a short announced wait: a few quick retries, counted like any other;
//  - nothing announced: back off 1s, 2s, 4s ... up to rateLimitPoll (5 minutes) between attempts, within the budget.
//
// An overloaded API (529, overloaded_error) backs off from 1s to 32s. When the usual retries are used up it does not
// give up but pauses and tries again at the longest delay, within the same wait budget as a rate limit.
export function planRetry(err, state, config, { now = Date.now(), rand = Math.random, allowWait = true } = {}) {
  if (!err.retryable) return { action: 'throw' };
  const maxRetries = config.maxRetries;
  const rl = err.rateLimit || null;
  const budget = config.rateLimitMaxWait;
  const quick = (attempt, max, retryAfterMs) => {
    const delayMs = retryDelay(attempt, retryAfterMs, rand);
    return { action: 'wait', kind: 'retry', delayMs, resumeAt: now + delayMs, attempt, maxRetries: max };
  };

  if ((err.status === 529 || err.overloaded) && maxRetries > 0) {
    // Its own count: a pause starts the quick retries over (see streamMessage), and this one must not.
    const n = state.overloaded = (state.overloaded || 0) + 1;
    const base = config.overloadedRetryBaseDelay ?? 1000;
    const cap = Math.max(base, config.overloadedRetryMaxDelay ?? 32_000);
    const delayMs = Math.max(Math.min(cap, base * 2 ** (n - 1)) + Math.floor(rand() * 500), Math.min(err.retryAfterMs ?? 0, MAX_RETRY_AFTER_MS));
    if (n <= maxRetries) return { action: 'wait', kind: 'retry', delayMs, resumeAt: now + delayMs, attempt: n, maxRetries };
    const allowed = allowWait ? (config.overloadedMaxWait ?? budget) : 0;
    const waited = state.overloadedWaitMs || 0;
    if (waited + delayMs > allowed) {
      return { action: 'throw', message: `${err.message} (the API was still overloaded after ${n - 1} retries${waited ? ` and ${humanDuration(waited)} of waiting` : ''})` };
    }
    state.overloadedWaitMs = waited + delayMs;
    return { action: 'wait', kind: 'rate_limit', overloaded: true, delayMs, resumeAt: now + delayMs, resetAt: null, label: 'API overloaded', polling: true, attempt: n, maxRetries: null };
  }

  if (err.status === 429 && allowWait && maxRetries > 0 && budget > 0) {
    const known = rl?.waitMs ?? null;
    if (known !== null && known < LONG_WAIT_MS) {
      state.attempt++;
      const max = Math.max(maxRetries, MIN_429_ATTEMPTS);
      return state.attempt > max ? { action: 'throw' } : quick(state.attempt, max, known);
    }
    state.rateLimitHits++;
    const polling = known === null;
    const delayMs = polling
      ? Math.min(config.rateLimitPoll, 1000 * 2 ** (state.rateLimitHits - 1)) + Math.floor(rand() * 500)
      : known + RESUME_MARGIN_MS + Math.floor(rand() * RESUME_JITTER_MS);
    if (state.waitedMs + delayMs > budget) return { action: 'throw', message: limitMessage(err, rl, state, budget, now, 'budget') };
    state.waitedMs += delayMs;
    return {
      action: 'wait',
      kind: delayMs >= LONG_WAIT_MS ? 'rate_limit' : 'retry',
      delayMs,
      resumeAt: now + delayMs,
      resetAt: rl?.resetAt ?? null,
      label: rl?.label ?? 'rate limit',
      polling,
      attempt: state.rateLimitHits,
      maxRetries: null,
    };
  }

  // Everything else: a limited number of attempts with exponential backoff. What the server
  // announced (a reset time or Retry-After) still counts: a wait too long to sit through is an error.
  // That is 5 minutes for most errors. A 429 only gets here when nobody waits for limits (a diagnostic
  // request, or waiting switched off): then a limit that lasts 30 seconds or more is reported with its
  // reset time at once, rather than sat through attempt after attempt (10 of them, silently).
  state.attempt++;
  const max = err.status === 429 && maxRetries > 0 ? Math.max(maxRetries, MIN_429_ATTEMPTS) : maxRetries;
  if (state.attempt > max) return { action: 'throw' };
  const announced = rl?.waitMs ?? err.retryAfterMs ?? null;
  const tooLong = announced !== null && (err.status === 429 ? announced >= LONG_WAIT_MS : announced > MAX_RETRY_AFTER_MS);
  if (tooLong) return { action: 'throw', message: limitMessage(err, rl, state, budget, now, 'off') };
  return quick(state.attempt, max, announced);
}

// Words for the pause notice, shared by the interactive and the print mode.
export function describePause(ev, now = Date.now()) {
  const label = capitalize(ev.label || 'rate limit');
  const left = humanDuration(Math.max(0, ev.resumeAt - now));
  if (ev.overloaded) return `The API is overloaded and kept refusing the request. Trying again at ${formatClock(ev.resumeAt, now)} (in ${left}), and every so often after that, then continuing automatically.`;
  const text = ev.polling
    ? `${label} reached and the server gave no reset time. Checking again at ${formatClock(ev.resumeAt, now)} (in ${left}), and every few minutes after that, then continuing automatically.`
    : `${label} reached. Pausing until ${formatClock(ev.resumeAt, now)} (in ${left}), then continuing automatically.`;
  return text;
}

// Whether a rate_limit_wait event should be announced to the user. `prev` is the wait that was last
// announced for the same pause (null at the first one). Polling repeats every few minutes and the
// announced reset moves a little between waits: those only continue the pause already announced,
// unless the reset moved by more than two minutes.
export const resumeText = (ev) => (ev?.woken ? 'Going on with the model you chose.' : ev?.overloaded ? 'The API is answering again; continuing.' : 'The limit has cleared; continuing.');

export function shouldAnnounce(prev, ev) {
  if (!prev) return true;
  return !ev.polling && Math.abs(ev.resumeAt - prev.resumeAt) > 120_000;
}
