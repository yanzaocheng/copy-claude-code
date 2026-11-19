// Providers that speak OpenAI's Chat Completions (OpenAI, OpenRouter, SiliconFlow, Volcengine Ark, Gemini, xAI, Ollama,
// the user's own): the Anthropic SDK is given a fetch (chatFetch) that turns its POST /v1/messages into a POST
// /chat/completions and the streamed reply back into Anthropic's events, so that everything above api.js speaks one
// protocol. Ported from codex-gateway's translate-chat.mjs (buildChatRequest, ChatToAnthropic), which does the same
// on the gateway for its Chat Completions upstreams.
//
// Lost in translation: prompt caching markers (these providers cache by themselves or not at all), Anthropic's server
// tools (web search: WebSearch falls back to scraping a search page), documents other than text, and the thinking of
// earlier turns (only the turn in progress sends its reasoning back, as these models' own APIs want).

import crypto from 'node:crypto';

// Thinking made from a reply's reasoning_content carries this signature, so that it can go back with the turn it
// belongs to, and so that an Anthropic endpoint (which cannot verify it) never gets it.
export const CHAT_SIGNATURE_PREFIX = 'cgwcb:';

const asBlocks = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);
const hash = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 8);

// OpenAI takes function names of letters, digits, _ and -, up to 64.
export function upstreamToolName(name) {
  let n = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
  if (n.length > 64) n = `${n.slice(0, 55)}_${hash(name)}`;
  return n || 'tool';
}

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n\n');
}

function sanitizeSchema(schema) {
  const s = schema && typeof schema === 'object' ? { ...schema } : {};
  delete s.$schema;
  if (s.type !== 'object') s.type = 'object';
  if (!s.properties || typeof s.properties !== 'object') s.properties = {};
  return s;
}

function imageUrl(block) {
  const s = block?.source || {};
  if (s.type === 'base64' && s.data) return `data:${s.media_type || 'image/png'};base64,${s.data}`;
  if (s.type === 'url' && s.url) return s.url;
  return null;
}

function documentText(block) {
  const s = block?.source || {};
  if (s.type === 'text') return s.data || '';
  if (s.type === 'content') return asBlocks(s.content).map((b) => b?.text || '').join('\n');
  return `[document${block?.title ? `: ${block.title}` : ''} (${s.media_type || 'file'}) omitted: this model reads text and images only]`;
}

// A tool_result as the text of a tool message; its images go to `images` (a user message after the tool results:
// tool messages take text only).
function toolResultText(block, images) {
  const texts = [];
  for (const part of asBlocks(block.content)) {
    if (part?.type === 'text') texts.push(part.text || '');
    else if (part?.type === 'image') {
      const url = imageUrl(part);
      if (url) {
        images.push({ type: 'text', text: `[image returned by tool call ${block.tool_use_id}]` }, { type: 'image_url', image_url: { url } });
        texts.push('[image: see the next message]');
      } else texts.push('[image omitted]');
    } else if (part?.type === 'document') texts.push(documentText(part));
  }
  const text = texts.join('\n');
  const shown = block.is_error && !/^\s*<tool_use_error>/.test(text) ? `ERROR: ${text}` : text;
  return shown || '(no output)';
}

// A prompt, not tool results: the current turn (whose reasoning is sent back) starts after the last one.
const isPrompt = (message) => message?.role === 'user' && !asBlocks(message.content).some((block) => block?.type === 'tool_result');

function convertTools(tools) {
  const out = [];
  for (const t of tools || []) {
    if (!t || (t.type && t.type !== 'custom' && !t.input_schema)) continue; // Anthropic server tools (web search, ...)
    out.push({ type: 'function', function: { name: upstreamToolName(t.name), description: t.description || '', parameters: sanitizeSchema(t.input_schema) } });
  }
  return out;
}

function toolChoice(choice) {
  switch (choice?.type) {
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { type: 'function', function: { name: upstreamToolName(choice.name) } };
    default: return null; // auto, the default
  }
}

// The reasoning_effort for Claude's effort levels: OpenAI's go up to xhigh.
const EFFORT_FOR_OPENAI = { max: 'xhigh', ultra: 'xhigh' };

