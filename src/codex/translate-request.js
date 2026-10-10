// Copied from codex-gateway (src/translate-request.mjs): Anthropic Messages request -> OpenAI Responses request.
// Anthropic Messages request -> OpenAI Responses request (Codex backend flavour).
import crypto from "node:crypto";

// Thinking blocks we emit carry Codex's encrypted reasoning in `signature`, prefixed with this
// marker, so the reasoning can be replayed on the next turn (store=false has no server state).
export const SIGNATURE_PREFIX = "cgw1:";

const hash = (s, n = 8) => crypto.createHash("sha256").update(s).digest("hex").slice(0, n);

/** OpenAI function names: ^[a-zA-Z0-9_-]{1,64}$. Long MCP names get a stable hashed suffix. */
export function upstreamToolName(name) {
  let n = String(name).replace(/[^a-zA-Z0-9_-]/g, "_");
  if (n.length > 64) n = `${n.slice(0, 55)}_${hash(name)}`;
  return n || "tool";
}

export function systemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .filter((b) => b?.type === "text" && b.text && !b.text.startsWith("x-anthropic-billing-header"))
    .map((b) => b.text)
    .join("\n\n");
}

const asBlocks = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : content || []);

function imagePart(block) {
  const s = block.source || {};
  if (s.type === "base64") return { type: "input_image", image_url: `data:${s.media_type};base64,${s.data}` };
  if (s.type === "url") return { type: "input_image", image_url: s.url };
  return null;
}

function documentPart(block) {
  const s = block.source || {};
  if (s.type === "text") return { type: "input_text", text: s.data || "" };
  if (s.type === "base64") {
    return {
      type: "input_file",
      filename: block.title || (s.media_type === "application/pdf" ? "document.pdf" : "document"),
      file_data: `data:${s.media_type};base64,${s.data}`,
    };
  }
  if (s.type === "content") return { type: "input_text", text: asBlocks(s.content).map((b) => b.text || "").join("\n") };
  return null;
}

function toolResultItem(block) {
  const parts = asBlocks(block.content);
  const errorPrefix = (text) => (block.is_error && !/^\s*<tool_use_error>/.test(text) ? `ERROR: ${text}` : text);
  let output;
  if (parts.some((p) => p.type === "image")) {
    output = parts
      .map((p) => (p.type === "image" ? imagePart(p) : p.type === "text" ? { type: "input_text", text: p.text } : null))
      .filter(Boolean);
    if (block.is_error) output.unshift({ type: "input_text", text: "ERROR:" });
  } else {
    const text = (p) =>
      p.type === "text" ? p.text
      : p.type === "document" ? documentPart(p)?.text || ""
      : p.type === "tool_reference" ? `Tool ${p.tool_name} is now available.`
      : "";
    output = errorPrefix(parts.map(text).join("\n"));
  }
  return { type: "function_call_output", call_id: block.tool_use_id, output };
}

function reasoningItem(block) {
  const sig = block.signature;
  if (typeof sig !== "string" || !sig.startsWith(SIGNATURE_PREFIX)) return null;
  return { type: "reasoning", summary: [], encrypted_content: sig.slice(SIGNATURE_PREFIX.length) };
}

function convertMessages(messages, { dropReasoning }) {
  const input = [];
  for (const msg of messages || []) {
    const blocks = asBlocks(msg.content);
    if (msg.role === "assistant") {
      let parts = [];
      const flush = () => {
        if (parts.length) input.push({ type: "message", role: "assistant", content: parts });
        parts = [];
      };
      for (const b of blocks) {
        if (b.type === "text") {
          if (b.text) parts.push({ type: "output_text", text: b.text });
        } else if (b.type === "thinking") {
          const r = !dropReasoning && reasoningItem(b);
          if (r) {
            flush();
            input.push(r);
          }
        } else if (b.type === "tool_use") {
          flush();
          input.push({
            type: "function_call",
            call_id: b.id,
            name: upstreamToolName(b.name),
            arguments: JSON.stringify(b.input ?? {}),
          });
        }
      }
      flush();
    } else {
      let parts = [];
      const flush = () => {
        if (parts.length) input.push({ type: "message", role: "user", content: parts });
        parts = [];
      };
      for (const b of blocks) {
        if (b.type === "text") {
          if (b.text) parts.push({ type: "input_text", text: b.text });
        } else if (b.type === "image") {
          const p = imagePart(b);
          if (p) parts.push(p);
        } else if (b.type === "document") {
          const p = documentPart(b);
          if (p) parts.push(p);
        } else if (b.type === "tool_result") {
          flush();
          input.push(toolResultItem(b));
        }
      }
      flush();
    }
  }
  return input;
}

