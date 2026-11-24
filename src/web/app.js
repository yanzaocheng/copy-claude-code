// claude-pro web console (see server.js). One page, routed by the address's #fragment.
(() => {
  "use strict";

  // ---------------------------------------------------------------- helpers

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const main = $("#main");

  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(data?.error || `请求失败 (${res.status})`);
      err.status = res.status;
      err.data = data;
      if (res.status === 401 && data?.login) { location.reload(); return new Promise(() => {}); } // 远程访问: its login page
      if (res.status === 401) showLoggedOut(err.message);
      throw err;
    }
    return data;
  }

  let toastTimer = 0;
  function toast(message, kind = "ok") {
    let el = $(".toast");
    if (!el) { el = document.createElement("div"); document.body.appendChild(el); }
    el.className = `toast${kind === "error" ? " error" : ""}`;
    el.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), kind === "error" ? 6000 : 3000);
  }
  const fail = (e) => toast(e?.message || String(e), "error");

  const fmtBytes = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  };
  const fmtTokens = (v) => { const n = Number(v) || 0; return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); };
  const fmtUsd = (v) => { const n = Number(v) || 0; return `$${n.toFixed(n !== 0 && n < 0.01 ? 4 : 2)}`; };
  const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
  function ago(ms) {
    if (!ms) return "—";
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return "刚刚";
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
    return new Date(ms).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  }
  const fmtDuration = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); if (s < 60) return `${s}s`; const m = Math.floor(s / 60); return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`; };
  const shortPath = (p) => String(p || "").replace(/\\/g, "/");

  // ---------------------------------------------------------------- ANSI and Markdown (as the gateway's page)

  const BASIC = ["#0c0c0c", "#cd3131", "#0dbc79", "#b5a10a", "#2472c8", "#bc3fbc", "#11a8cd", "#a0a0a0", "#666666", "#f14c4c", "#23d18b", "#b5a10a", "#3b8eea", "#d670d6", "#29b8db", "#8a8a8a"];
  function color256(value) {
    let n = Number(value) || 0;
    if (n < 16) return BASIC[n];
    if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
    n -= 16;
    const scale = [0, 95, 135, 175, 215, 255];
    return `rgb(${scale[Math.floor(n / 36)]},${scale[Math.floor(n / 6) % 6]},${scale[n % 6]})`;
  }
  function ansi(line) {
    line = String(line == null ? "" : line);
    let out = "";
    let style = {};
    // eslint-disable-next-line no-control-regex
    const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g;
    const add = (text) => {
      if (!text) return;
      let fg = style.fg, bg = style.bg;
      if (style.inverse) { const old = fg; fg = bg || "var(--rc-bg)"; bg = old || "var(--rc-fg)"; }
      // A background is the terminal's diff (dark red and green for a dark terminal): shown as the page's own added /
      // removed colours, with its text in the page's colour, so that it reads on a light page as on a dark one.
      let tone = "";
      if (bg && !style.inverse) {
        const rgb = /rgb\((\d+),(\d+),(\d+)\)/.exec(bg) || /^#(..)(..)(..)$/.exec(bg);
        const [r, g] = rgb ? [rgb[1], rgb[2]].map((v) => (v.length === 2 && rgb[0].startsWith("#") ? parseInt(v, 16) : Number(v))) : [0, 0];
        const b = rgb ? (rgb[0].startsWith("#") ? parseInt(rgb[3], 16) : Number(rgb[3])) : 0;
        tone = g > r + 12 ? "a-add" : r > g + 12 ? "a-del" : "a-bg";
        if (tone !== "a-bg" && r + g + b > 300) tone += " a-word"; // the changed words, brighter than their line
        bg = null;
        fg = null;
      }
      const classes = [tone, style.bold && "a-b", style.dim && !tone && "a-d", style.italic && "a-i", style.underline && "a-u", style.strike && "a-s"].filter(Boolean);
      const css = (fg ? `color:${fg};` : "") + (bg ? `background:${bg};` : "");
      const attrs = (classes.length ? ` class="${classes.join(" ")}"` : "") + (css ? ` style="${esc(css)}"` : "");
      out += attrs ? `<span${attrs}>${esc(text)}</span>` : esc(text);
    };
    let last = 0, m;
    while ((m = re.exec(line))) {
      add(line.slice(last, m.index));
      last = re.lastIndex;
      if (m[1] === undefined) continue;
      const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) style = {};
        else if (code === 1) style.bold = true;
        else if (code === 2) style.dim = true;
        else if (code === 22) style.bold = style.dim = false;
        else if (code === 3) style.italic = true;
        else if (code === 23) style.italic = false;
        else if (code === 4) style.underline = true;
        else if (code === 24) style.underline = false;
        else if (code === 7) style.inverse = true;
        else if (code === 27) style.inverse = false;
        else if (code === 9) style.strike = true;
        else if (code === 29) style.strike = false;
        else if (code >= 30 && code <= 37) style.fg = BASIC[code - 30];
        else if (code >= 90 && code <= 97) style.fg = BASIC[code - 82];
        else if (code >= 40 && code <= 47) style.bg = BASIC[code - 40];
        else if (code >= 100 && code <= 107) style.bg = BASIC[code - 92];
        else if (code === 39) style.fg = null;
        else if (code === 49) style.bg = null;
        else if (code === 38 || code === 48) {
          let color = null;
          if (codes[i + 1] === 2) { color = `rgb(${codes[i + 2] | 0},${codes[i + 3] | 0},${codes[i + 4] | 0})`; i += 4; }
          else if (codes[i + 1] === 5) { color = color256(codes[i + 2]); i += 2; }
          if (code === 38) style.fg = color; else style.bg = color;
        }
      }
    }
    add(line.slice(last));
    return out;
  }
  const ansiLines = (lines) => (Array.isArray(lines) ? lines : []).map(ansi).join("\n");
  const plain = (s) => String(s || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""); // eslint-disable-line no-control-regex

  function inline(source) {
    const codes = [];
    const text = String(source == null ? "" : source).replace(/\u0000/g, "").replace(/`([^`]+)`/g, (_, code) => { codes.push(code); return `\u0000${codes.length - 1}\u0000`; });
    return esc(text)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  }
  function md(source) {
    const lines = String(source == null ? "" : source).replace(/\r\n/g, "\n").split("\n");
    let html = "", para = [], i = 0;
    const flush = () => { if (para.length) { html += `<p>${para.map(inline).join("<br>")}</p>`; para = []; } };
    const row = /^\s*\|.*\|\s*$/;
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*(```+|~~~+)/.exec(line);
      if (fence) {
        flush();
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
        i++;
        html += `<pre>${esc(body.join("\n"))}</pre>`;
        continue;
      }
      if (row.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const rows = [];
        while (i < lines.length && row.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        html += "<table><thead><tr>" + cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>"
          + rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flush(); html += `<h${Math.min(4, h[1].length)}>${inline(h[2])}</h${Math.min(4, h[1].length)}>`; i++; continue; }
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) { flush(); html += `<div class="li" style="padding-left:${Math.min(li[1].length, 12) * 0.5}em"><span class="bullet">${/\d/.test(li[2]) ? esc(li[2]) : "•"}</span><span>${inline(li[3])}</span></div>`; i++; continue; }
      const q = /^\s*>\s?(.*)$/.exec(line);
      if (q) { flush(); html += `<blockquote>${inline(q[1])}</blockquote>`; i++; continue; }
      if (!line.trim()) { flush(); i++; continue; }
      para.push(line);
      i++;
    }
    flush();
    return html;
  }

  // ---------------------------------------------------------------- the transcript model (as the session's remote.js)

  function applyEvent(state, ev) {
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
  function hydrate(items) {
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
  function itemHtml(item, opts = {}) {
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
    return `<div class="turn-meta" title="${esc(text)}"><span class="tm-done"><span class="tm-check">${check}</span>${esc(at)} 完成</span>${parts.map((p) => `<span>${p}</span>`).join("")}</div>`;
  }

  // ---------------------------------------------------------------- images for a message (as pasting one in the terminal)

  const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const MAX_IMAGES = 6;
  const encode = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  // {media_type, data (base64), size, url}: scaled down to 2000 px on the longer edge (the model sees no more), at most 5 MB
  async function prepareImage(file) {
    if (!IMAGE_TYPES.includes(file.type)) throw new Error("只支持 PNG、JPEG、GIF、WebP 图片");
    let blob = file;
    if (file.type !== "image/gif") {
      const bitmap = await createImageBitmap(file).catch(() => null);
      if (bitmap && (Math.max(bitmap.width, bitmap.height) > 2000 || file.size > 2.5 * 1024 * 1024)) {
        const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        blob = (await encode(canvas, file.type === "image/png" ? "image/png" : "image/jpeg", 0.9)) || file;
        if (blob.size > 2.5 * 1024 * 1024) {
          ctx.globalCompositeOperation = "destination-over";
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          blob = (await encode(canvas, "image/jpeg", 0.85)) || blob;
        }
      }
      bitmap?.close?.();
    }
    if (blob.size > 5 * 1024 * 1024) throw new Error("图片太大：缩小后仍超过 5 MB");
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.readAsDataURL(blob);
    });
    return { media_type: IMAGE_TYPES.includes(blob.type) ? blob.type : file.type, data, size: blob.size, url: URL.createObjectURL(blob) };
  }

  // A tool's output: whole, but folded to its first lines when it is long (展开 shows the rest, 收起 folds it again).
  const FOLD_LINES = 5;
  function folded(html) {
    const n = html.split("\n").length;
    if (n <= FOLD_LINES + 2) return `<pre>${html}</pre>`;
    return `<div class="fold"><pre>${html}</pre><button type="button" class="fold-btn" data-fold>展开全部 · ${n} 行</button></div>`;
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-fold]");
    if (!b) return;
    const box = b.closest(".fold");
    const open = box.classList.toggle("open");
    b.textContent = open ? "收起" : `展开全部 · ${box.querySelector("pre").textContent.split("\n").length} 行`;
    if (!open) box.scrollIntoView({ block: "nearest" });
  });

  // An image of the conversation (or of the message box) opens in a box over the page: Esc, a click or ✕ closes it.
  function zoomImage(src) {
    const back = document.createElement("div");
    back.className = "zoom";
    back.innerHTML = `<img src="${esc(src)}" alt="图片"><button type="button" class="zoom-close" aria-label="关闭">✕</button>`;
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    back.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(back);
  }
  document.addEventListener("click", (e) => {
    const img = e.target.closest("img[data-zoom], .thumb img");
    if (!img) return;
    e.preventDefault();
    zoomImage(img.src);
  });

  // ---------------------------------------------------------------- whole tool outputs

  const EDIT_TOOL = /^(Edit|MultiEdit|Write|NotebookEdit)\b/;
  function truncated(item) {
    if (EDIT_TOOL.test(plain(item.head || ""))) return false;
    return (item.lines || []).some((l) => /… \+\d+ lines/.test(plain(l)));
  }

  // Watches the tool calls in `root` whose output was shortened; when one comes near the view its whole output is
  // fetched (fetch(id) → text) and handed to onWhole(id, text). Returns {observe(), disconnect()}.
  function wholeOutputs(root, fetch, onWhole) {
    const asked = new Set();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = e.target.dataset.cut;
        io.unobserve(e.target);
        if (!id || asked.has(id)) continue;
        asked.add(id);
        fetch(id).then((text) => { if (typeof text === "string") onWhole(id, text); }).catch(() => { /* the short one stays */ });
      }
    }, { root: root.closest(".chat-scroll") || null, rootMargin: "600px 0px" });
    return {
      observe() { for (const n of root.querySelectorAll("[data-cut]")) if (!asked.has(n.dataset.cut)) io.observe(n); },
      disconnect() { io.disconnect(); },
    };
  }

  // ---------------------------------------------------------------- modal and file editor

  function modal({ title, sub = "", body = "", foot = "", big = false, onClose = null }) {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal${big ? " big" : ""}" role="dialog"><div class="modal-head"><div><h2>${esc(title)}</h2>${sub ? `<div class="path">${esc(sub)}</div>` : ""}</div><button type="button" class="button secondary small" data-close>关闭</button></div><div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ""}</div>`;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      back.remove();
      document.removeEventListener("keydown", onKey);
      onClose?.();
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-close]")) close(); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(back);
    return { el: back, close };
  }

  async function openEditor(path, { title = "编辑文件", deletable = false, onSaved = () => {} } = {}) {
    let file;
    try { file = await api(`/api/file?path=${encodeURIComponent(path)}`); } catch (e) { return fail(e); }
    const m = modal({
      title: file.exists ? title : `${title}（新建）`, sub: file.path, big: true,
      body: `<textarea class="editor" spellcheck="false">${esc(file.text)}</textarea>`,
      foot: `<span class="modal-error"></span>${deletable && file.exists ? '<button type="button" class="button danger" data-delete>删除</button>' : ""}<button type="button" class="button secondary" data-close>取消</button><button type="button" class="button" data-save>保存</button>`,
    });
    const area = $("textarea", m.el);
    area.focus();
    area.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); }
      if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); document.execCommand("insertText", false, "  "); }
    });
    async function save() {
      try {
        const saved = await api("/api/file", { method: "PUT", body: { path: file.path, text: area.value, mtime: file.mtime } });
        file = { ...file, ...saved };
        toast("已保存");
        m.close();
        onSaved();
      } catch (e) { $(".modal-error", m.el).textContent = e.message; }
    }
    $("[data-save]", m.el).addEventListener("click", save);
    $("[data-delete]", m.el)?.addEventListener("click", async () => {
      if (!confirm(`删除 ${file.path}？（会移到 ~/.claude-pro/trash/files）`)) return;
      try { await api(`/api/file?path=${encodeURIComponent(file.path)}`, { method: "DELETE" }); toast("已删除"); m.close(); onSaved(); } catch (e) { fail(e); }
    });
  }

  // ---------------------------------------------------------------- routing

  let cleanup = null; // what the current view leaves behind (timers, streams)
  let closeMenu = null;
  function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("?")[0].split("/").map(decodeURIComponent); // (?tab=… is the view's own)
    const page = parts[0] || "new";
    $$("#nav a, .side-new").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
    $("#sideMe").classList.toggle("active", $$("#nav a").some((a) => a.dataset.nav === page)); // a page of its menu
    showUserMenu(false);
    markActive();
    $("#tip")?.classList.add("hidden");
    closeMenu?.();
    if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
    main.scrollTop = 0;
    setDrawer(false);
    const views = { new: newView, remote: remotePage, overview, sessions, session: () => sessionView(parts[1], parts[2]), live: () => (parts[1] ? liveView(parts[1]) : newView()), providers, settings, memory, extensions, usage };
    (views[page] || newView)();
  }
  // mode: true = full width, "chat" = the conversation layout (full height, its own scrolling)
  const page = (html, mode = false) => { main.innerHTML = `<div class="page${mode === "chat" ? " chat" : mode ? " wide" : ""}">${html}</div>`; return $(".page", main); };

  function showLoggedOut(message) {
    main.innerHTML = `<div class="page"><div class="panel panel-pad" style="max-width:560px;margin:60px auto"><h1>需要从 claude-pro 打开</h1><p class="sub">${esc(message)}</p><p>在任意 claude-pro 会话里输入 <code>/web</code>，或在终端运行 <code>claude-pro web</code>，会自动打开并登录这个页面。</p></div></div>`;
  }

  // ---------------------------------------------------------------- 概览

  async function overview() {
    const el = page('<h1>概览</h1><p class="sub">这台电脑上的 claude-pro</p><div class="empty">正在加载…</div>');
    let o;
    try { o = await api("/api/overview"); } catch (e) { el.innerHTML = `<h1>概览</h1><div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    $("#brandVersion").textContent = `v${o.version}`;
    const gw = o.gateway;
    el.innerHTML = `<h1>概览</h1><p class="sub">这台电脑上的 claude-pro · ${esc(o.host)}</p>
      <div class="cards">
        <a class="panel stat" href="#/new"><div class="label">运行中的会话</div><div class="value">${o.running}</div><div class="hint">${o.busy ? `${o.busy} 个正在工作` : "都空闲"}</div></a>
        <a class="panel stat" href="#/sessions"><div class="label">会话记录</div><div class="value">${o.sessions}</div><div class="hint">${o.projects} 个项目 · 占用 ${fmtBytes(o.storage)}</div></a>
        <a class="panel stat" href="#/providers"><div class="label">默认模型</div><div class="value" style="font-size:16px;word-break:break-all">${esc(o.remembered?.model || o.model)}</div><div class="hint">推理强度 ${esc(o.remembered?.effort || o.effort)}${o.remembered?.model ? " · 来自 /model 记住的选择" : ""}</div></a>
        <a class="panel stat" href="#/providers"><div class="label">7bit.fun 余额</div><div class="value">${gw ? (gw.balance != null ? fmtUsd(gw.balance) : "—") : "未连接"}</div><div class="hint">${gw ? esc(gw.account?.email || gw.account?.name || gw.key) : "在「模型与供应商」里连接"}${gw?.accountError ? ` · ${esc(gw.accountError)}` : ""}</div></a>
      </div>
      <div class="section-head"><h2>版本与位置</h2><button class="button secondary small" id="checkUpdate">检查更新</button></div>
      <div class="panel panel-pad"><dl class="kv">
        <dt>版本</dt><dd>v${esc(o.version)} <span id="updateState" class="muted"></span></dd>
        <dt>安装位置</dt><dd class="mono">${esc(o.installDir)}${o.sourceCheckout ? ' <span class="pill accent">源码</span>' : ""}</dd>
        <dt>配置目录</dt><dd class="mono">${esc(o.configDir)}</dd>
        <dt>Node</dt><dd>${esc(o.node)} · ${esc(o.platform)}</dd>
      </dl></div>
      <div class="section-head"><h2>已连接的供应商</h2><a class="button secondary small" href="#/providers">管理</a></div>
      <div class="panel">${gw || o.providers.length ? `<table class="list"><tbody>
        ${gw ? `<tr><td><strong>7bit.fun</strong></td><td class="muted">${esc(gw.url)}</td><td class="num">${esc(gw.key)}</td></tr>` : ""}
        ${o.providers.map((p) => `<tr><td><strong>${esc(p.name)}</strong></td><td class="muted">${p.models} 个模型</td><td class="num mono">${esc(p.id)}/…</td></tr>`).join("")}
      </tbody></table>` : '<div class="empty">还没有连接任何供应商</div>'}</div>`;
    $("#checkUpdate").addEventListener("click", async () => {
      $("#updateState").textContent = "检查中…";
      const u = await api("/api/update?check=1").catch((e) => ({ status: "error", error: e.message }));
      paintBrandUpdate(u);
      const state = $("#updateState", el);
      if (state) state.textContent = { dev: "· 源码版通过 Git 更新", current: "· 已是最新", available: `· 有新版本 ${u.version}，请点击版本号旁的更新按钮`, installed: `· 新版本 ${u.version} 已安装，点击版本号旁的按钮加载`, updating: "· 正在安装", restarting: "· 等待控制台加载新版", error: `· 检查失败：${u.error}` }[u.status] || "";
    });
  }

  // ---------------------------------------------------------------- 会话

  let sessionCache = null;
  async function sessions() {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    const tab = ["trash", "archived"].includes(params.get("tab")) ? params.get("tab") : "list";
    const el = page(`<h1>会话</h1><p class="sub">所有项目的对话记录：搜索、查看、改名、导出、在终端中继续</p>
      <div class="tabs"><a href="#/sessions" class="${tab === "list" ? "active" : ""}">全部会话</a><a href="#/sessions?tab=archived" class="${tab === "archived" ? "active" : ""}">已归档</a><a href="#/sessions?tab=trash" class="${tab === "trash" ? "active" : ""}">回收站</a></div><div id="body"><div class="empty">正在加载…</div></div>`);
    const body = $("#body", el);
    if (tab === "trash") return trash(body);
    let data;
    try { data = await api("/api/sessions"); } catch (e) { body.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    sessionCache = data.sessions;
    const projects = [...new Map(data.sessions.filter((s) => s.cwd).map((s) => [s.dir, s.cwd])).entries()];
    const saved = JSON.parse(sessionStorage.getItem("sessionFilter") || "{}");
    body.innerHTML = `<div class="toolbar"><input type="search" id="q" placeholder="搜索会话名、第一句话、id、目录…" value="${esc(saved.q || "")}">
      <select id="proj"><option value="">所有项目（${projects.length}）</option>${projects.map(([dir, cwd]) => `<option value="${esc(dir)}"${saved.proj === dir ? " selected" : ""}>${esc(shortPath(cwd))}</option>`).join("")}</select>
      <select id="sort"><option value="time">按最近使用</option><option value="size"${saved.sort === "size" ? " selected" : ""}>按大小</option><option value="cost"${saved.sort === "cost" ? " selected" : ""}>按花费</option></select></div>
      <div class="panel" id="table"></div><p class="faint" id="count" style="font-size:12px;margin-top:8px"></p>`;
    const draw = () => {
      const q = $("#q").value.trim().toLowerCase();
      const proj = $("#proj").value;
      const sort = $("#sort").value;
      sessionStorage.setItem("sessionFilter", JSON.stringify({ q, proj, sort }));
      let list = sessionCache.filter((s) => (tab === "archived" ? s.archived : !s.archived) && (!proj || s.dir === proj) && (!q || [s.title, s.firstPrompt, s.id, s.cwd, s.topic].some((v) => String(v || "").toLowerCase().includes(q))));
      if (sort === "size") list = list.slice().sort((a, b) => b.size - a.size);
      if (sort === "cost") list = list.slice().sort((a, b) => b.cost - a.cost);
      const shown = list.slice(0, 300);
      $("#table").innerHTML = shown.length ? `<table class="list"><thead><tr><th>会话</th><th>最后使用</th><th class="num">消息</th><th class="num">大小</th><th class="num">花费</th></tr></thead><tbody>
        ${shown.map((s) => `<tr class="click" data-open="${esc(s.dir)}/${esc(s.id)}"><td class="title-cell"><strong>${s.running ? '<span class="pill ok">运行中</span> ' : ""}${esc(s.title)}</strong><div class="path">${esc(shortPath(s.cwd || s.dir))} · ${esc(s.id.slice(0, 8))}</div></td>
          <td title="${esc(fmtTime(s.mtime))}">${ago(s.mtime)}</td><td class="num">${s.count}</td><td class="num">${fmtBytes(s.size)}</td><td class="num">${s.cost ? fmtUsd(s.cost) : "—"}${tab === "archived" ? ` <button class="button secondary small" data-unarchive="${esc(s.id)}">取消归档</button>` : ""}</td></tr>`).join("")}
      </tbody></table>` : `<div class="empty">${tab === "archived" ? "没有归档的会话：在工作区点会话右边的「…」，选择「归档」" : "没有符合条件的会话"}</div>`;
      $("#count").textContent = `共 ${list.length} 个${list.length > shown.length ? `，显示前 ${shown.length} 个（用搜索缩小范围）` : ""}`;
    };
    draw();
    $("#q").addEventListener("input", draw);
    $("#proj").addEventListener("change", draw);
    $("#sort").addEventListener("change", draw);
    $("#table").addEventListener("click", async (e) => {
      const un = e.target.closest("[data-unarchive]");
      if (un) {
        try { await archive([un.dataset.unarchive], false); } catch (err) { return fail(err); }
        const s = sessionCache.find((x) => x.id === un.dataset.unarchive);
        if (s) delete s.archived;
        return draw();
      }
      const row = e.target.closest("[data-open]");
      if (row) location.hash = `#/session/${row.dataset.open}`;
    });
    $("#q").focus();
  }

  async function trash(body) {
    let data;
    try { data = await api("/api/trash"); } catch (e) { body.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    const box = document.createElement("div");
    body.replaceChildren(box);
    box.innerHTML = `<p class="muted" style="font-size:13px">删除的会话在这里保留 7 天，之后自动清除。</p><div class="panel">${data.items.length ? `<table class="list"><thead><tr><th>会话</th><th>删除时间</th><th class="num">消息</th><th></th></tr></thead><tbody>
      ${data.items.map((t) => `<tr><td class="title-cell"><strong>${esc(t.title)}</strong><div class="path">${esc(shortPath(t.cwd || t.dir))}</div></td><td>${ago(t.deletedAt)}</td><td class="num">${t.count}</td>
        <td class="num"><button class="button secondary small" data-restore="${esc(t.trashId)}">恢复</button> <button class="button danger small" data-purge="${esc(t.trashId)}">彻底删除</button></td></tr>`).join("")}
    </tbody></table>` : '<div class="empty">回收站是空的</div>'}</div>${data.items.length ? '<div class="actions" style="margin-top:12px"><button class="button danger small" id="purgeAll">清空回收站</button></div>' : ""}`;
    box.addEventListener("click", async (e) => {
      const r = e.target.closest("[data-restore]"), p = e.target.closest("[data-purge]");
      try {
        if (r) { await api(`/api/trash/${encodeURIComponent(r.dataset.restore)}/restore`, { method: "POST" }); toast("已恢复"); trash(body); }
        if (p && confirm("彻底删除这个会话？不能恢复。")) { await api(`/api/trash/${encodeURIComponent(p.dataset.purge)}`, { method: "DELETE" }); trash(body); }
        if (e.target.id === "purgeAll" && confirm("清空回收站？不能恢复。")) { await api("/api/trash", { method: "DELETE" }); trash(body); }
      } catch (err) { fail(err); }
    });
  }

  async function sessionView(dir, id) {
    const here = location.hash;
    const el = page('<div class="chat-page"><div class="chat-scroll"><div class="empty">正在加载会话…</div></div></div>', "chat");
    let d;
    try { d = await api(`/api/sessions/${encodeURIComponent(dir)}/${encodeURIComponent(id)}`); } catch (e) { el.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    if (!el.isConnected || location.hash !== here) return;
    if (d.running) { location.replace(`#/live/${d.running}`); return; }
    // A conversation is opened as a running one: the console takes it up (in a tenth of a second) and the live view
    // replaces this one; what is drawn here meanwhile is the same conversation. (The console puts it away again once
    // nobody has looked at it for a while: see SessionHost.reap.)
    const base = `/api/sessions/${encodeURIComponent(dir)}/${encodeURIComponent(id)}`;
    el.innerHTML = `<div class="chat-page">
      <header class="chat-head"><div class="chat-titles"><h2>${esc(d.title)}</h2><div class="chat-sub">${esc(shortPath(d.cwd || dir))} · ${d.count} 条消息 · ${fmtBytes(d.size)}${d.cost ? ` · ${fmtUsd(d.cost)}` : ""} · 最后使用 ${esc(fmtTime(d.mtime))}</div></div><button type="button" class="icon-btn" id="hmenu" title="更多">${ICON.more}</button></header>
      <div class="chat-scroll" id="hscroll"><div class="chat-log" id="log"></div></div>
      <div class="chat-foot"><div class="chat-composer" id="hcomp"></div></div></div>`;
    const log = $("#log", el);
    const image = (n) => `${base}/image/${n}`;
    // drawn in pieces: a long conversation has thousands of items
    let i = 0;
    const wholes = wholeOutputs(log, async (tool) => (await api(`${base}/output/${encodeURIComponent(tool)}`)).text, (tool, text) => {
      const node = log.querySelector(`[data-cut="${CSS.escape(tool)}"]`);
      const old = node?.querySelector(".fold, pre");
      if (old) old.outerHTML = folded(esc(text));
    });
    cleanup = () => wholes.disconnect();
    const step = () => {
      log.insertAdjacentHTML("beforeend", d.items.slice(i, i + 200).map((it) => itemHtml(it, { image })).join(""));
      wholes.observe();
      i += 200;
      if (i < d.items.length) requestAnimationFrame(step);
      else if (!d.items.length) log.innerHTML = '<div class="chat-empty">没有内容</div>';
    };
    step();
    // The conversation goes on (in the console, or in a terminal tab): resolves with its live peer id once it is up
    // (null: it cannot be started from here, the command to run was shown), or throws.
    const start = async (inConsole) => {
      const r = await api(`${base}/open`, { method: "POST", body: { terminal: !inConsole } });
      if (r.peerId) return r.peerId;
      if (!r.opened) { await navigator.clipboard.writeText(r.command).catch(() => {}); toast(`请在终端运行（已复制）：${r.command}`); return null; }
      toast(`已在 ${r.how} 新标签中继续，等它上线…`);
      for (let k = 0; k < 30; k++) {
        await new Promise((res) => setTimeout(res, 1000));
        const live = (await api("/api/live").catch(() => ({ sessions: [] }))).sessions.find((x) => x.status?.sessionId === id);
        if (live) return live.peerId;
      }
      throw new Error("会话 30 秒内没有上线");
    };
    let sendingFirst = false;
    // Writing to it starts it: the message goes to it once its live view watches it (as for a new session)
    const hc = composer($("#hcomp", el), {
      placeholder: "发消息继续这个对话，/命令、!命令、@会话 都可以。Enter 发送，Shift+Enter 换行",
      dropZone: el,
      draftKey: `session:${id}`,
      onSend: async (text, images) => {
        sendingFirst = true;
        try {
          const peerId = await start(true);
          if (!peerId) throw new Error("这个系统不能自动启动会话");
          queueFirstMessage(peerId, text, images);
          if (!left && location.hash === here) location.hash = `#/live/${peerId}`;
        } catch (e) { sendingFirst = false; throw e; }
      },
    });
    const done = cleanup;
    let left = false;
    cleanup = () => { left = true; done(); hc.dispose(); };
    start(true).then((peerId) => { if (peerId && !left && !sendingFirst && location.hash === here) { loadWorkspace(); location.replace(`#/live/${peerId}`); } }).catch(() => { /* stays as it is: sending starts it */ });
    $("#hmenu", el).addEventListener("click", (e) => {
      popMenu(e.currentTarget, [{ key: "a", title: "", items: [
        { label: "导出 Markdown", value: "export" },
        { label: d.archived ? "取消归档" : "归档", description: d.archived ? "回到工作区" : "从工作区收起，内容保留", value: "archive" },
        { label: "删除", description: "先进回收站，7 天内可以恢复", value: "delete" },
      ] }], async (key, value) => {
        try {
          if (value === "export") location.href = `${base}/export`;
          if (value === "archive") { await archive([id], !d.archived); d.archived = !d.archived; }
          if (value === "delete" && confirm(`删除「${d.title}」？会先移到回收站，保留 7 天。`)) {
            await api(base, { method: "DELETE" });
            toast("已移到回收站");
            await loadWorkspace();
            location.hash = "#/new";
          }
        } catch (err) { fail(err); }
      });
    });
  }

  // ---------------------------------------------------------------- the sidebar: 工作区 (projects and their conversations)

  const ICON = {
    plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    folder: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    folderOpen: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1"/><path d="M3 19l2.5-7.5A2 2 0 0 1 7.4 10H21l-2.7 8a2 2 0 0 1-1.9 1H5a2 2 0 0 1-2-2"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
    newChat: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    stop: '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>',
    add: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    caret: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    chevron: '<svg class="chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 7 5 5-5 5M12 17h7"/></svg>',
    agent: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="2.5"/></svg>',
    todoOpen: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>',
    todoNow: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
    todoDone: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="currentColor"/><path d="m8 12.3 2.8 2.8L16.2 9.6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  };

  // how long ago, as short as the sidebar wants it: 刚刚, 5分, 3小时, 16天, 2个月, 1年
  function shortAgo(ms) {
    if (!ms) return "";
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return "刚刚";
    if (s < 3600) return `${Math.floor(s / 60)}分`;
    if (s < 86400) return `${Math.floor(s / 3600)}小时`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}天`;
    if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}个月`;
    return `${Math.floor(s / (86400 * 365))}年`;
  }

  const working = (it) => Boolean(it.peer && (it.peer.status?.turn || it.peer.status?.dialog));
  // what runs in the background for a session (its dev servers, its background agents): shown in the sidebar too
  const backgroundOf = (it) => (Array.isArray(it.peer?.status?.background) ? it.peer.status.background : []);
  const bgBadge = (list) => `<span class="ws-bg" title="${esc(`后台运行 ${list.length} 个：${list.map((b) => b.label).join("、")}`)}">${ICON.terminal}${list.length}</span>`;
  function liveState(st = {}) {
    if (st.dialog) return ["ask", "等待回答"];
    if (st.turn) return ["busy", st.verb ? `${st.verb}…` : "工作中"];
    return ["idle", "空闲"];
  }

  const ws = {
    sessions: [], live: [], projectOpen: {}, workspaces: [], q: "", loaded: false,
    closed: new Set(JSON.parse(localStorage.getItem("cpWsClosed") || "[]")),
    expanded: new Set(),
    tips: new Map(),
  };
  const projectKey = (cwd) => shortPath(cwd || "").toLowerCase().replace(/\/+$/, "");
  const baseName = (cwd) => shortPath(cwd || "").replace(/\/+$/, "").split("/").pop() || cwd || "?";

  let workspaceLoad;
  async function loadWorkspace({ afterPending = false } = {}) {
    if (workspaceLoad) {
      if (!afterPending) return workspaceLoad;
      await workspaceLoad;
    }
    return workspaceLoad ||= (async () => {
      try {
        const s = await api("/api/sessions");
        ws.sessions = s.sessions;
        ws.projectOpen = s.projectOpen || {};
        ws.workspaces = Array.isArray(s.workspaces) ? s.workspaces : [];
        ws.live = s.live || (await api("/api/live")).sessions;
        ws.loaded = true;
        if (!sidebarMenuOpen()) drawWorkspace();
      } catch (e) {
        if (!ws.loaded) $("#ws").innerHTML = `<div class="ws-empty">加载失败：${esc(e.message)}</div>`;
      }
    })().finally(() => { workspaceLoad = null; });
  }

  const sidebarMenuOpen = () => $("#ws :is([data-session-menu], [data-pmenu])[aria-expanded=true]");

  function drawWorkspace() {
    if (sidebarMenuOpen()) closeMenu?.();
    const box = $("#ws");
    const liveById = new Map(ws.live.map((l) => [l.peerId, l]));
    const known = new Set(ws.sessions.map((s) => s.id));
    // (an archived conversation is not listed, unless it runs again)
    const items = ws.sessions.filter((s) => !s.archived || s.running).map((s) => {
      const peer = s.running ? liveById.get(s.running) : null;
      return { id: s.id, dir: s.dir, archived: s.archived, href: peer ? `#/live/${peer.peerId}` : `#/session/${s.dir}/${s.id}`, title: peer?.status?.title || s.title, cwd: s.cwd || s.dir, mtime: s.mtime, peer, alt: peer ? `#/session/${s.dir}/${s.id}` : null };
    });
    // running sessions with nothing written yet (just started)
    for (const l of ws.live) if (!known.has(l.status?.sessionId)) items.push({ href: `#/live/${l.peerId}`, title: l.status?.title || l.name, cwd: l.status?.cwd || l.cwd, mtime: l.startedAt || 0, peer: l });
    const q = ws.q.toLowerCase();
    const groups = new Map();
    for (const it of items) {
      if (q && !`${it.title} ${it.cwd}`.toLowerCase().includes(q)) continue;
      const key = projectKey(it.cwd);
      if (!groups.has(key)) groups.set(key, { key, cwd: it.cwd, items: [], last: 0, live: false });
      const g = groups.get(key);
      g.items.push(it);
      // the projects with a session running first, then by when they last had a message (a running session counted as
      // "now" made two such projects swap places at every redraw: both were "now", a few ms apart)
      g.last = Math.max(g.last, it.mtime || 0);
      if (working(it)) g.live = true;
    }
    // the folders added to the 工作区 (添加工作区): listed before a conversation runs there
    for (const w of ws.workspaces) {
      const key = projectKey(w.cwd);
      if (groups.has(key)) { groups.get(key).added = true; continue; }
      if (q && !w.cwd.toLowerCase().includes(q)) continue;
      groups.set(key, { key, cwd: w.cwd, items: [], last: w.added || 0, live: false, added: true });
    }
    const list = [...groups.values()].sort((a, b) => b.live - a.live || b.last - a.last || a.key.localeCompare(b.key));
    const here = location.hash;
    ws.tips.clear();
    let n = 0;
    box.innerHTML = list.length ? list.map((g) => {
      g.items.sort((a, b) => working(b) - working(a) || (backgroundOf(b).length > 0) - (backgroundOf(a).length > 0) || b.mtime - a.mtime);
      const closed = ws.closed.has(g.key) && !q;
      const limit = ws.expanded.has(g.key) || q ? Infinity : 6;
      const rows = closed ? "" : g.items.slice(0, limit).map((it) => {
        const id = `t${n++}`;
        ws.tips.set(id, it);
        const [cls] = it.peer ? liveState(it.peer.status) : [""];
        const active = here === it.href || (it.alt && here === it.alt);
        return `<div class="ws-row${it.id ? " has-menu" : ""}" data-tip="${id}"><a class="ws-item${active ? " active" : ""}" href="${esc(it.href)}">${working(it) ? `<span class="ws-dot ${cls}"></span>` : ""}<span class="ws-title">${esc(it.title)}</span>${backgroundOf(it).length ? bgBadge(backgroundOf(it)) : ""}${working(it) ? "" : `<span class="ws-ago">${esc(shortAgo(it.mtime))}</span>`}</a>${it.id ? `<button type="button" class="ws-menu" data-session-menu aria-label="对话操作：${esc(it.title)}" aria-expanded="false">${ICON.more}</button>` : ""}</div>`;
      }).join("") + (!closed && g.items.length > limit ? `<button type="button" class="ws-more" data-expand="${esc(g.key)}">展开其余 ${g.items.length - limit} 个</button>` : "")
        + (!closed && !g.items.length ? '<div class="ws-hint">还没有会话，点右边的 + 新建</div>' : "");
      const running = g.items.filter(working).length;
      const bg = g.items.flatMap(backgroundOf);
      return `<div class="ws-group"><div class="ws-folder-row"><button type="button" class="ws-folder" data-folder="${esc(g.key)}" title="${esc(shortPath(g.cwd))}">${closed ? ICON.folder : ICON.folderOpen}<span>${esc(baseName(g.cwd))}</span>${bg.length ? bgBadge(bg) : ""}${running ? `<span class="ws-count">${running}</span>` : ""}</button><button type="button" class="ws-pmenu" data-pmenu="${esc(g.key)}" data-cwd="${esc(g.cwd)}" title="更多" aria-label="项目菜单" aria-expanded="false">${ICON.more}</button><button type="button" class="ws-add" data-add="${esc(g.cwd)}" title="在 ${esc(baseName(g.cwd))} 里新建会话" aria-label="新建会话">${ICON.add}</button></div>${rows}</div>`;
    }).join("") : `<div class="ws-empty">${q ? "没有符合的会话" : "还没有会话：点上方的文件夹图标添加工作区"}</div>`;
  }

  // 添加工作区: a folder chosen on the computer claude-pro runs on (the system's folder dialog here, the directory
  // browser from elsewhere), listed in the sidebar and opened there
  async function addWorkspaceDir() {
    const add = async (cwd) => {
      if (!cwd) return;
      try {
        const r = await api("/api/workspaces", { method: "POST", body: { cwd } });
        if (ws.closed.delete(projectKey(r.cwd))) localStorage.setItem("cpWsClosed", JSON.stringify([...ws.closed]));
        // the folder of the next new conversation (the new-conversation page, when shown, starts again with it)
        localStorage.setItem("cpNewDir", r.cwd);
        await loadWorkspace({ afterPending: true });
        if (location.hash === "#/new" || location.hash === "") route();
        toast(`已添加工作区 ${baseName(r.cwd)}`);
      } catch (e) { fail(e); }
    };
    browseProjectDirectories(null, add, { title: "添加工作区", action: "添加这个目录" });
  }

  function markActive() {
    const here = location.hash;
    $$("#ws .ws-item").forEach((a) => {
      const it = ws.tips.get(a.parentElement.dataset.tip);
      a.classList.toggle("active", Boolean(it && (here === it.href || (it.alt && here === it.alt))));
    });
  }

  // 归档 (or back, `archived` false): out of the workspace, kept whole, never cleaned up by age. A conversation the
  // console runs is put away first; one running in a terminal is only marked (it stays listed while it runs, and the
  // page does not end a terminal's session).
  async function archive(ids, archived = true, { force = false } = {}) {
    if (archived) {
      const live = (await api("/api/live")).sessions;
      for (const id of ids) {
        const peer = live.find((x) => x.status?.sessionId === id);
        if (peer?.status?.hidden) await putAway(id, { force, peer }).catch((e) => { if (!/对应的终端/.test(e.message)) throw e; });
      }
    }
    await api("/api/sessions/archive", { method: "POST", body: { ids, archived } });
    for (const s of ws.sessions) if (ids.includes(s.id)) s.archived = archived ? Date.now() : undefined;
    drawWorkspace();
    toast(archived ? `已归档${ids.length > 1 ? ` ${ids.length} 个会话` : ""}：在「全部会话 → 已归档」里可以找回` : "已取消归档");
    loadWorkspace({ afterPending: true });
  }

  // A conversation the console runs (taken up when it was opened) is let go of, its turn stopped if `force`: before it
  // is archived, deleted or continued in a terminal. Resolves once it is gone.
  async function putAway(sessionId, { force = false, peer } = {}) {
    const l = peer || (await api("/api/live")).sessions.find((x) => x.status?.sessionId === sessionId);
    if (!l) return;
    try { await api(`/api/live/${l.peerId}/end`, { method: "POST", body: { force } }); } catch (e) {
      if (!/不在运行/.test(e.message)) throw e; // (gone meanwhile: what was wanted)
    }
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (!(await api("/api/live")).sessions.some((x) => x.status?.sessionId === sessionId)) return;
    }
    throw new Error("会话尚未结束，请稍后再试");
  }

  async function copySessionId(id) {
    try {
      await navigator.clipboard.writeText(id);
      toast("已复制 Session ID");
    } catch {
      prompt("请手动复制 Session ID", id);
    }
  }

  function sidebarSessionMenu(button, it) {
    const items = [
      { label: it.archived ? "取消归档" : "归档", value: "archive" },
      { label: "复制 Session ID", value: "copy" },
      { label: "删除对话", value: "delete", danger: true },
    ];
    popMenu(button, [{ key: "session", title: "", items }], async (_, value) => {
      if (value === "copy") return copySessionId(it.id);
      const s = ws.sessions.find((s) => s.id === it.id) || it;
      const peer = ws.live.find((l) => l.status?.sessionId === it.id);
      const busy = Boolean(peer?.status?.busy || working({ peer }));
      const archiving = value === "archive" && !s.archived;
      try {
        if (value === "archive") {
          if (archiving && busy && peer?.status?.hidden && !confirm("它正在工作，归档会停止当前任务。确定归档？")) return;
          await archive([it.id], archiving, { force: busy });
        } else {
          if (!confirm(`删除「${it.title}」？会先移到回收站，保留 7 天。${busy ? "它正在工作，会先停止。" : ""}`)) return;
          await putAway(it.id, { force: busy });
          await api(`/api/sessions/${encodeURIComponent(it.dir)}/${encodeURIComponent(it.id)}`, { method: "DELETE" });
          toast("已移到回收站");
          await loadWorkspace({ afterPending: true });
        }
        if ((value === "delete" || archiving) && (location.hash === it.href || location.hash === it.alt)) location.hash = "#/new";
        else if (/^#\/sessions(?:\?|$)/.test(location.hash)) route();
      } catch (e) { fail(e); }
    }, { dropdown: true });
  }

  function wireSidebar() {
    const box = $("#ws");
    const tip = $("#tip");
    box.addEventListener("click", (e) => {
      const menu = e.target.closest("[data-session-menu]");
      if (menu) {
        tip.classList.add("hidden");
        const it = ws.tips.get(menu.closest("[data-tip]").dataset.tip);
        if (it) sidebarSessionMenu(menu, it);
        return;
      }
      const pm = e.target.closest("[data-pmenu]");
      if (pm) {
        const key = pm.dataset.pmenu;
        const ids = ws.sessions.filter((s) => !s.archived && !s.running && projectKey(s.cwd || s.dir) === key).map((s) => s.id);
        const items = [];
        if (ws.projectOpen.explorer) items.push({ label: "在资源管理器中打开", value: "explorer" });
        if (ws.projectOpen.vscode) items.push({ label: "在 VS Code 中打开", value: "vscode" });
        items.push({ label: ids.length ? `归档全部会话（${ids.length} 个）` : "没有可以归档的会话", description: ids.length ? "从工作区收起，内容保留，可以在「全部会话 → 已归档」里找回" : "运行中的会话不能归档", value: "all" });
        const pinned = ws.workspaces.find((w) => projectKey(w.cwd) === key);
        if (pinned) items.push({ label: "从工作区移除", description: "只是不再固定显示，目录和会话都不动", value: "unpin" });
        popMenu(pm, [{ key: "p", title: "", items }], async (_, value) => {
          try {
            if (value === "unpin") {
              await api("/api/workspaces/remove", { method: "POST", body: { cwd: pinned.cwd } });
              await loadWorkspace({ afterPending: true });
              toast(`已从工作区移除 ${baseName(pinned.cwd)}`);
            } else if (value === "all") {
              if (ids.length && confirm(`归档这个项目的 ${ids.length} 个会话？`)) await archive(ids);
            } else {
              await api("/api/projects/open", { method: "POST", body: { cwd: pm.dataset.cwd, target: value } });
              toast(value === "vscode" ? "已在运行 claude-pro 的电脑上打开 VS Code" : "已在运行 claude-pro 的电脑上打开资源管理器");
            }
          } catch (e) { fail(e); }
        }, { dropdown: true });
        return;
      }
      const add = e.target.closest("[data-add]");
      if (add) {
        // a new session in this project, at once (its first message is typed in its live view)
        if (add.disabled) return;
        add.disabled = true;
        startSession(add.dataset.add, "", []).catch(fail).finally(() => { add.disabled = false; });
        return;
      }
      const f = e.target.closest("[data-folder]"), x = e.target.closest("[data-expand]");
      if (f) {
        const key = f.dataset.folder;
        if (ws.closed.has(key)) ws.closed.delete(key); else ws.closed.add(key);
        localStorage.setItem("cpWsClosed", JSON.stringify([...ws.closed]));
        drawWorkspace();
      }
      if (x) { ws.expanded.add(x.dataset.expand); drawWorkspace(); }
    });
    box.addEventListener("mouseover", (e) => {
      const a = e.target.closest("[data-tip]");
      const it = a && ws.tips.get(a.dataset.tip);
      if (!it || sidebarMenuOpen() || e.target.closest("[data-session-menu]")) { tip.classList.add("hidden"); return; }
      const [cls, label] = working(it) ? liveState(it.peer.status) : ["", ""];
      const st = it.peer?.status || {};
      tip.innerHTML = `<strong>${esc(it.title)}</strong><div class="tip-path">${esc(shortPath(it.cwd))}</div><div>${it.peer ? esc([st.model, st.cost != null ? fmtUsd(st.cost) : "", st.context?.window ? `上下文 ${fmtTokens(st.context.used)}/${fmtTokens(st.context.window)}` : ""].filter(Boolean).join(" · ")) : esc(ago(it.mtime))}</div>${label || (it.peer && !st.hidden) ? `<div class="tip-state">${label ? `<span class="ws-dot ${cls}"></span>${esc(label)}` : ""}${it.peer && !st.hidden ? `${label ? " · " : ""}在终端窗口里运行` : ""}</div>` : ""}${backgroundOf(it).length ? `<div class="tip-bg">${backgroundOf(it).map((b) => `<div>${b.kind === "agent" ? ICON.agent : ICON.terminal}<span>${esc(b.label)}</span></div>`).join("")}</div>` : ""}`;
      const r = a.getBoundingClientRect();
      tip.classList.remove("hidden");
      tip.style.left = `${r.right + 8}px`;
      tip.style.top = `${Math.min(window.innerHeight - tip.offsetHeight - 8, r.top)}px`;
    });
    box.addEventListener("mouseleave", () => tip.classList.add("hidden"));
    box.addEventListener("scroll", () => {
      tip.classList.add("hidden");
      if (sidebarMenuOpen()) closeMenu?.();
    });
    $("#wsSearchBtn").addEventListener("click", () => {
      const input = $("#wsSearch");
      input.classList.toggle("hidden");
      if (!input.classList.contains("hidden")) input.focus(); else { input.value = ""; ws.q = ""; drawWorkspace(); }
    });
    $("#wsSearch").addEventListener("input", (e) => { ws.q = e.target.value.trim(); drawWorkspace(); });
    $("#wsRefresh").addEventListener("click", () => loadWorkspace());
    $("#wsAddDir").addEventListener("click", () => addWorkspaceDir().catch(fail));
  }

  // ---------------------------------------------------------------- the message box (new conversation and live)

  // What was typed and not sent, per box (`draftKey`): kept when the page shows another conversation and back. The text
  // also in localStorage (it survives a reload), the images only in memory (their object URLs live as long as the page).
  const draftImages = new Map();
  const draftQuotes = new Map(); // draftKey → the passages quoted in that box (引用), while the page is open
  const draftText = (key) => (key ? localStorage.getItem(`cpDraft:${key}`) || "" : "");
  function saveDraft(key, text, images) {
    if (!key) return;
    if (text) localStorage.setItem(`cpDraft:${key}`, text); else localStorage.removeItem(`cpDraft:${key}`);
    if (images.length) draftImages.set(key, images); else draftImages.delete(key);
  }

  // A rounded box with the text, images (pasted, dropped or added with +), what goes left and right of the send button.
  // onSend(text, images) resolves when sent (the box is emptied) or throws (it is kept).
  function composer(box, { placeholder, onSend, left = "", right = "", dropZone = box, draftKey = "" }) {
    box.innerHTML = `<form class="composer"><div class="quotes hidden"></div><div class="thumbs hidden"></div><textarea rows="1" placeholder="${esc(placeholder)}"></textarea>
      <div class="composer-bar"><button type="button" class="icon-btn" data-add title="添加图片（也可以粘贴或拖进来）" aria-label="添加图片">${ICON.add}</button><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
        <span class="composer-left">${left}</span><span class="grow"></span><span class="composer-right">${right}</span>
        <button type="button" class="round-btn stop hidden" data-stop title="停止当前任务">${ICON.stop}</button><button type="submit" class="round-btn" data-send title="发送（Enter）" disabled>${ICON.send}</button></div></form>`;
    const form = $("form", box), input = $("textarea", box), thumbs = $(".thumbs", box), file = $("input[type=file]", box), send = $("[data-send]", box);
    const quoteBox = $(".quotes", box);
    let images = [...(draftImages.get(draftKey) || [])];
    // 引用: passages of the conversation chosen with 引用文本, sent before the message as Markdown quotes; kept
    // with the draft
    let quotes = draftKey ? [...(draftQuotes.get(draftKey) || [])] : [];
    let sending = false;
    const keep = () => { saveDraft(draftKey, input.value, images); if (draftKey) { if (quotes.length) draftQuotes.set(draftKey, [...quotes]); else draftQuotes.delete(draftKey); } };
    const ready = () => { send.disabled = sending || (!input.value.trim() && !images.length && !quotes.length); };
    const paintQuotes = () => {
      quoteBox.classList.toggle("hidden", !quotes.length);
      quoteBox.innerHTML = quotes.map((q, i) => `<div class="quote-chip" title="${esc(q)}"><span class="quote-mark" aria-hidden="true">“</span><span class="quote-text">${esc(q.replace(/\s+/g, " "))}</span><button type="button" data-unquote="${i}" title="去掉这条引用" aria-label="去掉这条引用">×</button></div>`).join("");
      keep();
      ready();
    };
    quoteBox.addEventListener("click", (e) => {
      const b = e.target.closest("[data-unquote]");
      if (!b || sending) return;
      quotes.splice(Number(b.dataset.unquote), 1);
      paintQuotes();
    });
    const autosize = () => { input.style.height = "auto"; input.style.height = `${Math.min(240, input.scrollHeight)}px`; ready(); };
    const paint = () => {
      thumbs.classList.toggle("hidden", !images.length);
      thumbs.innerHTML = images.map((img, i) => `<div class="thumb"><img src="${img.url}" alt="图片 ${i + 1}"><button type="button" data-drop="${i}" title="移除" aria-label="移除">×</button></div>`).join("");
      keep();
      ready();
    };
    async function add(files) {
      if (sending) return;
      const list = [...files].filter((f) => f && f.type.startsWith("image/"));
      for (const f of list) {
        if (images.length >= MAX_IMAGES) { toast(`一条消息最多 ${MAX_IMAGES} 张图片`, "error"); break; }
        try { images.push(await prepareImage(f)); } catch (err) { fail(err); }
      }
      paint();
      input.focus();
    }
    thumbs.addEventListener("click", (e) => {
      const b = e.target.closest("[data-drop]");
      if (!b || sending) return;
      const [gone] = images.splice(Number(b.dataset.drop), 1);
      if (gone) URL.revokeObjectURL(gone.url);
      paint();
    });
    $("[data-add]", box).addEventListener("click", () => file.click());
    file.addEventListener("change", async () => { await add(file.files); file.value = ""; });
    input.addEventListener("input", () => { autosize(); keep(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    input.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.items || [])].filter((it) => it.kind === "file").map((it) => it.getAsFile());
      if (files.some((f) => f?.type.startsWith("image/"))) { e.preventDefault(); add(files); }
    });
    dropZone.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); box.classList.add("dropping"); } });
    dropZone.addEventListener("dragleave", (e) => { if (!dropZone.contains(e.relatedTarget)) box.classList.remove("dropping"); });
    dropZone.addEventListener("drop", (e) => { box.classList.remove("dropping"); if (e.dataTransfer?.files?.length) { e.preventDefault(); add(e.dataTransfer.files); } });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const typed = input.value;
      if (sending || (!typed.trim() && !images.length && !quotes.length)) return;
      // the quotes first, each a Markdown block quote, then what was typed
      const quoted = quotes.map((q) => q.split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join("\n")).join("\n\n");
      const text = quoted ? `${quoted}${typed.trim() ? `\n\n${typed}` : ""}` : typed;
      sending = true;
      input.readOnly = true;
      ready();
      try {
        await onSend(text, images.map(({ media_type, data }) => ({ media_type, data })));
        input.value = "";
        for (const img of images) URL.revokeObjectURL(img.url);
        images = [];
        quotes = [];
        paintQuotes();
        paint(); // (the draft goes with it)
        autosize();
      } catch (err) { fail(err); } finally { sending = false; input.readOnly = false; ready(); }
    });
    input.value = draftText(draftKey);
    if (images.length) paint();
    if (quotes.length) paintQuotes();
    requestAnimationFrame(autosize); // (measured once the box is on the page)
    return {
      input,
      submit: () => form.requestSubmit(),
      // a passage of the conversation quoted in the message being written (引用文本)
      quote(text) {
        const t = String(text || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
        if (!t || sending) return;
        if (!quotes.includes(t)) quotes.push(t);
        paintQuotes();
        input.focus();
      },
      left: $(".composer-left", box),
      right: $(".composer-right", box),
      setBusy(busy) { $("[data-stop]", box).classList.toggle("hidden", !busy); },
      onStop(fn) { $("[data-stop]", box).addEventListener("click", fn); },
      // (images of a draft stay: they come back with it)
      dispose() { for (const img of images) if (!draftImages.get(draftKey)?.includes(img)) URL.revokeObjectURL(img.url); },
    };
  }

  // 引用文本: text selected in the conversation (`log`) offers a small button above it that hands it to `onQuote`.
  // Returns what undoes it (the view's cleanup).
  function quoteSelection(log, onQuote) {
    let btn = null, text = "";
    const hide = () => { btn?.remove(); btn = null; text = ""; };
    const place = () => {
      const sel = getSelection();
      const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
      // (inside the conversation only: not the box being written, not a menu)
      const t = range && log.contains(range.commonAncestorContainer) ? sel.toString().trim() : "";
      if (!t) return hide();
      text = t;
      const r = range.getBoundingClientRect();
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "quote-pop";
        btn.textContent = "引用文本";
        // (pointerdown kept from taking the selection away; the text is the one the button was shown for)
        btn.addEventListener("pointerdown", (e) => e.preventDefault());
        btn.addEventListener("click", () => {
          const q = text;
          getSelection()?.removeAllRanges();
          hide();
          if (q) onQuote(q);
        });
        document.body.appendChild(btn);
      }
      const h = btn.offsetHeight || 34, w = btn.offsetWidth || 90;
      const top = r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8;
      btn.style.top = `${Math.round(top)}px`;
      btn.style.left = `${Math.round(Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8))}px`;
    };
    let timer = 0;
    const later = () => { clearTimeout(timer); timer = setTimeout(place, 120); };
    const scroller = log.closest(".chat-scroll");
    document.addEventListener("selectionchange", later);
    scroller?.addEventListener("scroll", later, { passive: true });
    addEventListener("resize", later);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", later);
      scroller?.removeEventListener("scroll", later);
      removeEventListener("resize", later);
      hide();
    };
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

  // A small menu next to `anchor`: onPick(section, value).
  function popMenu(anchor, sections, onPick, { dropdown = false } = {}) {
    const wasOpen = anchor.getAttribute("aria-expanded") === "true";
    closeMenu?.();
    if (wasOpen) return;
    const pop = document.createElement("div");
    pop.className = "pop";
    pop.innerHTML = sections.map((s) => `<div class="pop-head">${esc(s.title)}</div>${s.items.map((it, i) => `<button type="button" data-s="${esc(s.key)}" data-i="${i}" class="${it.current ? "current" : ""}${it.danger ? " danger" : ""}"><span>${esc(it.label)}${it.isDefault ? ' <span class="pill accent pop-default">默认</span>' : ""}</span>${it.description ? `<small>${esc(it.description)}</small>` : ""}</button>`).join("")}`).join("");
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`;
    const below = dropdown && r.bottom + pop.offsetHeight + 14 <= window.innerHeight;
    pop.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - pop.offsetHeight - 6)}px`;
    const close = (focus = false) => {
      pop.remove();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      closeMenu = null;
      if (dropdown) {
        anchor.setAttribute("aria-expanded", "false");
        if (focus) anchor.focus({ preventScroll: true });
      }
    };
    const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    const escape = (e) => { if (e.key === "Escape") { e.preventDefault(); close(true); } };
    closeMenu = close;
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    if (dropdown) {
      anchor.setAttribute("aria-expanded", "true");
      $("button", pop)?.focus({ preventScroll: true });
    }
    pop.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const s = sections.find((x) => x.key === b.dataset.s);
      close(true);
      onPick(s.key, s.items[Number(b.dataset.i)].value);
    });
  }

  // Clicking the tagged model follows the project default rather than creating a model override.
  const modelMenuItems = (models = []) => models.filter((m) => m.value !== "default").map((m) => ({ ...m, value: m.isDefault ? "default" : m.value }));

  // ---------------------------------------------------------------- 新会话

  // The folder browser (添加工作区, 其他目录…): in the page, so on top and at once, and the same from a phone (the
  // folders are those of the computer claude-pro runs on). The places on the side, the path in pieces, the folder's
  // subfolders (filtered as typed); the folder shown is the one chosen.
  let dirPlaces = null; // (asked once a page load)
  const samePath = (a, b) => Boolean(a && b) && a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
  function pathCrumbs(p) {
    const win = /^[a-z]:[\\/]?/i.test(p);
    const parts = p.split(/[\\/]+/).filter(Boolean);
    const out = win ? [] : [{ name: "/", path: "/" }];
    let acc = win ? "" : "/";
    parts.forEach((seg, i) => {
      acc = win ? (i === 0 ? `${seg}\\` : `${acc.replace(/\\?$/, "\\")}${seg}`) : `${acc.replace(/\/?$/, "/")}${seg}`;
      out.push({ name: seg, path: acc });
    });
    return out;
  }
  function browseProjectDirectories(initial, onSelect, { title = "选择项目目录", action = "选择这个目录" } = {}) {
    const up = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    const m = modal({
      title, sub: "运行 claude-pro 的电脑上的目录",
      body: `<div class="dirp"><nav class="dirp-side" data-places><div class="muted">正在读取…</div></nav><section class="dirp-main">
        <div class="dirp-bar"><button type="button" class="icon-btn" data-up title="上一级" aria-label="上一级" disabled>${up}</button><div class="dirp-crumbs" data-crumbs></div></div>
        <input type="search" class="dirp-filter" data-filter placeholder="筛选当前目录里的文件夹…" autocomplete="off">
        <div class="dirp-list" data-list aria-live="polite"></div></section></div>`,
      foot: `<span class="dirp-chosen" data-chosen></span><button type="button" class="button secondary" data-close>取消</button><button type="button" class="button" data-use disabled>${esc(action)}</button>`,
    });
    const list = $("[data-list]", m.el), use = $("[data-use]", m.el), filter = $("[data-filter]", m.el);
    let listing = null, request = 0;
    const drawSide = () => {
      if (!dirPlaces) return;
      const group = (label, items) => (items.length ? `<div class="dirp-group">${label}</div>${items.map((p) => `<button type="button" class="dirp-place${samePath(p.path, listing?.cwd) ? " active" : ""}" data-go="${esc(p.path)}" title="${esc(p.path)}">${ICON.folder}<span>${esc(p.name)}</span></button>`).join("")}` : "");
      $("[data-places]", m.el).innerHTML = group("位置", dirPlaces.places) + group("磁盘", dirPlaces.drives) + group("最近的项目", dirPlaces.recent);
    };
    const drawList = () => {
      if (!listing) return;
      const q = filter.value.trim().toLowerCase();
      const rows = listing.dirs.map((d, n) => ({ d, n })).filter(({ d }) => !q || d.name.toLowerCase().includes(q));
      list.innerHTML = rows.map(({ d, n }) => `<button type="button" class="dirp-row${d.hidden ? " dim" : ""}" data-i="${n}">${ICON.folder}<span>${esc(d.name)}</span>${ICON.chevron}</button>`).join("")
        || `<div class="dirp-empty">${q ? "没有符合的文件夹" : "这里没有子文件夹，可以直接选择这个目录"}</div>`;
    };
    async function load(cwd, fallback = null) {
      const id = ++request;
      list.innerHTML = '<div class="dirp-empty">正在读取…</div>';
      try {
        const next = await api(`/api/projects/directories?cwd=${encodeURIComponent(cwd)}`);
        if (id !== request || !m.el.isConnected) return;
        listing = next;
        filter.value = "";
        $("[data-up]", m.el).disabled = !next.parent;
        $("[data-crumbs]", m.el).innerHTML = pathCrumbs(next.cwd).map((c, i, all) => (i === all.length - 1 ? `<span class="dirp-crumb current">${esc(c.name)}</span>` : `<button type="button" class="dirp-crumb" data-go="${esc(c.path)}">${esc(c.name)}</button><span class="dirp-sep">›</span>`)).join("");
        $("[data-chosen]", m.el).textContent = next.cwd;
        $("[data-chosen]", m.el).title = next.cwd;
        use.disabled = false;
        drawSide();
        drawList();
        if (!mobileLayout.matches) filter.focus();
      } catch (e) {
        if (id !== request) return;
        if (fallback) return load(fallback);
        list.innerHTML = `<div class="dirp-empty">${esc(e.message)}</div>`;
      }
    }
    m.el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.hasAttribute("data-go")) load(b.dataset.go);
      else if (b.hasAttribute("data-up") && listing?.parent) load(listing.parent);
      else if (b.hasAttribute("data-i") && listing?.dirs[b.dataset.i]) load(listing.dirs[b.dataset.i].path);
      else if (b.hasAttribute("data-use") && listing?.cwd) { onSelect(listing.cwd); m.close(); }
    });
    filter.addEventListener("input", drawList);
    filter.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); $("[data-i]", list)?.click(); } // (the first match)
      else if (e.key === "Backspace" && !filter.value && listing?.parent) load(listing.parent);
    });
    (async () => {
      try { dirPlaces ||= await api("/api/projects/directories"); } catch { dirPlaces = { places: [], drives: [], recent: [], start: null }; }
      if (!m.el.isConnected) return;
      drawSide();
      const start = dirPlaces.start || dirPlaces.places[0]?.path;
      if (initial) load(initial, start); else if (start) load(start); else list.innerHTML = '<div class="dirp-empty">在左边选一个位置</div>';
    })();
  }

  async function newView() {
    const el = page(`<div class="chat-page"><div class="welcome"><img class="welcome-logo" src="/favicon.svg" alt="" width="56" height="56"><h1>你好，今天要做什么？</h1><p class="muted">选一个项目目录，告诉它要做什么：你在这里看着它工作、随时给它发消息。</p></div><div class="chat-composer" id="ncomp"></div></div>`, "chat");
    let projects = [];
    try { projects = (await api("/api/projects")).projects; } catch { /* the folder chooser still works */ }
    if (!el.isConnected) return;
    let dir = localStorage.getItem("cpNewDir") || projects[0]?.cwd || "";
    let model, effort, configRequest = 0;
    const c = composer($("#ncomp", el), {
      placeholder: "描述你要它做的事，/命令 也可以。Enter 发送，Shift+Enter 换行",
      left: `<button type="button" class="chip" id="ndir" title="会话在哪个目录里工作">${ICON.folder}<span></span>${ICON.caret}</button>`,
      right: `<button type="button" class="chip" id="nmodel" title="选择模型"><span>模型</span>${ICON.caret}</button><button type="button" class="chip" id="neffort" title="选择思考强度"><span>思考强度</span>${ICON.caret}</button>`,
      onSend: async (text, images) => startSession(dir, text, images, { model, effort }),
      draftKey: "new",
    });
    const chip = $("#ndir", el);
    const paintDir = () => { $("span", chip).textContent = dir ? baseName(dir) : "选择目录"; chip.title = dir ? `会话在 ${dir} 里工作` : "选择目录"; };
    paintDir();
    const modelChip = $("#nmodel", el), effortChip = $("#neffort", el);
    const options = (kind) => api(`/api/live/new/options?${new URLSearchParams({ cwd: dir, kind, ...(model ? { model } : {}), ...(effort ? { effort } : {}) })}`);
    function paintChoices(info) {
      $("span", modelChip).textContent = info.model || "模型";
      modelChip.title = `选择模型${info.model ? `：${info.model}` : ""}`;
      $("span", effortChip).textContent = info.effort === "auto" || !info.effort ? "思考强度：自动" : `思考强度：${info.effort}`;
    }
    async function refreshChoices() {
      const seq = ++configRequest;
      try { const info = await options("summary"); if (el.isConnected && seq === configRequest) paintChoices(info); } catch { /* the menus can try again */ }
    }
    const selectDir = (value) => {
      if (!value || !el.isConnected) return;
      dir = value;
      localStorage.setItem("cpNewDir", dir);
      paintDir();
      refreshChoices();
    };
    for (const [anchor, kind] of [[modelChip, "models"], [effortChip, "efforts"]]) {
      anchor.addEventListener("click", async () => {
        const currentDir = dir;
        anchor.disabled = true;
        try {
          const info = await options(kind);
          if (!el.isConnected || dir !== currentDir) return;
          const isModel = kind === "models";
          const items = isModel ? modelMenuItems(info.models) : (info.efforts || []).map((item) => ({ ...item, label: item.value === "default" ? "项目默认" : item.label, current: item.value === info.effortChoice }));
          if (!items.length) return toast(isModel ? "没有可选的模型" : "这个模型不能调推理强度");
          popMenu(anchor, [{ key: kind, title: isModel ? "模型" : "思考强度", items }], (_, value) => {
            if (isModel) { if (model !== value) effort = undefined; model = value; }
            else effort = value;
            refreshChoices();
          });
        } catch (e) { fail(e); } finally { anchor.disabled = false; }
      });
    }
    refreshChoices();
    chip.addEventListener("click", () => {
      popMenu(chip, [
        { key: "dir", title: "最近的项目", items: projects.slice(0, 12).map((p) => ({ label: baseName(p.cwd), description: shortPath(p.cwd), value: p.cwd, current: p.cwd === dir })) },
        { key: "other", title: "", items: [{ label: "其他目录…", value: "" }] },
      ], async (key, value) => {
        if (key !== "other") return selectDir(value);
        browseProjectDirectories(dir, selectDir, { title: "新会话的目录", action: "在这个目录里开始" });
      });
    });
    if (!mobileLayout.matches) c.input.focus();
  }

  const pendingFirstSends = new Set();
  function queueFirstMessage(peerId, text, images = []) {
    const key = `live:${peerId}`;
    if (draftText(key) || draftImages.has(key)) throw new Error("该会话已有未发送的草稿，本条消息仍保留在当前输入框");
    saveDraft(key, text, images.map((img) => ({ ...img, url: `data:${img.media_type};base64,${img.data}` })));
    pendingFirstSends.add(peerId);
  }

  // What a project would run or change (see projectRisk in config.js), shown before its first session: resolves true
  // (trust it), false (start without them).
  function askProjectTrust(dir, trust) {
    const labels = { mcp: "MCP 服务器（会启动的程序）", hooks: "hooks（会执行的命令）", env: "环境变量（可以改网关、shell 等）" };
    const rows = Object.entries(labels).map(([k, label]) => [label, trust.items.filter((i) => i.kind === k).map((i) => i.name)]).filter(([, n]) => n.length);
    const files = [...new Set(trust.items.map((i) => i.file))];
    return new Promise((resolve) => {
      let answered = false;
      const m = modal({
        title: "信任这个项目吗？", sub: dir,
        body: `<p style="margin:0 0 10px">这个项目带有会在本机运行程序或改变设置的配置，只在你信得过它时启用（比如是你自己的项目）。</p>
          ${rows.map(([label, names]) => `<div class="file-row"><span class="name" style="min-width:auto">${esc(label)}</span><span class="desc mono">${esc(names.join("、"))}</span></div>`).join("")}
          <p class="muted" style="font-size:12.5px;margin:10px 0 0">来自 ${files.map((f) => `<code>${esc(f)}</code>`).join("、")}。配置改了会再问。</p>`,
        foot: '<button class="button secondary" data-no>这次不启用</button><button class="button" data-yes>信任并启用</button>',
        onClose: () => { if (!answered) resolve(false); },
      });
      const done = (v) => { answered = true; m.close(); resolve(v); };
      $("[data-yes]", m.el).addEventListener("click", () => done(true));
      $("[data-no]", m.el).addEventListener("click", () => done(false));
    });
  }

  // A new session in `dir`, run by the console; it is opened here and the message goes to it.
  async function startSession(dir, text, images, choices = {}) {
    if (!dir) throw new Error("先选一个目录");
    const here = location.hash;
    const before = new Set(ws.live.map((r) => r.peerId));
    let r;
    try { r = await api("/api/live/new", { method: "POST", body: { cwd: dir, ...choices } }); }
    catch (e) {
      // a project whose hooks, MCP servers or env are not trusted yet: asked here, then started with the answer
      if (e.status !== 409 || !e.data?.trust) throw e;
      const trust = await askProjectTrust(dir, e.data.trust);
      r = await api("/api/live/new", { method: "POST", body: { cwd: dir, ...choices, trust, trustHash: e.data.trust.hash } });
    }
    localStorage.setItem("cpNewDir", r.cwd);
    const until = Date.now() + 30_000;
    let found = r.peerId ? { peerId: r.peerId } : null;
    while (!found && Date.now() < until) {
      await new Promise((res) => setTimeout(res, 1000));
      try { found = (await api("/api/live")).sessions.find((x) => !before.has(x.peerId) && projectKey(x.status?.cwd || x.cwd) === projectKey(r.cwd)); } catch { /* again */ }
    }
    if (!found) throw new Error("会话 30 秒内没有上线：可能是启动出错了，在终端里运行 claude-pro 看看");
    if (text || images?.length) queueFirstMessage(found.peerId, text, images);
    loadWorkspace({ afterPending: true });
    if (location.hash === here) location.hash = `#/live/${found.peerId}`;
  }

  // ---------------------------------------------------------------- a running session, live

  function liveView(peerId) {
    const el = page(`<div class="chat-page">
      <header class="chat-head"><div class="chat-titles"><h2 id="ltitle">连接中…</h2><div class="chat-sub" id="lsub"></div></div><span id="lconn" class="pill warn" hidden></span><button type="button" class="icon-btn" id="lmenu" title="更多">${ICON.more}</button></header>
      <div class="chat-scroll" id="lscroll"><div class="chat-log" id="log"></div></div>
      <div class="chat-foot"><div class="chat-extra"><div class="bgwork" id="lbg"></div><div class="todos" id="ltodos"></div><div class="queue" id="lqueue"></div><div id="ldialog"></div></div>
        <div class="status-line" id="lstatus"></div><div class="chat-composer" id="lcomp"></div><div class="chat-stats" id="lstats"></div></div>
    </div>`, "chat");
    const log = $("#log", el);
    const scroller = $("#lscroll", el);
    const elements = new Map();
    const full = new Map();
    let state = hydrate([]);
    let status = {};
    let statusAt = Date.now();
    let dialogShown = null;
    const post = (type, body = {}) => api(`/api/live/${peerId}/${type}`, { method: "POST", body });
    const near = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
    const c = composer($("#lcomp", el), {
      placeholder: "发消息继续这个对话，/命令、!命令、@会话 都可以。Enter 发送，Shift+Enter 换行",
      right: `<button type="button" class="chip" id="lmodel" title="切换模型"><span></span>${ICON.caret}</button><button type="button" class="chip" id="leffort" title="切换推理强度"><span></span>${ICON.caret}</button>`,
      dropZone: el,
      draftKey: `live:${peerId}`,
      onSend: async (text, images) => {
        if (/^\s*\/(exit|quit|restart|reload|update)(\s|$)/i.test(text)) throw new Error("结束、重启会话和更新 claude-pro 只能在终端里操作");
        const r = await post("send", { text, images });
        if (r.queued) toast("会话正忙：已排队，当前任务结束后处理");
        setTimeout(() => { scroller.scrollTop = scroller.scrollHeight; }, 50);
      },
    });
    c.onStop(() => post("interrupt").catch(fail));
    // the model and the reasoning effort, each its own menu
    const choose = (key, title, list) => async (e) => {
      const anchor = e.currentTarget;
      let o;
      try { o = await post("options"); } catch (err) { return fail(err); }
      if (!el.isConnected) return;
      const items = key === "model" ? modelMenuItems(o.models) : (o[list] || []);
      if (!items.length) return toast(key === "effort" ? "这个模型不能调推理强度" : "没有可选的模型");
      popMenu(anchor, [{ key, title, items }], (k, value) => post("send", { text: `/${k} ${value}` }).catch(fail));
    };
    $("#lmodel", el).addEventListener("click", choose("model", "模型", "models"));
    $("#leffort", el).addEventListener("click", choose("effort", "推理强度", "efforts"));
    $("#lmenu", el).addEventListener("click", (e) => {
      const known = ws.sessions.find((s) => s.id === status.sessionId);
      popMenu(e.currentTarget, [{ key: "a", title: "", items: [
        { label: "导出 Markdown", value: "export" },
        { label: "归档", description: "从工作区收起，内容保留", value: "archive" },
        { label: "删除", description: "先进回收站，7 天内可以恢复", value: "delete" },
      ] }], async (key, value) => {
        if (!known) return toast("这个对话还没有内容");
        const sessionId = status.sessionId;
        const busy = Boolean(status.busy || status.turn || status.dialog);
        const base = known ? `/api/sessions/${encodeURIComponent(known.dir)}/${encodeURIComponent(known.id)}` : "";
        try {
          if (value === "export") location.href = `${base}/export`;
          if (value === "archive") {
            if (busy && !confirm("它正在工作，归档会停止当前任务。确定归档？")) return;
            await archive([sessionId], true, { force: busy });
            location.hash = "#/new";
          }
          if (value === "delete") {
            if (!confirm(`删除「${status.title || known.title}」？会先移到回收站，保留 7 天。${busy ? "它正在工作，会先停止。" : ""}`)) return;
            await putAway(sessionId, { force: busy });
            await api(base, { method: "DELETE" });
            toast("已移到回收站");
            await loadWorkspace();
            location.hash = "#/new";
          }
        } catch (err) { fail(err); }
      });
    });

    function render(item) {
      let node = elements.get(item);
      const html = itemHtml(item, { full, canExpand: true, image: (n) => `/api/live/${peerId}/image/${n}` });
      if (!node) {
        if (!html) return;
        node = document.createElement("div");
        node.style.display = "contents";
        elements.set(item, node);
        log.appendChild(node);
      }
      const open = node.querySelector("details")?.open;
      node.innerHTML = html;
      if (open) { const det = node.querySelector("details"); if (det) det.open = true; }
      if (item.k === "tool" && item.status !== "running") wholes?.observe();
    }
    function renderAll() {
      log.innerHTML = "";
      elements.clear();
      for (const it of state.items) render(it);
      wholes?.observe();
      if (!state.items.length) log.innerHTML = '<div class="chat-empty">还没有消息：在下面输入，或在它的终端里输入</div>';
      scroller.scrollTop = scroller.scrollHeight;
    }
    function renderStatus() {
      const s = status;
      const busy = Boolean(s.turn ?? s.busy);
      let html = "";
      if (s.rateWait) html = `<span class="work">⏸ ${esc(s.rateWait.text)}</span>`;
      else if (busy) {
        const frames = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
        const parts = [fmtDuration((s.elapsed || 0) + Date.now() - statusAt)];
        if (s.tokens) parts.push(`↓ ${fmtTokens(s.tokens)} tokens`);
        if (s.aborting) parts.push("正在停止…");
        html = `<span class="work">${frames[Math.floor(Date.now() / 120) % frames.length]} ${esc(s.verb || "Working")}…</span> <span class="muted">(${parts.join(" · ")})</span>`;
      }
      $("#lstatus", el).innerHTML = html;
      for (const t of $$("#lbg [data-since]", el)) t.textContent = fmtDuration(Math.max(0, Date.now() - Number(t.dataset.since)));
      c.setBusy(busy);
    }
    // what runs in the background for the session (its background agents, its run_in_background commands)
    function renderBackground(list) {
      const box = $("#lbg", el);
      const open = $("details", box)?.open ?? true;
      box.innerHTML = list.length ? `<details class="side-card"${open ? " open" : ""}><summary><span class="pulse"></span>后台运行<span class="card-count">${list.length}</span>${ICON.chevron}</summary><div class="card-list">${list.map((b) => {
        const agent = b.kind === "agent";
        const tip = b.command && b.command !== b.label ? b.command : b.label;
        const since = Number(b.since) > 0 ? Number(b.since) : 0;
        return `<div class="bg-row${agent ? " agent" : ""}" title="${esc(tip)}"><span class="bg-icon" title="${agent ? "后台 agent" : "后台命令"}">${agent ? ICON.agent : ICON.terminal}</span><span class="bg-label">${esc(b.label)}</span><span class="bg-id">${esc(b.id)}</span>${since ? `<span class="bg-time" data-since="${since}">${fmtDuration(Math.max(0, Date.now() - since))}</span>` : ""}</div>`;
      }).join("")}</div></details>` : "";
    }
    function renderTodos(todos) {
      const box = $("#ltodos", el);
      const open = $("details", box)?.open ?? true;
      const done = todos.filter((t) => t.status === "completed").length;
      box.innerHTML = todos.length ? `<details class="side-card"${open ? " open" : ""}><summary>待办<span class="card-count">${done}/${todos.length}</span><span class="todo-bar"><i style="width:${Math.round((done / todos.length) * 100)}%"></i></span>${ICON.chevron}</summary><div class="card-list">${todos.map((t) => {
        const state = t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : "";
        return `<div class="todo-row ${state}"><span class="todo-icon">${state === "done" ? ICON.todoDone : state === "now" ? ICON.todoNow : ICON.todoOpen}</span><span>${esc(t.content)}</span></div>`;
      }).join("")}</div></details>` : "";
    }
    function setStatus(next) {
      status = next || {};
      statusAt = Date.now();
      $("#ltitle", el).textContent = status.title || status.name || "claude-pro";
      $("#lsub", el).textContent = `@${status.name || ""} · ${shortPath(status.cwd || "")}${status.hidden ? "" : " · 在终端窗口里运行"}`;
      $("#lmodel span", el).textContent = status.model || "模型";
      $("#leffort span", el).textContent = status.effort || "推理强度";
      $("#leffort", el).hidden = !status.effort;
      const stats = [];
      if (status.context?.window) stats.push(`上下文 ${fmtTokens(status.context.used || 0)} / ${fmtTokens(status.context.window)}（${Math.round(((status.context.used || 0) / status.context.window) * 100)}%）`);
      if (Number.isFinite(status.cost)) stats.push(`花费 ${fmtUsd(status.cost)}`);
      if (status.tasks && !Array.isArray(status.background)) stats.push(`${status.tasks} 个后台 agent`); // (a session of an older version)
      $("#lstats", el).textContent = stats.join("  ·  ");
      renderBackground(Array.isArray(status.background) ? status.background : []);
      renderTodos(Array.isArray(status.todos) ? status.todos : []);
      $("#lqueue", el).innerHTML = (status.queue || []).map((q) => `<div class="queue-row"><span class="queue-tag">排队中</span><span>${esc(String(q).replace(/\s+/g, " ").slice(0, 200))}</span></div>`).join("");
      renderDialog(status.dialog);
      renderStatus();
    }
    function renderDialog(d) {
      const box = $("#ldialog", el);
      if (!d) { box.innerHTML = ""; dialogShown = null; return; }
      if (dialogShown === d.id) return;
      dialogShown = d.id;
      let html = `<div class="dialog-box"><strong>${ansi(d.title || "问题")}</strong>`;
      if (d.markdown) html += `<div class="md">${md(d.markdown)}</div>`;
      else if (d.body?.length) html += `<pre style="margin:0;white-space:pre-wrap">${ansiLines(d.body)}</pre>`;
      if (d.question) html += `<div>${ansi(d.question)}</div>`;
      if (Array.isArray(d.options)) {
        html += '<div class="opts">';
        d.options.forEach((o, i) => {
          if (o.other) html += `<div class="actions"><input class="dlg-other" placeholder="其他：输入你自己的回答" style="flex:1"><button type="button" class="button small" data-other>发送</button></div>`;
          else if (d.multi) html += `<label class="opt"><input type="checkbox" value="${i}"> ${ansi(o.label)}${o.description ? `<div class="desc">${ansi(o.description)}</div>` : ""}</label>`;
          else html += `<button type="button" class="opt" data-i="${i}">${i + 1}. ${ansi(o.label)}${o.description ? `<div class="desc">${ansi(o.description)}</div>` : ""}</button>`;
        });
        html += `</div><div class="actions">${d.multi ? '<button type="button" class="button small" data-confirm>确认</button>' : ""}<button type="button" class="button secondary small" data-cancel>取消</button></div>`;
      } else html += '<div class="muted">这个问题只能在终端里回答。</div><div class="actions"><button type="button" class="button secondary small" data-cancel>取消</button></div>';
      box.innerHTML = `${html}</div>`;
    }
    $("#ldialog", el).addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b || dialogShown == null) return;
      const checked = $$("#ldialog input[type=checkbox]:checked", el).map((x) => Number(x.value));
      let body = null;
      if (b.dataset.i !== undefined) body = { index: Number(b.dataset.i) };
      else if (b.dataset.confirm !== undefined) body = { indices: checked };
      else if (b.dataset.other !== undefined) { const text = $(".dlg-other", el)?.value.trim(); if (text) body = { text, indices: checked }; }
      else if (b.dataset.cancel !== undefined) body = { cancel: true };
      if (!body) return;
      try { await post("dialog", { id: dialogShown, ...body }); } catch (err) { fail(err); dialogShown = null; renderDialog(status.dialog); }
    });
    const wholes = wholeOutputs(log, async (id) => (await post("output", { id })).text, (id, text) => {
      full.set(id, text);
      const item = state.items.find((it) => it.id === id);
      if (item) render(item);
    });

    function handle(msg) {
      if (msg.t === "snapshot") {
        state = hydrate(msg.items || []);
        renderAll();
        if (msg.status) setStatus(msg.status);
        if (pendingFirstSends.delete(peerId)) {
          if (status.dialog) toast("消息已保留为草稿：请先完成会话的提示，再发送");
          else c.submit(); // only once; the composer holds the draft on any unacknowledged send
        }
        return;
      }
      if (msg.t === "status") { setStatus(msg.status); return; }
      if (msg.t === "batch") {
        const stick = near();
        log.querySelector(".chat-empty")?.remove();
        for (const ev of msg.events || []) { const it = applyEvent(state, ev); if (it) render(it); }
        if (stick) scroller.scrollTop = scroller.scrollHeight;
      }
    }
    const conn = $("#lconn", el);
    const es = new EventSource(`/api/live/${peerId}/events`);
    // shown only when the page has lost the session (connected is the normal state, not worth a word)
    es.onopen = () => { conn.hidden = true; };
    es.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch { /* skip */ } };
    es.onerror = () => { conn.textContent = es.readyState === EventSource.CLOSED ? "连接已断开，请刷新页面" : "正在重新连接…"; conn.hidden = false; };
    const tick = setInterval(renderStatus, 250);
    const unquote = quoteSelection(log, (text) => c.quote(text));
    cleanup = () => { es.close(); clearInterval(tick); c.dispose(); wholes.disconnect(); unquote(); };
    if (!mobileLayout.matches) c.input.focus();
  }

  // ---------------------------------------------------------------- 远程访问

  async function remotePage() {
    const el = page('<h1>远程访问</h1><p class="sub">在手机或别的电脑上，通过你自己的域名（https://&lt;前缀&gt;.7bit.fun）打开这台电脑的控制台，要输入密码</p><div id="body"><div class="empty">正在加载…</div></div>');
    let v;
    try { v = await api("/api/remote"); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    // the address's prefix (the account's 通讯号 at the gateway), asked once
    const h = v.gateway ? await api("/api/remote/handle").catch((e) => ({ error: e.message })) : null;
    if (!el.isConnected) return;
    drawRemote(el, v, h);
    const timer = setInterval(async () => { try { const next = await api("/api/remote"); if (JSON.stringify(next.tunnel) !== JSON.stringify(v.tunnel)) { v = next; drawRemote(el, v, h); } } catch { /* next time */ } }, 3000);
    cleanup = () => clearInterval(timer);
  }

  const HANDLE_RULE = /^[a-z][a-z0-9-]{1,18}[a-z0-9]$/;
  const HANDLE_HINT = "3–20 个小写字母、数字或 -，字母开头、不以 - 结尾";

  function drawRemote(el, v, h) {
    // without 7bit.fun there is no address: only the way to connect it
    if (!v.gateway) {
      $("#body", el).innerHTML = `<div class="panel panel-pad"><div style="font-weight:650;margin-bottom:6px">远程访问需要 7bit.fun 网关</div><p class="muted" style="margin:0 0 14px;font-size:13px">访问地址 https://&lt;前缀&gt;.7bit.fun 由网关提供：连接 7bit.fun 后，就能在这里选一个自己的域名前缀并开启。</p><button class="button" id="rConnectGw">去连接 7bit.fun</button></div>`;
      $("#rConnectGw", el).addEventListener("click", () => { sessionStorage.setItem("cpOpenAdd", "1"); location.hash = "#/providers"; });
      return;
    }
    const t = v.tunnel || {};
    const domain = h?.domain || "7bit.fun";
    const prefixField = (id) => `<label class="field" style="margin:0">域名前缀<small>${HANDLE_HINT}；要唯一，它也是你在网关的通讯号（联系人用它找到你）</small>
        <span class="prefix-row"><span class="mono muted">https://</span><input id="${id}" class="mono" maxlength="20" autocomplete="off" spellcheck="false" placeholder="例如 yanzc" value="${h && !h.auto ? esc(h.handle) : ""}"><span class="mono muted">.${esc(domain)}</span></span></label>`;
    const state = !v.enabled ? ["off", "已关闭"] : t.status === "online" ? ["ok", "已开启"] : t.status === "error" ? ["off", "没有接上"] : ["warn", "正在连接"];
    const device = (ua) => { const s = String(ua || ""); return /iPhone|iPad/.test(s) ? "iPhone / iPad" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows" : /Mac OS/.test(s) ? "Mac" : s.slice(0, 40) || "未知设备"; };
    $("#body", el).innerHTML = `
      <div class="panel panel-pad"><div class="actions" style="justify-content:space-between">
        <div><div class="muted" style="font-size:12.5px">状态</div><div style="font-size:18px;font-weight:650;margin-top:2px"><span class="pill ${state[0]}">${state[1]}</span>
          ${t.status === "online" && t.host ? ` <a href="https://${esc(t.host)}" target="_blank" rel="noopener" class="mono" style="font-size:15px">https://${esc(t.host)}</a>` : ""}</div>
          ${t.error ? `<div style="color:var(--danger);font-size:13px;margin-top:4px">${esc(t.error)}</div>` : ""}
          ${h?.error ? `<div style="color:var(--danger);font-size:13px;margin-top:4px">读不到域名前缀：${esc(h.error)}</div>` : ""}</div>
        <div class="actions">${v.enabled ? `<button class="button secondary" id="rRename">修改前缀</button><button class="button danger" id="rOff">关闭远程访问</button>` : ""}</div></div>
        ${v.enabled ? "" : `<div class="remote-setup">${prefixField("rHandle")}<div class="actions"><button class="button" id="rOn" ${v.hasPassword ? "" : "disabled"}>开启远程访问</button>${v.hasPassword ? "" : '<span class="muted" style="font-size:12.5px">先在下面设一个密码</span>'}<span class="modal-error" id="rErr"></span></div></div>`}
        <p class="muted" style="font-size:12.5px;margin:12px 0 0">开启后这台电脑的控制台服务常驻后台；电脑休眠或关机时打不开。开机后想马上能连，就打开下面的「开机自动启动」；不开的话，claude-pro 的任何会话启动时也会重新接上。</p></div>
      <div class="panel panel-pad" id="rAuto"><span class="muted">正在读取开机启动设置…</span></div>
      <div class="section-head"><div><h2>密码</h2><p>${v.hasPassword ? "已设置。改密码会让所有已登录的设备退出。" : `还没有设置：开启前先设一个（至少 ${v.minPassword} 位）。`}</p></div></div>
      <form class="panel panel-pad actions" id="rPwForm"><input type="password" id="rPw1" placeholder="新密码" autocomplete="new-password" style="flex:1;min-width:180px"><input type="password" id="rPw2" placeholder="再输一次" autocomplete="new-password" style="flex:1;min-width:180px"><button class="button" type="submit">${v.hasPassword ? "修改密码" : "设置密码"}</button></form>
      <div class="section-head"><div><h2>已登录的设备</h2><p>${v.sessions.length} 台</p></div>${v.sessions.length ? '<button class="button danger small" id="rLogoutAll">全部退出</button>' : ""}</div>
      <div class="panel">${v.sessions.length ? `<table class="list"><tbody>${v.sessions.map((s) => `<tr><td>${esc(device(s.ua))}</td><td class="mono">${esc(s.ip || "")}</td><td>最近 ${esc(ago(s.lastSeen))}</td><td class="num muted">${s.remember ? "记住 30 天" : "1 天"}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">没有</div>'}</div>
      <div class="section-head"><h2>最近的登录</h2></div>
      <div class="panel">${v.logins.length ? `<table class="list"><tbody>${v.logins.map((l) => `<tr><td>${l.ok ? '<span class="pill ok">成功</span>' : '<span class="pill off">密码错误</span>'}</td><td>${esc(device(l.ua))}</td><td class="mono">${esc(l.ip || "")}</td><td class="num">${esc(fmtTime(l.at))}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">还没有人登录过</div>'}</div>`;
    // 开机自动启动: the console started at log-in (a shortcut in Startup, a LaunchAgent, an XDG autostart entry)
    const drawAuto = (a) => {
      const box = $("#rAuto", el);
      if (!box) return;
      const head = '<div class="auto-head"><div><div style="font-weight:650">开机自动启动</div><div class="muted" style="font-size:12.5px;margin-top:2px">电脑开机、登录后在后台启动控制台，手机马上就能连。没开远程访问时，没人用 30 分钟后它会自己退出。</div></div>';
      if (!a.supported) {
        box.innerHTML = `${head}</div><p class="muted" style="font-size:13px;margin:12px 0 6px">这台电脑没有图形桌面，没有「登录时启动」的地方。要开机启动，把下面这行加进 <code>crontab -e</code>：</p><pre class="auto-cmd">${esc(a.hint)}</pre>`;
        return;
      }
      const how = { windows: "「启动」文件夹里的快捷方式", macos: "LaunchAgent", linux: "桌面的自启动项" }[a.kind] || "";
      box.innerHTML = `${head}<label class="switch"><input type="checkbox" id="rAutoOn" role="switch"${a.enabled ? " checked" : ""}><span class="switch-track" aria-hidden="true"></span><span class="sr-only">开机自动启动</span></label></div>${a.enabled ? `<div class="muted" style="font-size:12px;margin-top:10px">${esc(how)}：<span class="mono">${esc(a.file)}</span></div>` : ""}`;
      $("#rAutoOn", box).addEventListener("change", async (e) => {
        const on = e.target.checked;
        e.target.disabled = true;
        try {
          drawAuto(await api("/api/autostart", { method: "POST", body: { enabled: on } }));
          toast(on ? "已设置开机自动启动" : "已取消开机自动启动");
        } catch (err) { e.target.checked = !on; e.target.disabled = false; fail(err); }
      });
    };
    api("/api/autostart").then(drawAuto).catch((e) => { const box = $("#rAuto", el); if (box) box.innerHTML = `<span class="muted">读不到开机启动设置：${esc(e.message)}</span>`; });

    const post = async (body, done) => {
      const next = await api("/api/remote", { method: "POST", body });
      if (body.handle && h) Object.assign(h, { handle: body.handle, auto: false, error: null });
      drawRemote(el, next, h);
      if (done) toast(done);
    };
    // the prefix typed, checked here as the gateway will: none needed when the user chose one before
    const typedHandle = (input, err) => {
      const value = input.value.trim().toLowerCase();
      if (!value && h && !h.auto) return h.handle;
      if (!value) { err("先填一个域名前缀"); input.focus(); return null; }
      if (!HANDLE_RULE.test(value)) { err(`域名前缀要是 ${HANDLE_HINT}`); input.focus(); return null; }
      return value;
    };
    $("#rOn", el)?.addEventListener("click", async (e) => {
      const b = e.currentTarget, errBox = $("#rErr", el), err = (m) => { errBox.textContent = m; };
      err("");
      const handle = typedHandle($("#rHandle", el), err);
      if (!handle) return;
      b.disabled = true;
      try { await post({ ...(handle !== h?.handle ? { handle } : {}), enabled: true }, `远程访问已开启：https://${handle}.${domain}，正在连接网关…`); }
      catch (ex) { err(ex.message); b.disabled = false; }
    });
    $("#rHandle", el)?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#rOn", el)?.click(); });
    $("#rRename", el)?.addEventListener("click", () => {
      const m = modal({
        title: "修改域名前缀", sub: `现在是 https://${h?.handle || "…"}.${domain}；改后旧地址就打不开了`,
        body: prefixField("rNewHandle"),
        foot: '<span class="modal-error"></span><button class="button secondary" data-close>取消</button><button class="button" id="rSaveHandle">保存</button>',
      });
      const input = $("#rNewHandle", m.el);
      input.focus(); input.select();
      const save = async () => {
        const err = (msg) => { $(".modal-error", m.el).textContent = msg; };
        err("");
        const handle = typedHandle(input, err);
        if (!handle) return;
        if (handle === h?.handle) return m.close();
        try { await post({ handle }, `已改为 https://${handle}.${domain}，正在重新连接…`); m.close(); } catch (ex) { err(ex.message); }
      };
      $("#rSaveHandle", m.el).addEventListener("click", save);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
    });
    $("#rOff", el)?.addEventListener("click", () => { if (confirm("关闭远程访问？外网就打不开这台电脑的控制台了。")) post({ enabled: false }, "远程访问已关闭").catch(fail); });
    $("#rLogoutAll", el)?.addEventListener("click", () => { if (confirm("让所有已登录的设备退出？")) post({ logoutAll: true }, "都已退出").catch(fail); });
    $("#rPwForm", el).addEventListener("submit", (e) => {
      e.preventDefault();
      const a = $("#rPw1", el).value, b = $("#rPw2", el).value;
      if (a.length < v.minPassword) return toast(`密码至少 ${v.minPassword} 位`, "error");
      if (a !== b) return toast("两次输入不一样", "error");
      post({ password: a }, "密码已保存，所有已登录的设备都已退出").catch(fail);
    });
  }

  // ---------------------------------------------------------------- 模型与供应商

  async function providers() {
    const el = page('<h1>模型与供应商</h1><p class="sub">和终端里的 /connect、/model 是同一份配置</p><div id="body"><div class="empty">正在加载…</div></div>');
    let p;
    try { p = await api("/api/providers"); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    drawProviders(el, p);
  }

  let modelTab = null; // the provider whose tab 模型列表 shows (kept across redraws; a provider just connected gets it)
  function drawProviders(el, p) {
    $("#body", el).innerHTML = `<div id="pbody">
      <div class="section-head"><div><h2>默认设置</h2><p>新会话用的模型和思考强度，选了就保存。会话里的 /model、/effort 只改那一个会话（并记住给下次用）；已经开着的会话要 /model default 或重启才换</p></div></div>
      <div class="panel" id="defaults"><div class="panel-pad muted">正在读取…</div></div>
      <div class="section-head"><div><h2>模型列表</h2><p>勾选的模型出现在会话的模型菜单里，也是「默认模型」的选项（都不勾就列出全部）。列表只在点「刷新模型列表」时更新</p></div><div class="actions head-actions"><input type="search" id="modelFilter" placeholder="搜索模型…" style="width:180px"><button class="button secondary small" id="refreshModels" title="重新向 7bit.fun 和各供应商拉取模型列表">刷新模型列表</button><button class="button small" id="addProvider" title="连接 7bit.fun、DeepSeek、Kimi、OpenRouter 等供应商，或你自己的兼容接口">添加供应商</button></div></div>
      <div id="modelLists"><div class="panel panel-pad muted">正在读取…</div></div></div>`;
    loadModelLists(el, p);
    // 添加供应商: any built-in provider or 7bit.fun (one connected already: another account of it), or one of the
    // user's own
    $("#addProvider", el).addEventListener("click", (e) => {
      const others = (base) => p.custom.filter((c) => c.preset === base && c.connected).length;
      const again = "已连接 · 再添加一个账号";
      popMenu(e.currentTarget, [
        { key: "preset", title: "选择供应商", items: [
          { label: "7bit.fun", description: p.gateway.connected ? again : `${p.gateway.url} · Claude、GPT 等模型`, value: "7bit" },
          ...p.presets.map((x) => ({ label: x.providerName || x.name, description: x.connected ? again : x.baseUrl, value: x.id })),
        ] },
        { key: "custom", title: "", items: [{ label: "自定义供应商…", description: "任何兼容 Anthropic 或 OpenAI 的接口", value: "" }] },
      ], (key, value) => {
        if (key === "custom") return connectDialog(el, null);
        if (value === "7bit") {
          if (!p.gateway.connected) return gatewayDialog(el, p);
          return connectDialog(el, null, { instanceOf: "7bit", template: { name: "7bit.fun", baseUrl: p.gateway.url }, count: 1 + others("7bit") });
        }
        const x = p.presets.find((y) => y.id === value);
        if (!x) return;
        if (!x.connected) return connectDialog(el, x);
        connectDialog(el, null, { instanceOf: x.id, template: { name: x.providerName || x.name, baseUrl: x.baseUrl, keyless: x.keyless }, count: 1 + others(x.id) });
      }, { dropdown: true });
    });
    // (from the first-run notice: the menu opens by itself)
    if (sessionStorage.getItem("cpOpenAdd")) { sessionStorage.removeItem("cpOpenAdd"); setTimeout(() => { if (el.isConnected) $("#addProvider", el)?.click(); }, 60); }
    $("#refreshModels", el).addEventListener("click", async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      b.textContent = "正在刷新…";
      try {
        const r = await api("/api/models/refresh", { method: "POST", body: {} });
        const parts = [...(r.gateway ? [{ name: "7bit.fun", ...r.gateway }] : []), ...r.providers];
        const ok = parts.filter((x) => !x.error).map((x) => `${x.name} ${x.count} 个`);
        const bad = parts.filter((x) => x.error).map((x) => `${x.name}（${x.error}）`);
        if (!parts.length) toast("还没有连接任何供应商", "error");
        else toast([ok.length ? `已刷新：${ok.join("，")}` : "", bad.length ? `失败：${bad.join("，")}` : ""].filter(Boolean).join("；"), bad.length && !ok.length ? "error" : "ok");
        if (el.isConnected) drawProviders(el, r.view);
      } catch (err) { fail(err); b.disabled = false; b.textContent = "刷新模型列表"; }
    });
  }

  // 模型列表: the kept lists, a tab per provider (nothing is asked of the providers here: see 刷新模型列表); each
  // tab says how its provider is connected, with 更换 Key / 模型 and 断开.
  async function loadModelLists(el, p) {
    const box = $("#modelLists", el);
    let r;
    try { r = await api("/api/models/kept"); } catch (e) {
      box.innerHTML = `<div class="panel panel-pad muted">读取失败：${esc(e.message)}</div>`;
      $("#defaults", el).innerHTML = `<div class="panel-pad muted">读取失败：${esc(e.message)}</div>`;
      return;
    }
    if (!el.isConnected) return;
    const current = r.remembered?.model || r.current;
    const picked = new Set(r.picked || []);
    const price = (m) => (m.price ? `$${m.price.input} / $${m.price.output}` : "—");
    const pickedNote = () => (picked.size ? `菜单显示勾选的 ${picked.size} 个` : "菜单显示全部");
    const providerOf = (id) => [...(p?.presets || []), ...(p?.custom || [])].find((x) => x.id === id);
    if (!r.groups.some((g) => g.id === modelTab)) modelTab = r.groups[0]?.id || null;
    const head = (g) => {
      const x = providerOf(g.id);
      const when = `${g.models.length} 个模型${g.at ? ` · ${esc(ago(g.at))}更新` : ""}`;
      if (g.id === "7bit" && p?.gateway) {
        // (the balance comes after: GET /api/gateway/account)
        return `<div class="mg-head"><div class="meta">${esc(p.gateway.url)} · Key ${esc(p.gateway.key)}<span id="gwAccount">${p.gateway.account?.email ? ` · ${esc(p.gateway.account.email)}` : ""}</span> · 余额 <strong id="gwBalance">…</strong> · ${when}</div>
          <div class="actions"><button class="button secondary small" data-gateway="change">更换 Key</button><button class="button danger small" data-gateway="remove">断开</button><a class="button secondary small" href="${esc(p.gateway.keyPage)}" target="_blank" rel="noopener">获取 Key</a></div></div>`;
      }
      if (!x) return `<div class="mg-head"><div class="meta">${when}</div></div>`;
      return `<div class="mg-head"><div class="meta">${esc(x.protocol === "openai" ? "OpenAI 协议" : "Anthropic 协议")} · ${esc(x.baseUrl)} · Key ${esc(x.key || "（无需）")} · ${when}</div>
        <div class="actions"><button class="button secondary small" data-connect="${esc(x.id)}">更换 Key / 模型</button><button class="button danger small" data-remove="${esc(x.id)}">断开</button>${x.keyPage ? `<a class="button secondary small" href="${esc(x.keyPage)}" target="_blank" rel="noopener">获取 Key</a>` : ""}</div></div>`;
    };
    box.innerHTML = r.groups.length ? `<div class="mtabs" role="tablist">${r.groups.map((g) => `<button type="button" role="tab" data-tab="${esc(g.id)}" aria-selected="${g.id === modelTab}" class="${g.id === modelTab ? "active" : ""}">${esc(g.name)}<span class="count">${g.models.length}</span></button>`).join("")}</div>` + r.groups.map((g) => `<div class="panel model-group" role="tabpanel" data-group="${esc(g.id)}"${g.id === modelTab ? "" : " hidden"}>
      ${head(g)}<div class="empty no-match" hidden>这个供应商里没有匹配的模型</div>
      ${g.models.length ? `<table class="list"><thead><tr><th class="pick" title="勾选的模型出现在会话的模型菜单里">菜单</th><th>模型</th><th class="num">上下文</th><th class="num">最大输出</th><th>推理强度</th><th class="num" title="每百万 token 的美元价：输入 / 输出">价格（输入/输出）</th></tr></thead><tbody>
        ${g.models.map((m) => `<tr class="click" data-model="${esc(m.ref)}" data-text="${esc([m.ref, m.name, m.vendor].filter(Boolean).join(" ").toLowerCase())}"><td class="pick"><input type="checkbox" data-pick="${esc(m.ref)}" aria-label="在会话的模型菜单里显示 ${esc(m.ref)}"${picked.has(m.ref) ? " checked" : ""}></td><td class="title-cell"><strong class="mono">${esc(m.ref)}${m.ref === current ? ' <span class="pill ok def-pill">默认</span>' : ""}</strong>${m.name || m.vendor ? `<div class="path">${esc([m.name, m.vendor].filter(Boolean).join(" · "))}</div>` : ""}</td><td class="num">${m.window ? fmtTokens(m.window) : "—"}</td><td class="num">${m.maxOutput ? fmtTokens(m.maxOutput) : "—"}</td><td>${m.efforts.length ? esc(m.efforts.join(" · ")) : '<span class="faint">—</span>'}</td><td class="num">${price(m)}</td></tr>`).join("")}
      </tbody></table>` : '<div class="empty">还没有拉取过模型列表：点「刷新模型列表」</div>'}</div>`).join("") : '<div class="panel panel-pad muted">还没有连接供应商：点「添加供应商」</div>';
    if (r.groups.length) box.insertAdjacentHTML("afterbegin", `<div class="pick-bar"><span id="pickedNote">${pickedNote()}</span><button type="button" class="button secondary small" id="clearPicked"${picked.size ? "" : " hidden"}>清除勾选</button></div>`);
    // 默认设置: the default model, among the models ticked below (all when none is), and the default effort; each
    // saved when chosen (settings.json), and what a session's /model or /effort remembered of it forgotten
    let defModel = r.remembered?.model || r.current;
    let defEffort = p?.remembered?.effort || p?.effort || "auto";
    let remembered = { model: r.remembered?.model || null, effort: p?.remembered?.effort || null };
    const allModels = r.groups.flatMap((g) => g.models.map((m) => ({ ref: m.ref, group: g.name, name: m.name })));
    const paintDefaults = () => {
      const dbox = $("#defaults", el);
      if (!dbox) return;
      const choices = picked.size ? allModels.filter((m) => picked.has(m.ref)) : allModels;
      const groups = [...new Set(choices.map((m) => m.group))];
      const listed = choices.some((m) => m.ref === defModel);
      const efforts = ["auto", "low", "medium", "high", "xhigh", "max"];
      dbox.innerHTML = `<div class="def-row"><div class="def-label"><strong>默认模型</strong><small>选项是下面「模型列表」里勾选的模型${picked.size ? `（${picked.size} 个）` : "（没勾选：列出全部）"}</small></div>
          <div><select id="defModel">${listed || !defModel ? "" : `<option value="${esc(defModel)}" selected>${esc(defModel)}（当前）</option>`}${groups.map((gname) => `<optgroup label="${esc(gname)}">${choices.filter((m) => m.group === gname).map((m) => `<option value="${esc(m.ref)}"${m.ref === defModel ? " selected" : ""}>${esc(m.ref)}${m.name ? ` · ${esc(m.name)}` : ""}</option>`).join("")}</optgroup>`).join("")}</select>
          ${remembered.model ? `<div class="def-note">现在生效的是会话里 /model 记住的选择；在这里选一次就以这里为准</div>` : ""}</div></div>
        <div class="def-row"><div class="def-label"><strong>思考强度</strong><small>auto 用模型自己的默认；不支持的模型会取最接近的一档</small></div>
          <div><select id="defEffort">${efforts.map((x) => `<option${x === defEffort ? " selected" : ""}>${x}</option>`).join("")}${efforts.includes(defEffort) ? "" : `<option selected>${esc(defEffort)}</option>`}</select>
          ${remembered.effort ? `<div class="def-note">现在生效的是会话里 /effort 记住的选择；在这里选一次就以这里为准</div>` : ""}</div></div>`;
      $("#defModel", dbox).onchange = async (e) => {
        const value = e.target.value;
        try {
          await api("/api/settings", { method: "POST", body: { scope: "user", key: "model", value } });
          if (remembered.model) await api("/api/remembered", { method: "POST", body: { model: null } });
          defModel = value;
          remembered.model = null;
          for (const pill of $$(".def-pill", box)) pill.remove();
          $(`tr[data-model="${CSS.escape(value)}"] .title-cell strong`, box)?.insertAdjacentHTML("beforeend", ' <span class="pill ok def-pill">默认</span>');
          toast(`默认模型已改为 ${value}`);
        } catch (err) { fail(err); }
        paintDefaults();
      };
      $("#defEffort", dbox).onchange = async (e) => {
        const value = e.target.value;
        try {
          await api("/api/settings", { method: "POST", body: { scope: "user", key: "effort", value } });
          if (remembered.effort) await api("/api/remembered", { method: "POST", body: { effort: null } });
          defEffort = value;
          remembered.effort = null;
          toast(`默认思考强度已改为 ${value}`);
        } catch (err) { fail(err); }
        paintDefaults();
      };
    };
    paintDefaults();
    let saving = Promise.resolve();
    const savePicked = () => {
      const models = [...picked];
      $("#pickedNote", box).textContent = pickedNote();
      $("#clearPicked", box).hidden = !picked.size;
      paintDefaults(); // (its choices are the ticked models)
      saving = saving.then(() => api("/api/models/picked", { method: "POST", body: { models } })).catch((e) => fail(e));
    };
    box.onchange = (e) => {
      const cb = e.target.closest("input[data-pick]");
      if (!cb) return;
      if (cb.checked) picked.add(cb.dataset.pick); else picked.delete(cb.dataset.pick);
      savePicked();
    };
    $("#clearPicked", box)?.addEventListener("click", () => {
      picked.clear();
      for (const cb of $$("input[data-pick]", box)) cb.checked = false;
      savePicked();
      toast("已清除勾选：会话的模型菜单显示全部模型");
    });
    if ($("#gwBalance", box)) {
      api("/api/gateway/account").then((a) => {
        const b = $("#gwBalance", box);
        if (!b) return;
        b.textContent = a.balance != null ? fmtUsd(a.balance) : "—";
        if (a.error) b.title = `查询失败：${a.error}`;
        if (a.email && !$("#gwAccount", box).textContent) $("#gwAccount", box).textContent = ` · ${a.email}`;
      }).catch(() => { const b = $("#gwBalance", box); if (b) b.textContent = "—"; });
    }
    const filter = $("#modelFilter", el);
    // searching: every tab says how many of its models match; the tab shown lists them
    const apply = () => {
      const q = filter.value.trim().toLowerCase();
      for (const g of $$(".model-group", box)) {
        const rows = $$("tr[data-model]", g);
        let shown = 0;
        for (const tr of rows) { const hit = !q || tr.dataset.text.includes(q); tr.hidden = !hit; shown += hit; }
        $(".no-match", g).hidden = !q || !rows.length || shown > 0;
        const tab = $(`[data-tab="${CSS.escape(g.dataset.group)}"] .count`, box);
        if (tab) tab.textContent = q ? `${shown}/${rows.length}` : rows.length;
      }
    };
    const show = (id) => {
      modelTab = id;
      for (const t of $$("[data-tab]", box)) { const on = t.dataset.tab === id; t.classList.toggle("active", on); t.setAttribute("aria-selected", String(on)); }
      for (const g of $$(".model-group", box)) g.hidden = g.dataset.group !== id;
    };
    filter.oninput = apply;
    apply();
    box.onclick = async (e) => {
      const tab = e.target.closest("[data-tab]");
      if (tab) return show(tab.dataset.tab);
      const gw = e.target.closest("[data-gateway]");
      if (gw?.dataset.gateway === "change") return gatewayDialog(el, p);
      if (gw?.dataset.gateway === "remove") {
        if (!confirm("断开 7bit.fun？保存的 Key 会删除：它的模型不能用了，这台电脑的会话也会下线（远程访问、跨电脑互发任务靠它）。")) return;
        try { drawProviders(el, await api("/api/gateway", { method: "DELETE" })); toast("已断开 7bit.fun"); } catch (err) { fail(err); }
        return;
      }
      const c = e.target.closest("[data-connect]"), rm = e.target.closest("[data-remove]");
      if (c) return connectDialog(el, providerOf(c.dataset.connect));
      if (rm) {
        const x = providerOf(rm.dataset.remove);
        if (!confirm(`断开 ${x?.name || rm.dataset.remove}？保存的 Key 会删除，它的模型也从列表里去掉。`)) return;
        try { drawProviders(el, await api(`/api/providers/${encodeURIComponent(rm.dataset.remove)}`, { method: "DELETE" })); toast("已断开"); } catch (err) { fail(err); }
        return;
      }
      if (e.target.closest(".pick")) return; // (the checkbox itself)
      // a click on the row ticks (or unticks) the model
      const cb = e.target.closest("tr[data-model]")?.querySelector("input[data-pick]");
      if (!cb) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
    };
  }

  // Connect 7bit.fun, or change its key: the gateway checks the key (its account), and its model list comes with it.
  function gatewayDialog(el, p) {
    const again = p.gateway.connected;
    const m = modal({
      title: again ? `${p.gateway.name || "7bit.fun"}：名称与 Key` : "连接 7bit.fun", sub: p.gateway.url,
      body: `<label class="field">名称<small>显示在 tab 里</small><input id="gName" maxlength="40" value="${esc(p.gateway.name || "7bit.fun")}"></label>
        <label class="field">API Key<small>${again ? "留空则继续用已保存的 Key；" : ""}在网关网页「API 密钥」里创建</small><input type="password" id="gKey" autocomplete="off" placeholder="${again ? "留空：用已保存的" : "粘贴 7bit.fun 的 API Key"}"></label>
        <a class="button secondary small" href="${esc(p.gateway.keyPage)}" target="_blank" rel="noopener">获取 Key</a>`,
      foot: `<span class="modal-error"></span><button class="button secondary" data-close>取消</button><button class="button" id="gConnect">${again ? "保存" : "连接"}</button>`,
    });
    const input = $("#gKey", m.el);
    (again ? $("#gName", m.el) : input).focus();
    const go = async () => {
      const apiKey = input.value.trim();
      const name = $("#gName", m.el).value.trim();
      const err = $(".modal-error", m.el);
      if (!apiKey && !again) { err.textContent = "请先粘贴 Key"; return; }
      const b = $("#gConnect", m.el);
      b.disabled = true;
      b.textContent = "正在验证…";
      err.textContent = "";
      try {
        const view = await api("/api/gateway", { method: "POST", body: { ...(apiKey ? { apiKey } : {}), name } });
        m.close();
        toast(again ? "已保存" : `已连接 ${name || "7bit.fun"}`);
        modelTab = "7bit";
        drawProviders(el, view);
      } catch (ex) { err.textContent = ex.message; b.disabled = false; b.textContent = again ? "保存" : "连接"; }
    };
    $("#gConnect", m.el).addEventListener("click", go);
    for (const i of [input, $("#gName", m.el)]) i.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  }

  // Connect a provider: a built-in one (x; connected already: its key, model or name changed), another account of one
  // or of 7bit.fun (instanceOf, with its template and how many are connected), or with neither one of the user's own.
  // 名称 → key → models → test → saved.
  function connectDialog(el, x, { instanceOf = null, template = null, count = 0 } = {}) {
    const custom = !x && !instanceOf;
    const base = x || template;
    const defaultName = x ? x.name : instanceOf ? `${template.name} ${count + 1}` : "";
    const m = modal({
      title: custom ? "添加自定义供应商" : x ? (x.connected ? `${x.name}：名称、Key 与模型` : `连接 ${x.name}`) : `再添加一个 ${template.name} 账号`,
      sub: custom ? "任何兼容 Anthropic Messages 或 OpenAI Chat Completions 的接口" : `${base.baseUrl}`,
      body: `<label class="field">名称<small>${custom ? "显示在 tab 和模型菜单里；英文名同时是模型前缀，比如 myrelay/gpt-5" : "显示在 tab 和模型菜单里"}</small><input id="cName" maxlength="40" value="${esc(defaultName)}" placeholder="${custom ? "myrelay" : esc(base.name)}"></label>
        ${custom ? `<label class="field">协议<select id="cProto"><option value="openai">OpenAI 兼容（/chat/completions）</option><option value="anthropic">Anthropic 兼容（/v1/messages）</option></select></label>
        <label class="field">地址<input id="cUrl" placeholder="https://api.example.com/v1"></label>` : ""}
        <label class="field">API Key${x?.connected ? "<small>留空则继续用已保存的 Key</small>" : base?.keyless ? "<small>这个供应商不需要 Key</small>" : ""}<input type="password" id="cKey" autocomplete="off" placeholder="${x?.connected ? "留空：用已保存的" : "粘贴 Key"}"></label>
        <div class="actions"><button class="button secondary" id="cCheck">检查 Key 并列出模型</button></div>
        <div id="cModels" style="margin-top:14px"></div>`,
      foot: '<span class="modal-error"></span><button class="button secondary" data-close>取消</button><button class="button" id="cConnect" disabled>测试并连接</button>',
    });
    let checked = null;
    const err = (t) => { $(".modal-error", m.el).textContent = t || ""; };
    const target = () => (custom ? { custom: { name: $("#cName", m.el).value, protocol: $("#cProto", m.el).value, baseUrl: $("#cUrl", m.el).value } } : instanceOf ? { instanceOf } : { id: x.id });
    (x?.connected ? $("#cName", m.el) : custom ? $("#cName", m.el) : $("#cKey", m.el)).focus();
    $("#cCheck", m.el).addEventListener("click", async (e) => {
      err("");
      e.target.disabled = true;
      e.target.textContent = "检查中…";
      try {
        checked = await api("/api/providers/check", { method: "POST", body: { ...target(), apiKey: $("#cKey", m.el).value } });
        const list = checked.models || [];
        $("#cModels", m.el).innerHTML = list.length
          ? `<input type="search" id="cFilter" placeholder="筛选 ${list.length} 个模型" style="width:100%;margin-bottom:8px"><div class="model-list">${list.map((mm, i) => `<label data-name="${esc(mm.id.toLowerCase())}"><input type="radio" name="cm" value="${i}"${mm.id === checked.current || (!checked.current && i === 0) ? " checked" : ""}> <span class="mono">${esc(mm.id)}</span><small>${[mm.window ? `${fmtTokens(mm.window)} 上下文` : "", mm.price ? `$${mm.price.input}/$${mm.price.output} 每百万` : ""].filter(Boolean).join(" · ")}</small></label>`).join("")}</div>`
          : '<label class="field">它没有列出模型：填写要用的模型名<input id="cManual" placeholder="模型 id"></label>';
        $("#cModels", m.el).insertAdjacentHTML("beforeend", '<label class="muted" style="display:block;margin-top:10px;font-size:13px"><input type="checkbox" id="cUse" checked> 连接后设为当前使用的模型（和 /model 一样）</label>');
        $("#cFilter", m.el)?.addEventListener("input", (ev) => { const q = ev.target.value.toLowerCase(); $$(".model-list label", m.el).forEach((l) => l.classList.toggle("hidden", !l.dataset.name.includes(q))); });
        $("#cConnect", m.el).disabled = false;
      } catch (ex) { err(ex.message); } finally { e.target.disabled = false; e.target.textContent = "检查 Key 并列出模型"; }
    });
    $("#cConnect", m.el).addEventListener("click", async (e) => {
      err("");
      const list = checked?.models || [];
      const picked = $("input[name=cm]:checked", m.el);
      const model = picked ? list[Number(picked.value)].id : $("#cManual", m.el)?.value.trim();
      if (!model) return err("请选择或填写一个模型");
      e.target.disabled = true;
      e.target.textContent = `正在测试 ${model}…`;
      try {
        const p = await api("/api/providers/connect", { method: "POST", body: { ...target(), name: $("#cName", m.el).value, apiKey: $("#cKey", m.el).value, model, models: list.length ? list : [{ id: model }], authHeader: checked?.authHeader, useNow: $("#cUse", m.el)?.checked } });
        m.close();
        toast(`已连接，模型 ${model} 测试通过`);
        modelTab = p.connected || modelTab; // (its tab is the one shown)
        drawProviders(el, p);
      } catch (ex) { err(ex.message); e.target.disabled = false; e.target.textContent = "测试并连接"; }
    });
  }

  // ---------------------------------------------------------------- 设置

  const CHOICES = { effort: ["auto", "low", "medium", "high", "xhigh", "max"], promptCacheTtl: ["5m", "1h"], subagentPromptCacheTtl: ["5m", "1h"] };
  // The settings' descriptions in Chinese (the terminal's /config has them in English, in config.js)
  const ZH = {
    model: "默认模型，写成 供应商/模型（如 deepseek/deepseek-v4-pro）或 opus、sonnet。没设置时：连了 Claude 就用 opus，否则用第一个连接的供应商的模型。会话里的 /model 和 --model 会覆盖它",
    effort: "推理强度：auto、low、medium、high、xhigh、max。会话里的 /effort 和 --effort 会覆盖它",
    promptCacheTtl: "主对话的提示词缓存时长：5m 或 1h",
    subagentPromptCacheTtl: "子 agent、压缩和辅助请求的提示词缓存时长：5m 或 1h",
    cleanupPeriodDays: "会话最后一次使用后保留多少天（之后连同运行记录一起删除，和 Claude Code 一样；至少 1 天，想长期保留可以填 3650）",
    CLAUDE_PRO_GATEWAY_URL: "网关地址（默认 https://7bit.fun）",
    CLAUDE_PRO_ONLINE: "设为 0：交互会话不连网关（也就不能跨电脑互发任务、不能和通讯录好友通讯）",
    CLAUDE_PRO_MACHINE_NAME: "这台电脑在其他电脑的会话里显示的名字（如 公司、家里；默认是主机名）",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "每次回复的 max_tokens（默认 48000；网关允许的更少时会自动降低）",
    MAX_THINKING_TOKENS: "思考预算：0 关闭思考，N 表示预算 N 个 token",
    CLAUDE_PRO_CACHE_KEEPALIVE_HOURS: "Claude 模型用 1 小时缓存时：你离开期间在缓存过期前刷新它（读一次只要重写的 1/40），最多保持这么多小时（默认 8；0 关闭）",
    DISABLE_PROMPT_CACHING: "设为 1：完全不发缓存标记（所有模型都不用提示词缓存）",
    API_TIMEOUT_MS: "请求超时，毫秒",
    CLAUDE_PRO_MAX_RETRIES: "API 请求失败时的重试次数（0 = 不重试，也不再等待限流恢复）",
    CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS: "遇到限流（比如 5 小时额度）时最多等多久再自动继续（默认 21600000 = 6 小时；0 = 直接报错不等）",
    CLAUDE_CODE_GIT_BASH_PATH: "Windows：bash.exe（Git Bash）的路径",
    CLAUDE_PRO_RIPGREP_PATH: "ripgrep（rg）的路径，Grep 和 @ 文件补全会用；off 强制用内置的 JS 扫描（默认：PATH 里的 rg，没有就用 JS）",
    CLAUDE_PRO_BROWSER: "Browser 工具操作哪个浏览器：auto（默认，Edge、Chrome、Brave、Chromium 中第一个打开了远程调试的）、edge、chrome、brave、chromium、own（claude-pro 自己的 Chrome 配置，无需允许）、DevTools 地址，或 off（不提供 Browser 工具）",
    CLAUDE_PRO_PYTHON: "REPL 工具用的 Python（默认：Windows 上 python，其他系统 python3）",
    CLAUDE_PRO_VERIFY_COMMAND: "agent 改完文件后运行的命令（如 npm test），失败会发回给它修",
    CLAUDE_PRO_DISABLE_AUTO_MEMORY: "设为 1：关闭每个项目的自动记忆",
    CLAUDE_PRO_DISABLE_TOPIC_TITLE: "设为 1：不再每条消息后让模型总结话题（标签页标题改为显示第一条消息）",
    CLAUDE_PRO_TRACE: "设为 0：关闭运行记录（默认开启，只记结构和用量，不记内容；用量页的数据来自它）",
  };
  const SCOPE_NAMES = { user: "用户（所有项目）", project: "项目（随仓库提交）", local: "项目本地（不提交）" };

  async function projectsSelect(id, selected, { allLabel = "只看用户级" } = {}) {
    let list = [];
    try { list = (await api("/api/projects")).projects; } catch { /* only the user's */ }
    return `<select id="${id}"><option value="">${esc(allLabel)}</option>${list.map((p) => `<option value="${esc(p.cwd)}"${p.cwd === selected ? " selected" : ""}>${esc(shortPath(p.cwd))}</option>`).join("")}</select>`;
  }

  async function settings() {
    const project = sessionStorage.getItem("settingsProject") || "";
    const el = page(`<h1>设置</h1><p class="sub">和 /config、claude-pro config 是同一份设置。改动对新会话生效；已经开着的会话大多要重启才会读到</p>
      <div class="toolbar"><span class="muted" style="font-size:13px">项目：</span>${await projectsSelect("proj", project)}<input type="search" id="q" placeholder="筛选设置…"></div><div id="body"><div class="empty">正在加载…</div></div>`);
    $("#proj", el).addEventListener("change", (e) => { sessionStorage.setItem("settingsProject", e.target.value); settings(); });
    let s;
    try { s = await api(`/api/settings${project ? `?project=${encodeURIComponent(project)}` : ""}`); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    const sourceName = (src) => {
      if (src === "default") return "默认值";
      if (src === "process environment") return "进程环境变量";
      if (/flag$/.test(src)) return "命令行参数";
      for (const [scope, file] of Object.entries(s.files)) if (file === src) return SCOPE_NAMES[scope];
      return src;
    };
    const row = (e) => {
      const scopes = e.userOnly || !s.project ? ["user"] : ["user", "project", "local"];
      const set = Object.entries(e.scopes).filter(([, v]) => v != null);
      const input = CHOICES[e.key]
        ? `<select data-value>${CHOICES[e.key].map((c) => `<option${String(e.value) === c ? " selected" : ""}>${c}</option>`).join("")}</select>`
        : `<input data-value value="${esc(e.value ?? "")}" placeholder="${e.default != null ? `默认 ${esc(e.default)}` : "未设置"}">`;
      return `<div class="setting" data-key="${esc(e.key)}" data-search="${esc(`${e.key} ${e.description} ${ZH[e.key] || ""}`.toLowerCase())}"><div><div class="key">${esc(e.key)}</div><div class="desc" title="${esc(e.description || "")}">${esc(ZH[e.key] || e.description || "")}</div></div>
        <div><div class="now">当前：<strong class="mono">${e.value == null || e.value === "" ? "（未设置）" : esc(e.value)}</strong> <span class="pill${e.source === "default" ? "" : " accent"}">${esc(sourceName(e.source))}</span>
          ${(s.project ? set : []).map(([scope, v]) => `<span class="pill" title="${esc(s.files[scope])}">${esc(SCOPE_NAMES[scope])}：${esc(v)}</span>`).join(" ")}</div>
        <div class="row">${input}<select data-scope>${scopes.map((sc) => `<option value="${sc}">${esc(SCOPE_NAMES[sc])}</option>`).join("")}</select><button class="button small" data-save>保存</button>${set.length ? '<button class="button secondary small" data-unset>恢复默认</button>' : ""}</div></div></div>`;
    };
    const basic = s.entries.filter((e) => e.basic), advanced = s.entries.filter((e) => !e.basic);
    $("#body", el).innerHTML = `${s.remembered?.model || s.remembered?.effort ? `<div class="panel panel-pad" style="margin-bottom:14px">/model、/effort 记住的选择会覆盖下面的 model、effort：<strong class="mono">${esc([s.remembered.model, s.remembered.effort].filter(Boolean).join(" · "))}</strong> <button class="button secondary small" id="forget">清除记住的选择</button></div>` : ""}
      <div class="section-head"><h2>常用设置</h2></div><div class="panel">${basic.map(row).join("")}</div>
      <div class="section-head"><div><h2>高级设置</h2><p>写在设置文件的 env 里；进程环境变量会覆盖它们</p></div></div><div class="panel">${advanced.map(row).join("")}</div>
      <p class="faint" style="font-size:12px;margin-top:12px">设置文件：${Object.entries(s.files).map(([k, f]) => `${esc(SCOPE_NAMES[k])} <span class="mono">${esc(f)}</span>`).join(" · ")}</p>`;
    $("#q", el).addEventListener("input", (e) => { const q = e.target.value.toLowerCase(); $$(".setting", el).forEach((n) => n.classList.toggle("hidden", !n.dataset.search.includes(q))); });
    $("#forget", el)?.addEventListener("click", async () => { try { await api("/api/remembered", { method: "POST", body: { model: null, effort: null } }); toast("已清除"); settings(); } catch (e) { fail(e); } });
    $("#body", el).addEventListener("click", async (e) => {
      const box = e.target.closest(".setting");
      if (!box) return;
      const key = box.dataset.key;
      const scope = $("[data-scope]", box).value;
      try {
        if (e.target.closest("[data-save]")) {
          const raw = $("[data-value]", box).value;
          const value = key === "cleanupPeriodDays" ? Number(raw) : raw;
          await api("/api/settings", { method: "POST", body: { key, value, scope, project } });
          toast(`${key} 已保存`);
          settings();
        } else if (e.target.closest("[data-unset]")) {
          for (const [sc, v] of Object.entries((s.entries.find((x) => x.key === key) || {}).scopes || {})) if (v != null) await api("/api/settings", { method: "POST", body: { key, unset: true, scope: sc, project } });
          toast(`${key} 已恢复默认`);
          settings();
        }
      } catch (err) { fail(err); }
    });
  }

  // ---------------------------------------------------------------- 记忆与指令

  async function memory() {
    const el = page('<h1>记忆与指令</h1><p class="sub">CLAUDE.md（你写给 agent 的长期指令）和 agent 自动记下的记忆。改动从下一个新会话（或 /clear、/compact 之后）开始生效</p><div id="body"><div class="empty">正在加载…</div></div>');
    let m;
    try { m = await api("/api/memory"); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    const open = new Set(JSON.parse(sessionStorage.getItem("memoryOpen") || "[]"));
    $("#body", el).innerHTML = `<div class="section-head"><h2>全局指令</h2></div>
      <div class="panel"><div class="file-row"><span class="name">~/.claude-pro/CLAUDE.md</span><span class="desc">所有项目都会加载</span><button class="button small ${m.user.exists ? "secondary" : ""}" data-edit="${esc(m.user.path)}">${m.user.exists ? "编辑" : "新建"}</button></div></div>
      <div class="section-head"><div><h2>各项目</h2><p>${m.projects.length} 个有会话记录的项目</p></div><input type="search" id="q" placeholder="筛选项目…"></div>
      <div class="panel">${m.projects.map((p) => `<details class="proj" data-path="${esc(p.cwd.toLowerCase())}"${open.has(p.cwd) ? " open" : ""} data-cwd="${esc(p.cwd)}"><summary><strong class="mono" style="font-size:13px">${esc(shortPath(p.cwd))}</strong>${p.exists ? "" : '<span class="pill off">目录不在了</span>'}<span class="muted" style="margin-left:auto;font-size:12px">${p.memory.length} 条记忆 · ${p.instructions.filter((f) => f.exists).length} 个指令文件 · ${p.sessions} 个会话</span></summary><div>
        ${p.instructions.filter((f) => f.exists || f.name === "CLAUDE.md").map((f) => `<div class="file-row"><span class="name">${esc(f.name)}</span><span class="desc">${f.name === "CLAUDE.local.md" ? "只在本机，不提交" : "项目指令"}</span>${p.exists ? `<button class="button small ${f.exists ? "secondary" : ""}" data-edit="${esc(f.path)}">${f.exists ? "编辑" : "新建"}</button>` : ""}</div>`).join("")}
        ${p.memory.length ? p.memory.map((f) => `<div class="file-row"><span class="name">记忆/${esc(f.name)}</span><span class="desc">${f.name === "MEMORY.md" ? "索引：每个会话都会加载" : fmtBytes(f.size)}</span><button class="button secondary small" data-edit="${esc(f.path)}" data-deletable="1">编辑</button></div>`).join("") : '<div class="file-row"><span class="desc">还没有自动记忆</span></div>'}
      </div></details>`).join("") || '<div class="empty">没有项目</div>'}</div>`;
    $("#q", el).addEventListener("input", (e) => { const q = e.target.value.toLowerCase(); $$("details.proj", el).forEach((d) => d.classList.toggle("hidden", !d.dataset.path.includes(q))); });
    $$("details.proj", el).forEach((d) => d.addEventListener("toggle", () => {
      if (d.open) open.add(d.dataset.cwd); else open.delete(d.dataset.cwd);
      sessionStorage.setItem("memoryOpen", JSON.stringify([...open]));
    }));
    $("#body", el).addEventListener("click", (e) => {
      const b = e.target.closest("[data-edit]");
      if (b) openEditor(b.dataset.edit, { title: "编辑", deletable: Boolean(b.dataset.deletable), onSaved: memory });
    });
  }

  // ---------------------------------------------------------------- 扩展

  async function extensions() {
    const project = sessionStorage.getItem("extProject") || "";
    const el = page(`<h1>扩展</h1><p class="sub">内置工具、技能、子 agent、MCP 和 hooks。新会话会加载改动</p>
      <div class="toolbar"><span class="muted" style="font-size:13px">项目：</span>${await projectsSelect("proj", project)}</div><div id="body"><div class="empty">正在加载…</div></div>`);
    $("#proj", el).addEventListener("change", (e) => { sessionStorage.setItem("extProject", e.target.value); extensions(); });
    let x;
    try { x = await api(`/api/extensions${project ? `?project=${encodeURIComponent(project)}` : ""}`); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    const scopePill = (s) => `<span class="pill${s === "built-in" ? "" : s === "user" ? " accent" : " ok"}">${{ "built-in": "内置", user: "用户", project: "项目" }[s] || esc(s)}</span>`;
    const list = (items, kind) => items.length ? items.map((i) => `<div class="file-row"><span class="name">${esc(i.name)}</span>${scopePill(i.scope)}<span class="desc" title="${esc(i.description)}">${esc(i.description)}</span>${i.path ? `<button class="button secondary small" data-edit="${esc(i.path)}">编辑</button>` : ""}</div>`).join("") : '<div class="file-row"><span class="desc">还没有</span></div>';
    // 新建: a new conversation with the request written for the model (it knows the formats and asks what is missing)
    const aiBtn = (kind) => `<button class="button secondary small" data-ai="${kind}" title="打开新会话，写好要求交给模型去做">${ICON.agent}让 AI 新建</button>`;
    // 内置工具: what every request gives the model, in a line each (the whole description on hover)
    const tools = x.tools || [];
    const toolRows = tools.map((t) => {
      const first = (t.description.split(/\n/).find((l) => l.trim()) || "").replace(/^[-\s]+/, "").split(/(?<=\.)\s/)[0];
      return `<div class="file-row"><span class="name">${esc(t.name)}</span><span class="desc" title="${esc(t.description.slice(0, 1200))}">${esc(TOOL_ZH[t.name] || first)}</span></div>`;
    }).join("");
    $("#body", el).innerHTML = `
      <div class="section-head"><div><h2>内置工具<span class="card-count" style="margin-left:8px;vertical-align:2px">${tools.length + (x.selfRestart ? 1 : 0)}</span></h2><p>每次请求都会发给模型、由模型决定何时调用的工具，写在程序里（不是 MCP）。鼠标停在说明上可以看到发给模型的原文</p></div></div>
      <div class="panel">${toolRows || '<div class="file-row"><span class="desc">读不到工具清单</span></div>'}${x.selfRestart ? `<div class="file-row"><span class="name">Restart</span><span class="desc">${esc(TOOL_ZH.Restart)}</span></div>` : ""}
        <div class="file-row"><span class="desc">另外：配置了 MCP 服务器时，它们的工具会以 mcp__服务器名__工具名 加进这个清单；子 agent 用的是它定义里 tools 列出的那些。</span></div></div>
      <div class="section-head"><div><h2>技能</h2><p>skills/&lt;名字&gt;/SKILL.md：模型按描述决定何时用 Skill 工具加载</p></div>${aiBtn("skill")}</div><div class="panel">${list(x.skills, "skill")}</div>
      <div class="section-head"><div><h2>子 agent</h2><p>agents/*.md：Task 工具可以把任务交给它们</p></div>${aiBtn("agent")}</div><div class="panel">${list(x.agents, "agent")}</div>
      <div class="section-head"><div><h2>MCP</h2><p>别的工具要装 MCP 才有的常用能力，这里已经内置，不用安装；也可以接入外部 MCP 服务器，它们的工具会加进上面的清单</p></div>${aiBtn("mcp")}</div>
      <div class="panel">${BUILTIN_MCP.filter((b) => tools.some((t) => t.name === b.tool)).map((b) => `<div class="file-row"><span class="name" style="font-family:inherit;font-weight:600">${esc(b.name)}</span><span class="pill">内置</span><span class="desc" title="${esc(b.tools)}">${esc(b.desc)}${b.like ? `<span class="faint"> · 相当于 ${esc(b.like)}</span>` : ""}</span></div>`).join("")}
        <div class="file-row mcp-sub"><span class="desc"><strong>外部 MCP 服务器</strong> · 环境变量和请求头的值不会显示</span></div>
        ${x.mcp.length ? x.mcp.map((s, i) => `<div class="file-row"><span class="name">${esc(s.name)}</span><span class="pill">${esc(s.scope)}</span><span class="desc mono">${esc(s.spec?.url || [s.spec?.command, ...(s.spec?.args || [])].filter(Boolean).join(" "))}</span>${s.scope === "user" || s.scope === ".mcp.json" ? `<button class="button secondary small" data-mcp="${i}">编辑</button>` : `<button class="button secondary small" data-edit="${esc(s.file)}">编辑文件</button>`}</div>`).join("") : '<div class="file-row"><span class="desc">还没有添加外部 MCP 服务器</span></div>'}</div>
      <div class="section-head"><div><h2>Hooks</h2><p>在工具调用前后、提交消息时等运行的命令，写在设置文件的 hooks 里</p></div></div>
      <div class="panel">${x.hooks.length ? x.hooks.map((h) => `<div class="file-row"><span class="name">${esc(h.event)}</span><span class="pill">${esc(h.scope)}</span><span class="desc mono">${esc(JSON.stringify(h.entries))}</span><button class="button secondary small" data-edit="${esc(h.file)}">编辑文件</button></div>`).join("") : `<div class="file-row"><span class="desc">没有 hooks。要添加，编辑设置文件的 "hooks" 字段</span><button class="button secondary small" data-edit="${esc(x.settingsFiles.user)}">编辑用户设置文件</button></div>`}</div>`;
    $("#body", el).addEventListener("click", async (e) => {
      const ed = e.target.closest("[data-edit]"), ai = e.target.closest("[data-ai]"), mc = e.target.closest("[data-mcp]");
      if (ed) openEditor(ed.dataset.edit, { title: "编辑", deletable: !/\.json$/i.test(ed.dataset.edit), onSaved: extensions });
      if (ai) askModelToCreate(ai.dataset.ai, { project, settingsFile: x.settingsFiles?.user || "" });
      if (mc) mcpDialog(x, x.mcp[Number(mc.dataset.mcp)], project);
    });
  }

  // The built-in tools in a few Chinese words (扩展's 内置工具; what the model reads is their English description)
  const TOOL_ZH = {
    Task: "把复杂的多步任务交给子 agent，可以在后台运行",
    Skill: "加载一个技能（下面「技能」里写好的做事说明）",
    TaskOutput: "查看后台 agent 的状态和结果",
    TaskStop: "停止一个后台 agent",
    Bash: "运行终端命令（git、npm、构建、测试等），可以放到后台",
    BashOutput: "读取后台命令的输出",
    KillShell: "结束一个后台命令",
    REPL: "在常驻的 Python / Node.js 进程里运行代码，变量和数据保留到下次",
    Processes: "列出本机进程（端口、命令行），或结束进程",
    Glob: "按文件名模式找文件",
    Grep: "按内容搜索文件（ripgrep）",
    Read: "读取文件，也能看图片和 notebook",
    Edit: "在文件里精确替换一段文字",
    MultiEdit: "一次在同一个文件里做多处替换",
    Write: "写入文件（新建或整个覆盖）",
    NotebookEdit: "编辑 Jupyter notebook 的单元格",
    WebFetch: "抓取网页，按要求提取内容",
    WebSearch: "联网搜索",
    Browser: "操作真实的浏览器：打开网页、点击、输入、截图",
    TodoWrite: "维护当前任务的待办清单（就是对话下方的「待办」）",
    AskUserQuestion: "向你提问、让你在几个选项里选",
    Effort: "遇到难题时调高自己本次的思考强度",
    ListPeers: "列出其他 claude-pro 会话（本机、你的其他电脑、联系人）",
    MessagePeer: "给其他会话发任务或问题，答复自动发回",
    Restart: "改了 claude-pro 自身代码后重启加载（只有源码版有）",
  };

  // What other agents get from MCP servers and claude-pro has built in (扩展's MCP section): shown while its tool is
  // there (Browser can be turned off).
  const BUILTIN_MCP = [
    { tool: "Browser", tools: "Browser", name: "浏览器", desc: "打开网页、点击、输入、截图，可以用你已登录的浏览器", like: "Playwright / Chrome DevTools MCP" },
    { tool: "WebSearch", tools: "WebSearch", name: "联网搜索", desc: "搜索并汇总结果，附来源", like: "Brave / Tavily 等搜索 MCP" },
    { tool: "WebFetch", tools: "WebFetch", name: "抓取网页", desc: "读取网页正文，按要求提取内容", like: "Fetch MCP" },
    { tool: "Read", tools: "Read · Write · Edit · MultiEdit · Glob · Grep", name: "文件系统", desc: "读写、修改、搜索本机文件", like: "Filesystem MCP" },
    { tool: "REPL", tools: "REPL", name: "代码执行", desc: "常驻的 Python / Node.js 进程，处理数据、跑脚本", like: "代码执行类 MCP" },
    { tool: "Processes", tools: "Processes", name: "进程管理", desc: "查看进程和占用的端口，结束进程", like: "系统 / 进程类 MCP" },
    { tool: "MessagePeer", tools: "ListPeers · MessagePeer", name: "多会话协作", desc: "和本机、你的其他电脑、联系人的 claude-pro 会话互发任务", like: "" },
  ];

  // 让 AI 新建: the new conversation's box with the request (where the file goes, its format), the project's directory
  // chosen when the page shows one; what the thing should do is left for the user to write at the end.
  function askModelToCreate(kind, { project, settingsFile }) {
    const sep = settingsFile.includes("\\") ? "\\" : "/";
    const userDir = settingsFile ? settingsFile.slice(0, settingsFile.lastIndexOf(sep)) : "~/.claude-pro";
    const dir = project ? `${project}${sep}.claude-pro` : userDir;
    const where = project ? `项目 ${project}` : "用户级（所有项目都能用）";
    const text = {
      skill: `帮我新建一个技能，放在${where}：${dir}${sep}skills${sep}<名字>${sep}SKILL.md。frontmatter 写 name 和 description（description 说清楚什么时候该用它），正文写步骤和说明。信息不够就先问我。\n\n这个技能用来：`,
      agent: `帮我新建一个子 agent，放在${where}：${dir}${sep}agents${sep}<名字>.md。frontmatter 写 name、description（什么时候把任务交给它）和 tools，正文是它的系统提示词。信息不够就先问我。\n\n这个子 agent 负责：`,
      mcp: `帮我添加一个 MCP 服务器，写进${project ? `项目的 ${project}${sep}.mcp.json` : ` ${settingsFile || "用户设置文件"} 的 "mcpServers"`}（写法和 Claude Code 的 mcpServers 一样：stdio 用 command/args/env，远程用 type: "http" 和 url/headers）。需要安装或填密钥就告诉我，先别把密钥写进会提交的文件。\n\n要接入的服务：`,
    }[kind];
    if (!text) return;
    if (draftText("new").trim() && !confirm("新会话输入框里还有没发送的内容，用这段要求替换它吗？")) return;
    saveDraft("new", text, []);
    if (project) localStorage.setItem("cpNewDir", project);
    location.hash = "#/new";
  }

  function mcpDialog(x, server, project) {
    const spec = server ? server.spec : { command: "npx", args: ["-y", "some-mcp-server"] };
    const m = modal({
      title: server ? `MCP 服务器：${server.name}` : "添加 MCP 服务器", sub: server ? server.file : "",
      body: `<label class="field">名字<input id="mName" value="${esc(server?.name || "")}"${server ? " disabled" : ""}></label>
        ${server ? "" : `<label class="field">放在<select id="mScope"><option value="user">用户设置（所有项目）</option>${project ? `<option value="project">项目的 .mcp.json（${esc(project)}）</option>` : ""}</select></label>`}
        <label class="field">配置（JSON，和 Claude Code 的 mcpServers 写法一样）<small>stdio：{"command","args","env"}；远程：{"type":"http","url","headers"}</small><textarea id="mSpec" class="editor" style="min-height:220px">${esc(JSON.stringify(spec, null, 2))}</textarea></label>`,
      foot: `<span class="modal-error"></span>${server ? '<button class="button danger" id="mDel">删除</button>' : ""}<button class="button secondary" data-close>取消</button><button class="button" id="mSave">保存</button>`,
    });
    const scope = () => (server ? (server.scope === ".mcp.json" ? "project" : "user") : $("#mScope", m.el).value);
    $("#mSave", m.el).addEventListener("click", async () => {
      let parsed;
      try { parsed = JSON.parse($("#mSpec", m.el).value); } catch (e) { $(".modal-error", m.el).textContent = `JSON 有误：${e.message}`; return; }
      try { await api("/api/mcp", { method: "POST", body: { name: $("#mName", m.el).value.trim(), scope: scope(), project, spec: parsed } }); m.close(); toast("已保存：新会话会启动它"); extensions(); } catch (e) { $(".modal-error", m.el).textContent = e.message; }
    });
    $("#mDel", m.el)?.addEventListener("click", async () => {
      if (!confirm(`删除 MCP 服务器 ${server.name}？`)) return;
      try { await api("/api/mcp", { method: "POST", body: { name: server.name, scope: scope(), project, remove: true } }); m.close(); toast("已删除"); extensions(); } catch (e) { fail(e); }
    });
  }

  // ---------------------------------------------------------------- 用量

  async function usage() {
    const days = Number(sessionStorage.getItem("usageDays")) || 30;
    const period = days === 1 ? "今天" : `近 ${days} 天`;
    const el = page(`<h1>用量</h1><p class="sub">按天、模型、项目统计（来自每次请求的运行记录；有价格的模型才算得出花费）</p>
      <div class="toolbar">${[1, 7, 30, 90].map((d) => `<button class="button ${d === days ? "" : "secondary"} small" data-days="${d}">${d === 1 ? "今天" : `近 ${d} 天`}</button>`).join("")}<span style="flex:1"></span><label class="muted" style="font-size:13px">图表：<select id="metric"><option value="cost">花费</option><option value="tokens">tokens</option><option value="requests">请求数</option></select></label></div><div id="body"><div class="empty">正在统计…</div></div>`);
    $$("[data-days]", el).forEach((b) => b.addEventListener("click", () => { sessionStorage.setItem("usageDays", b.dataset.days); usage(); }));
    let u;
    try { u = await api(`/api/usage?days=${days}`); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    const total = u.days.reduce((a, d) => ({ cost: a.cost + d.cost, requests: a.requests + d.requests, tokens: a.tokens + d.input + d.output + d.cacheRead + d.cacheWrite }), { cost: 0, requests: 0, tokens: 0 });
    const table = (rows, label) => rows.length ? `<table class="list"><thead><tr><th>${label}</th><th class="num">请求</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存读</th><th class="num">缓存写</th><th class="num">花费</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="mono" style="word-break:break-all">${esc(shortPath(r.key))}</td><td class="num">${r.requests}</td><td class="num">${fmtTokens(r.input)}</td><td class="num">${fmtTokens(r.output)}</td><td class="num">${fmtTokens(r.cacheRead)}</td><td class="num">${fmtTokens(r.cacheWrite)}</td><td class="num">${r.cost ? fmtUsd(r.cost) : "—"}${r.unpriced ? ` <span class="faint" title="${r.unpriced} 次请求的模型没有价格">*</span>` : ""}</td></tr>`).join("")}
    </tbody></table>` : '<div class="empty">没有记录</div>';
    $("#body", el).innerHTML = `<div class="cards">
        <div class="panel stat"><div class="label">花费（${period}，按价格估算）</div><div class="value">${fmtUsd(total.cost)}</div></div>
        <div class="panel stat"><div class="label">请求</div><div class="value">${total.requests}</div></div>
        <div class="panel stat"><div class="label">tokens（含缓存）</div><div class="value">${fmtTokens(total.tokens)}</div></div>
        <div class="panel stat"><div class="label">所有会话累计花费</div><div class="value">${fmtUsd(u.totalSessionCost)}</div><div class="hint">会话自己记录的花费，不限时间</div></div></div>
      <div class="section-head"><h2>${days === 1 ? "每小时" : "每天"}</h2></div><div class="panel panel-pad"><svg class="chart" id="chart"></svg></div>
      <div class="section-head"><h2>按模型</h2></div><div class="panel">${table(u.models, "模型")}</div>
      <div class="section-head"><h2>按项目</h2></div><div class="panel">${table(u.projects, "项目")}</div>
      <div class="section-head"><h2>花费最多的会话（${period}）</h2></div><div class="panel">${u.sessions.length ? `<table class="list"><tbody>${u.sessions.map((s) => `<tr${s.dir ? ` class="click" data-open="${esc(s.dir)}/${esc(s.id)}"` : ""}><td class="title-cell"><strong>${esc(s.title || "（已删除的会话）")}</strong><div class="path">${esc(s.cwd || s.dir ? shortPath(s.cwd || s.dir) : s.id)}</div></td><td>${s.mtime ? ago(s.mtime) : ""}</td><td class="num">${s.requests} 次</td><td class="num">${s.cost ? fmtUsd(s.cost) : "—"}${s.unpriced ? ` <span class="faint" title="${s.unpriced} 次请求的模型没有价格">*</span>` : ""}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">没有记录</div>'}</div>`;
    const drawChart = () => {
      const metric = $("#metric", el).value;
      const val = (d) => (metric === "cost" ? d.cost : metric === "tokens" ? d.input + d.output + d.cacheRead + d.cacheWrite : d.requests);
      const svg = $("#chart", el);
      const series = days === 1 && u.hours ? u.hours : u.days; // (today: by hour)
      const w = svg.clientWidth || 900, h = 220, pad = { l: 56, r: 10, t: 10, b: 26 };
      const max = Math.max(...series.map(val), metric === "cost" ? 0.01 : 1);
      const bw = (w - pad.l - pad.r) / series.length;
      const fmt = (v) => (metric === "cost" ? fmtUsd(v) : fmtTokens(v));
      let s = "";
      for (let i = 0; i <= 4; i++) { const y = pad.t + ((h - pad.t - pad.b) * i) / 4; s += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}"/><text x="${pad.l - 6}" y="${y + 3}" text-anchor="end">${esc(fmt(max * (1 - i / 4)))}</text>`; }
      const label = (d) => (series === u.days ? d.key.slice(5) : d.key.slice(0, 2));
      const every = Math.max(1, Math.ceil(series.length / (w < 520 ? 6 : 12)));
      series.forEach((d, i) => {
        const v = val(d);
        const bh = ((h - pad.t - pad.b) * v) / max;
        const x = pad.l + i * bw;
        s += `<rect class="bar" x="${x + bw * 0.15}" y="${h - pad.b - bh}" width="${Math.max(1, bw * 0.7)}" height="${Math.max(0, bh)}"><title>${esc(d.key)}：${esc(fmt(v))} · ${d.requests} 次请求</title></rect>`;
        if (i % every === 0) s += `<text x="${x + bw / 2}" y="${h - 8}" text-anchor="middle">${esc(label(d))}</text>`;
      });
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      svg.innerHTML = s;
    };
    drawChart();
    $("#metric", el).addEventListener("change", drawChart);
    window.addEventListener("resize", drawChart);
    cleanup = () => window.removeEventListener("resize", drawChart);
    $("#body", el).addEventListener("click", (e) => { const r = e.target.closest("[data-open]"); if (r) location.hash = `#/session/${r.dataset.open}`; });
  }

  // ---------------------------------------------------------------- manual npm updates

  let updateInfo, updateTimer, clickedVersion;
  const updateButton = $("#brandUpdate");
  function paintBrandUpdate(info) {
    updateInfo = info;
    if (info.runningVersion) $("#brandVersion").textContent = `v${info.runningVersion}`;
    const busy = info.status === "updating" || info.status === "restarting";
    const available = info.status === "available" || info.status === "installed";
    updateButton.classList.toggle("hidden", !available && !busy);
    updateButton.disabled = busy;
    updateButton.textContent = busy ? "…" : "↑";
    updateButton.title = busy ? (info.status === "updating" ? `正在安装 v${info.version}` : `等待加载 v${info.version}`) : available ? `${info.status === "installed" ? "加载" : "更新到"} v${info.version}` : "";
    updateButton.setAttribute("aria-label", updateButton.title);
    if (clickedVersion && !busy) {
      if (info.runningVersion === clickedVersion) { toast(`已更新到 v${info.runningVersion}，刷新网页可加载新版界面`); clickedVersion = null; }
      else if (info.error && available) { fail(new Error(info.error)); clickedVersion = null; }
      else if (info.status === "current" || info.status === "dev") clickedVersion = null;
    }
    scheduleUpdateCheck(busy || clickedVersion ? 2500 : info.status === "error" ? 60_000 : 15 * 60_000);
  }

  function scheduleUpdateCheck(delay = 0) {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(async () => {
      try { paintBrandUpdate(await api("/api/update")); }
      catch { scheduleUpdateCheck(clickedVersion ? 2500 : 60_000); }
    }, delay);
  }

  updateButton.addEventListener("click", async () => {
    if (!updateInfo || updateButton.disabled) return;
    const { status, version } = updateInfo;
    const promptText = status === "installed" ? `加载已安装的 v${version}？控制台会在会话空闲后重启。` : `在运行 claude-pro 的电脑上安装 v${version}？只会在会话空闲时开始。`;
    if (!confirm(promptText)) return;
    clearTimeout(updateTimer);
    updateButton.disabled = true;
    try {
      clickedVersion = version;
      paintBrandUpdate(await api("/api/update", { method: "POST", body: { version } }));
    } catch (e) {
      clickedVersion = null;
      paintBrandUpdate(updateInfo);
      fail(e);
    }
  });

  // ---------------------------------------------------------------- start

  const theme = localStorage.getItem("cpTheme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  $("#themeToggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("cpTheme", next);
  });
  window.addEventListener("hashchange", route);
  wireSidebar();
  // the account's menu: settings and the other pages
  function showUserMenu(open) {
    $("#userMenu").classList.toggle("hidden", !open);
    $("#sideMe").classList.toggle("open", open);
    $("#sideMe").setAttribute("aria-expanded", String(open));
  }
  $("#sideMe").addEventListener("click", () => showUserMenu($("#userMenu").classList.contains("hidden")));
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#userMenu, #sideMe")) showUserMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") showUserMenu(false); });
  const mobileLayout = matchMedia("(max-width: 860px)");
  const drawer = $(".side"), mobileMenu = $("#menuBtn");
  function setDrawer(open, { focus = false } = {}) {
    const mobile = mobileLayout.matches;
    open = mobile && open;
    if (focus && !open) mobileMenu.focus({ preventScroll: true });
    $(".app").classList.toggle("nav-open", open);
    mobileMenu.setAttribute("aria-expanded", String(open));
    drawer.inert = mobile && !open;
    main.inert = open;
    if (open && focus) $("#drawerClose")?.focus({ preventScroll: true });
    if (!open) showUserMenu(false);
  }
  const toggleDrawer = () => {
    closeMenu?.();
    setDrawer(!$(".app").classList.contains("nav-open"), { focus: true });
  };
  mobileMenu.addEventListener("click", toggleDrawer);
  $("#drawerClose")?.addEventListener("click", toggleDrawer);
  $("#sideBackdrop").addEventListener("click", () => { closeMenu?.(); setDrawer(false, { focus: true }); });
  drawer.addEventListener("click", (e) => { if (e.target.closest('a[href^="#/"]')) { closeMenu?.(); setDrawer(false); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !closeMenu && !$(".modal-back") && $(".app").classList.contains("nav-open")) setDrawer(false, { focus: true }); });
  mobileLayout.addEventListener("change", () => { closeMenu?.(); setDrawer(false); syncVisualHeight(); });
  function syncVisualHeight() {
    const viewport = window.visualViewport;
    if (!mobileLayout.matches || !viewport || Math.abs(viewport.scale - 1) > 0.03) { document.documentElement.style.removeProperty("--visible-height"); return; }
    document.documentElement.style.setProperty("--visible-height", `${Math.round(viewport.height)}px`);
  }
  window.visualViewport?.addEventListener("resize", syncVisualHeight);
  // 收起侧栏 (desktop): its button, the rail's, Ctrl+B (⌘B); kept for the next visits
  const sideCollapsed = () => $(".app").classList.contains("side-collapsed");
  function setSideHidden(hidden, { focus = false } = {}) {
    closeMenu?.();
    showUserMenu(false);
    $("#tip")?.classList.add("hidden");
    $(".app").classList.toggle("side-collapsed", hidden);
    $("#sideHide").setAttribute("aria-expanded", String(!hidden));
    $("#sideShow").setAttribute("aria-expanded", String(!hidden));
    try { if (hidden) localStorage.setItem("cpSideHidden", "1"); else localStorage.removeItem("cpSideHidden"); } catch { /* private mode */ }
    if (focus) (hidden ? $("#sideShow") : $("#sideHide")).focus({ preventScroll: true });
  }
  setSideHidden(localStorage.getItem("cpSideHidden") === "1");
  $("#sideHide").addEventListener("click", () => setSideHidden(true, { focus: true }));
  $("#sideShow").addEventListener("click", () => setSideHidden(false, { focus: true }));
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "b" || mobileLayout.matches) return;
    e.preventDefault();
    setSideHidden(!sideCollapsed());
  });
  setDrawer(false);
  syncVisualHeight();
  $("#logoutBtn").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); location.reload(); });
  // The console took up new code (an update, an edit): this page is the old one, and the API may differ from it.
  let pageCode = null, toldReload = false;
  function noteServerCode(p) {
    if (!p?.code) return;
    pageCode ??= p.code;
    if (p.code === pageCode || toldReload) return;
    toldReload = true;
    const el = document.createElement("div");
    el.className = "reload-note"; // (not .toast: toast() reuses and removes that one)
    el.innerHTML = `控制台已更新到 v${esc(p.version)}：<button type="button" class="button small" data-reload>刷新页面</button>`;
    el.querySelector("[data-reload]").addEventListener("click", () => location.reload());
    document.body.appendChild(el);
  }
  // New code waits for the sessions to be idle, and a background agent may run long: said at the top with what holds
  // it up, and a button that ends those agents. A turn running is not shown: it ends by itself and the switch follows.
  // (Background programs are not in the way: they keep running and the new console takes them over.)
  let pendingDismissed = "";
  function notePending(p) {
    const old = $("#pendingNote");
    const pending = p?.pending;
    const held = (pending?.blockers || []).filter((b) => b.background.length);
    const key = held.map((b) => b.name + ":" + b.background.map((x) => x.id).join(",")).join("|");
    if (!pending || !held.length || key === pendingDismissed) { old?.remove(); return; }
    const what = held.map((b) => `<strong>${esc(b.title)}</strong>（${b.background.map((x) => `后台 agent「${esc(x.label)}」`).join("、")}）`).join("；");
    const others = (pending.blockers || []).filter((b) => !b.background.length && (b.turn || b.dialog || b.queued)).length;
    const html = `<span class="pending-text">新版本 v${esc(pending.version)} 已就绪，等这些会话空闲后自动切换：${what}${others ? `；另有 ${others} 个会话正在工作，完成后会自动继续` : ""}</span><button type="button" class="button small" data-clear>结束后台 agent 并更新</button><button type="button" class="icon-btn" data-dismiss title="先不管" aria-label="关闭">✕</button>`;
    const el = old || Object.assign(document.createElement("div"), { id: "pendingNote", className: "reload-note pending-note" });
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.innerHTML = html;
    el.querySelector("[data-dismiss]").addEventListener("click", () => { pendingDismissed = key; el.remove(); });
    el.querySelector("[data-clear]").addEventListener("click", async (e) => {
      if (!confirm(`结束这些后台 agent？${held.map((b) => b.background.map((x) => `\n· ${b.title}：${x.label}`).join("")).join("")}\n\n它们做到一半的工作会丢掉；后台程序（开发服务器等）不受影响，会继续运行。`)) return;
      e.currentTarget.disabled = true;
      try {
        const r = await api("/api/update/clear", { method: "POST", body: {} });
        el.remove();
        toast(`已结束 ${r.ended} 个后台 agent，控制台空闲后切换到新版本`);
      } catch (err) { fail(err); e.currentTarget.disabled = false; }
    });
    if (!old) document.body.appendChild(el);
  }
  // 安装为桌面应用: the browser's own install prompt (Chrome, Edge), offered in the settings menu while it can be
  // shown; not inside the installed app itself
  let installPrompt = null;
  const installItem = $("#installApp");
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    installItem.classList.remove("hidden");
  });
  addEventListener("appinstalled", () => { installPrompt = null; installItem.classList.add("hidden"); toast("已安装：桌面和开始菜单里有 claude-pro 了"); });
  installItem.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice.catch(() => ({}));
    if (outcome === "accepted") { installPrompt = null; installItem.classList.add("hidden"); }
  });

  let pingTick = 0;
  api("/api/ping").then((p) => {
    noteServerCode(p);
    notePending(p);
    $("#brandVersion").textContent = `v${p.version}`;
    if (p.machine) $("#sideMe").title = `设置与更多 · ${p.machine}`;
    $("#remoteLinks").classList.toggle("hidden", !p.remote); // opened through 远程访问: switch computer, log out
    if (p.repo) { $("#repoLink").href = p.repo; $("#repoLink").classList.remove("hidden"); $("#repoSep").classList.remove("hidden"); }
    route();
    loadWorkspace();
    scheduleUpdateCheck();
    noticeNoProvider();
  }).catch(() => {});
  // A first start (nothing connected, not even 7bit.fun): said at once, with the way to the page that adds one. Once a
  // browser session, and not on that page.
  function noticeNoProvider() {
    if (sessionStorage.getItem("cpNoProviderShown")) return;
    api("/api/providers").then((v) => {
      if (v.gateway?.connected || [...(v.presets || []), ...(v.custom || [])].some((x) => x.connected)) return;
      if (location.hash.startsWith("#/providers") || sessionStorage.getItem("cpNoProviderShown")) return;
      sessionStorage.setItem("cpNoProviderShown", "1");
      const m = modal({
        title: "先添加一个模型供应商",
        body: `<p style="margin:0 0 10px">claude-pro 需要连上至少一个模型供应商才能工作：7bit.fun、DeepSeek、Kimi、OpenAI、OpenRouter……也可以是任何兼容 Anthropic 或 OpenAI 接口的服务。</p><p class="muted" style="margin:0;font-size:13px">添加之后，在「模型与供应商」里还能勾选会话里要用的模型、设置默认模型。</p>`,
        foot: '<button class="button secondary" data-close>稍后</button><button class="button" id="goAddProvider">添加供应商</button>',
      });
      $("#goAddProvider", m.el).addEventListener("click", () => {
        m.close();
        sessionStorage.setItem("cpOpenAdd", "1");
        if (location.hash === "#/providers") route(); else location.hash = "#/providers";
      });
      $("#goAddProvider", m.el).focus();
    }).catch(() => {});
  }
  // the sidebar follows the sessions (and keeps the server from stopping while the page is open)
  setInterval(() => {
    const visible = document.visibilityState === "visible";
    if (visible) loadWorkspace();
    if (!visible || ++pingTick % 6 === 0) api("/api/ping").then((p) => { noteServerCode(p); notePending(p); }).catch(() => {}); // (every 30 s while looked at)
  }, 5000);
})();
