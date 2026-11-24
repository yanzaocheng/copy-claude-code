// The sidebar: 工作区, the projects and their conversations, running sessions first.

import { esc, api, toast, fail, fmtTokens, fmtUsd, ago, shortPath, ICON, $, $$ } from "./util.js";
import { view, route } from "./router.js";
import { popMenu } from "./composer.js";
import { browseProjectDirectories, startSession } from "./page-new.js";
import { drawAuthRequests } from "./page-remote.js";

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

export const ws = {
  sessions: [], live: [], projectOpen: {}, workspaces: [], q: "", loaded: false,
  closed: new Set(JSON.parse(localStorage.getItem("cpWsClosed") || "[]")),
  expanded: new Set(),
  tips: new Map(),
};
export const projectKey = (cwd) => shortPath(cwd || "").toLowerCase().replace(/\/+$/, "");
export const baseName = (cwd) => shortPath(cwd || "").replace(/\/+$/, "").split("/").pop() || cwd || "?";

let workspaceLoad;
export async function loadWorkspace({ afterPending = false } = {}) {
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
      drawAuthRequests();
    } catch (e) {
      if (!ws.loaded) $("#ws").innerHTML = `<div class="ws-empty">加载失败：${esc(e.message)}</div>`;
    }
  })().finally(() => { workspaceLoad = null; });
}

const sidebarMenuOpen = () => $("#ws :is([data-session-menu], [data-pmenu])[aria-expanded=true]");

function drawWorkspace() {
  if (sidebarMenuOpen()) view.closeMenu?.();
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

export function markActive() {
  const here = location.hash;
  $$("#ws .ws-item").forEach((a) => {
    const it = ws.tips.get(a.parentElement.dataset.tip);
    a.classList.toggle("active", Boolean(it && (here === it.href || (it.alt && here === it.alt))));
  });
}

// 归档 (or back, `archived` false): out of the workspace, kept whole, never cleaned up by age. A conversation the
// console runs is put away first; one running in a terminal is only marked (it stays listed while it runs, and the
// page does not end a terminal's session).
export async function archive(ids, archived = true, { force = false } = {}) {
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
export async function putAway(sessionId, { force = false, peer } = {}) {
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

export function wireSidebar() {
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
    if (sidebarMenuOpen()) view.closeMenu?.();
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
