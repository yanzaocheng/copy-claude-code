// The panel beside a conversation: the files of the folder it works in (its 工作区), files open in an editor, and
// terminals there, as tabs; + opens a page of what can be opened (工作区文件 Ctrl+P, 新建终端 Ctrl+`). One set of
// tabs per workspace, kept while the page is open (an editor with unsaved changes stays as it is while the page shows
// another conversation) and remembered for the next visit (localStorage cpDock:<workspace>). Terminals belong to
// their workspace on the console's side (pty.js): those opened there from another browser are listed too.
//
// The views say which workspace the page is in (setDockWorkspace); a page that is in none (settings and the like)
// hides the panel and keeps it.

import { esc, api, fail, shortPath, ICON, $, $$ } from "./util.js";
import { popMenu } from "./composer.js";
import { filesPane, fileIcon, menuAt, relativeTo, copyText } from "./dock-files.js";
import { editorPane } from "./dock-editor.js";
import { terminalPane } from "./dock-terminal.js";

const keyOf = (cwd) => shortPath(cwd || "").toLowerCase().replace(/\/+$/, "");
const mobile = matchMedia("(max-width: 860px)");
const app = $(".app");
const root = $("#dock");
const store = {
  get: (k, d = null) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* full, private mode */ } },
};
const state = {
  open: store.get("cpDockOpen") === "1" && !mobile.matches,
  width: Number(store.get("cpDockWidth")) || 0,
  space: null, // the workspace shown
  spaces: new Map(), // key -> {key, cwd, tabs, active, ready}
  terminals: null, // GET /api/terminals: {shells, windowsPty} (asked once)
};
let tabSeq = 0;

const FOLDER_TAB = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#f0b43c"/><path d="M3 10h18" stroke="#fff" stroke-opacity=".55" stroke-width="1.4"/></svg>';
const TERM_TAB = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 7 5 5-5 5M12 17h7"/></svg>';
const PLUS_TAB = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
const FOLDER_CARD = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#f0b43c"/><path d="M5.5 9.5h13a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5V11a1.5 1.5 0 0 1 1.5-1.5z" fill="#f7cc6a"/></svg>';
const TERM_CARD = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#5b7fe0" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 7 5 5-5 5M13 18h6"/></svg>';
export const DOCK_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M14.5 4v16"/></svg>';
// the button of a view's header that shows and hides the panel
export const dockButton = () => `<button type="button" class="icon-btn dock-toggle" data-dock-toggle title="文件与终端（Ctrl+P 文件，Ctrl+\` 终端）" aria-label="文件与终端" aria-pressed="${state.open && Boolean(state.space)}">${DOCK_ICON}</button>`;

root.innerHTML = `<div class="dock-resize" title="拖动调整宽度"></div>
  <div class="dock-bar"><div class="dock-tabs" role="tablist"></div><button type="button" class="icon-btn dock-add" title="新建标签页" aria-label="新建标签页">${PLUS_TAB}</button><span class="dock-gap"></span><button type="button" class="icon-btn dock-hide" title="收起面板" aria-label="收起面板">${CLOSE}</button></div>
  <div class="dock-body"></div>`;
const tabsEl = $(".dock-tabs", root);
const body = $(".dock-body", root);

// ---------------------------------------------------------------- layout

function applyWidth() {
  const side = app.classList.contains("side-collapsed") ? 0 : 284;
  const max = Math.max(320, innerWidth - side - 380);
  // (at first: 45% of the window, leaving the conversation 480 px where it can)
  const w = Math.round(Math.min(max, Math.max(320, state.width || Math.min(innerWidth * 0.45, innerWidth - side - 480))));
  app.style.setProperty("--dock-w", `${w}px`);
}
function layout() {
  const shown = Boolean(state.open && state.space);
  app.classList.toggle("dock-open", shown);
  for (const b of $$("[data-dock-toggle]")) { b.setAttribute("aria-pressed", String(shown)); b.disabled = !state.space; }
  applyWidth();
}
addEventListener("resize", applyWidth);
new MutationObserver(applyWidth).observe(app, { attributes: true, attributeFilter: ["class"] });

