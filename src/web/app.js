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
    if (item.k === "user") return `<div class="it it-user"><div class="bubble">${esc(item.text)}</div></div>`;
    if (item.k === "image") return `<div class="it it-image">${opts.image ? `<img src="${opts.image(item.n)}" alt="图片" loading="lazy" data-zoom>` : "[图片]"}</div>`;
    if (item.k === "text") return `<div class="it it-text"><span class="mark">⏺</span><div class="md">${md(item.text)}</div></div>`;
    if (item.k === "thinking") return `<div class="it it-thinking"><details${item.open ? " open" : ""}><summary>✻ ${item.open ? "思考中…" : "思考过程"}</summary><div class="pre">${esc(item.text)}</div></details></div>`;
    if (item.k === "summary") return `<div class="it it-summary"><details><summary>✻ 对话已压缩（摘要）</summary><div class="md">${md(item.text)}</div></details></div>`;
    if (item.k === "output") {
      const lines = trimBlank(item.lines);
      return lines.length ? `<div class="it it-output"><pre>${ansiLines(lines)}</pre></div>` : "";
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

  function modal({ title, sub = "", body = "", foot = "", big = false }) {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal${big ? " big" : ""}" role="dialog"><div class="modal-head"><div><h2>${esc(title)}</h2>${sub ? `<div class="path">${esc(sub)}</div>` : ""}</div><button type="button" class="button secondary small" data-close>关闭</button></div><div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ""}</div>`;
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
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
  function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    const page = parts[0] || "new";
    $$("#nav a, .side-new").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
    markActive();
    $("#tip")?.classList.add("hidden");
    $(".pop")?.remove();
    if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
    main.scrollTop = 0;
    $(".app").classList.remove("nav-open");
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
      const u = await api("/api/update").catch((e) => ({ status: "error", error: e.message }));
      $("#updateState").textContent = { dev: "· 源码运行，不检查 npm", current: "· 已是最新", available: `· 有新版本 ${u.version}：在会话里 /update`, installed: `· 新版本 ${u.version} 已安装，重启会话后生效`, error: `· 检查失败：${u.error}` }[u.status] || "";
    });
  }

  // ---------------------------------------------------------------- 会话

  let sessionCache = null;
  async function sessions() {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    const tab = params.get("tab") === "trash" ? "trash" : "list";
    const el = page(`<h1>会话</h1><p class="sub">所有项目的对话记录：搜索、查看、改名、导出、在终端中继续</p>
      <div class="tabs"><a href="#/sessions" class="${tab === "list" ? "active" : ""}">全部会话</a><a href="#/sessions?tab=trash" class="${tab === "trash" ? "active" : ""}">回收站</a></div><div id="body"><div class="empty">正在加载…</div></div>`);
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
      let list = sessionCache.filter((s) => (!proj || s.dir === proj) && (!q || [s.title, s.firstPrompt, s.id, s.cwd, s.topic].some((v) => String(v || "").toLowerCase().includes(q))));
      if (sort === "size") list = list.slice().sort((a, b) => b.size - a.size);
      if (sort === "cost") list = list.slice().sort((a, b) => b.cost - a.cost);
      const shown = list.slice(0, 300);
      $("#table").innerHTML = shown.length ? `<table class="list"><thead><tr><th>会话</th><th>最后使用</th><th class="num">消息</th><th class="num">大小</th><th class="num">花费</th></tr></thead><tbody>
        ${shown.map((s) => `<tr class="click" data-open="${esc(s.dir)}/${esc(s.id)}"><td class="title-cell"><strong>${s.running ? '<span class="pill ok">运行中</span> ' : ""}${esc(s.title)}</strong><div class="path">${esc(shortPath(s.cwd || s.dir))} · ${esc(s.id.slice(0, 8))}</div></td>
          <td title="${esc(fmtTime(s.mtime))}">${ago(s.mtime)}</td><td class="num">${s.count}</td><td class="num">${fmtBytes(s.size)}</td><td class="num">${s.cost ? fmtUsd(s.cost) : "—"}</td></tr>`).join("")}
      </tbody></table>` : '<div class="empty">没有符合条件的会话</div>';
      $("#count").textContent = `共 ${list.length} 个${list.length > shown.length ? `，显示前 ${shown.length} 个（用搜索缩小范围）` : ""}`;
    };
    draw();
    $("#q").addEventListener("input", draw);
    $("#proj").addEventListener("change", draw);
    $("#sort").addEventListener("change", draw);
    $("#table").addEventListener("click", (e) => { const row = e.target.closest("[data-open]"); if (row) location.hash = `#/session/${row.dataset.open}`; });
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
    const el = page('<div class="chat-page"><div class="chat-scroll"><div class="empty">正在加载会话…</div></div></div>', "chat");
    let d;
    try { d = await api(`/api/sessions/${encodeURIComponent(dir)}/${encodeURIComponent(id)}`); } catch (e) { el.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    if (d.running) { location.replace(`#/live/${d.running}`); return; }
    const base = `/api/sessions/${encodeURIComponent(dir)}/${encodeURIComponent(id)}`;
    el.innerHTML = `<div class="chat-page">
      <header class="chat-head"><div class="chat-titles"><h2>${esc(d.title)}</h2><div class="chat-sub">${esc(shortPath(d.cwd || dir))} · ${d.count} 条消息 · ${fmtBytes(d.size)}${d.cost ? ` · ${fmtUsd(d.cost)}` : ""} · 最后使用 ${esc(fmtTime(d.mtime))}</div></div><span class="pill">未运行</span><button type="button" class="icon-btn" id="hmenu" title="更多">${ICON.more}</button></header>
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
    // The session started again (in the background, or in a terminal tab): resolves with its live peer id once it is up
    // (null: it cannot be started from here, the command to run was shown), or throws.
    const start = async (background) => {
      const r = await api(`${base}/open`, { method: "POST", body: { background } });
      if (!r.opened) { await navigator.clipboard.writeText(r.command).catch(() => {}); toast(`请在终端运行（已复制）：${r.command}`); return null; }
      toast(background ? "正在后台启动这个会话…" : `已在 ${r.how} 新标签中继续，等它上线…`);
      for (let k = 0; k < 30; k++) {
        await new Promise((res) => setTimeout(res, 1000));
        const live = (await api("/api/live").catch(() => ({ sessions: [] }))).sessions.find((x) => x.status?.sessionId === id);
        if (live) return live.peerId;
      }
      throw new Error("会话 30 秒内没有上线");
    };
    const open = async (peerId) => { await loadWorkspace(); location.hash = `#/live/${peerId}`; };
    const resume = (background) => start(background).then((peerId) => peerId && open(peerId)).catch(fail);
    // Writing to it starts it: the message goes to it once its live view watches it (as for a new session)
    const hc = composer($("#hcomp", el), {
      placeholder: "继续这个对话：发消息就会在后台启动它（不开窗口）。Enter 发送，Shift+Enter 换行",
      dropZone: el,
      draftKey: `session:${id}`,
      onSend: async (text, images) => {
        const peerId = await start(true);
        if (!peerId) throw new Error("这个系统不能自动启动会话");
        firstMessage = { peerId, text, images };
        setTimeout(() => open(peerId), 0); // after the box is emptied
      },
    });
    const done = cleanup;
    cleanup = () => { done(); hc.dispose(); };
    let toolsShown = true;
    $("#hmenu", el).addEventListener("click", (e) => {
      popMenu(e.currentTarget, [{ key: "a", title: "", items: [
        { label: "改名", value: "rename" },
        { label: "在终端窗口里继续", value: "terminal" },
        { label: "导出 Markdown", value: "export" },
        { label: toolsShown ? "隐藏工具调用" : "显示工具调用", value: "tools" },
        { label: "删除（进回收站）", value: "delete" },
      ] }], async (key, value) => {
        try {
          if (value === "rename") {
            const name = prompt("会话的新名字（留空则去掉名字）", d.name || "");
            if (name === null) return;
            await api(`${base}/rename`, { method: "POST", body: { name } });
            toast("已改名");
            loadWorkspace();
            sessionView(dir, id);
          }
          if (value === "export") location.href = `${base}/export`;
          if (value === "terminal") resume(false);
          if (value === "tools") { toolsShown = !toolsShown; $$(".it-tool", log).forEach((n) => n.classList.toggle("hidden", !toolsShown)); }
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

  function liveState(st = {}) {
    if (st.dialog) return ["ask", "等待回答"];
    if (st.turn) return ["busy", st.verb ? `${st.verb}…` : "工作中"];
    return ["idle", "空闲"];
  }

  const ws = {
    sessions: [], live: [], q: "", loaded: false,
    closed: new Set(JSON.parse(localStorage.getItem("cpWsClosed") || "[]")),
    expanded: new Set(),
    tips: new Map(),
  };
  const projectKey = (cwd) => shortPath(cwd || "").toLowerCase().replace(/\/+$/, "");
  const baseName = (cwd) => shortPath(cwd || "").replace(/\/+$/, "").split("/").pop() || cwd || "?";

  async function loadWorkspace() {
    try {
      const [s, l] = await Promise.all([api("/api/sessions"), api("/api/live")]);
      ws.sessions = s.sessions;
      ws.live = l.sessions;
      ws.loaded = true;
      drawWorkspace();
    } catch (e) {
      if (!ws.loaded) $("#ws").innerHTML = `<div class="ws-empty">加载失败：${esc(e.message)}</div>`;
    }
  }

  function drawWorkspace() {
    const box = $("#ws");
    const liveById = new Map(ws.live.map((l) => [l.peerId, l]));
    const known = new Set(ws.sessions.map((s) => s.id));
    const items = ws.sessions.map((s) => {
      const peer = s.running ? liveById.get(s.running) : null;
      return { href: peer ? `#/live/${peer.peerId}` : `#/session/${s.dir}/${s.id}`, title: peer?.status?.title || s.title, cwd: s.cwd || s.dir, mtime: s.mtime, peer, alt: peer ? `#/session/${s.dir}/${s.id}` : null };
    });
    // running sessions with nothing written yet (just started)
    for (const l of ws.live) if (!known.has(l.status?.sessionId)) items.push({ href: `#/live/${l.peerId}`, title: l.status?.title || l.name, cwd: l.status?.cwd || l.cwd, mtime: Date.now(), peer: l });
    const q = ws.q.toLowerCase();
    const groups = new Map();
    for (const it of items) {
      if (q && !`${it.title} ${it.cwd}`.toLowerCase().includes(q)) continue;
      const key = projectKey(it.cwd);
      if (!groups.has(key)) groups.set(key, { key, cwd: it.cwd, items: [], last: 0 });
      const g = groups.get(key);
      g.items.push(it);
      g.last = Math.max(g.last, it.peer ? Date.now() : it.mtime);
    }
    const list = [...groups.values()].sort((a, b) => b.last - a.last);
    const here = location.hash;
    ws.tips.clear();
    let n = 0;
    box.innerHTML = list.length ? list.map((g) => {
      g.items.sort((a, b) => Boolean(b.peer) - Boolean(a.peer) || b.mtime - a.mtime);
      const closed = ws.closed.has(g.key) && !q;
      const limit = ws.expanded.has(g.key) || q ? Infinity : 6;
      const rows = closed ? "" : g.items.slice(0, limit).map((it) => {
        const id = `t${n++}`;
        ws.tips.set(id, it);
        const [cls] = it.peer ? liveState(it.peer.status) : [""];
        const active = here === it.href || (it.alt && here === it.alt);
        return `<a class="ws-item${active ? " active" : ""}" href="${esc(it.href)}" data-tip="${id}">${it.peer ? `<span class="ws-dot ${cls}"></span>` : ""}<span class="ws-title">${esc(it.title)}</span><span class="ws-ago">${it.peer ? "" : esc(shortAgo(it.mtime))}</span></a>`;
      }).join("") + (!closed && g.items.length > limit ? `<button type="button" class="ws-more" data-expand="${esc(g.key)}">展开其余 ${g.items.length - limit} 个</button>` : "");
      const running = g.items.filter((it) => it.peer).length;
      return `<div class="ws-group"><button type="button" class="ws-folder" data-folder="${esc(g.key)}" title="${esc(shortPath(g.cwd))}">${closed ? ICON.folder : ICON.folderOpen}<span>${esc(baseName(g.cwd))}</span>${running ? `<span class="ws-count">${running}</span>` : ""}</button>${rows}</div>`;
    }).join("") : `<div class="ws-empty">${q ? "没有符合的会话" : "还没有会话"}</div>`;
  }

  function markActive() {
    const here = location.hash;
    $$("#ws .ws-item").forEach((a) => {
      const it = ws.tips.get(a.dataset.tip);
      a.classList.toggle("active", Boolean(it && (here === it.href || (it.alt && here === it.alt))));
    });
  }

  function wireSidebar() {
    const box = $("#ws");
    box.addEventListener("click", (e) => {
      const f = e.target.closest("[data-folder]"), x = e.target.closest("[data-expand]");
      if (f) {
        const key = f.dataset.folder;
        if (ws.closed.has(key)) ws.closed.delete(key); else ws.closed.add(key);
        localStorage.setItem("cpWsClosed", JSON.stringify([...ws.closed]));
        drawWorkspace();
      }
      if (x) { ws.expanded.add(x.dataset.expand); drawWorkspace(); }
    });
    const tip = $("#tip");
    box.addEventListener("mouseover", (e) => {
      const a = e.target.closest("[data-tip]");
      const it = a && ws.tips.get(a.dataset.tip);
      if (!it) { tip.classList.add("hidden"); return; }
      const [cls, label] = it.peer ? liveState(it.peer.status) : ["off", "未运行"];
      const st = it.peer?.status || {};
      tip.innerHTML = `<strong>${esc(it.title)}</strong><div class="tip-path">${esc(shortPath(it.cwd))}</div><div>${it.peer ? esc([st.model, st.cost != null ? fmtUsd(st.cost) : "", st.context?.window ? `上下文 ${fmtTokens(st.context.used)}/${fmtTokens(st.context.window)}` : ""].filter(Boolean).join(" · ")) : esc(ago(it.mtime))}</div><div class="tip-state"><span class="ws-dot ${cls}"></span>${esc(label)}${it.peer ? (st.hidden ? " · 后台运行" : " · 终端窗口") : ""}</div>`;
      const r = a.getBoundingClientRect();
      tip.classList.remove("hidden");
      tip.style.left = `${r.right + 8}px`;
      tip.style.top = `${Math.min(window.innerHeight - tip.offsetHeight - 8, r.top)}px`;
    });
    box.addEventListener("mouseleave", () => tip.classList.add("hidden"));
    box.addEventListener("scroll", () => tip.classList.add("hidden"));
    $("#wsSearchBtn").addEventListener("click", () => {
      const input = $("#wsSearch");
      input.classList.toggle("hidden");
      if (!input.classList.contains("hidden")) input.focus(); else { input.value = ""; ws.q = ""; drawWorkspace(); }
    });
    $("#wsSearch").addEventListener("input", (e) => { ws.q = e.target.value.trim(); drawWorkspace(); });
    $("#wsRefresh").addEventListener("click", () => loadWorkspace());
  }

  // ---------------------------------------------------------------- the message box (new conversation and live)

  // What was typed and not sent, per box (`draftKey`): kept when the page shows another conversation and back. The text
  // also in localStorage (it survives a reload), the images only in memory (their object URLs live as long as the page).
  const draftImages = new Map();
  const draftText = (key) => (key ? localStorage.getItem(`cpDraft:${key}`) || "" : "");
  function saveDraft(key, text, images) {
    if (!key) return;
    if (text) localStorage.setItem(`cpDraft:${key}`, text); else localStorage.removeItem(`cpDraft:${key}`);
    if (images.length) draftImages.set(key, images); else draftImages.delete(key);
  }

  // A rounded box with the text, images (pasted, dropped or added with +), what goes left and right of the send button.
  // onSend(text, images) resolves when sent (the box is emptied) or throws (it is kept).
  function composer(box, { placeholder, onSend, left = "", right = "", dropZone = box, draftKey = "" }) {
    box.innerHTML = `<form class="composer"><div class="thumbs hidden"></div><textarea rows="1" placeholder="${esc(placeholder)}"></textarea>
      <div class="composer-bar"><button type="button" class="icon-btn" data-add title="添加图片（也可以粘贴或拖进来）" aria-label="添加图片">${ICON.add}</button><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
        <span class="composer-left">${left}</span><span class="grow"></span><span class="composer-right">${right}</span>
        <button type="button" class="round-btn stop hidden" data-stop title="停止当前任务">${ICON.stop}</button><button type="submit" class="round-btn" data-send title="发送（Enter）" disabled>${ICON.send}</button></div></form>`;
    const form = $("form", box), input = $("textarea", box), thumbs = $(".thumbs", box), file = $("input[type=file]", box), send = $("[data-send]", box);
    let images = [...(draftImages.get(draftKey) || [])];
    let sending = false;
    const keep = () => saveDraft(draftKey, input.value, images);
    const ready = () => { send.disabled = sending || (!input.value.trim() && !images.length); };
    const autosize = () => { input.style.height = "auto"; input.style.height = `${Math.min(240, input.scrollHeight)}px`; ready(); };
    const paint = () => {
      thumbs.classList.toggle("hidden", !images.length);
      thumbs.innerHTML = images.map((img, i) => `<div class="thumb"><img src="${img.url}" alt="图片 ${i + 1}"><button type="button" data-drop="${i}" title="移除" aria-label="移除">×</button></div>`).join("");
      keep();
      ready();
    };
    async function add(files) {
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
      if (!b) return;
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
      const text = input.value;
      if (sending || (!text.trim() && !images.length)) return;
      sending = true;
      ready();
      try {
        await onSend(text, images.map(({ media_type, data }) => ({ media_type, data })));
        input.value = "";
        for (const img of images) URL.revokeObjectURL(img.url);
        images = [];
        paint(); // (the draft goes with it)
        autosize();
      } catch (err) { fail(err); } finally { sending = false; ready(); }
    });
    input.value = draftText(draftKey);
    if (images.length) paint();
    requestAnimationFrame(autosize); // (measured once the box is on the page)
    return {
      input,
      left: $(".composer-left", box),
      right: $(".composer-right", box),
      setBusy(busy) { $("[data-stop]", box).classList.toggle("hidden", !busy); },
      onStop(fn) { $("[data-stop]", box).addEventListener("click", fn); },
      // (images of a draft stay: they come back with it)
      dispose() { for (const img of images) if (!draftImages.get(draftKey)?.includes(img)) URL.revokeObjectURL(img.url); },
    };
  }

  // A small menu under `anchor`: items [{label, description, current, value}], onPick(value).
  function popMenu(anchor, sections, onPick) {
    $(".pop")?.remove();
    const pop = document.createElement("div");
    pop.className = "pop";
    pop.innerHTML = sections.map((s) => `<div class="pop-head">${esc(s.title)}</div>${s.items.map((it, i) => `<button type="button" data-s="${esc(s.key)}" data-i="${i}" class="${it.current ? "current" : ""}"><span>${esc(it.label)}</span>${it.description ? `<small>${esc(it.description)}</small>` : ""}</button>`).join("")}`).join("");
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`;
    pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 6)}px`;
    const close = (e) => { if (!e || !pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", close); } };
    setTimeout(() => document.addEventListener("mousedown", close), 0);
    pop.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const s = sections.find((x) => x.key === b.dataset.s);
      onPick(s.key, s.items[Number(b.dataset.i)].value);
      close();
    });
  }

  // ---------------------------------------------------------------- 新会话

  async function newView() {
    const el = page(`<div class="chat-page"><div class="welcome"><div class="welcome-logo">c</div><h1>你好，今天要做什么？</h1><p class="muted">在一个目录里开一个新的 claude-pro 会话：它在后台运行，不开窗口，你在这里看着它工作、给它发消息。</p></div><div class="chat-composer" id="ncomp"></div></div>`, "chat");
    let projects = [];
    try { projects = (await api("/api/projects")).projects; } catch { /* typed by hand */ }
    let dir = localStorage.getItem("cpNewDir") || projects[0]?.cwd || "";
    const c = composer($("#ncomp", el), {
      placeholder: "描述你要它做的事，/命令 也可以。Enter 发送，Shift+Enter 换行",
      left: `<button type="button" class="chip" id="ndir" title="会话在哪个目录里工作">${ICON.folder}<span></span>${ICON.caret}</button>`,
      onSend: async (text, images) => startSession(dir, text, images),
      draftKey: "new",
    });
    const chip = $("#ndir", el);
    const paintDir = () => { $("span", chip).textContent = dir ? baseName(dir) : "选择目录"; chip.title = dir ? `会话在 ${dir} 里工作` : "选择目录"; };
    paintDir();
    chip.addEventListener("click", () => {
      popMenu(chip, [
        { key: "dir", title: "最近的项目", items: projects.slice(0, 12).map((p) => ({ label: baseName(p.cwd), description: shortPath(p.cwd), value: p.cwd, current: p.cwd === dir })) },
        { key: "other", title: "", items: [{ label: "其他目录…", value: "" }] },
      ], (key, value) => {
        if (key === "other") value = prompt("目录的完整路径", dir) || "";
        if (value) { dir = value.trim(); localStorage.setItem("cpNewDir", dir); paintDir(); }
      });
    });
    c.input.focus();
  }

  let firstMessage = null; // {peerId, text, images}: for a session just started, sent by its live view (startSession)

  // claude-pro in the background (a hidden window) in `dir`; once it is up it is opened here and the message goes to it.
  async function startSession(dir, text, images) {
    if (!dir) throw new Error("先选一个目录");
    const before = new Set(ws.live.map((r) => r.peerId));
    const r = await api("/api/live/new", { method: "POST", body: { cwd: dir, background: true } });
    if (!r.opened) throw new Error(`这个系统不能自动启动会话，请在终端运行：${r.command}`);
    localStorage.setItem("cpNewDir", r.cwd);
    toast("会话正在后台启动…");
    const until = Date.now() + 30_000;
    let found = null;
    while (!found && Date.now() < until) {
      await new Promise((res) => setTimeout(res, 1000));
      try { found = (await api("/api/live")).sessions.find((x) => !before.has(x.peerId) && projectKey(x.status?.cwd || x.cwd) === projectKey(r.cwd)); } catch { /* again */ }
    }
    if (!found) throw new Error("会话 30 秒内没有上线：可能是启动出错了，在终端里运行 claude-pro 看看");
    // sent by its live view once that watches it (sent before, what the session printed first was missed)
    firstMessage = { peerId: found.peerId, text, images };
    await loadWorkspace();
    location.hash = `#/live/${found.peerId}`;
  }

  // ---------------------------------------------------------------- a running session, live

  function liveView(peerId) {
    const el = page(`<div class="chat-page">
      <header class="chat-head"><div class="chat-titles"><h2 id="ltitle">连接中…</h2><div class="chat-sub" id="lsub"></div></div><span id="lconn" class="pill">连接中</span><button type="button" class="icon-btn" id="lmenu" title="更多">${ICON.more}</button></header>
      <div class="chat-scroll" id="lscroll"><div class="chat-log" id="log"></div></div>
      <div class="chat-foot"><div class="chat-extra"><div class="todos" id="ltodos"></div><div class="queue" id="lqueue"></div><div id="ldialog"></div></div>
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
      placeholder: "发给这个会话：和在终端里输入一样，/命令、!命令、@会话 都可以。Enter 发送，Shift+Enter 换行",
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
      const items = (o[list] || []).map((m) => ({ label: m.label || m.value, description: m.description || "", value: m.value, current: m.current }));
      if (!items.length) return toast(key === "effort" ? "这个模型不能调推理强度" : "没有可选的模型");
      popMenu(anchor, [{ key, title, items }], (k, value) => post("send", { text: `/${k} ${value}` }).catch(fail));
    };
    $("#lmodel", el).addEventListener("click", choose("model", "模型", "models"));
    $("#leffort", el).addEventListener("click", choose("effort", "推理强度", "efforts"));
    $("#lmenu", el).addEventListener("click", (e) => {
      popMenu(e.currentTarget, [{ key: "a", title: "", items: [
        { label: "查看完整历史记录", value: "history" },
        { label: "改名（/rename）", value: "rename" },
        { label: "压缩上下文（/compact）", value: "compact" },
        ...(status.hidden ? [{ label: "改到终端窗口里", description: "结束后台运行，在终端标签里接着这个对话", value: "terminal" }] : []),
        { label: "结束会话", description: "对话会保存，以后可以继续", value: "end" },
      ] }], async (key, value) => {
        const known = ws.sessions.find((s) => s.id === status.sessionId);
        if (value === "history") { if (known) location.hash = `#/session/${known.dir}/${known.id}`; else toast("这个会话还没有保存的记录"); }
        if (value === "rename") { const name = prompt("新的名字", status.title || ""); if (name) post("send", { text: `/rename ${name}` }).catch(fail); }
        if (value === "compact") post("send", { text: "/compact" }).catch(fail);
        if (value === "end" || value === "terminal") {
          const busy = Boolean(status.turn);
          if (!confirm(busy ? "会话正在工作，结束会停止当前任务。确定结束？" : value === "terminal" ? "结束后台运行，改在终端窗口里继续？" : "结束这个会话？对话会保存，以后可以继续。")) return;
          const sessionId = status.sessionId;
          try { await post("end", { force: busy }); } catch (err) { return fail(err); }
          toast("会话已结束");
          if (value === "terminal" && sessionId) {
            // wait for it to be gone, then the same conversation in a terminal tab
            for (let i = 0; i < 20; i++) {
              await new Promise((r) => setTimeout(r, 500));
              const still = (await api("/api/live").catch(() => ({ sessions: [] }))).sessions.some((x) => x.status?.sessionId === sessionId);
              if (!still) break;
            }
            await loadWorkspace();
            const known = ws.sessions.find((x) => x.id === sessionId);
            if (known) { try { const r = await api(`/api/sessions/${encodeURIComponent(known.dir)}/${encodeURIComponent(known.id)}/open`, { method: "POST", body: { background: false } }); toast(r.opened ? `已在 ${r.how} 里继续` : `请在终端运行：${r.command}`); } catch (err) { fail(err); } }
            return;
          }
          await loadWorkspace();
          location.hash = "#/new";
        }
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
      c.setBusy(busy);
    }
    function setStatus(next) {
      status = next || {};
      statusAt = Date.now();
      $("#ltitle", el).textContent = status.title || status.name || "claude-pro";
      $("#lsub", el).textContent = `@${status.name || ""} · ${shortPath(status.cwd || "")}${status.hidden ? " · 后台运行" : " · 终端窗口"}`;
      $("#lmodel span", el).textContent = status.model || "模型";
      $("#leffort span", el).textContent = status.effort || "推理强度";
      $("#leffort", el).hidden = !status.effort;
      const stats = [];
      if (status.context?.window) stats.push(`上下文 ${fmtTokens(status.context.used || 0)} / ${fmtTokens(status.context.window)}（${Math.round(((status.context.used || 0) / status.context.window) * 100)}%）`);
      if (Number.isFinite(status.cost)) stats.push(`花费 ${fmtUsd(status.cost)}`);
      if (status.tasks) stats.push(`${status.tasks} 个后台 agent`);
      $("#lstats", el).textContent = stats.join("  ·  ");
      const todos = Array.isArray(status.todos) ? status.todos : [];
      $("#ltodos", el).innerHTML = todos.length ? `<details open><summary class="muted">待办 ${todos.filter((t) => t.status === "completed").length}/${todos.length}</summary>${todos.map((t) => `<div class="${t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : ""}">${t.status === "completed" ? "☒" : t.status === "in_progress" ? "◼" : "☐"} ${esc(t.content)}</div>`).join("")}</details>` : "";
      $("#lqueue", el).innerHTML = (status.queue || []).map((q) => `<div>⎿ 排队中：${esc(String(q).replace(/\s+/g, " ").slice(0, 200))}</div>`).join("");
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
        if (firstMessage?.peerId === peerId) {
          const { text, images } = firstMessage;
          firstMessage = null;
          (async () => {
            // the session may still be drawing its first screen: tried again for a few seconds
            for (let i = 0; i < 10; i++) {
              try { await post("send", { text, images }); return; } catch (ex) {
                if (i === 9) toast(`消息没发出去：${ex.message}`, "error");
                await new Promise((res) => setTimeout(res, 800));
              }
            }
          })();
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
    es.onopen = () => { conn.textContent = "实时"; conn.className = "pill ok"; };
    es.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch { /* skip */ } };
    es.onerror = () => { conn.textContent = es.readyState === EventSource.CLOSED ? "已断开" : "重新连接中…"; conn.className = "pill warn"; };
    const tick = setInterval(renderStatus, 250);
    cleanup = () => { es.close(); clearInterval(tick); c.dispose(); wholes.disconnect(); };
    c.input.focus();
  }

  // ---------------------------------------------------------------- 远程访问

  async function remotePage() {
    const el = page('<h1>远程访问</h1><p class="sub">在手机或别的电脑上，通过 https://&lt;你的通讯号&gt;.7bit.fun 打开这台电脑的控制台，要输入密码</p><div id="body"><div class="empty">正在加载…</div></div>');
    let v;
    try { v = await api("/api/remote"); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    drawRemote(el, v);
    const timer = setInterval(async () => { try { const next = await api("/api/remote"); if (JSON.stringify(next.tunnel) !== JSON.stringify(v.tunnel)) { v = next; drawRemote(el, v); } } catch { /* next time */ } }, 3000);
    cleanup = () => clearInterval(timer);
  }

  function drawRemote(el, v) {
    const t = v.tunnel || {};
    const state = !v.enabled ? ["off", "已关闭"] : t.status === "online" ? ["ok", "已开启"] : t.status === "error" ? ["off", "没有接上"] : ["warn", "正在连接"];
    const device = (ua) => { const s = String(ua || ""); return /iPhone|iPad/.test(s) ? "iPhone / iPad" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows" : /Mac OS/.test(s) ? "Mac" : s.slice(0, 40) || "未知设备"; };
    $("#body", el).innerHTML = `
      <div class="panel panel-pad"><div class="actions" style="justify-content:space-between">
        <div><div class="muted" style="font-size:12.5px">状态</div><div style="font-size:18px;font-weight:650;margin-top:2px"><span class="pill ${state[0]}">${state[1]}</span>
          ${t.status === "online" && t.host ? ` <a href="https://${esc(t.host)}" target="_blank" rel="noopener" class="mono" style="font-size:15px">https://${esc(t.host)}</a>` : ""}</div>
          ${t.error ? `<div style="color:var(--danger);font-size:13px;margin-top:4px">${esc(t.error)}</div>` : ""}
          ${!v.gateway ? '<div class="muted" style="font-size:13px;margin-top:4px">远程访问通过 7bit.fun 网关：先在「模型与供应商」里连接 7bit.fun。</div>' : ""}</div>
        <div class="actions">${v.enabled ? '<button class="button danger" id="rOff">关闭远程访问</button>' : `<button class="button" id="rOn" ${v.hasPassword && v.gateway ? "" : "disabled"}>开启远程访问</button>`}</div></div>
        <p class="muted" style="font-size:12.5px;margin:12px 0 0">地址用的是你在网关的通讯号（在网关网页「通讯录」里改）。开启后这台电脑的控制台服务常驻后台；电脑休眠或关机时打不开，claude-pro 的任何会话启动时会重新接上。</p></div>
      <div class="section-head"><div><h2>密码</h2><p>${v.hasPassword ? "已设置。改密码会让所有已登录的设备退出。" : `还没有设置：开启前先设一个（至少 ${v.minPassword} 位）。`}</p></div></div>
      <form class="panel panel-pad actions" id="rPwForm"><input type="password" id="rPw1" placeholder="新密码" autocomplete="new-password" style="flex:1;min-width:180px"><input type="password" id="rPw2" placeholder="再输一次" autocomplete="new-password" style="flex:1;min-width:180px"><button class="button" type="submit">${v.hasPassword ? "修改密码" : "设置密码"}</button></form>
      <div class="section-head"><div><h2>已登录的设备</h2><p>${v.sessions.length} 台</p></div>${v.sessions.length ? '<button class="button danger small" id="rLogoutAll">全部退出</button>' : ""}</div>
      <div class="panel">${v.sessions.length ? `<table class="list"><tbody>${v.sessions.map((s) => `<tr><td>${esc(device(s.ua))}</td><td class="mono">${esc(s.ip || "")}</td><td>最近 ${esc(ago(s.lastSeen))}</td><td class="num muted">${s.remember ? "记住 30 天" : "1 天"}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">没有</div>'}</div>
      <div class="section-head"><h2>最近的登录</h2></div>
      <div class="panel">${v.logins.length ? `<table class="list"><tbody>${v.logins.map((l) => `<tr><td>${l.ok ? '<span class="pill ok">成功</span>' : '<span class="pill off">密码错误</span>'}</td><td>${esc(device(l.ua))}</td><td class="mono">${esc(l.ip || "")}</td><td class="num">${esc(fmtTime(l.at))}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">还没有人登录过</div>'}</div>`;
    const post = async (body, done) => { try { drawRemote(el, await api("/api/remote", { method: "POST", body })); if (done) toast(done); } catch (e) { fail(e); } };
    $("#rOn", el)?.addEventListener("click", () => post({ enabled: true }, "远程访问已开启，正在连接网关…"));
    $("#rOff", el)?.addEventListener("click", () => { if (confirm("关闭远程访问？外网就打不开这台电脑的控制台了。")) post({ enabled: false }, "远程访问已关闭"); });
    $("#rLogoutAll", el)?.addEventListener("click", () => { if (confirm("让所有已登录的设备退出？")) post({ logoutAll: true }, "都已退出"); });
    $("#rPwForm", el).addEventListener("submit", (e) => {
      e.preventDefault();
      const a = $("#rPw1", el).value, b = $("#rPw2", el).value;
      if (a.length < v.minPassword) return toast(`密码至少 ${v.minPassword} 位`, "error");
      if (a !== b) return toast("两次输入不一样", "error");
      post({ password: a }, "密码已保存，所有已登录的设备都已退出");
    });
  }

  // ---------------------------------------------------------------- 模型与供应商

  async function providers() {
    const el = page('<h1>模型与供应商</h1><p class="sub">和终端里的 /connect、/model 是同一份配置</p><div id="body"><div class="empty">正在加载…</div></div>');
    let p;
    try { p = await api("/api/providers"); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    drawProviders(el, p);
  }

  function drawProviders(el, p) {
    const card = (x) => `<div class="panel prov${x.connected ? " connected" : ""}"><div class="prov-top"><strong>${esc(x.name)}</strong>${x.connected ? '<span class="pill ok">已连接</span>' : ""}</div>
      <div class="meta">${esc(x.protocol === "openai" ? "OpenAI 协议" : "Anthropic 协议")} · ${esc(x.baseUrl)}</div>
      ${x.connected ? `<div class="meta">Key ${esc(x.key || "（无需）")} · ${x.models.length} 个模型${x.model ? ` · 选的是 ${esc(x.model)}` : ""}</div>` : ""}
      <div class="actions">${x.connected ? `<button class="button secondary small" data-connect="${esc(x.id)}">更换 Key / 模型</button><button class="button danger small" data-remove="${esc(x.id)}">断开</button>` : `<button class="button small" data-connect="${esc(x.id)}">连接</button>`}${x.keyPage ? `<a class="button secondary small" href="${esc(x.keyPage)}" target="_blank" rel="noopener">获取 Key</a>` : ""}</div></div>`;
    const connected = [...p.presets, ...p.custom].filter((x) => x.connected);
    $("#body", el).innerHTML = `<div id="pbody">
      <div class="section-head"><div><h2>默认模型</h2><p>新会话用的模型和推理强度。会话里的 /model、/effort 只改那一个会话（并记住给下次用）</p></div></div>
      <div class="panel panel-pad" id="defaults"><div class="muted">正在读取可用模型…</div></div>
      <div class="section-head"><div><h2>7bit.fun 网关</h2><p>Claude、GPT 等模型，余额、远程控制、跨电脑和通讯录都通过它</p></div></div>
      <div class="panel prov${p.gateway.connected ? " connected" : ""}" style="max-width:640px"><div class="prov-top"><strong>7bit.fun</strong>${p.gateway.connected ? '<span class="pill ok">已连接</span>' : ""}</div>
        <div class="meta">${esc(p.gateway.url)}${p.gateway.connected ? ` · Key ${esc(p.gateway.key)}${p.gateway.account?.email ? ` · ${esc(p.gateway.account.email)}` : ""}` : ""}</div>
        <form class="actions" id="gwForm"><input type="password" id="gwKey" placeholder="${p.gateway.connected ? "粘贴新 Key 来更换" : "粘贴 7bit.fun 的 API Key"}" style="flex:1;min-width:240px" autocomplete="off"><button class="button small" type="submit">${p.gateway.connected ? "更换" : "连接"}</button>${p.gateway.connected ? '<button class="button danger small" type="button" id="gwOut">断开</button>' : ""}<a class="button secondary small" href="${esc(p.gateway.keyPage)}" target="_blank" rel="noopener">获取 Key</a></form></div>
      <div class="section-head"><div><h2>模型供应商</h2><p>${connected.length} 个已连接。Key 保存在 ~/.claude-pro/providers.json，页面上只显示开头和结尾</p></div><button class="button secondary small" id="addCustom">添加自定义供应商</button></div>
      <div class="prov-grid">${[...p.presets.filter((x) => x.connected), ...p.custom, ...p.presets.filter((x) => !x.connected)].map(card).join("")}</div></div>`;
    loadDefaults(el, p);
    $("#gwForm", el).addEventListener("submit", async (e) => {
      e.preventDefault();
      const apiKey = $("#gwKey", el).value.trim();
      if (!apiKey) return toast("请先粘贴 Key", "error");
      try { drawProviders(el, await api("/api/gateway", { method: "POST", body: { apiKey } })); toast("已连接 7bit.fun"); } catch (err) { fail(err); }
    });
    $("#gwOut", el)?.addEventListener("click", async () => {
      if (!confirm("断开 7bit.fun？这台电脑的会话会下线，网关上的模型也不能用了。")) return;
      try { drawProviders(el, await api("/api/gateway", { method: "DELETE" })); toast("已断开"); } catch (err) { fail(err); }
    });
    $("#addCustom", el).addEventListener("click", () => connectDialog(el, null));
    $("#pbody", el).addEventListener("click", async (e) => {
      const c = e.target.closest("[data-connect]"), r = e.target.closest("[data-remove]");
      if (c) connectDialog(el, [...p.presets, ...p.custom].find((x) => x.id === c.dataset.connect));
      if (r && confirm(`断开 ${r.dataset.remove}？保存的 Key 会删除。`)) {
        try { drawProviders(el, await api(`/api/providers/${encodeURIComponent(r.dataset.remove)}`, { method: "DELETE" })); toast("已断开"); } catch (err) { fail(err); }
      }
    });
  }

  async function loadDefaults(el, p) {
    const box = $("#defaults", el);
    let m;
    try { m = await api("/api/models"); } catch (e) { box.innerHTML = `<div class="muted">读取失败：${esc(e.message)}</div>`; return; }
    const current = m.remembered?.model || m.current;
    const efforts = ["auto", "low", "medium", "high", "xhigh", "max"];
    const currentEffort = p.remembered?.effort || p.effort;
    box.innerHTML = `<div class="actions" style="align-items:flex-end">
      <label class="field" style="flex:2;min-width:260px;margin:0">模型<input list="modelList" id="defModel" value="${esc(current)}" placeholder="provider/model，或 opus、sonnet"><datalist id="modelList">${m.models.map((x) => `<option value="${esc(x.ref)}">${esc(x.provider)}${x.window ? ` · ${fmtTokens(x.window)} 上下文` : ""}</option>`).join("")}</datalist></label>
      <label class="field" style="min-width:140px;margin:0">推理强度<select id="defEffort">${efforts.map((x) => `<option${x === currentEffort ? " selected" : ""}>${x}</option>`).join("")}${efforts.includes(currentEffort) ? "" : `<option selected>${esc(currentEffort)}</option>`}</select></label>
      <button class="button" id="saveDefaults">保存为默认</button></div>
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">${m.remembered?.model || m.remembered?.effort ? `现在生效的是会话里 /model、/effort 记住的选择（${esc([m.remembered.model, m.remembered.effort].filter(Boolean).join(" · "))}）。保存后会写入设置的 model / effort，并清掉记住的选择。` : "保存到 ~/.claude-pro/settings.json 的 model / effort。"}已经开着的会话要 /model default 或重启才换。</p>`;
    $("#saveDefaults", box).addEventListener("click", async () => {
      const model = $("#defModel", box).value.trim();
      const effort = $("#defEffort", box).value;
      try {
        if (model) await api("/api/settings", { method: "POST", body: { scope: "user", key: "model", value: model } });
        await api("/api/settings", { method: "POST", body: { scope: "user", key: "effort", value: effort } });
        await api("/api/remembered", { method: "POST", body: { model: null, effort: null } });
        toast("已保存默认模型");
        providers();
      } catch (e) { fail(e); }
    });
  }

  // Connect a provider (a built-in one, or with x = null one of the user's own): key → models → test → saved.
  function connectDialog(el, x) {
    const custom = !x;
    const m = modal({
      title: custom ? "添加自定义供应商" : `连接 ${x.name}`, sub: custom ? "任何兼容 Anthropic Messages 或 OpenAI Chat Completions 的接口" : `${x.baseUrl}`,
      body: `${custom ? `<label class="field">名字<small>模型名会是 名字/模型，比如 myrelay/gpt-5</small><input id="cName" placeholder="myrelay"></label>
        <label class="field">协议<select id="cProto"><option value="openai">OpenAI 兼容（/chat/completions）</option><option value="anthropic">Anthropic 兼容（/v1/messages）</option></select></label>
        <label class="field">地址<input id="cUrl" placeholder="https://api.example.com/v1"></label>` : ""}
        <label class="field">API Key${x?.connected ? "<small>留空则继续用已保存的 Key</small>" : x?.keyless ? "<small>这个供应商不需要 Key</small>" : ""}<input type="password" id="cKey" autocomplete="off" placeholder="${x?.connected ? "留空：用已保存的" : "粘贴 Key"}"></label>
        <div class="actions"><button class="button secondary" id="cCheck">检查 Key 并列出模型</button></div>
        <div id="cModels" style="margin-top:14px"></div>`,
      foot: '<span class="modal-error"></span><button class="button secondary" data-close>取消</button><button class="button" id="cConnect" disabled>测试并连接</button>',
    });
    let checked = null;
    const err = (t) => { $(".modal-error", m.el).textContent = t || ""; };
    const target = () => (custom ? { custom: { name: $("#cName", m.el).value, protocol: $("#cProto", m.el).value, baseUrl: $("#cUrl", m.el).value } } : { id: x.id });
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
        const p = await api("/api/providers/connect", { method: "POST", body: { ...target(), apiKey: $("#cKey", m.el).value, model, models: list.length ? list : [{ id: model }], authHeader: checked?.authHeader, useNow: $("#cUse", m.el)?.checked } });
        m.close();
        toast(`已连接，模型 ${model} 测试通过`);
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
    const el = page(`<h1>扩展</h1><p class="sub">技能、子 agent、自定义命令、MCP 服务器和 hooks。新会话会加载改动</p>
      <div class="toolbar"><span class="muted" style="font-size:13px">项目：</span>${await projectsSelect("proj", project)}</div><div id="body"><div class="empty">正在加载…</div></div>`);
    $("#proj", el).addEventListener("change", (e) => { sessionStorage.setItem("extProject", e.target.value); extensions(); });
    let x;
    try { x = await api(`/api/extensions${project ? `?project=${encodeURIComponent(project)}` : ""}`); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    const scopePill = (s) => `<span class="pill${s === "built-in" ? "" : s === "user" ? " accent" : " ok"}">${{ "built-in": "内置", user: "用户", project: "项目" }[s] || esc(s)}</span>`;
    const list = (items, kind) => items.length ? items.map((i) => `<div class="file-row"><span class="name">${esc(kind === "command" ? `/${i.name}` : i.name)}</span>${scopePill(i.scope)}<span class="desc" title="${esc(i.description)}">${esc(i.description)}</span>${i.path ? `<button class="button secondary small" data-edit="${esc(i.path)}">编辑</button>` : ""}</div>`).join("") : '<div class="file-row"><span class="desc">还没有</span></div>';
    const newBtn = (kind, label) => `<button class="button secondary small" data-new="${kind}">新建${label}</button>`;
    $("#body", el).innerHTML = `
      <div class="section-head"><div><h2>技能</h2><p>skills/&lt;名字&gt;/SKILL.md：模型按描述决定何时加载</p></div>${newBtn("skill", "技能")}</div><div class="panel">${list(x.skills, "skill")}</div>
      <div class="section-head"><div><h2>子 agent</h2><p>agents/*.md：Task 工具可以把任务交给它们</p></div>${newBtn("agent", "子 agent")}</div><div class="panel">${list(x.agents, "agent")}</div>
      <div class="section-head"><div><h2>自定义命令</h2><p>commands/*.md：在会话里输入 /名字</p></div>${newBtn("command", "命令")}</div><div class="panel">${list(x.commands, "command")}</div>
      <div class="section-head"><div><h2>MCP 服务器</h2><p>环境变量和请求头的值不会显示（保持 ••• 就是不改）</p></div><button class="button secondary small" id="addMcp">添加 MCP 服务器</button></div>
      <div class="panel">${x.mcp.length ? x.mcp.map((s, i) => `<div class="file-row"><span class="name">${esc(s.name)}</span><span class="pill">${esc(s.scope)}</span><span class="desc mono">${esc(s.spec?.url || [s.spec?.command, ...(s.spec?.args || [])].filter(Boolean).join(" "))}</span>${s.scope === "user" || s.scope === ".mcp.json" ? `<button class="button secondary small" data-mcp="${i}">编辑</button>` : `<button class="button secondary small" data-edit="${esc(s.file)}">编辑文件</button>`}</div>`).join("") : '<div class="file-row"><span class="desc">没有配置 MCP 服务器</span></div>'}</div>
      <div class="section-head"><div><h2>Hooks</h2><p>在工具调用前后、提交消息时等运行的命令，写在设置文件的 hooks 里</p></div></div>
      <div class="panel">${x.hooks.length ? x.hooks.map((h) => `<div class="file-row"><span class="name">${esc(h.event)}</span><span class="pill">${esc(h.scope)}</span><span class="desc mono">${esc(JSON.stringify(h.entries))}</span><button class="button secondary small" data-edit="${esc(h.file)}">编辑文件</button></div>`).join("") : `<div class="file-row"><span class="desc">没有 hooks。要添加，编辑设置文件的 "hooks" 字段</span><button class="button secondary small" data-edit="${esc(x.settingsFiles.user)}">编辑用户设置文件</button></div>`}</div>`;
    $("#body", el).addEventListener("click", async (e) => {
      const ed = e.target.closest("[data-edit]"), nw = e.target.closest("[data-new]"), mc = e.target.closest("[data-mcp]");
      if (ed) openEditor(ed.dataset.edit, { title: "编辑", deletable: !/\.json$/i.test(ed.dataset.edit), onSaved: extensions });
      if (nw) {
        const kind = nw.dataset.new;
        const name = prompt(`新${{ skill: "技能", agent: "子 agent", command: "命令" }[kind]}的名字（字母、数字、_ . -）`);
        if (!name) return;
        const scope = project && confirm(`放在项目 ${project} 里吗？\n确定：项目级（.claude-pro/）  取消：用户级（所有项目）`) ? "project" : "user";
        try { const r = await api("/api/extensions", { method: "POST", body: { kind, scope, name, project } }); openEditor(r.path, { title: "编辑", onSaved: extensions }); } catch (err) { fail(err); }
      }
      if (mc) mcpDialog(x, x.mcp[Number(mc.dataset.mcp)], project);
    });
    $("#addMcp", el).addEventListener("click", () => mcpDialog(x, null, project));
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
    const el = page(`<h1>用量</h1><p class="sub">按天、模型、项目统计（来自每次请求的运行记录；有价格的模型才算得出花费）</p>
      <div class="toolbar">${[7, 30, 90].map((d) => `<button class="button ${d === days ? "" : "secondary"} small" data-days="${d}">近 ${d} 天</button>`).join("")}<span style="flex:1"></span><label class="muted" style="font-size:13px">图表：<select id="metric"><option value="cost">花费</option><option value="tokens">tokens</option><option value="requests">请求数</option></select></label></div><div id="body"><div class="empty">正在统计…</div></div>`);
    $$("[data-days]", el).forEach((b) => b.addEventListener("click", () => { sessionStorage.setItem("usageDays", b.dataset.days); usage(); }));
    let u;
    try { u = await api(`/api/usage?days=${days}`); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    const total = u.days.reduce((a, d) => ({ cost: a.cost + d.cost, requests: a.requests + d.requests, tokens: a.tokens + d.input + d.output + d.cacheRead + d.cacheWrite }), { cost: 0, requests: 0, tokens: 0 });
    const table = (rows, label) => rows.length ? `<table class="list"><thead><tr><th>${label}</th><th class="num">请求</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存读</th><th class="num">缓存写</th><th class="num">花费</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="mono" style="word-break:break-all">${esc(shortPath(r.key))}</td><td class="num">${r.requests}</td><td class="num">${fmtTokens(r.input)}</td><td class="num">${fmtTokens(r.output)}</td><td class="num">${fmtTokens(r.cacheRead)}</td><td class="num">${fmtTokens(r.cacheWrite)}</td><td class="num">${r.cost ? fmtUsd(r.cost) : "—"}${r.unpriced ? ` <span class="faint" title="${r.unpriced} 次请求的模型没有价格">*</span>` : ""}</td></tr>`).join("")}
    </tbody></table>` : '<div class="empty">没有记录</div>';
    $("#body", el).innerHTML = `<div class="cards">
        <div class="panel stat"><div class="label">花费（近 ${days} 天，按价格估算）</div><div class="value">${fmtUsd(total.cost)}</div></div>
        <div class="panel stat"><div class="label">请求</div><div class="value">${total.requests}</div></div>
        <div class="panel stat"><div class="label">tokens（含缓存）</div><div class="value">${fmtTokens(total.tokens)}</div></div>
        <div class="panel stat"><div class="label">所有会话累计花费</div><div class="value">${fmtUsd(u.totalSessionCost)}</div><div class="hint">会话自己记录的花费，不限时间</div></div></div>
      <div class="section-head"><h2>每天</h2></div><div class="panel panel-pad"><svg class="chart" id="chart"></svg></div>
      <div class="section-head"><h2>按模型</h2></div><div class="panel">${table(u.models, "模型")}</div>
      <div class="section-head"><h2>按项目</h2></div><div class="panel">${table(u.projects, "项目")}</div>
      <div class="section-head"><h2>花费最多的会话</h2></div><div class="panel">${u.sessions.length ? `<table class="list"><tbody>${u.sessions.map((s) => `<tr class="click" data-open="${esc(s.dir)}/${esc(s.id)}"><td class="title-cell"><strong>${esc(s.title)}</strong><div class="path">${esc(shortPath(s.cwd || s.dir))}</div></td><td>${ago(s.mtime)}</td><td class="num">${fmtUsd(s.cost)}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">没有记录</div>'}</div>`;
    const drawChart = () => {
      const metric = $("#metric", el).value;
      const val = (d) => (metric === "cost" ? d.cost : metric === "tokens" ? d.input + d.output + d.cacheRead + d.cacheWrite : d.requests);
      const svg = $("#chart", el);
      const w = svg.clientWidth || 900, h = 220, pad = { l: 56, r: 10, t: 10, b: 26 };
      const max = Math.max(...u.days.map(val), metric === "cost" ? 0.01 : 1);
      const bw = (w - pad.l - pad.r) / u.days.length;
      const fmt = (v) => (metric === "cost" ? fmtUsd(v) : fmtTokens(v));
      let s = "";
      for (let i = 0; i <= 4; i++) { const y = pad.t + ((h - pad.t - pad.b) * i) / 4; s += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}"/><text x="${pad.l - 6}" y="${y + 3}" text-anchor="end">${esc(fmt(max * (1 - i / 4)))}</text>`; }
      u.days.forEach((d, i) => {
        const v = val(d);
        const bh = ((h - pad.t - pad.b) * v) / max;
        const x = pad.l + i * bw;
        s += `<rect class="bar" x="${x + bw * 0.15}" y="${h - pad.b - bh}" width="${Math.max(1, bw * 0.7)}" height="${Math.max(0, bh)}"><title>${esc(d.key)}：${esc(fmt(v))} · ${d.requests} 次请求</title></rect>`;
        if (u.days.length <= 31 ? i % Math.ceil(u.days.length / 10) === 0 : i % 10 === 0) s += `<text x="${x + bw / 2}" y="${h - 8}" text-anchor="middle">${esc(d.key.slice(5))}</text>`;
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
  $("#menuBtn").addEventListener("click", () => $(".app").classList.toggle("nav-open"));
  $("#sideBackdrop").addEventListener("click", () => $(".app").classList.remove("nav-open"));
  $("#logoutBtn").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); location.reload(); });
  api("/api/ping").then((p) => {
    $("#brandVersion").textContent = `v${p.version}`;
    $("#remoteLinks").classList.toggle("hidden", !p.remote); // opened through 远程访问: switch computer, log out
    route();
    loadWorkspace();
  }).catch(() => {});
  // the sidebar follows the sessions (and keeps the server from stopping while the page is open)
  setInterval(() => { if (document.visibilityState === "visible") loadWorkspace(); else api("/api/ping").catch(() => {}); }, 5000);
  api("/api/overview").then((o) => { const who = o.gateway?.account?.name || o.gateway?.account?.email || o.host; $("#sideUser").textContent = who; $("#sideAvatar").textContent = String(who || "?").slice(0, 1).toUpperCase(); }).catch(() => {});
})();
