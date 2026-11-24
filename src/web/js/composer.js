// The message box of a new conversation and of a live one: text, images, quotes, @ and / completions, the model.

import { esc, toast, fail, ICON, $ } from "./util.js";
import { MAX_IMAGES, prepareImage } from "./images.js";
import { view } from "./router.js";

// What was typed and not sent, per box (`draftKey`): kept when the page shows another conversation and back. The text
// also in localStorage (it survives a reload), the images only in memory (their object URLs live as long as the page).
export const draftImages = new Map();
const draftQuotes = new Map(); // draftKey → the passages quoted in that box (引用), while the page is open
export const draftText = (key) => (key ? localStorage.getItem(`cpDraft:${key}`) || "" : "");
export function saveDraft(key, text, images) {
  if (!key) return;
  if (text) localStorage.setItem(`cpDraft:${key}`, text); else localStorage.removeItem(`cpDraft:${key}`);
  if (images.length) draftImages.set(key, images); else draftImages.delete(key);
}

// A rounded box with the text, images (pasted, dropped or added with +), what goes left and right of the send button.
// onSend(text, images) resolves when sent (the box is emptied) or throws (it is kept).
export function composer(box, { placeholder, onSend, left = "", right = "", dropZone = box, draftKey = "" }) {
  box.innerHTML = `<form class="composer"><div class="quotes hidden"></div><div class="thumbs hidden"></div><textarea rows="1" placeholder="${esc(placeholder)}"></textarea>
      <div class="composer-bar"><button type="button" class="icon-btn" data-add title="添加图片（也可以粘贴或拖进来）" aria-label="添加图片">${ICON.add}</button><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
        <span class="composer-left">${left}</span><span class="grow"></span><span class="composer-right">${right}</span>
        <button type="button" class="round-btn stop hidden" data-stop title="停止当前任务">${ICON.stop}</button><button type="submit" class="round-btn" data-send title="发送（Enter）" disabled>${ICON.send}</button></div></form>`;
  const form = $("form", box), input = $("textarea", box), thumbs = $(".thumbs", box), file = $("input[type=file]", box), send = $("[data-send]", box);
  const quoteBox = $(".quotes", box);
  let images = [...(draftImages.get(draftKey) || [])];
  // 引用: passages of the conversation chosen with 引用文本, sent before the message as Markdown quotes; kept
  // with the draft
  let quotes = draftKey ? [...(draftQuotes.get(draftKey) || [])] : [];
  let sending = false;
  const keep = () => { saveDraft(draftKey, input.value, images); if (draftKey) { if (quotes.length) draftQuotes.set(draftKey, [...quotes]); else draftQuotes.delete(draftKey); } };
  const ready = () => { send.disabled = sending || (!input.value.trim() && !images.length && !quotes.length); };
  const paintQuotes = () => {
    quoteBox.classList.toggle("hidden", !quotes.length);
    quoteBox.innerHTML = quotes.map((q, i) => `<div class="quote-chip" title="${esc(q)}"><span class="quote-mark" aria-hidden="true">“</span><span class="quote-text">${esc(q.replace(/\s+/g, " "))}</span><button type="button" data-unquote="${i}" title="去掉这条引用" aria-label="去掉这条引用">×</button></div>`).join("");
    keep();
    ready();
  };
  quoteBox.addEventListener("click", (e) => {
    const b = e.target.closest("[data-unquote]");
    if (!b || sending) return;
    quotes.splice(Number(b.dataset.unquote), 1);
    paintQuotes();
  });
  const autosize = () => { input.style.height = "auto"; input.style.height = `${Math.min(240, input.scrollHeight)}px`; ready(); };
  const paint = () => {
    thumbs.classList.toggle("hidden", !images.length);
    thumbs.innerHTML = images.map((img, i) => `<div class="thumb"><img src="${img.url}" alt="图片 ${i + 1}"><button type="button" data-drop="${i}" title="移除" aria-label="移除">×</button></div>`).join("");
    keep();
    ready();
  };
  async function add(files) {
    if (sending) return;
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
    if (!b || sending) return;
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
    const typed = input.value;
    if (sending || (!typed.trim() && !images.length && !quotes.length)) return;
    // the quotes first, each a Markdown block quote, then what was typed
    const quoted = quotes.map((q) => q.split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join("\n")).join("\n\n");
    const text = quoted ? `${quoted}${typed.trim() ? `\n\n${typed}` : ""}` : typed;
    sending = true;
    input.readOnly = true;
    ready();
    try {
      await onSend(text, images.map(({ media_type, data }) => ({ media_type, data })));
      input.value = "";
      for (const img of images) URL.revokeObjectURL(img.url);
      images = [];
      quotes = [];
      paintQuotes();
      paint(); // (the draft goes with it)
      autosize();
    } catch (err) { fail(err); } finally { sending = false; input.readOnly = false; ready(); }
  });
  input.value = draftText(draftKey);
  if (images.length) paint();
  if (quotes.length) paintQuotes();
  requestAnimationFrame(autosize); // (measured once the box is on the page)
  return {
    input,
    submit: () => form.requestSubmit(),
    // a passage of the conversation quoted in the message being written (引用文本)
    quote(text) {
      const t = String(text || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
      if (!t || sending) return;
      if (!quotes.includes(t)) quotes.push(t);
      paintQuotes();
      input.focus();
    },
    left: $(".composer-left", box),
    right: $(".composer-right", box),
    setBusy(busy) { $("[data-stop]", box).classList.toggle("hidden", !busy); },
    onStop(fn) { $("[data-stop]", box).addEventListener("click", fn); },
    // (images of a draft stay: they come back with it)
    dispose() { for (const img of images) if (!draftImages.get(draftKey)?.includes(img)) URL.revokeObjectURL(img.url); },
  };
}

