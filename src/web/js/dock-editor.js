// A file open in the panel (dock.js): CodeMirror (src/web/vendor, loaded the first time a file opens), the file's
// language by its name, saved with Ctrl+S in the encoding and line endings it had (files.js). The file on disk is
// looked at while the tab is shown: changed there (an agent edited it) it is read again when nothing here is unsaved,
// else the change is said and nothing is overwritten unless asked. Pictures are shown; other binary files and very
// large ones are not opened.

import { esc, api, toast, fail, fmtBytes, $ } from "./util.js";
import { relativeTo, baseOf, copyText } from "./dock-files.js";

const POLL_MS = 3000;
let cmLoad = null;
const loadCM = () => (cmLoad ||= import("/vendor/codemirror.js"));
const dark = () => document.documentElement.dataset.theme === "dark";

// The editors open, for the theme switch: each reconfigures its theme compartment.
const views = new Set();
new MutationObserver(() => { for (const v of views) v.retheme(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

function themeOf(cm) {
  const isDark = dark();
  return [
    cm.EditorView.theme({
      "&": { height: "100%", fontSize: "13px", color: "var(--text)", backgroundColor: "var(--main-bg)" },
      ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
      ".cm-content": { caretColor: "var(--text)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
      ".cm-gutters": { backgroundColor: "var(--main-bg)", color: "var(--faint)", border: "none" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
      ".cm-activeLine": { backgroundColor: "var(--hover)" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: isDark ? "rgba(217, 128, 95, .3)" : "rgba(201, 100, 66, .2)" },
      ".cm-panels": { backgroundColor: "var(--surface-2)", color: "var(--text)" },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
      ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
      ".cm-textfield": { backgroundColor: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: "6px", padding: "2px 6px" },
      ".cm-button": { backgroundImage: "none", backgroundColor: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: "6px", color: "var(--text-2)" },
      ".cm-tooltip": { backgroundColor: "var(--surface)", border: "1px solid var(--line)", borderRadius: "8px" },
      ".cm-foldPlaceholder": { backgroundColor: "var(--surface-3)", border: "none", color: "var(--muted)" },
    }, { dark: isDark }),
    // (not a fallback: basicSetup's light one is, and the first fallback wins)
    cm.syntaxHighlighting(isDark ? cm.oneDarkHighlightStyle : cm.defaultHighlightStyle),
  ];
}

// ctx: {cwd, setDirty(bool), setTitle(text)}
export function editorPane(ctx, filePath) {
  const el = document.createElement("div");
  el.className = "dock-pane ed";
  el.innerHTML = `<div class="ed-bar"><span class="ed-path"></span><span class="ed-badges"></span><button type="button" class="button secondary small" data-act="save" disabled>保存</button></div><div class="ed-notes"></div><div class="ed-host"><div class="ed-empty">正在打开…</div></div>`;
  const host = $(".ed-host", el);
  const notes = $(".ed-notes", el);
  const saveBtn = $("[data-act=save]", el);
  let file = filePath;
  let info = null; // what the file was when read (mtime, encoding, bom, eol, readonly)
  let view = null, cm = null, clean = null, langComp = null, themeComp = null, roComp = null;
  let dirty = false, saving = false, timer = 0, shown = false, externalNote = false, disposed = false;

  const paintPath = () => {
    const rel = relativeTo(ctx.cwd, file);
    $(".ed-path", el).textContent = rel;
    $(".ed-path", el).title = file;
    ctx.setTitle(baseOf(file), file);
  };
  paintPath();
  const setDirty = (d) => {
    if (d === dirty) return;
    dirty = d;
    saveBtn.disabled = !d || Boolean(info?.readonly);
    ctx.setDirty(d);
  };
  function note(kind, html, actions = {}) {
    const n = document.createElement("div");
    n.className = `ed-note ${kind}`;
    n.innerHTML = html;
    n.addEventListener("click", (e) => {
      const b = e.target.closest("[data-note]");
      if (!b) return;
      n.remove();
      actions[b.dataset.note]?.();
    });
    notes.appendChild(n);
    return n;
  }
  const clearNotes = () => { notes.innerHTML = ""; externalNote = false; };
  function badges() {
    const b = [];
    if (info?.encodingName && info.encoding !== "utf8") b.push(info.encodingName);
    else if (info?.bom) b.push("UTF-8 BOM");
    if (info?.eol === "crlf") b.push("CRLF");
    if (info?.readonly) b.push("只读");
    $(".ed-badges", el).innerHTML = b.map((x) => `<span class="ed-badge">${esc(x)}</span>`).join("");
  }

  async function language(name) {
    const desc = cm.LanguageDescription.matchFilename(cm.languages, name);
    if (!desc) return [];
    try { return await desc.load(); } catch { return []; }
  }

  async function open({ keepView = false } = {}) {
    let r;
    try { r = await api(`/api/fs/read?path=${encodeURIComponent(file)}`); } catch (e) {
      if (!keepView) host.innerHTML = `<div class="ed-empty">打不开：${esc(e.message)}</div>`;
      else fail(e);
      return;
    }
    if (disposed) return;
    info = r;
    badges();
    if (r.image) {
      host.innerHTML = `<div class="ed-image"><img src="/api/fs/raw?path=${encodeURIComponent(file)}&t=${Math.round(r.mtime)}" alt="${esc(r.name)}"><div class="ed-meta">${esc(fmtBytes(r.size))}</div></div>`;
      saveBtn.hidden = true;
      return;
    }
    if (r.binary || r.tooLarge) {
      host.innerHTML = `<div class="ed-empty">${r.binary ? "这是二进制文件，不能在这里编辑" : `文件太大（${esc(fmtBytes(r.size))}），不在编辑器里打开`}<div><button type="button" class="button secondary small" data-copy>复制路径</button></div></div>`;
      $("[data-copy]", host).addEventListener("click", () => copyText(file));
      saveBtn.hidden = true;
      return;
    }
    saveBtn.hidden = false;
    cm ||= await loadCM();
    if (disposed) return;
    if (view && keepView) {
      // read again (changed on disk): the new text, the cursor kept where it can be
      const sel = view.state.selection.main;
      const len = r.text.length;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: r.text }, selection: { anchor: Math.min(sel.anchor, len), head: Math.min(sel.head, len) } });
      view.dispatch({ effects: roComp.reconfigure(cm.EditorState.readOnly.of(Boolean(r.readonly))) });
      clean = view.state.doc;
      setDirty(false);
      return;
    }
    host.innerHTML = "";
    langComp = new cm.Compartment();
    themeComp = new cm.Compartment();
    roComp = new cm.Compartment();
    const state = cm.EditorState.create({
      doc: r.text,
      extensions: [
        cm.basicSetup,
        cm.keymap.of([cm.indentWithTab, { key: "Mod-s", preventDefault: true, run: () => { save(); return true; } }]),
        langComp.of([]),
        themeComp.of(themeOf(cm)),
        roComp.of(cm.EditorState.readOnly.of(Boolean(r.readonly))),
        cm.EditorView.updateListener.of((u) => { if (u.docChanged) setDirty(!u.state.doc.eq(clean)); }),
      ],
    });
    view = new cm.EditorView({ state, parent: host });
    clean = view.state.doc;
    view.retheme = () => view.dispatch({ effects: themeComp.reconfigure(themeOf(cm)) });
    views.add(view);
    if (r.readonly) note("warn", esc(r.readonly));
    if (shown) view.focus();
    const lang = await language(baseOf(file));
    if (!disposed && view) view.dispatch({ effects: langComp.reconfigure(lang) });
  }

  async function save({ force = false } = {}) {
    if (!view || saving || info?.readonly) return;
    if (!dirty && !force) return;
    saving = true;
    saveBtn.disabled = true;
    const doc = view.state.doc;
    try {
      const r = await api("/api/fs/write", { method: "PUT", body: { path: file, text: doc.toString(), mtime: force ? undefined : info.mtime, force, encoding: info.encoding, bom: info.bom, eol: info.eol } });
      info.mtime = r.mtime;
      clean = doc;
      setDirty(!view.state.doc.eq(clean));
      clearNotes();
      toast(`已保存 ${baseOf(file)}`);
    } catch (e) {
      if (e.status === 409 && e.data?.conflict) {
        clearNotes();
        externalNote = true;
        note("warn", `文件在磁盘上已经被改动（可能是 agent 改的），这次没有保存。<span class="ed-note-acts"><button type="button" class="button small" data-note="overwrite">用我的覆盖</button><button type="button" class="button secondary small" data-note="reload">放弃我的修改，重新读取</button></span>`, {
          overwrite: () => save({ force: true }),
          reload: () => open({ keepView: true }),
        });
      } else fail(e);
    } finally {
      saving = false;
      saveBtn.disabled = !dirty;
    }
  }
  saveBtn.addEventListener("click", () => save());

  // the file on disk, while the tab is shown
  async function poll() {
    if (!shown || !info || info.image || document.visibilityState !== "visible" || saving) return;
    let st;
    try { st = await api(`/api/fs/stat?path=${encodeURIComponent(file)}`); } catch { return; }
    if (disposed || saving) return;
    if (!st.exists) {
      if (!externalNote) { externalNote = true; note("warn", "文件已经不在磁盘上了（被删除或改名）。保存会重新建立它。"); }
      return;
    }
    if (Math.abs(st.mtime - info.mtime) <= 1) return;
    if (!dirty && view) { await open({ keepView: true }); return; }
    if (info.binary || info.tooLarge) { await open(); return; }
    if (externalNote) return;
    externalNote = true;
    note("warn", `文件在磁盘上已经被改动（可能是 agent 改的），你这里还有没保存的修改。<span class="ed-note-acts"><button type="button" class="button secondary small" data-note="reload">放弃我的修改，重新读取</button><button type="button" class="button secondary small" data-note="keep">保留我的</button></span>`, {
      reload: () => { externalNote = false; open({ keepView: true }); },
      keep: () => { /* (saving asks again: the times differ) */ },
    });
  }

  open();
  return {
    el,
    get path() { return file; },
    get dirty() { return dirty; },
    activate() {
      shown = true;
      clearInterval(timer);
      timer = setInterval(poll, POLL_MS);
      poll();
      view?.focus();
    },
    deactivate() { shown = false; clearInterval(timer); },
    focus() { view?.focus(); },
    setPath(p) { file = p; paintPath(); if (view && cm) language(baseOf(p)).then((l) => view && view.dispatch({ effects: langComp.reconfigure(l) })); },
    canClose: () => !dirty || confirm(`「${baseOf(file)}」有没保存的修改，关闭会丢掉它们。确定关闭？`),
    dispose() {
      disposed = true;
      clearInterval(timer);
      if (view) { views.delete(view); view.destroy(); view = null; }
    },
    persist: () => ({ k: "file", p: file }),
  };
}
