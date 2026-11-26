// 会话: all conversations, the trash, and one conversation as history.

import { esc, api, toast, fail, fmtBytes, fmtUsd, fmtTime, ago, shortPath, ICON, $ } from "./util.js";
import { itemHtml, wireForks } from "./transcript.js";
import { folded } from "./images.js";
import { wholeOutputs } from "./dialogs.js";
import { view, page } from "./router.js";
import { loadWorkspace, archive } from "./workspace.js";
import { composer, popMenu } from "./composer.js";
import { queueFirstMessage } from "./page-new.js";
import { setDockWorkspace, dockButton } from "./dock.js";

let sessionCache = null;
export async function sessions() {
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

export async function sessionView(dir, id) {
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
  if (d.cwd) setDockWorkspace(d.cwd);
  el.innerHTML = `<div class="chat-page">
      <header class="chat-head"><div class="chat-titles"><h2>${esc(d.title)}</h2><div class="chat-sub">${esc(shortPath(d.cwd || dir))} · ${d.count} 条消息 · ${fmtBytes(d.size)}${d.cost ? ` · ${fmtUsd(d.cost)}` : ""} · 最后使用 ${esc(fmtTime(d.mtime))}</div></div>${dockButton()}<button type="button" class="icon-btn" id="hmenu" title="更多">${ICON.more}</button></header>
      <div class="chat-scroll" id="hscroll"><div class="chat-log" id="log"></div></div>
      <div class="chat-foot"><div class="chat-composer" id="hcomp"></div></div></div>`;
  const log = $("#log", el);
  const image = (n) => `${base}/image/${n}`;
  // drawn in pieces: a long conversation has thousands of items
  let i = 0;
  wireForks(log, () => id);
  const wholes = wholeOutputs(log, async (tool) => (await api(`${base}/output/${encodeURIComponent(tool)}`)).text, (tool, text) => {
    const node = log.querySelector(`[data-cut="${CSS.escape(tool)}"]`);
    const old = node?.querySelector(".fold, pre");
    if (old) old.outerHTML = folded(esc(text));
  });
  view.cleanup = () => wholes.disconnect();
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
  const done = view.cleanup;
  let left = false;
  view.cleanup = () => { left = true; done(); hc.dispose(); };
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
