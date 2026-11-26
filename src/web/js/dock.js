// The panel beside a conversation: the folder it works in (its 工作区) as in VS Code, the file tree, the editor with a
// tab for each file open, and the terminals below it (dock-workbench.js). One workbench per workspace, kept while the
// page is open (an editor with unsaved changes stays as it is while the page shows another conversation) and
// remembered for the next visit (localStorage cpDock:<workspace>). Terminals belong to their workspace on the
// console's side (pty.js): those opened there from another browser are listed too.
//
// The views say which workspace the page is in (setDockWorkspace); a page that is in none (settings and the like)
// hides the panel and keeps it. The header holds the folder's path, what shows and hides the tree and the terminals,
// and the panel's close button.

import { api, $, $$ } from "./util.js";
import { workbench } from "./dock-workbench.js";
import { workspaceKey } from "./dock-util.js";

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
  space: null, // the workspace shown: {key, cwd, wb}
  spaces: new Map(),
  terminals: null, // GET /api/terminals: {terminals, shells, windowsPty}
};

const TREE_ICON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/></svg>';
const PANEL_ICON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 14h18M7 17.2l1.6-1.2L7 14.8"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
export const DOCK_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M14.5 4v16"/></svg>';
// the button of a view's header that shows and hides the panel
export const dockButton = () => `<button type="button" class="icon-btn dock-toggle" data-dock-toggle title="文件与终端（Ctrl+P 文件，Ctrl+\` 终端）" aria-label="文件与终端" aria-pressed="${state.open && Boolean(state.space)}">${DOCK_ICON}</button>`;

root.innerHTML = `<div class="dock-resize" title="拖动调整宽度"></div>
  <div class="dock-head"><span class="dock-title"></span><button type="button" class="icon-btn" data-h="tree" title="显示 / 隐藏文件列表" aria-label="文件列表">${TREE_ICON}</button><button type="button" class="icon-btn" data-h="panel" title="显示 / 隐藏终端（Ctrl+\`）" aria-label="终端">${PANEL_ICON}</button><button type="button" class="icon-btn" data-h="close" title="收起面板" aria-label="收起面板">${CLOSE}</button></div>
  <div class="dock-body"></div>`;
const body = $(".dock-body", root);

// ---------------------------------------------------------------- layout

