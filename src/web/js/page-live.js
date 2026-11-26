// A running session, live: its transcript as it streams, its status, its dialogs, and the message box.

import { esc, api, toast, fail, fmtTokens, fmtUsd, fmtDuration, shortPath, ICON, $, $$ } from "./util.js";
import { ansi, ansiLines, md } from "./markdown.js";
import { applyEvent, hydrate, itemHtml } from "./transcript.js";
import { wholeOutputs } from "./dialogs.js";
import { view, page } from "./router.js";
import { ws, loadWorkspace, archive, putAway } from "./workspace.js";
import { composer, quoteSelection, popMenu, modelMenuItems } from "./composer.js";
import { pendingFirstSends } from "./page-new.js";
import { mobileLayout } from "./main.js";
import { setDockWorkspace, dockButton } from "./dock.js";
import { findInConversation, FIND_ICON, takePendingFind } from "./find.js";

export function liveView(peerId) {
  const el = page(`<div class="chat-page">
      <header class="chat-head"><div class="chat-titles"><h2 id="ltitle">连接中…</h2><div class="chat-sub" id="lsub"></div></div><span id="lconn" class="pill warn" hidden></span><button type="button" class="icon-btn find-toggle" id="lfind" title="在对话中查找（Ctrl+F）" aria-label="在对话中查找" aria-pressed="false">${FIND_ICON}</button>${dockButton()}<button type="button" class="icon-btn" id="lmenu" title="更多">${ICON.more}</button></header>
      <div class="chat-scroll" id="lscroll"><div class="chat-log" id="log"></div></div>
      <div class="chat-foot"><div class="chat-extra"><div class="bgwork" id="lbg"></div><div class="todos" id="ltodos"></div><div class="queue" id="lqueue"></div><div id="ldialog"></div></div>
        <div class="status-line" id="lstatus"></div><div class="chat-composer" id="lcomp"></div><div class="chat-stats" id="lstats"></div></div>
    </div>`, "chat");
  // the panel follows the session's folder (known from the sidebar's list at once, else from its first status)
  const listed = ws.live.find((l) => l.peerId === peerId);
  if (listed?.status?.cwd || listed?.cwd) setDockWorkspace(listed.status?.cwd || listed.cwd);
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
    suggest: (text, cursor) => post("suggest", { text, cursor }),
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
    if (status.cwd) setDockWorkspace(status.cwd);
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
      findAsked();
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
  const finder = findInConversation({ root: log, scroller, host: $(".chat-page", el), button: $("#lfind", el) });
  // opened from the sidebar's search by what was said in it: at the place the words are (once the conversation is
  // drawn; at once when it is this one)
  function findAsked() {
    const q = status.sessionId && takePendingFind(status.sessionId);
    if (q && !finder.show(q)) toast(`这里显示的是最近的对话，里面没有「${q}」：它在更早的部分，或在没有完整显示的工具输出里`);
  }
  const onFind = (e) => { if (e.detail?.sessionId && e.detail.sessionId === status.sessionId && state.items.length) findAsked(); };
  document.addEventListener("cp-find", onFind);
  view.cleanup = () => { es.close(); clearInterval(tick); c.dispose(); wholes.disconnect(); unquote(); finder.dispose(); document.removeEventListener("cp-find", onFind); };
  if (!mobileLayout.matches) c.input.focus();
}