{
  const handle = $(".dock-resize", root);
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("dock-dragging");
    const move = (ev) => { state.width = innerWidth - ev.clientX; applyWidth(); };
    const up = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("dock-dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      store.set("cpDockWidth", String(Math.round(parseFloat(app.style.getPropertyValue("--dock-w")) || state.width)));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("dblclick", () => { state.width = 0; store.set("cpDockWidth", null); applyWidth(); });
}

// ---------------------------------------------------------------- workspaces and their tabs

async function terminalsInfo(fresh = false) {
  if (!state.terminals || fresh) {
    try { state.terminals = await api("/api/terminals"); } catch (e) { if (!state.terminals) throw e; }
  }
  return state.terminals;
}

function save(s) {
  const tabs = s.tabs.map((t) => t.pane.persist());
  store.set(`cpDock:${s.key}`, JSON.stringify({ tabs, active: Math.max(0, s.tabs.indexOf(s.active)) }));
}

function spaceFor(cwd) {
  const key = keyOf(cwd);
  let s = state.spaces.get(key);
  if (s) return s;
  s = { key, cwd, tabs: [], active: null, ready: null };
  state.spaces.set(key, s);
  s.ready = restore(s);
  return s;
}

// The tabs of the last visit; the terminals the host still has for this workspace (closed ones are left out).
async function restore(s) {
  let saved = null;
  try { saved = JSON.parse(store.get(`cpDock:${s.key}`) || "null"); } catch { /* none */ }
  let terms = [];
  try { terms = (await terminalsInfo(true)).terminals.filter((t) => keyOf(t.workspace) === s.key); } catch { /* none to restore */ }
  const byId = new Map(terms.map((t) => [t.id, t]));
  for (const t of Array.isArray(saved?.tabs) ? saved.tabs : []) {
    if (t?.k === "files") addTab(s, "files", {}, { activate: false });
    else if (t?.k === "file" && typeof t.p === "string") addTab(s, "file", { path: t.p }, { activate: false });
    else if (t?.k === "launcher") addTab(s, "launcher", {}, { activate: false });
    else if (t?.k === "term" && byId.has(t.id)) { addTab(s, "term", { info: byId.get(t.id) }, { activate: false }); byId.delete(t.id); }
  }
  for (const t of byId.values()) addTab(s, "term", { info: t }, { activate: false });
  if (!s.tabs.length) addTab(s, "launcher", {}, { activate: false });
  const want = s.tabs[Math.min(s.tabs.length - 1, Math.max(0, Number(saved?.active) || 0))];
  if (state.space === s) activate(s, want); else s.active = want;
  save(s);
}

function addTab(s, kind, opts = {}, { activate: show = true, at = s.tabs.length } = {}) {
  const tab = { id: `dt${++tabSeq}`, kind, space: s, title: "", tip: "", dirty: false, pane: null };
  const ctx = {
    cwd: s.cwd, key: s.key,
    windowsPty: state.terminals?.windowsPty || opts.info?.windowsPty || null,
    setTitle: (title, tip = "") => { tab.title = title; tab.tip = tip; if (state.space === s) renderTabs(); },
    setDirty: (d) => { tab.dirty = d; if (state.space === s) renderTabs(); },
    closeTab: ({ force = false } = {}) => closeTab(tab, { force }),
    openFile: (p) => openFile(p),
    openTerminal: (o) => openTerminal(o),
    renamed: (from, to) => renamed(s, from, to),
    onExit: () => { if (state.space === s) renderTabs(); },
  };
  if (kind === "launcher") tab.pane = launcherPane(s);
  else if (kind === "files") tab.pane = filesPane(ctx);
  else if (kind === "file") tab.pane = editorPane(ctx, opts.path);
  else if (kind === "term") tab.pane = terminalPane(ctx, opts.info);
  tab.title ||= tab.pane.title || "";
  tab.pane.el.hidden = true;
  tab.pane.el.dataset.tab = tab.id;
  body.appendChild(tab.pane.el);
  s.tabs.splice(at, 0, tab);
  if (show) activate(s, tab); else if (state.space === s) renderTabs();
  save(s);
  return tab;
}

function activate(s, tab) {
  if (s.active && s.active !== tab) { s.active.pane.el.hidden = true; s.active.pane.deactivate?.(); }
  s.active = tab;
  if (state.space === s && tab) {
    tab.pane.el.hidden = false;
    if (state.open) tab.pane.activate?.();
  }
  renderTabs();
  save(s);
}

// (`kill`: a terminal's shell is ended too; not when the host closed it already)
function removeTab(tab, { kill = true } = {}) {
  const s = tab.space;
  const i = s.tabs.indexOf(tab);
  if (i < 0) return -1;
  s.tabs.splice(i, 1);
  tab.pane.deactivate?.();
  tab.pane.dispose?.({ kill });
  tab.pane.el.remove();
  if (s.active === tab) s.active = null;
  return i;
}

async function closeTab(tab, { force = false } = {}) {
  const s = tab.space;
  if (!force && tab.pane.canClose && !(await tab.pane.canClose())) return;
  const i = removeTab(tab, { kill: !force });
  if (i < 0) return;
  if (!s.active) {
    const next = s.tabs[Math.min(i, s.tabs.length - 1)];
    if (next) activate(s, next); else addTab(s, "launcher");
  }
  renderTabs();
  save(s);
}

// a tab opened from the + page takes its place
function placeFor(s) {
  const a = s.active;
  if (a?.kind !== "launcher") return s.tabs.length;
  return removeTab(a);
}

function renderTabs() {
  const s = state.space;
  if (!s) { tabsEl.innerHTML = ""; return; }
  const counts = new Map();
  tabsEl.innerHTML = s.tabs.map((t) => {
    let label = t.title || (t.kind === "launcher" ? "新标签页" : "…");
    if (t.kind === "term") {
      const n = (counts.get(label) || 0) + 1;
      counts.set(label, n);
      if (n > 1) label = `${label} ${n}`;
    }
    const icon = t.kind === "files" ? FOLDER_TAB : t.kind === "term" ? TERM_TAB : t.kind === "file" ? fileIcon(t.title) : PLUS_TAB;
    const ended = t.kind === "term" && t.pane.exited;
    return `<div class="dock-tab${t === s.active ? " active" : ""}${t.dirty ? " dirty" : ""}${ended ? " ended" : ""}" role="tab" aria-selected="${t === s.active}" data-tab="${t.id}" title="${esc(t.tip || label)}"><span class="dock-tab-icon">${icon}</span><span class="dock-tab-label">${esc(label)}</span><button type="button" class="dock-tab-x" data-close title="关闭" aria-label="关闭">${CLOSE}</button></div>`;
  }).join("");
  tabsEl.querySelector(".dock-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

const tabById = (id) => state.space?.tabs.find((t) => t.id === id);
tabsEl.addEventListener("click", (e) => {
  const el = e.target.closest("[data-tab]");
  const tab = el && tabById(el.dataset.tab);
  if (!tab) return;
  if (e.target.closest("[data-close]")) closeTab(tab);
  else { activate(tab.space, tab); tab.pane.focus?.(); }
});
tabsEl.addEventListener("auxclick", (e) => {
  const el = e.target.closest("[data-tab]");
  const tab = el && tabById(el.dataset.tab);
  if (tab && e.button === 1) { e.preventDefault(); closeTab(tab); }
});
tabsEl.addEventListener("contextmenu", (e) => {
  const el = e.target.closest("[data-tab]");
  const tab = el && tabById(el.dataset.tab);
  if (!tab) return;
  e.preventDefault();
  const items = [{ label: "关闭", value: "close" }, { label: "关闭其他", value: "others" }];
  if (tab.kind === "file") items.push({ label: "复制路径", value: "copy" }, { label: "复制相对路径", value: "copyrel" });
  menuAt(e.clientX, e.clientY, items, async (v) => {
    if (v === "close") closeTab(tab);
    else if (v === "others") { for (const t of [...tab.space.tabs]) if (t !== tab) await closeTab(t); }
    else if (v === "copy") copyText(tab.pane.path);
    else if (v === "copyrel") copyText(relativeTo(tab.space.cwd, tab.pane.path), "相对路径");
  });
});
$(".dock-add", root).addEventListener("click", () => {
  const s = state.space;
  if (!s) return;
  const open = s.tabs.find((t) => t.kind === "launcher");
  if (open) activate(s, open); else addTab(s, "launcher");
});
$(".dock-hide", root).addEventListener("click", () => toggleDock(false));
document.addEventListener("click", (e) => { if (e.target.closest("[data-dock-toggle]")) toggleDock(); });

function renamed(s, from, to) {
  const f = from.toLowerCase();
  for (const t of s.tabs) {
    if (t.kind !== "file") continue;
    const p = t.pane.path;
    if (p.toLowerCase() === f) t.pane.setPath(to);
    else if (p.toLowerCase().startsWith(f) && /[\\/]/.test(p[from.length])) t.pane.setPath(to + p.slice(from.length));
  }
  save(s);
}

// ---------------------------------------------------------------- the + page

function launcherPane(s) {
  const el = document.createElement("div");
  el.className = "dock-pane dock-launch";
  const paint = (shell) => {
    el.innerHTML = `<div class="launch-path" title="${esc(s.cwd)}">${esc(s.cwd)}</div>
      <button type="button" class="launch-card" data-l="files"><span class="launch-icon">${FOLDER_CARD}</span><span class="launch-text"><strong>工作区文件</strong><small>浏览会话工作区的文件</small></span><span class="launch-key">Ctrl + P</span></button>
      <div class="launch-card" role="button" tabindex="0" data-l="term"><span class="launch-icon">${TERM_CARD}</span><span class="launch-text"><strong>新建终端<button type="button" class="launch-more" data-l="shells" title="选择 shell" aria-label="选择 shell">${ICON.caret}</button></strong><small>在会话工作区运行命令${shell ? ` · ${esc(shell)}` : ""}</small></span><span class="launch-key">Ctrl + \`</span></div>`;
  };
  paint("");
  terminalsInfo().then((t) => { const sh = t.shells.find((x) => x.id === store.get("cpDockShell")) || t.shells[0]; if (sh) paint(sh.label); }).catch(() => {});
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-l]");
    if (!b) return;
    if (b.dataset.l === "files") openFilesTab({ focusSearch: false });
    else if (b.dataset.l === "shells") { e.stopPropagation(); shellMenu(b); }
    else if (b.dataset.l === "term") openTerminal({});
  });
  el.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.dataset.l === "term") { e.preventDefault(); openTerminal({}); } });
  return { el, title: "新标签页", persist: () => ({ k: "launcher" }) };
}