function applyWidth() {
  const side = app.classList.contains("side-collapsed") ? 0 : 284;
  const max = Math.max(320, innerWidth - side - 380);
  // (at first: half the window, leaving the conversation 440 px where it can)
  const w = Math.round(Math.min(max, Math.max(320, state.width || Math.min(innerWidth * 0.5, innerWidth - side - 440))));
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

// the header: the folder, and the tree and the terminals as they are in its workbench
function paintHead() {
  const s = state.space;
  const title = $(".dock-title", root);
  title.textContent = s?.cwd || "";
  title.title = s?.cwd || "";
  const st = s?.wb?.state() || {};
  const tree = $("[data-h=tree]", root), panel = $("[data-h=panel]", root);
  tree.setAttribute("aria-pressed", String(Boolean(st.tree)));
  tree.disabled = !st.treeToggle;
  panel.setAttribute("aria-pressed", String(Boolean(st.panel)));
}
$(".dock-head", root).addEventListener("click", (e) => {
  const h = e.target.closest("[data-h]")?.dataset.h;
  const wb = state.space?.wb;
  if (h === "close") toggleDock(false);
  else if (h === "tree") wb?.toggleTree();
  else if (h === "panel") wb?.togglePanel();
});
document.addEventListener("click", (e) => { if (e.target.closest("[data-dock-toggle]")) toggleDock(); });

// ---------------------------------------------------------------- workspaces

async function terminalsInfo(fresh = false) {
  if (!state.terminals || fresh) {
    try { state.terminals = await api("/api/terminals"); } catch (e) { if (!state.terminals) throw e; }
  }
  return state.terminals;
}

// What was open the last time. (Before 2026-11-26 each file and terminal was a tab of the panel: {tabs, active}.)
function savedOf(key) {
  let saved = null;
  try { saved = JSON.parse(store.get(`cpDock:${key}`) || "null"); } catch { /* none */ }
  if (!saved || typeof saved !== "object") return {};
  if (!Array.isArray(saved.tabs)) return saved;
  const tabs = saved.tabs.filter((t) => t && typeof t === "object");
  const open = [...tabs.filter((t) => t.k === "file" && typeof t.p === "string").map((t) => t.p), ...tabs.flatMap((t) => (t.k === "files" && Array.isArray(t.open) ? t.open : []))];
  const terms = tabs.filter((t) => t.k === "term" && typeof t.id === "string").map((t) => t.id);
  return { open, terms, panel: tabs[saved.active]?.k === "term" };
}

function spaceFor(cwd) {
  const key = workspaceKey(cwd);
  let s = state.spaces.get(key);
  if (s) return s;
  s = { key, cwd, wb: null };
  state.spaces.set(key, s);
  s.wb = workbench({
    cwd, key,
    save: () => { if (s.wb) store.set(`cpDock:${key}`, JSON.stringify(s.wb.persist())); },
    changed: () => { if (state.space === s && s.wb) paintHead(); },
    terminalsInfo,
    windowsPty: () => state.terminals?.windowsPty || null,
  }, savedOf(key));
  s.wb.el.hidden = true;
  body.appendChild(s.wb.el);
  return s;
}

// ---------------------------------------------------------------- what the views and keys call

export const dockWorkspace = () => state.space?.cwd || null;

// The workspace of the page shown (null: none; the panel is hidden and kept).
export function setDockWorkspace(cwd) {
  const key = cwd ? workspaceKey(cwd) : null;
  if (key && key === state.space?.key) return;
  if (state.space) { state.space.wb.el.hidden = true; state.space.wb.setShown(false); }
  state.space = cwd ? spaceFor(cwd) : null;
  layout();
  if (state.space) { state.space.wb.el.hidden = false; state.space.wb.setShown(state.open); }
  paintHead();
}

export function toggleDock(open = !(state.open && state.space)) {
  if (open && !state.space) return;
  state.open = open;
  if (!mobile.matches) store.set("cpDockOpen", open ? "1" : null);
  layout();
  const wb = state.space?.wb;
  if (!wb) return;
  wb.setShown(open);
  if (open) wb.focus();
}

function ready() {
  const s = state.space;
  if (!s) return null;
  if (!state.open) toggleDock(true);
  return s;
}

export function openFilesTab({ focusSearch = true } = {}) {
  const s = ready();
  if (!s) return;
  if (focusSearch) s.wb.focusSearch(); else s.wb.focusTree();
}

export function openFile(path) {
  ready()?.wb.openFile(path);
}

export async function openTerminal({ shell, cwd, focusExisting = false } = {}) {
  const s = ready();
  if (!s) return;
  if (focusExisting) { await s.wb.ready; s.wb.togglePanel(true); } else s.wb.newTerminal({ shell, cwd });
}

// Ctrl+P: the files (finding by name); Ctrl+`: the terminals shown (a new one when there is none) or hidden again,
// as in VS Code; Ctrl+Shift+`: a new terminal. Taken before the editor and the terminal see them.
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || !state.space || $(".modal-back")) return;
  if (e.code === "Backquote" || e.key === "`") {
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) { openTerminal({}); return; }
    if (!state.open) { openTerminal({ focusExisting: true }); return; }
    state.space.wb.terminalKey();
  } else if (!e.shiftKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    e.stopPropagation();
    openFilesTab({ focusSearch: true });
  }
}, true);

addEventListener("beforeunload", (e) => {
  for (const s of state.spaces.values()) {
    if (s.wb?.dirty) { e.preventDefault(); e.returnValue = ""; return; }
  }
});
mobile.addEventListener("change", () => { if (mobile.matches && state.open) toggleDock(false); });

layout();
