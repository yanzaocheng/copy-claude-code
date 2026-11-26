// A workspace in the panel (dock.js), laid out as VS Code: the file tree on the left (dock-files.js); on the right the
// files open in the editor (dock-editor.js) under a row of their own tabs, and below them the terminals
// (dock-terminal.js), a panel with its own tabs that Ctrl+` shows and hides. With no file open and the terminals
// hidden the tree takes the whole width; with no file open the terminals take the right side. Where it is narrow (a
// phone, a narrow panel) the tree shows over the rest and goes away once a file is picked.
//
// What is open (files, terminals, the tree and the terminals shown or not) is said by persist() and kept by dock.js.

import { esc, api, fail, $ } from "./util.js";
import { popMenu } from "./composer.js";
import { explorer } from "./dock-files.js";
import { editorPane, diffPane } from "./dock-editor.js";
import { gitPanel } from "./dock-git.js";
import { terminalPane } from "./dock-terminal.js";
import { fileIcon, CLOSE_ICON, baseOf, samePath, within, relativeTo, copyText, menuAt, workspaceKey } from "./dock-util.js";

const NARROW = 560; // px: narrower, the tree shows over the rest
const TERM_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 7 5 5-5 5M12 17h7"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const CARET = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const HIDE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* full */ } },
};

// A pane (tree, editor, terminal) told once that it is shown, and once that it no longer is.
function setOn(pane, on) {
  if (!pane || Boolean(pane.on) === on) return;
  pane.on = on;
  if (on) pane.activate?.(); else pane.deactivate?.();
}

// The drag of a divider: `apply(clientX, clientY)` while it moves, `done()` at the end.
function dragger(handle, apply, done) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("dock-dragging");
    document.body.style.cursor = getComputedStyle(handle).cursor;
    const move = (ev) => apply(ev.clientX, ev.clientY);
    const up = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("dock-dragging");
      document.body.style.cursor = "";
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      done();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