async function shellMenu(anchor) {
  let t;
  try { t = await terminalsInfo(); } catch (e) { return fail(e); }
  const last = store.get("cpDockShell") || t.shells[0]?.id;
  popMenu(anchor, [{ key: "shell", title: "新建终端", items: t.shells.map((x) => ({ label: x.label, value: x.id, current: x.id === last })) }], (k, v) => openTerminal({ shell: v }), { dropdown: true });
}

// ---------------------------------------------------------------- what the views and keys call

export const dockWorkspace = () => state.space?.cwd || null;

// The workspace of the page shown (null: none; the panel is hidden and kept).
export function setDockWorkspace(cwd) {
  const key = cwd ? keyOf(cwd) : null;
  if (key && key === state.space?.key) return;
  const before = state.space;
  if (before?.active) { before.active.pane.el.hidden = true; before.active.pane.deactivate?.(); }
  state.space = cwd ? spaceFor(cwd) : null;
  layout();
  if (state.space?.active) activate(state.space, state.space.active);
  else renderTabs();
}

export function toggleDock(open = !(state.open && state.space)) {
  if (open && !state.space) return;
  state.open = open;
  if (!mobile.matches) store.set("cpDockOpen", open ? "1" : null);
  const a = state.space?.active;
  layout();
  if (!a) return;
  if (open) { a.pane.activate?.(); a.pane.focus?.(); } else a.pane.deactivate?.();
}

