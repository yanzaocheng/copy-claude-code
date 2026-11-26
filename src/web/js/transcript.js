// The transcript model of a live session: a copy of the reducer in src/remote.js (applyEvent), and how its items are
// drawn.

import { esc, api, toast, fail } from "./util.js";
import { ansi, ansiLines, plain, md } from "./markdown.js";
import { folded } from "./images.js";
import { truncated } from "./dialogs.js";

export function applyEvent(state, ev) {
  const items = state.items;
  const push = (item) => { items.push(item); return item; };
  switch (ev.t) {
    case "user": return push({ k: "user", text: ev.text });
    case "image": return push({ k: "image", n: ev.n });
    case "output": {
      const last = items[items.length - 1];
      if (last && last.k === "output") { last.lines.push(...(ev.lines || [])); return last; }
      return push({ k: "output", lines: (ev.lines || []).slice() });
    }
    case "start":
      if (state.open) state.open.open = false;
      state.open = push({ k: ev.kind === "thinking" ? "thinking" : "text", text: "", open: true });
      return state.open;
    case "delta":
      if (!state.open) state.open = push({ k: ev.kind === "thinking" ? "thinking" : "text", text: "", open: true });
      state.open.text += String(ev.text || "");
      return state.open;
    case "stop": { const it = state.open; if (!it) return null; it.open = false; state.open = null; return it; }
    case "tool": { const it = push({ k: "tool", id: ev.id, head: ev.head, status: "running", progress: "", sub: [], subCount: 0, lines: [] }); state.tools[ev.id] = it; return it; }
    case "progress": { const it = state.tools[ev.id]; if (!it || it.status !== "running") return null; it.progress = ev.text; return it; }
    case "sub": { const it = state.tools[ev.id]; if (!it || it.status !== "running") return null; it.sub.push(ev.head); if (it.sub.length > 3) it.sub.shift(); it.subCount++; return it; }
    case "done": {
      const it = state.tools[ev.id] || push({ k: "tool", id: ev.id, sub: [], subCount: 0 });
      it.head = ev.head ?? it.head; it.status = ev.status; it.lines = ev.lines || []; it.progress = "";
      delete state.tools[ev.id];
      return it;
    }
    default: return null;
  }
}
export function hydrate(items) {
  const state = { items, open: null, tools: {} };
  for (const it of items) {
    if (it.open) state.open = it;
    if (it.k === "tool" && it.status === "running") state.tools[it.id] = it;
  }
  return state;
}

const trimBlank = (lines) => {
  const out = Array.isArray(lines) ? lines.slice() : [];
  const blank = (l) => !plain(l).trim();
  while (out.length && blank(out[0])) out.shift();
  while (out.length && blank(out[out.length - 1])) out.pop();
  return out;
};

// One transcript item as HTML. opts: {image(n): url, full: Map id -> text, canExpand}
export function itemHtml(item, opts = {}) {
  if (item.k === "user") return `<div class="it it-user"><div class="bubble">${userText(item.text)}</div></div>`;
  if (item.k === "image") return `<div class="it it-image">${opts.image ? `<img src="${opts.image(item.n)}" alt="图片" loading="lazy" data-zoom>` : "[图片]"}</div>`;
  if (item.k === "text") return `<div class="it it-text"><span class="mark">⏺</span><div class="md">${md(item.text)}</div></div>`;
  if (item.k === "thinking") return `<div class="it it-thinking"><details${item.open ? " open" : ""}><summary>✻ ${item.open ? "思考中…" : "思考过程"}</summary><div class="pre">${esc(item.text)}</div></details></div>`;
  if (item.k === "summary") return `<div class="it it-summary"><details><summary>✻ 对话已压缩（摘要）</summary><div class="md">${md(item.text)}</div></details></div>`;
  if (item.k === "output") {
    const lines = trimBlank(item.lines);
    if (!lines.length) return "";
    // the "✻ Done at …" line under an answer (see App.doneText): a line of its own, the rest as the terminal had it
    let html = "", run = [];
    const flush = () => { const r = trimBlank(run); if (r.length) html += `<pre>${ansiLines(r)}</pre>`; run = []; };
    for (const line of lines) {
      const text = plain(line).trim();
      if (/^✻ Done at \d{1,2}:\d{2}\b/.test(text)) { flush(); html += turnMeta(text); } else run.push(line);
    }
    flush();
    return html ? `<div class="it it-output">${html}</div>` : "";
  }
  if (item.k === "tool") {
    const running = item.status === "running";
    let body = running
      ? [...(item.sub || []).map((h) => `<span class="a-d">${ansi(h)}</span>`), (item.subCount || 0) > (item.sub || []).length ? `<span class="a-d">+${item.subCount - item.sub.length} 次工具调用</span>` : "", item.progress ? `<span class="a-d">${esc(item.progress)}</span>` : ""].filter(Boolean).join("\n")
      : ansiLines(trimBlank(item.lines));
    const whole = opts.full?.get(item.id);
    if (whole != null && !running) body = esc(whole);
    // a shortened output ("… +N lines") is fetched whole when it comes into view (see wholeOutputs), except for
    // the edits, whose diff says more than their result
    const cut = !running && whole == null && item.id && truncated(item);
    return `<div class="it it-tool ${running ? "running" : item.status === "error" ? "error" : "done"}"${cut ? ` data-cut="${esc(item.id)}"` : ""}><div class="head"><span class="dot"></span><span>${ansi(item.head || "")}</span></div>${body ? (running ? `<pre>${body}</pre>` : folded(body)) : ""}</div>`;
  }
  return "";
}

