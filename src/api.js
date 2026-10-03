// Thin layer over the Anthropic SDK: builds request params from config and turns the
// raw SSE stream into a fully assembled assistant message while reporting progress.

import Anthropic from '@anthropic-ai/sdk';

let cached = null;

export function getClient(config) {
  const key = `${config.baseURL}|${config.authToken}|${config.apiKey}|${config.env.ANTHROPIC_CUSTOM_HEADERS || ''}`;
  if (cached?.key === key) return cached.client;
  const client = new Anthropic({
    baseURL: config.baseURL,
    // Prefer the bearer token; pass null explicitly so the SDK never falls back to env vars.
    authToken: config.authToken,
    apiKey: config.authToken ? null : (config.apiKey || null),
    defaultHeaders: config.customHeaders,
    timeout: config.apiTimeout,
    maxRetries: 0, // retries are handled in streamMessage so the UI can report them

    dangerouslyAllowBrowser: false,
  });
  cached = { key, client };
  return client;
}

// Mark the last block of the system prompt, tools and the latest user message as cacheable.
// Endpoints that don't support prompt caching (e.g. DeepSeek, which caches automatically) ignore it.
function withCacheControl(messages) {
  if (!messages.length) return messages;
  const out = messages.slice();
  const idx = out.length - 1;
  const last = out[idx];
  if (last.role !== 'user') return out;
  const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.slice();
  if (!content.length) return out;
  const tail = content.length - 1;
  content[tail] = { ...content[tail], cache_control: { type: 'ephemeral' } };
  out[idx] = { ...last, content };
  return out;
}

export function buildParams(config, { model, system, messages, tools, maxTokens, effort }) {
  const params = {
    model: model.id,
    max_tokens: maxTokens || config.maxOutputTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: withCacheControl(messages),
    stream: true,
  };
  if (tools?.length) {
    params.tools = tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t));
  }
  const eff = effort === undefined ? config.effort : effort;
  if (eff) params.output_config = { effort: eff };
  const budget = config.thinkingBudget;
  if (budget === 0) params.thinking = { type: 'disabled' };
  else if (budget > 0) params.thinking = { type: 'enabled', budget_tokens: Math.min(budget, params.max_tokens - 1) };
  return params;
}

export class APIError extends Error {
  constructor(message, { status, retryable, promptTooLong } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.promptTooLong = promptTooLong;
  }
}

function describeError(err) {
  if (err?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError) return err;
  const status = err?.status;
  let msg = err?.error?.error?.message || err?.error?.message || err?.message || String(err);
  const promptTooLong = /prompt is too long|context length|maximum context|too many tokens|context_length_exceeded/i.test(msg);
  if (status === 401) msg = `Authentication failed (401). Check ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY. ${msg}`;
  const retryable = !status || status === 408 || status === 409 || status === 429 || status >= 500;
  return new APIError(msg, { status, retryable, promptTooLong });
}

export function isAbort(err) {
  return err?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError || /aborted/i.test(err?.message || '');
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

// Stream a message. `onEvent` receives:
//   {type:'block_start', index, block}
//   {type:'text', index, text}          text delta
//   {type:'thinking', index, text}      thinking delta
//   {type:'tool_input', index, partial} partial JSON of a tool call
//   {type:'block_stop', index, block}   finished block (tool_use input parsed)
//   {type:'retry', attempt, error, delayMs}
//   {type:'reset'}                      partial output from a failed attempt must be discarded
// Returns {message, usage, stopReason}.
export async function streamMessage(config, request, { signal, onEvent = () => {} } = {}) {
  const client = getClient(config);
  const params = buildParams(config, request);
  let attempt = 0;
  for (;;) {
    let emitted = false;
    try {
      const stream = await client.messages.create(params, { signal });
      const blocks = [];
      const jsonBufs = [];
      let usage = {};
      let stopReason = null;
      let model = params.model;
      let stopped = false;
      for await (const ev of stream) {
        switch (ev.type) {
          case 'message_stop':
            stopped = true;
            break;
          case 'message_start':
            usage = { ...ev.message.usage };
            model = ev.message.model || model;
            break;
          case 'content_block_start': {
            const b = { ...ev.content_block };
            if (b.type === 'tool_use') { b.input = {}; jsonBufs[ev.index] = ''; }
            if (b.type === 'text') b.text = b.text || '';
            if (b.type === 'thinking') { b.thinking = b.thinking || ''; b.signature = b.signature || ''; }
            blocks[ev.index] = b;
            emitted = true;
            onEvent({ type: 'block_start', index: ev.index, block: b });
            break;
          }
          case 'content_block_delta': {
            const b = blocks[ev.index];
            const d = ev.delta;
            if (!b) break;
            if (d.type === 'text_delta') { b.text += d.text; onEvent({ type: 'text', index: ev.index, text: d.text }); }
            else if (d.type === 'thinking_delta') { b.thinking += d.thinking; onEvent({ type: 'thinking', index: ev.index, text: d.thinking }); }
            else if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
            else if (d.type === 'input_json_delta') {
              jsonBufs[ev.index] += d.partial_json;
              onEvent({ type: 'tool_input', index: ev.index, partial: jsonBufs[ev.index], block: b });
            }
            break;
          }
          case 'content_block_stop': {
            const b = blocks[ev.index];
            if (b?.type === 'tool_use') {
              const raw = jsonBufs[ev.index];
              try { b.input = raw ? JSON.parse(raw) : {}; } catch { b.input = { __invalid_json: raw }; }
            }
            if (b) onEvent({ type: 'block_stop', index: ev.index, block: b });
            break;
          }
          case 'message_delta':
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
            if (ev.usage) usage = { ...usage, ...Object.fromEntries(Object.entries(ev.usage).filter(([, v]) => v != null)) };
            break;
          case 'error':
            throw Object.assign(new Error(ev.error?.message || 'stream error'), { status: 500 });
          default:
            break;
        }
      }
      // The SDK ends the iterator quietly when aborted; a stream without message_stop was cut off.
      if (signal?.aborted) {
        const partial = blocks.filter((b) => b?.type === 'text' && b.text.trim()).map((b) => ({ type: 'text', text: b.text }));
        throw Object.assign(new Error('aborted'), { name: 'AbortError', partial });
      }
      if (!stopped && !stopReason) throw Object.assign(new Error('The response stream ended unexpectedly'), { status: 503 });
      const content = blocks.filter(Boolean).filter((b) => !(b.type === 'text' && !b.text));
      return { message: { role: 'assistant', content }, usage, stopReason, model };
    } catch (raw) {
      if (signal?.aborted || isAbort(raw)) throw Object.assign(new Error('aborted'), { name: 'AbortError', partial: raw?.partial || [] });
      const err = describeError(raw);
      attempt++;
      if (!err.retryable || attempt > config.maxRetries) throw err;
      const delayMs = Math.min(32_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
      if (emitted) onEvent({ type: 'reset' });
      onEvent({ type: 'retry', attempt, error: err, delayMs, maxRetries: config.maxRetries });
      await sleep(delayMs, signal);
    }
  }
}

// One-shot, non-streaming helper for small side queries (summaries, titles, web page extraction).
export async function quickQuery(config, { model, system, prompt, maxTokens = 4096, signal }) {
  const res = await streamMessage(config, {
    model,
    system,
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    effort: null,
  }, { signal });
  return res.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

export function contextTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
}