// 引用文本: text selected in the conversation (`log`) offers a small button above it that hands it to `onQuote`.
// Returns what undoes it (the view's cleanup).
export function quoteSelection(log, onQuote) {
  let btn = null, text = "";
  const hide = () => { btn?.remove(); btn = null; text = ""; };
  const place = () => {
    const sel = getSelection();
    const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
    // (inside the conversation only: not the box being written, not a menu)
    const t = range && log.contains(range.commonAncestorContainer) ? sel.toString().trim() : "";
    if (!t) return hide();
    text = t;
    const r = range.getBoundingClientRect();
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quote-pop";
      btn.textContent = "引用文本";
      // (pointerdown kept from taking the selection away; the text is the one the button was shown for)
      btn.addEventListener("pointerdown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        const q = text;
        getSelection()?.removeAllRanges();
        hide();
        if (q) onQuote(q);
      });
      document.body.appendChild(btn);
    }
    const h = btn.offsetHeight || 34, w = btn.offsetWidth || 90;
    const top = r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8;
    btn.style.top = `${Math.round(top)}px`;
    btn.style.left = `${Math.round(Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8))}px`;
  };
  let timer = 0;
  const later = () => { clearTimeout(timer); timer = setTimeout(place, 120); };
  const scroller = log.closest(".chat-scroll");
  document.addEventListener("selectionchange", later);
  scroller?.addEventListener("scroll", later, { passive: true });
  addEventListener("resize", later);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("selectionchange", later);
    scroller?.removeEventListener("scroll", later);
    removeEventListener("resize", later);
    hide();
  };
}

// A small menu next to `anchor`: onPick(section, value).
export function popMenu(anchor, sections, onPick, { dropdown = false } = {}) {
  const wasOpen = anchor.getAttribute("aria-expanded") === "true";
  view.closeMenu?.();
  if (wasOpen) return;
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.innerHTML = sections.map((s) => `<div class="pop-head">${esc(s.title)}</div>${s.items.map((it, i) => `<button type="button" data-s="${esc(s.key)}" data-i="${i}" class="${it.current ? "current" : ""}${it.danger ? " danger" : ""}"><span>${esc(it.label)}${it.isDefault ? ' <span class="pill accent pop-default">默认</span>' : ""}</span>${it.description ? `<small>${esc(it.description)}</small>` : ""}</button>`).join("")}`).join("");
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`;
  const below = dropdown && r.bottom + pop.offsetHeight + 14 <= window.innerHeight;
  pop.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - pop.offsetHeight - 6)}px`;
  const close = (focus = false) => {
    pop.remove();
    document.removeEventListener("pointerdown", outside);
    document.removeEventListener("keydown", escape);
    view.closeMenu = null;
    if (dropdown) {
      anchor.setAttribute("aria-expanded", "false");
      if (focus) anchor.focus({ preventScroll: true });
    }
  };
  const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const escape = (e) => { if (e.key === "Escape") { e.preventDefault(); close(true); } };
  view.closeMenu = close;
  document.addEventListener("pointerdown", outside);
  document.addEventListener("keydown", escape);
  if (dropdown) {
    anchor.setAttribute("aria-expanded", "true");
    $("button", pop)?.focus({ preventScroll: true });
  }
  pop.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const s = sections.find((x) => x.key === b.dataset.s);
    close(true);
    onPick(s.key, s.items[Number(b.dataset.i)].value);
  });
}

// Clicking the tagged model follows the project default rather than creating a model override.
export const modelMenuItems = (models = []) => models.filter((m) => m.value !== "default").map((m) => ({ ...m, value: m.isDefault ? "default" : m.value }));