// "✻ Done at 17:37 · worked 5m 40s · $0.05 (total $0.10) · ctx 119.1k/1M · opus-5-5 max" as the page shows it
function turnMeta(text) {
  const [head, ...rest] = text.split(" · ");
  const at = head.replace(/^✻ Done at /, "");
  const parts = rest.map((p) => { // (HTML: every piece of the line escaped)
    let m;
    if ((m = /^worked (.+)$/.exec(p))) return `用时 ${esc(m[1])}`;
    if ((m = /^(\$[\d.,]+) \(total (\$[\d.,]+)\)$/.exec(p))) return `${esc(m[1])}<span class="tm-dim">（累计 ${esc(m[2])}）</span>`;
    if ((m = /^ctx (.+)$/.exec(p))) return `上下文 ${esc(m[1])}`;
    return esc(p);
  });
  const check = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  return `<div class="turn-meta" title="${esc(text)}" data-turn="${esc(text)}"><span class="tm-done"><span class="tm-check">${check}</span>${esc(at)} 完成</span>${parts.map((p) => `<span>${p}</span>`).join("")}<span class="tm-acts"><button type="button" class="tm-act" data-fork title="在新对话中分支：从这里接着聊，这个对话不受影响" aria-label="在新对话中分支">${BRANCH}</button></span></div>`;
}
const BRANCH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="5.5" r="2.2"/><circle cx="18" cy="18.5" r="2.2"/><path d="M8 11 16 6.6M8 13l8 4.4"/></svg>';

// 在新对话中分支 under an answer: a new conversation with this one up to there (data.js forkSession), run by the console
// and opened. The answer is told by its done line, and which of the lines that read the same it is, from the last.
export function wireForks(log, sessionIdOf) {
  log.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-fork]");
    if (!b || b.disabled) return;
    const meta = b.closest(".turn-meta");
    const turn = meta?.dataset.turn;
    const id = sessionIdOf();
    if (!turn || !id) { toast("这个对话还没有保存，稍后再试"); return; }
    const same = [...log.querySelectorAll(".turn-meta")].filter((m) => m.dataset.turn === turn);
    const nth = same.length - 1 - same.indexOf(meta);
    b.disabled = true;
    try {
      const r = await api("/api/sessions/fork", { method: "POST", body: { id, turn, nth } });
      toast("已在新对话中分支：从这一轮接着聊，原来的对话不变");
      if (r.peerId) location.hash = `#/live/${r.peerId}`;
      else if (r.dir && r.sessionId) location.hash = `#/session/${r.dir}/${r.sessionId}`;
    } catch (err) { fail(err); } finally { b.disabled = false; }
  });
}

// A user's message: its leading "> " lines (引用) shown as quotes above what was typed.
function userText(text) {
  const lines = String(text || "").split("\n");
  const quoted = [];
  let i = 0;
  while (i < lines.length && (/^>/.test(lines[i]) || (lines[i] === "" && quoted.length && /^>/.test(lines[i + 1] || "")))) quoted.push(lines[i++]);
  if (!quoted.length) return esc(text);
  while (i < lines.length && lines[i] === "") i++;
  const blocks = quoted.join("\n").split(/\n\n+/).map((b) => b.split("\n").map((l) => l.replace(/^> ?/, "")).join("\n"));
  return blocks.map((b) => `<div class="user-quote">${esc(b)}</div>`).join("") + esc(lines.slice(i).join("\n"));
}