// ctx: {cwd, key, save(), changed(), terminalsInfo(fresh)}; saved: persist() of the last visit
export function workbench(ctx, saved = {}) {
  const el = document.createElement("div");
  el.className = "wb";
  el.innerHTML = `<div class="wb-split" title="拖动调整宽度"></div>
    <div class="wb-main">
      <div class="wb-editors"><div class="wb-bar"><div class="wb-tabs" role="tablist"></div></div><div class="wb-body"></div></div>
      <div class="wb-hsplit" title="拖动调整高度"></div>
      <div class="wb-panel"><div class="wb-pbar"><div class="wb-ptabs" role="tablist"></div><button type="button" class="icon-btn" data-p="new" title="新建终端">${PLUS}</button><button type="button" class="icon-btn wb-shells" data-p="shells" title="选择 shell 新建终端">${CARET}</button><span class="wb-gap"></span><button type="button" class="icon-btn" data-p="hide" title="隐藏终端（Ctrl+\`）">${HIDE}</button></div><div class="wb-pbody"></div></div>
    </div>`;
  // the editor's tabs: files {id, path, title, pane (made when first shown), dirty}, and changes opened from 源代码管理
  // (`diff`: {rel, staged}; not kept for the next visit)
  const files = [];
  let fileSeq = 0;
  const terms = []; // {id, title, pane}
  let active = null, activeTerm = null, shown = false, creating = false;
  // the tree: beside the rest unless hidden (`hideTree`, kept); where it is narrow, over the rest only while asked
  // for (`treeOver`: the tree button, Ctrl+P), until a file is picked or the rest touched
  let hideTree = Boolean(saved.hide), treeOver = false, panelOpen = Boolean(saved.panel);
  const ex = explorer({ cwd: ctx.cwd, key: ctx.key, openFile: (p, o) => openFile(p, o), openTerminal: (o) => newTerminal(o), renamed, deleted });
  const gp = gitPanel({
    cwd: ctx.cwd,
    openDiff: ({ rel, staged }) => openDiff(rel, staged),
    openFile: (p) => openFile(p),
    reveal: (p) => { showTree(); update(); ex.reveal(p); },
  });
  // the left column: the tree, and 源代码管理 under it (its height dragged, kept for every workspace)
  const side = document.createElement("div");
  side.className = "wb-side";
  const gsplit = document.createElement("div");
  gsplit.className = "wb-gsplit";
  gsplit.title = "拖动调整高度";
  side.append(ex.el, gsplit, gp.el);
  el.prepend(side);
  const gitH = Number(store.get("cpDockGitHeight")) || 0;
  if (gitH) el.style.setProperty("--wb-git", `${gitH}px`);
  const main = $(".wb-main", el), tabsEl = $(".wb-tabs", el), body = $(".wb-body", el);
  const ptabs = $(".wb-ptabs", el), pbody = $(".wb-pbody", el);
  const narrow = () => el.clientWidth > 0 && el.clientWidth < NARROW;
  const treeW = Number(store.get("cpDockTreeWidth")) || 0;
  if (treeW) el.style.setProperty("--wb-tree", `${treeW}px`);
  const panelH = Number(store.get("cpDockPanelHeight")) || 0;
  if (panelH) el.style.setProperty("--wb-panel", `${panelH}px`);
  const fileOf = (p) => files.find((f) => !f.diff && samePath(f.path, p));
  const anyDirty = () => files.some((f) => f.dirty);
  const hasFiles = () => files.length > 0;
  const hasPanel = () => panelOpen && terms.length > 0;
  const treeShown = () => !(hasFiles() || hasPanel()) || (narrow() ? treeOver : !hideTree);
  // the tree asked for: beside, or over the rest where narrow
  const showTree = () => { if (narrow()) treeOver = true; else if (hideTree) { hideTree = false; ctx.save(); } };

  // what is shown follows the state: the classes, and which panes are told they are on
  function update() {
    el.classList.toggle("has-files", hasFiles());
    el.classList.toggle("has-panel", hasPanel());
    el.classList.toggle("tree-hidden", !treeShown());
    setOn(ex, shown && treeShown());
    setOn(gp, shown && treeShown());
    for (const f of files) setOn(f.pane, shown && f === active);
    for (const t of terms) setOn(t.pane, shown && hasPanel() && t === activeTerm);
    ctx.changed();
  }

  // ---- the editors
  function drawTabs() {
    tabsEl.innerHTML = files.map((f) => `<div class="wb-tab${f === active ? " active" : ""}${f.dirty ? " dirty" : ""}${f.diff ? " diff" : ""}" role="tab" aria-selected="${f === active}" data-f="${f.id}" title="${esc(f.diff ? `${f.diff.rel}（${f.diff.staged ? "已暂存的更改" : "工作区里的更改"}）` : f.path)}">${fileIcon(f.diff ? baseOf(f.diff.rel) : f.title)}<span class="wb-tab-label">${esc(f.title)}</span><button type="button" class="wb-tab-x" data-close title="关闭" aria-label="关闭">${CLOSE_ICON}</button></div>`).join("");
    tabsEl.querySelector(".wb-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function paneOf(f) {
    if (!f.pane) {
      f.pane = f.diff
        ? diffPane({ cwd: ctx.cwd, setTitle: (title) => { f.title = title; drawTabs(); }, openFile: (p) => openFile(p) }, { cwd: ctx.cwd, ...f.diff })
        : editorPane({
          cwd: ctx.cwd,
          setDirty: (d) => { f.dirty = d; drawTabs(); ctx.changed(); },
          setTitle: (title) => { f.title = title; drawTabs(); },
        }, f.path);
      f.pane.el.hidden = true;
      body.appendChild(f.pane.el);
    }
    return f.pane;
  }
  function show(f, { focus = true } = {}) {
    if (active && active !== f && active.pane) active.pane.el.hidden = true;
    active = f;
    paneOf(f).el.hidden = false;
    update();
    if (focus) f.pane.focus();
    if (!f.diff) ex.select(f.path);
    drawTabs();
    ctx.save();
  }
  function openFile(p, { focus = true } = {}) {
    let f = fileOf(p);
    if (!f) {
      f = { id: `f${++fileSeq}`, path: p, title: baseOf(p), pane: null, dirty: false };
      files.splice(active ? files.indexOf(active) + 1 : files.length, 0, f);
    }
    treeOver = false; // (where narrow, the tree was over the editor)
    show(f, { focus });
  }
  // a change from 源代码管理: its own tab (one per file and side), read again each time it is shown
  function openDiff(rel, staged) {
    let f = files.find((x) => x.diff && x.diff.rel === rel && x.diff.staged === staged);
    if (!f) {
      f = { id: `f${++fileSeq}`, path: rel, title: baseOf(rel), pane: null, dirty: false, diff: { rel, staged } };
      files.splice(active ? files.indexOf(active) + 1 : files.length, 0, f);
    }
    treeOver = false;
    show(f, { focus: false });
  }
  async function closeFile(f, { ask = true } = {}) {
    if (ask && f.pane?.canClose && !(await f.pane.canClose())) return false;
    const i = files.indexOf(f);
    if (i < 0) return true;
    files.splice(i, 1);
    setOn(f.pane, false);
    f.pane?.dispose?.();
    f.pane?.el.remove();
    if (active === f) {
      active = null;
      const next = files[Math.min(i, files.length - 1)];
      if (next) show(next, { focus: false });
    }
    if (!files.length) ex.select(null);
    update();
    drawTabs();
    ctx.save();
    return true;
  }
  // deleted in the tree: its tabs (or those under the folder) closed, but not one with unsaved changes (its editor says
  // the file is gone; saving makes it again)
  function deleted(p) {
    for (const f of [...files]) if (within(f.path, p) && !f.dirty) closeFile(f, { ask: false });
  }
  // renamed in the tree: the files open there (or under the folder) follow
  function renamed(from, to) {
    for (const f of files) {
      if (f.diff) continue;
      if (samePath(f.path, from)) f.path = to;
      else if (samePath(f.path.slice(0, from.length), from) && /[\\/]/.test(f.path[from.length])) f.path = to + f.path.slice(from.length);
      else continue;
      f.title = baseOf(f.path);
      f.pane?.setPath(f.path);
    }
    drawTabs();
    ctx.save();
  }
  const fileAt = (target) => { const t = target.closest("[data-f]"); return t && files.find((f) => f.id === t.dataset.f); };
  tabsEl.addEventListener("click", (e) => {
    const f = fileAt(e.target);
    if (!f) return;
    if (e.target.closest("[data-close]")) { closeFile(f); return; }
    treeOver = false;
    show(f);
  });
  tabsEl.addEventListener("auxclick", (e) => {
    const f = fileAt(e.target);
    if (f && e.button === 1) { e.preventDefault(); closeFile(f); }
  });
  tabsEl.addEventListener("contextmenu", (e) => {
    const f = fileAt(e.target);
    if (!f) return;
    e.preventDefault();
    menuAt(e.clientX, e.clientY, [
      { label: "关闭", value: "close" }, { label: "关闭其他", value: "others" }, { label: "全部关闭", value: "all" },
      { label: "在文件列表中显示", value: "reveal" }, { label: "复制路径", value: "copy" }, { label: "复制相对路径", value: "copyrel" },
    ], async (v) => {
      // (a change's tab: the file it is of, once it was read)
      const p = f.diff ? f.pane?.path || f.diff.rel : f.path;
      if (v === "close") closeFile(f);
      else if (v === "others" || v === "all") { for (const x of [...files]) if (v === "all" || x !== f) { if (!(await closeFile(x))) break; } }
      else if (v === "reveal") { showTree(); update(); ex.reveal(p); }
      else if (v === "copy") copyText(p);
      else if (v === "copyrel") copyText(relativeTo(ctx.cwd, p), "相对路径");
    });
  });

  // ---- the terminals
  function drawTerms() {
    const counts = new Map();
    ptabs.innerHTML = terms.map((t) => {
      const n = (counts.get(t.title) || 0) + 1;
      counts.set(t.title, n);
      const label = n > 1 ? `${t.title} ${n}` : t.title;
      return `<div class="wb-tab${t === activeTerm ? " active" : ""}${t.pane.exited ? " ended" : ""}" role="tab" aria-selected="${t === activeTerm}" data-t="${t.id}" title="${esc(t.tip || label)}">${TERM_ICON}<span class="wb-tab-label">${esc(label)}</span><button type="button" class="wb-tab-x" data-close title="关闭" aria-label="关闭">${CLOSE_ICON}</button></div>`;
    }).join("");
    ptabs.querySelector(".wb-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function addTerm(info) {
    const t = { id: info.id, title: info.label, tip: "", pane: null };
    t.pane = terminalPane({
      cwd: ctx.cwd,
      windowsPty: ctx.windowsPty() || info.windowsPty || null,
      setTitle: (title, tip) => { t.title = title; t.tip = tip; drawTerms(); },
      closeTab: ({ force = false } = {}) => closeTerm(t, { force }),
      onExit: () => drawTerms(),
    }, info);
    t.pane.el.hidden = true;
    pbody.appendChild(t.pane.el);
    terms.push(t);
    return t;
  }
  function showTerm(t, { focus = true } = {}) {
    if (activeTerm && activeTerm !== t) activeTerm.pane.el.hidden = true;
    activeTerm = t;
    t.pane.el.hidden = false;
    panelOpen = true;
    treeOver = false;
    update();
    if (focus) t.pane.focus();
    drawTerms();
    ctx.save();
  }
  async function closeTerm(t, { force = false } = {}) {
    if (!force && t.pane.canClose && !(await t.pane.canClose())) return false;
    const i = terms.indexOf(t);
    if (i < 0) return true;
    terms.splice(i, 1);
    setOn(t.pane, false);
    t.pane.dispose({ kill: !force });
    t.pane.el.remove();
    if (activeTerm === t) {
      activeTerm = null;
      const next = terms[Math.min(i, terms.length - 1)];
      if (next) showTerm(next, { focus: false });
    }
    if (!terms.length) panelOpen = false;
    update();
    drawTerms();
    ctx.save();
    return true;
  }
  async function newTerminal({ shell, cwd } = {}) {
    if (creating) return;
    creating = true;
    try {
      const info = await ctx.terminalsInfo();
      const id = shell || store.get("cpDockShell") || info.shells[0]?.id;
      if (shell) store.set("cpDockShell", shell);
      // a first size from the room it will have (the terminal fits itself once drawn)
      const w = (hasPanel() ? pbody.clientWidth : main.clientWidth || el.clientWidth) - 20;
      const h = hasPanel() ? pbody.clientHeight : (main.clientHeight || el.clientHeight) * (hasFiles() ? 0.4 : 1) - 40;
      const t = await api("/api/terminals", { method: "POST", body: { cwd: cwd || ctx.cwd, workspace: ctx.cwd, shell: id, cols: Math.max(20, Math.floor(w / 7.8)), rows: Math.max(5, Math.floor(h / 15.5)) } });
      showTerm(addTerm(t));
    } catch (e) { fail(e); } finally { creating = false; }
  }
  async function shellMenu(anchor) {
    let info;
    try { info = await ctx.terminalsInfo(); } catch (e) { return fail(e); }
    const last = store.get("cpDockShell") || info.shells[0]?.id;
    popMenu(anchor, [{ key: "shell", title: "新建终端", items: info.shells.map((x) => ({ label: x.label, value: x.id, current: x.id === last })) }], (k, v) => newTerminal({ shell: v }), { dropdown: true });
  }
  function togglePanel(open = !hasPanel()) {
    if (open && !terms.length) { newTerminal(); return; }
    if (open && activeTerm) { showTerm(activeTerm); return; }
    panelOpen = open;
    update();
    ctx.save();
  }
  const termAt = (target) => { const x = target.closest("[data-t]"); return x && terms.find((t) => t.id === x.dataset.t); };
  ptabs.addEventListener("click", (e) => {
    const t = termAt(e.target);
    if (!t) return;
    if (e.target.closest("[data-close]")) closeTerm(t); else showTerm(t);
  });
  ptabs.addEventListener("auxclick", (e) => {
    const t = termAt(e.target);
    if (t && e.button === 1) { e.preventDefault(); closeTerm(t); }
  });
  // (narrow: the tree over the rest goes away when the rest is touched)
  main.addEventListener("pointerdown", () => { if (treeOver) { treeOver = false; update(); } });
  // (the tree beside or over the rest, as the width goes across NARROW)
  let wasNarrow = null;
  new ResizeObserver(() => { const n = narrow(); if (n !== wasNarrow) { wasNarrow = n; treeOver = false; update(); } }).observe(el);
  $(".wb-pbar", el).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]");
    if (!b) return;
    if (b.dataset.p === "new") newTerminal();
    else if (b.dataset.p === "shells") shellMenu(b);
    else if (b.dataset.p === "hide") togglePanel(false);
  });

  // ---- the dividers: the tree's width, the terminals' height (kept for every workspace)
  {
    let w = 0;
    dragger($(".wb-split", el), (x) => {
      w = Math.round(Math.max(150, Math.min(el.clientWidth - 220, x - el.getBoundingClientRect().left)));
      el.style.setProperty("--wb-tree", `${w}px`);
    }, () => { if (w) store.set("cpDockTreeWidth", String(w)); });
    $(".wb-split", el).addEventListener("dblclick", () => { el.style.removeProperty("--wb-tree"); store.set("cpDockTreeWidth", null); });
    let h = 0;
    dragger($(".wb-hsplit", el), (x, y) => {
      const r = main.getBoundingClientRect();
      h = Math.round(Math.max(90, Math.min(r.height - 90, r.bottom - y)));
      el.style.setProperty("--wb-panel", `${h}px`);
    }, () => { if (h) store.set("cpDockPanelHeight", String(h)); });
    $(".wb-hsplit", el).addEventListener("dblclick", () => { el.style.removeProperty("--wb-panel"); store.set("cpDockPanelHeight", null); });
    let g = 0;
    dragger(gsplit, (x, y) => {
      const r = side.getBoundingClientRect();
      g = Math.round(Math.max(120, Math.min(r.height - 120, r.bottom - y)));
      el.style.setProperty("--wb-git", `${g}px`);
    }, () => { if (g) store.set("cpDockGitHeight", String(g)); });
    gsplit.addEventListener("dblclick", () => { el.style.removeProperty("--wb-git"); store.set("cpDockGitHeight", null); });
  }

  // ---- what was open the last time: the files (each read when first shown), the terminals still running
  for (const p of Array.isArray(saved.open) ? saved.open : []) if (typeof p === "string" && !fileOf(p)) files.push({ id: `f${++fileSeq}`, path: p, title: baseOf(p), pane: null, dirty: false });
  if (files.length) show((saved.active && fileOf(saved.active)) || files[0], { focus: false });
  update();
  const ready = ctx.terminalsInfo(true).then((info) => {
    const mine = new Map(info.terminals.filter((t) => workspaceKey(t.workspace) === ctx.key).map((t) => [t.id, t]));
    for (const id of Array.isArray(saved.terms) ? saved.terms : []) if (mine.has(id)) { addTerm(mine.get(id)); mine.delete(id); }
    for (const t of mine.values()) addTerm(t);
    const want = terms.find((t) => t.id === saved.term) || terms[0];
    if (want) { activeTerm = want; want.pane.el.hidden = false; }
    update();
    drawTerms();
  }).catch(() => { update(); });

  return {
    el,
    ready,
    get dirty() { return anyDirty(); },
    // the panel shown, with this workspace in it, or not
    setShown(on) { shown = on; update(); },
    // for the panel's header: whether the tree and the terminals show, and whether the tree can be hidden
    state: () => ({ tree: treeShown(), treeToggle: hasFiles() || hasPanel(), panel: hasPanel() }),
    openFile,
    focus() {
      if (hasPanel() && pbody.contains(document.activeElement)) return;
      if (active && !(narrow() && treeShown())) active.pane?.focus?.(); else ex.focus();
    },
    focusSearch() {
      if (!treeShown()) { showTree(); update(); }
      ex.focusSearch();
    },
    focusTree() {
      if (!treeShown()) { showTree(); update(); }
      ex.focus();
    },
    toggleTree() {
      if (!(hasFiles() || hasPanel())) return;
      if (narrow()) treeOver = !treeOver; else hideTree = !hideTree;
      update();
      ctx.save();
      if (treeShown()) ex.focus(); else active?.pane?.focus?.();
    },
    togglePanel,
    newTerminal,
    // Ctrl+`: the terminals shown and the cursor in one; hidden if it was there already
    terminalKey() {
      if (hasPanel() && pbody.contains(document.activeElement)) togglePanel(false);
      else togglePanel(true);
    },
    persist: () => ({
      v: 2, open: files.filter((f) => !f.diff).map((f) => f.path), active: active && !active.diff ? active.path : null, terms: terms.map((t) => t.id), term: activeTerm?.id || null,
      ...(hideTree ? { hide: true } : {}), ...(panelOpen ? { panel: true } : {}),
    }),
  };
}