function sanitizeSchema(schema) {
  const s = schema && typeof schema === "object" ? { ...schema } : {};
  delete s.$schema;
  if (s.type !== "object") s.type = "object";
  if (!s.properties || typeof s.properties !== "object") s.properties = {};
  return s;
}

function convertTools(tools, { webSearch }) {
  const out = [];
  for (const t of tools || []) {
    if (typeof t.type === "string" && t.type.startsWith("web_search")) {
      if (webSearch) out.push({ type: "web_search" });
      continue;
    }
    if (t.type && t.type !== "custom" && !t.input_schema) continue; // other Anthropic server tools
    out.push({
      type: "function",
      name: upstreamToolName(t.name),
      description: t.description || "",
      parameters: sanitizeSchema(t.input_schema),
      strict: false,
    });
  }
  return out;
}

function convertToolChoice(tc) {
  if (!tc) return "auto";
  switch (tc.type) {
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", name: upstreamToolName(tc.name) };
    default:
      return "auto";
  }
}

/** Maps upstream (possibly shortened) tool names back to the client's names. */
export function toolNameMap(anth) {
  const map = new Map();
  const add = (n) => n && map.set(upstreamToolName(n), n);
  for (const t of anth.tools || []) add(t.name);
  for (const m of anth.messages || []) for (const b of asBlocks(m.content)) if (b.type === "tool_use") add(b.name);
  return map;
}

/** Stable per-conversation id, used as session_id header and prompt_cache_key. */
export function sessionIdFor(anth) {
  const uid = anth.metadata?.user_id;
  let sid = null;
  if (typeof uid === "string") {
    try {
      sid = JSON.parse(uid).session_id || null;
    } catch {}
    sid ||= uid.match(/session_([0-9a-fA-F-]{36})/)?.[1] || null;
  }
  const seed = `${sid || "anon"}|${systemText(anth.system).slice(0, 300)}`;
  const h = crypto.createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * @param anth Anthropic request body
 * @param o { model, effort, summary, sessionId, instructionsMode: "custom"|"codex", codexInstructions,
 *            dropReasoning, removedParams:Set<string>, webSearch, parallelToolCalls }
 */
export function buildResponsesRequest(anth, o) {
  const system = systemText(anth.system);
  const input = convertMessages(anth.messages, o);
  let instructions = system || "You are a helpful assistant.";
  if (o.instructionsMode === "codex" && o.codexInstructions) {
    instructions = o.codexInstructions;
    const note =
      "The instructions above describe the Codex CLI harness. In this session you are driven by a different " +
      "harness: follow the developer instructions below and use only the tools defined in this request.";
    input.unshift({ type: "message", role: "developer", content: [{ type: "input_text", text: `${note}\n\n${system}` }] });
  }

  const payload = {
    model: o.model,
    instructions,
    input,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: o.sessionId,
  };
  if (o.effort) {
    payload.reasoning = { effort: o.effort };
    if (o.summary && o.summary !== "none") payload.reasoning.summary = o.summary;
  }
  const tools = convertTools(anth.tools, o);
  if (tools.length) {
    payload.tools = tools;
    payload.tool_choice = convertToolChoice(anth.tool_choice);
    payload.parallel_tool_calls = o.parallelToolCalls && !anth.tool_choice?.disable_parallel_tool_use;
  }
  for (const p of o.removedParams || []) {
    const [a, b] = p.split(".");
    if (b && payload[a] && typeof payload[a] === "object") delete payload[a][b];
    else delete payload[a];
  }
  return payload;
}