async function ready() {
  const s = state.space;
  if (!s) return null;
  if (!state.open) toggleDock(true);
  await s.ready;
  return s;
}

export async function openFilesTab({ focusSearch = true } = {}) {
  const s = await ready();
  if (!s) return;
  let tab = s.tabs.find((t) => t.kind === "files");
  if (tab) activate(s, tab); else tab = addTab(s, "files", {}, { at: placeFor(s) });
  if (focusSearch) tab.pane.focusSearch(); else tab.pane.focus?.();
}

export async function openFile(path) {
  const s = await ready();
  if (!s) return;
  const p = path.toLowerCase();
  const tab = s.tabs.find((t) => t.kind === "file" && t.pane.path.toLowerCase() === p);
  if (tab) { activate(s, tab); tab.pane.focus?.(); return; }
  addTab(s, "file", { path }, { at: placeFor(s) });
}

let creating = false;
export async function openTerminal({ shell, cwd, focusExisting = false } = {}) {
  const s = await ready();
  if (!s) return;
  if (focusExisting) {
    const t = (s.active?.kind === "term" ? s.active : null) || s.tabs.find((x) => x.kind === "term" && !x.pane.exited);
    if (t) { activate(s, t); t.pane.focus?.(); return; }
  }
  if (creating) return;
  creating = true;
  try {
    const info = await terminalsInfo();
    const id = shell || store.get("cpDockShell") || info.shells[0]?.id;
    if (shell) store.set("cpDockShell", shell);
    // a first size from the panel's (the terminal fits itself once drawn)
    const cols = Math.max(20, Math.floor((body.clientWidth - 24) / 7.8)), rows = Math.max(5, Math.floor((body.clientHeight - 16) / 15.5));
    const t = await api("/api/terminals", { method: "POST", body: { cwd: cwd || s.cwd, workspace: s.cwd, shell: id, cols, rows } });
    addTab(s, "term", { info: t }, { at: placeFor(s) });
  } catch (e) { fail(e); } finally { creating = false; }
}

// Ctrl+P: the files (finding by name); Ctrl+`: a terminal (the one there, or a new one); Ctrl+Shift+`: a new one.
// Taken before the editor and the terminal see them.
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || !state.space || $(".modal-back")) return;
  if (e.code === "Backquote" || e.key === "`") {
    e.preventDefault();
    e.stopPropagation();
    openTerminal({ focusExisting: !e.shiftKey });
  } else if (!e.shiftKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    e.stopPropagation();
    openFilesTab({ focusSearch: true });
  }
}, true);

addEventListener("beforeunload", (e) => {
  for (const s of state.spaces.values()) {
    if (s.tabs.some((t) => t.dirty)) { e.preventDefault(); e.returnValue = ""; return; }
  }
});
mobile.addEventListener("change", () => { if (mobile.matches && state.open) toggleDock(false); });

layout();