// The Chat Completions request for an Anthropic Messages request. `quirks`: what this provider and model were found to
// want ({maxCompletionTokens, noEffort, noStreamOptions}, see chatFetch).
export function buildChatRequest(anth, { quirks = {} } = {}) {
  const messages = [];
  const system = systemText(anth.system);
  if (system) messages.push({ role: 'system', content: system });
  const source = Array.isArray(anth.messages) ? anth.messages : [];
  const turnStart = source.findLastIndex(isPrompt);
  source.forEach((message, index) => {
    if (!message || typeof message !== 'object') return;
    const blocks = asBlocks(message.content);
    if (message.role === 'assistant') {
      const text = blocks.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('');
      const reasoning = index > turnStart
        ? blocks.filter((b) => b?.type === 'thinking' && String(b.signature || '').startsWith(CHAT_SIGNATURE_PREFIX) && b.thinking).map((b) => b.thinking).join('')
        : '';
      const calls = blocks.filter((b) => b?.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: upstreamToolName(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      if (!text && !calls.length) return;
      const out = { role: 'assistant', content: text };
      if (reasoning) out.reasoning_content = reasoning;
      if (calls.length) out.tool_calls = calls;
      messages.push(out);
      return;
    }
    // Tool results answer the assistant message before them, so they come first; the rest is one user message.
    const parts = [];
    const toolImages = [];
    for (const b of blocks) {
      if (b?.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultText(b, toolImages) });
      else if (b?.type === 'text') { if (b.text) parts.push({ type: 'text', text: b.text }); }
      else if (b?.type === 'image') {
        const url = imageUrl(b);
        parts.push(url ? { type: 'image_url', image_url: { url } } : { type: 'text', text: '[image omitted]' });
      } else if (b?.type === 'document') parts.push({ type: 'text', text: documentText(b) });
    }
    const all = [...toolImages, ...parts];
    if (!all.length) return;
    messages.push({ role: 'user', content: all.every((p) => p.type === 'text') ? all.map((p) => p.text).join('\n\n') : all });
  });

  const payload = { model: anth.model, messages, stream: true };
  if (!quirks.noStreamOptions) payload.stream_options = { include_usage: true };
  const max = Number(anth.max_tokens);
  if (max > 0) payload[quirks.maxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = max;
  if (typeof anth.temperature === 'number') payload.temperature = anth.temperature;
  if (Array.isArray(anth.stop_sequences) && anth.stop_sequences.length) payload.stop = anth.stop_sequences.slice(0, 4);
  const effort = anth.output_config?.effort;
  if (effort && !quirks.noEffort) payload.reasoning_effort = EFFORT_FOR_OPENAI[effort] || effort;
  const tools = convertTools(anth.tools);
  if (tools.length) {
    payload.tools = tools;
    const choice = toolChoice(anth.tool_choice);
    if (choice) payload.tool_choice = choice;
  }
  return payload;
}

// Chat Completions usage as Anthropic's: prompt_tokens includes the cached ones, which are cache reads.
export function chatUsage(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const prompt = Number(u.prompt_tokens) || 0;
  const cached = Math.min(prompt, Number(u.prompt_tokens_details?.cached_tokens || u.prompt_cache_hit_tokens || u.cache_read_input_tokens || u.cached_tokens) || 0);
  return { input_tokens: Math.max(0, prompt - cached), output_tokens: Number(u.completion_tokens) || 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}

const STOP_REASONS = { stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

// Chat Completions chunks in (handle), Anthropic events out (onEvent), one content block after another: thinking from
// reasoning_content (or OpenRouter's reasoning), text from content, a tool_use per tool call (its arguments streamed
// as they come).
export class ChatToAnthropic {
  constructor({ model, toolNames, onEvent }) {
    this.model = model;
    this.toolNames = toolNames || new Map();
    this.onEvent = onEvent;
    this.messageId = 'msg_' + crypto.randomBytes(12).toString('hex');
    this.index = -1;
    this.open = null; // {key, type}
    this.calls = new Map(); // tool call index -> {id, name, args, key, opened}
    this.sawToolUse = false;
    this.started = false;
    this.done = false;
    this.finishReason = null;
    this.rawUsage = null;
  }

  emit(name, data) { this.onEvent(name, { type: name, ...data }); }

  start() {
    if (this.started) return;
    this.started = true;
    this.emit('message_start', {
      message: { id: this.messageId, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
  }

  openBlock(key, contentBlock) {
    if (this.open?.key === key) return;
    this.closeBlock();
    this.index += 1;
    this.open = { key, type: contentBlock.type };
    this.emit('content_block_start', { index: this.index, content_block: contentBlock });
  }

  closeBlock() {
    if (!this.open) return;
    if (this.open.type === 'thinking') this.delta({ type: 'signature_delta', signature: CHAT_SIGNATURE_PREFIX + crypto.randomBytes(8).toString('hex') });
    this.emit('content_block_stop', { index: this.index });
    this.open = null;
  }

  delta(delta) { this.emit('content_block_delta', { index: this.index, delta }); }

  openCall(call) {
    this.sawToolUse = true;
    call.opened = true;
    this.openBlock(call.key, { type: 'tool_use', id: call.id, name: this.toolNames.get(call.name) || call.name, input: {} });
    if (call.args) this.delta({ type: 'input_json_delta', partial_json: call.args });
  }

  handle(chunk) {
    if (this.done || !chunk || typeof chunk !== 'object') return;
    this.start();
    if (chunk.error) {
      const e = chunk.error;
      return this.fail(typeof e === 'string' ? e : e.message || e.msg || JSON.stringify(e).slice(0, 300), typeof e === 'object' ? e.code || e.type : null);
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    const delta = choice?.delta || choice?.message || {};
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (reasoning) {
      if (this.open?.type !== 'thinking') this.openBlock(`think:${this.index + 1}`, { type: 'thinking', thinking: '', signature: '' });
      this.delta({ type: 'thinking_delta', thinking: reasoning });
    }
    if (typeof delta.content === 'string' && delta.content) {
      if (this.open?.type !== 'text') this.openBlock(`text:${this.index + 1}`, { type: 'text', text: '' });
      this.delta({ type: 'text_delta', text: delta.content });
    }
    for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const at = Number.isInteger(tc?.index) ? tc.index : this.calls.size;
      let call = this.calls.get(at);
      if (!call) {
        call = { id: tc.id || `call_${crypto.randomBytes(12).toString('hex')}`, name: '', args: '', key: `tool:${at}`, opened: false };
        this.calls.set(at, call);
      }
      if (!call.opened) {
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name = tc.function.name;
      }
      const args = typeof tc.function?.arguments === 'string' ? tc.function.arguments : tc.function?.arguments && typeof tc.function.arguments === 'object' ? JSON.stringify(tc.function.arguments) : '';
      if (!call.opened) {
        call.args += args;
        if (call.name) this.openCall(call);
      } else if (args && this.open?.key === call.key) this.delta({ type: 'input_json_delta', partial_json: args });
    }
    if (choice?.finish_reason) this.finishReason = choice.finish_reason;
    if (chunk.usage) this.rawUsage = chunk.usage;
  }

  finish() {
    if (this.done) return;
    for (const call of this.calls.values()) if (!call.opened) { if (!call.name) call.name = 'unknown_tool'; this.openCall(call); }
    this.closeBlock();
    this.done = true;
    const stopReason = this.sawToolUse && this.finishReason !== 'length' ? 'tool_use' : STOP_REASONS[this.finishReason] || 'end_turn';
    this.emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: chatUsage(this.rawUsage) });
    this.emit('message_stop', {});
  }

  fail(message, code) {
    if (this.done) return;
    this.closeBlock();
    this.done = true;
    const type = /rate|limit|quota/i.test(`${code} ${message}`) ? 'rate_limit_error' : /overload|capacity/i.test(message) ? 'overloaded_error' : 'api_error';
    this.emit('error', { error: { type, message: code ? `${message} (${code})` : message } });
  }

  // The upstream stream ended: a reply without its finish is an error. (Some providers end with usage and no
  // finish_reason after the content: taken as finished when anything came.)
  end() {
    if (this.done) return;
    this.start();
    if (this.finishReason || this.index >= 0) this.finish();
    else this.fail('The provider\'s stream ended before the response completed');
  }
}

// ---------------------------------------------------------------- the SDK's fetch

// What each provider and model was found to want, learned from its 400s: {maxCompletionTokens, noEffort, noStreamOptions}.
const quirksOf = new Map();
const QUIRKS = [
  { key: 'maxCompletionTokens', test: (text) => /max_completion_tokens/i.test(text) },
  { key: 'noEffort', test: (text) => /reasoning[_ ]effort|reasoning_effort|unrecognized.*reasoning|reasoning.*not supported/i.test(text) },
  { key: 'noStreamOptions', test: (text) => /stream_options/i.test(text) },
];

const errorType = (status) => (status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error' : status === 529 || status === 503 ? 'overloaded_error' : status >= 500 ? 'api_error' : 'invalid_request_error');

async function upstreamMessage(res) {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text);
    const first = Array.isArray(body) ? body[0] : body;
    return first?.error?.message || first?.message || (typeof first?.error === 'string' ? first.error : '') || text.slice(0, 500);
  } catch {
    return text.slice(0, 500) || `HTTP ${res.status}`;
  }
}

// An upstream error as the SDK takes an Anthropic one: the status, the provider's words, and the headers that say when
// to try again (Retry-After, rate limits).
function errorResponse(status, message, headers) {
  const keep = new Headers({ 'content-type': 'application/json' });
  for (const [k, v] of headers || []) if (/^retry-after$|ratelimit/i.test(k)) keep.set(k, v);
  return new Response(JSON.stringify({ type: 'error', error: { type: errorType(status), message } }), { status, headers: keep });
}

// The fetch for an Anthropic SDK client whose requests go to a Chat Completions endpoint: {baseURL, key, provider,
// quirks} (quirks: what /connect found the provider to want).
export function chatFetch({ baseURL, key, provider, quirks: known = {} }, fetchImpl = (...args) => globalThis.fetch(...args)) {
  return async (url, init = {}) => {
    const target = String(url);
    if (!/\/v1\/messages(?:\?|$)/.test(target) || String(init.method || 'GET').toUpperCase() !== 'POST') {
      return errorResponse(404, `${provider} speaks Chat Completions: ${new URL(target).pathname} is not offered`);
    }
    const anth = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
    const toolNames = new Map((anth.tools || []).filter((t) => t?.name).map((t) => [upstreamToolName(t.name), t.name]));
    const quirkKey = `${baseURL}|${anth.model}`;
    let res;
    for (let attempt = 0; attempt <= QUIRKS.length; attempt++) {
      const quirks = { ...known, ...quirksOf.get(quirkKey) };
      res = await fetchImpl(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${key}` },
        body: JSON.stringify(buildChatRequest(anth, { quirks })),
        signal: init.signal,
      });
      if (res.ok) break;
      const message = await upstreamMessage(res);
      const learned = res.status === 400 && QUIRKS.find((q) => !quirks[q.key] && q.test(message));
      if (!learned) return errorResponse(res.status, message, res.headers);
      quirksOf.set(quirkKey, { ...quirks, [learned.key]: true }); // asked again without what it refused
    }
    const conv = new ChatToAnthropic({ model: anth.model, toolNames, onEvent: () => {} });
    const encoder = new TextEncoder();
    const json = /application\/json/i.test(res.headers.get('content-type') || '');
    const body = new ReadableStream({
      async start(controller) {
        conv.onEvent = (name, data) => controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
        try {
          if (json) { // a provider that answered the whole reply at once (stream not honoured)
            conv.handle(await res.json());
            conv.end();
          } else {
            const decoder = new TextDecoder();
            let buf = '';
            const line = (raw) => {
              const text = raw.replace(/\r$/, '');
              if (!text.startsWith('data:')) return;
              const data = text.slice(5).trim();
              if (!data) return;
              if (data === '[DONE]') { conv.end(); return; }
              try { conv.handle(JSON.parse(data)); } catch { /* a line that is not JSON (a comment, a keep-alive) */ }
            };
            for await (const chunk of res.body) {
              buf += decoder.decode(chunk, { stream: true });
              let nl;
              while ((nl = buf.indexOf('\n')) >= 0) { line(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
            }
            if (buf) line(buf);
            conv.end();
          }
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}
