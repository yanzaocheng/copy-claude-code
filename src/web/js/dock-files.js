// The file tree of the panel's workbench (dock-workbench.js): the workspace's folders, a level loaded at a time and
// refreshed while shown (an agent's new files appear), a box that finds files by name (Ctrl+P; files.js findFiles),
// and a right click for what can be done with a file or folder. A file picked opens in the editor beside it.

import { esc, api, fail, shortPath, ICON, $ } from "./util.js";
import { fileIcon, joinPath, parentOf, baseOf, samePath, relativeTo, copyText, menuAt } from "./dock-util.js";

const REFRESH_MS = 4000;
const CHEV = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const FOLDER = '<svg class="fo" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const FOLDER_OPEN = '<svg class="fo" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1"/><path d="M3 19l2.5-7.5A2 2 0 0 1 7.4 10H21l-2.7 8a2 2 0 0 1-1.9 1H5a2 2 0 0 1-2-2"/></svg>';
const NEW_FILE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M12 11v6M9 14h6"/></svg>';
const NEW_FOLDER = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/></svg>';
const COLLAPSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 20 5-5 5 5M7 4l5 5 5-5"/></svg>';

// ctx: {cwd, key, openFile(path), openTerminal({cwd}), renamed(from, to)}
export function explorer(ctx) {
  const root = ctx.cwd;
  const el = document.createElement("div");
  el.className = "wb-explorer";
  el.innerHTML = `<div class="ft-head"><span class="ft-root" title="${esc(root)}">${esc(baseOf(root) || root)}</span>
      <button type="button" class="icon-btn" data-act="newfile" title="新建文件">${NEW_FILE}</button><button type="button" class="icon-btn" data-act="newdir" title="新建文件夹">${NEW_FOLDER}</button><button type="button" class="icon-btn" data-act="refresh" title="刷新">${ICON.refresh}</button><button type="button" class="icon-btn" data-act="collapse" title="全部折叠">${COLLAPSE}</button></div>
    <div class="ft-find">${ICON.search}<input type="search" placeholder="按文件名查找（Ctrl+P）" spellcheck="false" autocomplete="off"></div>
    <div class="ft-list" tabindex="-1"></div>`;
  const list = $(".ft-list", el);
  const input = $(".ft-find input", el);
  const treeKey = `cpDockTree:${ctx.key}`;
  const expanded = new Set((() => { try { return JSON.parse(localStorage.getItem(treeKey) || "[]"); } catch { return []; } })());
  const lists = new Map(); // folder -> {entries, truncated} | {error}
  const sigs = new Map();
  const loading = new Set();
  let selected = null, selectedDir = false, revealing = false;
  let mode = "tree"; // or "find"
  let hits = [], hit = 0, findSeq = 0, findTimer = 0;
  let timer = 0, shown = false;

  const saveExpanded = () => { try { localStorage.setItem(treeKey, JSON.stringify([...expanded].slice(0, 300))); } catch { /* full */ } };
  const sigOf = (l) => (l?.entries ? l.entries.map((e) => (e.dir ? "d" : "f") + e.name).join("/") + (l.truncated ? "+" : "") : `!${l?.error}`);

  async function load(dir) {
    if (loading.has(dir)) return;
    loading.add(dir);
    try {
      const l = await api(`/api/fs/list?path=${encodeURIComponent(dir)}`);
      lists.set(dir, l);
      sigs.set(dir, sigOf(l));
    } catch (e) {
      lists.set(dir, { error: e.message, status: e.status });
      if (dir !== root && e.status === 404) { expanded.delete(dir); saveExpanded(); }
    } finally { loading.delete(dir); }
    if (mode === "tree") draw();
  }

  function rows(dir, depth, out) {
    const l = lists.get(dir);
    if (!l) { out.push(`<div class="ft-note" style="--d:${depth}">加载中…</div>`); if (!loading.has(dir)) load(dir); return; }
    if (l.error) { out.push(`<div class="ft-note err" style="--d:${depth}">${esc(l.error)}</div>`); return; }
    if (!l.entries.length && depth === 0) out.push('<div class="ft-note" style="--d:0">（空文件夹）</div>');
    for (const e of l.entries) {
      const p = joinPath(dir, e.name);
      const open = e.dir && expanded.has(p);
      const sel = selected && samePath(p, selected);
      const cls = `ft-row${e.dir ? " dir" : ""}${open ? " open" : ""}${sel ? " sel" : ""}${e.name.startsWith(".") ? " dim" : ""}`;
      out.push(`<div class="${cls}" style="--d:${depth}" data-p="${esc(p)}"${e.dir ? ' data-dir="1"' : ""} title="${esc(e.name)}"><span class="ft-chev">${e.dir ? CHEV : ""}</span>${e.dir ? (open ? FOLDER_OPEN : FOLDER) : fileIcon(e.name)}<span class="ft-name">${esc(e.name)}</span>${e.link ? '<span class="ft-link" title="链接">↗</span>' : ""}</div>`);
      if (open) rows(p, depth + 1, out);
    }
    if (l.truncated) out.push(`<div class="ft-note" style="--d:${depth}">只列出了前 5000 项</div>`);
  }
  function draw() {
    if (mode !== "tree") return;
    const out = [];
    rows(root, 0, out);
    list.innerHTML = out.join("");
    // (a file asked to be shown: scrolled to once its folders are loaded)
    if (revealing) {
      const row = list.querySelector(".ft-row.sel");
      if (row) { row.scrollIntoView({ block: "center" }); revealing = false; }
    }
  }

  function drawHits(r) {
    list.innerHTML = hits.length
      ? hits.map((h, i) => {
        const name = baseOf(h.rel), dir = h.rel.slice(0, Math.max(0, h.rel.length - name.length - 1));
        return `<div class="ft-hit${i === hit ? " sel" : ""}" data-p="${esc(h.path)}" data-i="${i}">${fileIcon(name)}<span class="ft-name">${esc(name)}</span><span class="ft-dir">${esc(dir)}</span></div>`;
      }).join("") + (r?.truncated ? '<div class="ft-note">文件太多，只在一部分里找了</div>' : "")
      : `<div class="ft-note">${r ? "没有找到" : "正在查找…"}</div>`;
    $(".ft-hit.sel", list)?.scrollIntoView({ block: "nearest" });
  }
  async function find() {
    const q = input.value.trim();
    if (!q) { mode = "tree"; hits = []; draw(); return; }
    mode = "find";
    const seq = ++findSeq;
    if (!hits.length) drawHits(null);
    try {
      const r = await api(`/api/fs/find?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`);
      if (seq !== findSeq || mode !== "find") return;
      hits = r.results;
      hit = 0;
      drawHits(r);
    } catch (e) { if (seq === findSeq) list.innerHTML = `<div class="ft-note err">${esc(e.message)}</div>`; }
  }
  input.addEventListener("input", () => { clearTimeout(findTimer); findTimer = setTimeout(find, 120); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (input.value) { e.preventDefault(); e.stopPropagation(); input.value = ""; find(); } else input.blur();
      return;
    }
    if (mode !== "find" || !hits.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      hit = (hit + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
      drawHits({});
    } else if (e.key === "Enter") {
      e.preventDefault();
      ctx.openFile(hits[hit].path);
    }
  });

  function toggle(dir) {
    if (expanded.has(dir)) expanded.delete(dir); else { expanded.add(dir); if (!lists.has(dir)) load(dir); }
    saveExpanded();
    draw();
  }
  list.addEventListener("click", (e) => {
    const row = e.target.closest("[data-p]");
    if (!row) return;
    selected = row.dataset.p;
    selectedDir = Boolean(row.dataset.dir);
    if (selectedDir) toggle(selected);
    else {
      if (mode === "tree") draw();
      ctx.openFile(selected);
    }
  });

  // ---- what can be done with a file or folder
  async function create(dir, isDir) {
    const name = prompt(isDir ? `在 ${baseOf(dir) || dir} 里新建文件夹：` : `在 ${baseOf(dir) || dir} 里新建文件（可以带子目录，如 src/a.js）：`);
    if (!name || !name.trim()) return;
    try {
      const r = await api("/api/fs/create", { method: "POST", body: { path: joinPath(dir, name.trim()), dir: isDir } });
      for (let d = parentOf(r.path); d.length > root.length && d !== parentOf(d); d = parentOf(d)) expanded.add(d);
      if (isDir) expanded.add(r.path);
      saveExpanded();
      selected = r.path;
      selectedDir = isDir;
      await refresh(true);
      if (!isDir) ctx.openFile(r.path);
    } catch (e) { fail(e); }
  }
  async function rename(p) {
    const name = prompt("新名字：", baseOf(p));
    if (!name || !name.trim() || name.trim() === baseOf(p)) return;
    try {
      const r = await api("/api/fs/rename", { method: "POST", body: { from: p, to: joinPath(parentOf(p), name.trim()) } });
      if (expanded.delete(p)) expanded.add(r.path);
      saveExpanded();
      selected = r.path;
      ctx.renamed(p, r.path);
      await refresh(true);
    } catch (e) { fail(e); }
  }
  list.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const row = e.target.closest("[data-p]");
    const p = row?.dataset.p || null;
    const isDir = Boolean(row?.dataset.dir);
    const here = p ? (isDir ? p : parentOf(p)) : root;
    if (p) { selected = p; selectedDir = isDir; if (mode === "tree") draw(); }
    const items = [];
    if (p && !isDir) items.push({ label: "打开", value: "open" });
    items.push({ label: "新建文件…", value: "newfile" }, { label: "新建文件夹…", value: "newdir" }, { label: "在终端中打开", description: shortPath(here), value: "term" });
    if (p) items.push({ label: "重命名…", value: "rename" }, { label: "复制路径", value: "copy" }, { label: "复制相对路径", value: "copyrel" });
    items.push({ label: "刷新", value: "refresh" });
    menuAt(e.clientX, e.clientY, items, (v) => {
      if (v === "open") ctx.openFile(p);
      else if (v === "newfile" || v === "newdir") create(here, v === "newdir");
      else if (v === "term") ctx.openTerminal({ cwd: here });
      else if (v === "rename") rename(p);
      else if (v === "copy") copyText(p);
      else if (v === "copyrel") copyText(relativeTo(root, p), "相对路径");
      else if (v === "refresh") refresh(true);
    });
  });
  el.querySelector(".ft-head").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "newfile" || act === "newdir") create(!selected ? root : selectedDir ? selected : parentOf(selected), act === "newdir");
    else if (act === "refresh") { lists.clear(); sigs.clear(); draw(); }
    else if (act === "collapse") { expanded.clear(); saveExpanded(); draw(); }
  });

  // The folders shown, looked at again: drawn anew only when something in them changed.
  async function refresh(force = false) {
    if (!force && (!shown || document.visibilityState !== "visible")) return;
    const paths = [root, ...[...expanded].filter((d) => lists.has(d))].slice(0, 100);
    try {
      const r = await api("/api/fs/lists", { method: "POST", body: { paths } });
      let changed = false;
      for (const p of paths) {
        const l = r.lists[p];
        if (!l) continue;
        const sig = sigOf(l);
        if (sig === sigs.get(p)) continue;
        sigs.set(p, sig);
        lists.set(p, l);
        if (l.error && p !== root && l.status === 404) { expanded.delete(p); saveExpanded(); }
        changed = true;
      }
      if (changed && mode === "tree") draw();
    } catch { /* the next round */ }
  }

  return {
    el,
    activate() {
      shown = true;
      if (!lists.has(root)) draw(); else refresh(true);
      clearInterval(timer);
      timer = setInterval(refresh, REFRESH_MS);
    },
    deactivate() { shown = false; clearInterval(timer); },
    focus() { list.focus({ preventScroll: true }); },
    focusSearch() { input.focus(); input.select(); },
    // the file of the editor's tab, marked in the tree where its folders are open
    select(p) {
      selected = p;
      selectedDir = false;
      if (mode !== "tree") return;
      draw();
      list.querySelector(".ft-row.sel")?.scrollIntoView({ block: "nearest" });
    },
    // 在文件列表中显示: its folders opened, scrolled to
    reveal(p) {
      if (mode !== "tree") { input.value = ""; mode = "tree"; hits = []; }
      for (let d = parentOf(p); d.length > root.length && d !== parentOf(d); d = parentOf(d)) expanded.add(d);
      saveExpanded();
      selected = p;
      selectedDir = false;
      revealing = true;
      draw();
    },
    dispose() { clearInterval(timer); clearTimeout(findTimer); },
  };
}
