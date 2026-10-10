// Copied from codex-gateway (src/translate-stream.mjs): OpenAI Responses SSE -> Anthropic Messages SSE events.
// OpenAI Responses SSE events -> Anthropic Messages SSE events (and a non-streaming aggregator).
import crypto from "node:crypto";
import { SIGNATURE_PREFIX } from "./translate-request.js";

/** Async iterator over parsed SSE `data:` JSON payloads from a Node readable stream. */
export async function* parseSSE(stream) {
  let buf = "";
  const decoder = new TextDecoder();
  const parseFrame = (frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  };
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let m;
    while ((m = buf.match(/\r?\n\r?\n/))) {
      const frame = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const ev = parseFrame(frame);
      if (ev) yield ev;
    }
  }
  const ev = parseFrame(buf);
  if (ev) yield ev;
}

/** Merges usage objects, skipping null/undefined fields so a partial update cannot erase counts. */
export function mergeUsage(base, update) {
  const merged = { ...(base || {}) };
  for (const [key, value] of Object.entries(update || {})) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}

export function anthropicUsage(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const cached = u.input_tokens_details?.cached_tokens || 0;
  return {
    input_tokens: Math.max(0, (u.input_tokens || 0) - cached),
    output_tokens: u.output_tokens || 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/**
 * Feed upstream events through handle(); Anthropic events come out through onEvent(name, data).
 * Content blocks are emitted strictly one after another, as the Anthropic protocol requires.
 */
export class ResponsesToAnthropic {
  constructor({ model, toolNames, emitThinking = true, onEvent }) {
    this.model = model;
    this.toolNames = toolNames || new Map();
    this.emitThinking = emitThinking;
    this.onEvent = onEvent;
    this.messageId = "msg_" + crypto.randomBytes(12).toString("hex");
    this.index = -1;
    this.open = null; // { key, type, sawDelta, summaryIndex, citations }
    this.closedKeys = new Set();
    this.sawToolUse = false;
    this.started = false;
    this.done = false;
    this.usage = null;
    this.error = null;
  }

  emit(name, data) {
    this.onEvent(name, { type: name, ...data });
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.emit("message_start", {
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
  }

  openBlock(key, contentBlock, extra = {}) {
    if (this.open?.key === key) return this.open;
    this.closeBlock();
    this.index += 1;
    this.open = { key, type: contentBlock.type, sawDelta: false, ...extra };
    this.emit("content_block_start", { index: this.index, content_block: contentBlock });
    return this.open;
  }

  closeBlock() {
    if (!this.open) return;
    this.emit("content_block_stop", { index: this.index });
    this.closedKeys.add(this.open.key);
    this.open = null;
  }

  delta(delta) {
    this.emit("content_block_delta", { index: this.index, delta });
  }

  textBlock(key) {
    return this.openBlock(key, { type: "text", text: "" }, { citations: [] });
  }

  thinkingBlock(key) {
    return this.openBlock(key, { type: "thinking", thinking: "", signature: "" }, { summaryIndex: null });
  }

  handle(ev) {
    if (this.done) return;
    this.start();
    const item = ev.item;
    switch (ev.type) {
      case "response.output_item.added":
        // Reasoning blocks open lazily (first summary delta or item done) to avoid empty blocks.
        if (item?.type === "function_call") this.toolBlock(ev.output_index, item);
        break;

      case "response.reasoning_summary_part.added":
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        if (!this.emitThinking) break;
        const key = `rs:${ev.output_index}`;
        if (this.closedKeys.has(key) || (!ev.delta && this.open?.key !== key)) break;
        const blk = this.thinkingBlock(key);
        const part = ev.summary_index ?? ev.content_index ?? 0;
        if (blk.summaryIndex !== null && blk.summaryIndex !== part && blk.sawDelta) {
          this.delta({ type: "thinking_delta", thinking: "\n\n" });
        }
        blk.summaryIndex = part;
        if (ev.delta) {
          blk.sawDelta = true;
          this.delta({ type: "thinking_delta", thinking: ev.delta });
        }
        break;
      }

      case "response.output_text.delta":
      case "response.refusal.delta": {
        const key = `msg:${ev.output_index}:${ev.content_index ?? 0}`;
        if (this.closedKeys.has(key)) break;
        const blk = this.textBlock(key);
        if (ev.delta) {
          blk.sawDelta = true;
          this.delta({ type: "text_delta", text: ev.delta });
        }
        break;
      }

      case "response.output_text.annotation.added": {
        const a = ev.annotation;
        if (a?.type === "url_citation" && this.open?.type === "text") this.open.citations.push(a);
        break;
      }

      case "response.function_call_arguments.delta": {
        const key = `fc:${ev.output_index}`;
        if (this.open?.key !== key || !ev.delta) break;
        this.open.sawDelta = true;
        this.delta({ type: "input_json_delta", partial_json: ev.delta });
        break;
      }

      case "response.output_item.done":
        this.itemDone(ev.output_index, item);
        break;

      case "response.completed":
      case "response.incomplete":
        this.finish(ev.response);
        break;

      case "response.failed":
        this.fail(ev.response?.error?.message || "Upstream response failed", ev.response?.error?.code);
        break;

      case "error":
        this.fail(ev.message || ev.error?.message || "Upstream error", ev.code || ev.error?.code || ev.error?.type);
        break;
    }
  }

  toolBlock(outputIndex, item) {
    this.sawToolUse = true;
    return this.openBlock(`fc:${outputIndex}`, {
      type: "tool_use",
      id: item.call_id || item.id,
      name: this.toolNames.get(item.name) || item.name,
      input: {},
    });
  }

  itemDone(outputIndex, item) {
    if (!item) return;
    if (item.type === "reasoning") {
      if (!this.emitThinking) return;
      const key = `rs:${outputIndex}`;
      if (this.closedKeys.has(key)) return;
      const text = (item.summary || []).map((s) => s.text).filter(Boolean).join("\n\n");
      if (this.open?.key !== key && !text && !item.encrypted_content) return;
      const blk = this.thinkingBlock(key);
      if (!blk.sawDelta && text) this.delta({ type: "thinking_delta", thinking: text });
      if (item.encrypted_content) {
        this.delta({ type: "signature_delta", signature: SIGNATURE_PREFIX + item.encrypted_content });
      }
      this.closeBlock();
    } else if (item.type === "function_call") {
      const key = `fc:${outputIndex}`;
      if (this.closedKeys.has(key)) return;
      const blk = this.open?.key === key ? this.open : this.toolBlock(outputIndex, item);
      if (!blk.sawDelta && item.arguments) this.delta({ type: "input_json_delta", partial_json: item.arguments });
      this.closeBlock();
    } else if (item.type === "message") {
      (item.content || []).forEach((part, ci) => {
        const key = `msg:${outputIndex}:${ci}`;
        if (this.closedKeys.has(key)) return;
        const text = part.text ?? part.refusal ?? "";
        const blk = this.open?.key === key ? this.open : text ? this.textBlock(key) : null;
        if (!blk) return;
        if (!blk.sawDelta && text) this.delta({ type: "text_delta", text });
        const cites = blk.citations.length ? blk.citations : (part.annotations || []).filter((a) => a.type === "url_citation");
        const seen = new Set();
        const lines = cites
          .filter((c) => c.url && !seen.has(c.url) && seen.add(c.url))
          .map((c) => `- [${c.title || c.url}](${c.url})`);
        if (lines.length) this.delta({ type: "text_delta", text: `\n\nSources:\n${lines.join("\n")}` });
        this.closeBlock();
      });
    }
  }

  finish(response) {
    if (this.done) return;
    this.closeBlock();
    this.done = true;
    this.usage = anthropicUsage(response?.usage);
    let stop = this.sawToolUse ? "tool_use" : "end_turn";
    if (response?.status === "incomplete") {
      const reason = response.incomplete_details?.reason;
      stop = reason === "max_output_tokens" ? "max_tokens" : reason === "content_filter" ? "refusal" : stop;
    }
    this.stopReason = stop;
    this.emit("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: this.usage });
    this.emit("message_stop", {});
  }

  fail(message, code) {
    if (this.done) return;
    this.closeBlock();
    this.done = true;
    const type = /rate|limit|quota/i.test(`${code} ${message}`) ? "rate_limit_error" : /overload|capacity/i.test(message) ? "overloaded_error" : "api_error";
    this.error = { type, message: code ? `${message} (${code})` : message };
    this.emit("error", { error: this.error });
  }

  /** Call when the upstream stream ended; reports truncated streams as errors. */
  end() {
    if (!this.done) {
      this.start();
      this.fail("Upstream stream ended before the response completed");
    }
  }
}

/** Rebuilds a complete Anthropic message object from the Anthropic event stream. */
export class MessageAggregator {
  constructor() {
    this.message = null;
    this.json = new Map();
    this.error = null;
  }

  onEvent = (name, data) => {
    switch (name) {
      case "message_start":
        this.message = { ...data.message, content: [] };
        break;
      case "content_block_start":
        this.message.content[data.index] = { ...data.content_block };
        break;
      case "content_block_delta": {
        const b = this.message.content[data.index];
        const d = data.delta;
        if (d.type === "text_delta") b.text += d.text;
        else if (d.type === "thinking_delta") b.thinking += d.thinking;
        else if (d.type === "signature_delta") b.signature = d.signature;
        else if (d.type === "input_json_delta") this.json.set(data.index, (this.json.get(data.index) || "") + d.partial_json);
        break;
      }
      case "content_block_stop": {
        const b = this.message.content[data.index];
        if (b.type === "tool_use") {
          try {
            b.input = JSON.parse(this.json.get(data.index) || "{}");
          } catch {
            b.input = {};
          }
        }
        break;
      }
      case "message_delta":
        Object.assign(this.message, data.delta);
        this.message.usage = mergeUsage(this.message.usage, data.usage);
        break;
      case "error":
        this.error = data.error;
        break;
    }
  };
}
