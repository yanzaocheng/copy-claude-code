// Whole tool outputs, the modal and the file editor.

import { esc, api, toast, fail, $ } from "./util.js";
import { plain } from "./markdown.js";

const EDIT_TOOL = /^(Edit|MultiEdit|Write|NotebookEdit)\b/;
export function truncated(item) {
  if (EDIT_TOOL.test(plain(item.head || ""))) return false;
  return (item.lines || []).some((l) => /… \+\d+ lines/.test(plain(l)));
}

// Watches the tool calls in `root` whose output was shortened; when one comes near the view its whole output is
// fetched (fetch(id) → text) and handed to onWhole(id, text). Returns {observe(), disconnect()}.
export function wholeOutputs(root, fetch, onWhole) {
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

export function modal({ title, sub = "", body = "", foot = "", big = false, onClose = null }) {
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

export async function openEditor(path, { title = "编辑文件", deletable = false, onSaved = () => {} } = {}) {
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
