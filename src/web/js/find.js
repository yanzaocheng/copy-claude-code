// 在对话中查找: a box under a conversation's header (its 🔍 button, or Ctrl+F on the page) that finds words in what
// is shown of the conversation: every place marked, the current one in a stronger colour and scrolled to, Enter and
// Shift+Enter (or ↓ ↑) going from one to the next. The marks are the browser's own highlights (CSS.highlights), not
// elements: the conversation goes on being drawn while it streams, and the places are found again as it changes.
// A place inside something folded (thinking, a long tool output) unfolds when it becomes the current one.

import { $ } from "./util.js";

const MAX = 2000;
const UP = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>';
const DOWN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
export const FIND_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const highlights = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";

// A conversation opened from the sidebar's search, found by what was said in it: the words looked for once it is
// drawn (its view takes them, takePendingFind), or at once when it is the one shown (the cp-find event).
let pending = null;
export function findWhenOpened(sessionId, q) {
  pending = { sessionId, q, at: Date.now() };
  document.dispatchEvent(new CustomEvent("cp-find", { detail: { sessionId } }));
}
export function takePendingFind(sessionId) {
  if (!pending || pending.sessionId !== sessionId || Date.now() - pending.at > 60_000) return null;
  const { q } = pending;
  pending = null;
  return q;
}

// root: what is searched (the conversation's log); scroller: what scrolls it; host: where the box goes (positioned);
// button: the header's 🔍. Returns {open(), close(), dispose()}.
export function findInConversation({ root, scroller, host, button }) {
  const bar = document.createElement("div");
  bar.className = "find-bar hidden";
  bar.innerHTML = `<input type="text" placeholder="在对话中查找" spellcheck="false" autocomplete="off" aria-label="在对话中查找"><span class="find-count"></span><button type="button" class="icon-btn" data-f="prev" title="上一个（Shift+Enter）" aria-label="上一个">${UP}</button><button type="button" class="icon-btn" data-f="next" title="下一个（Enter）" aria-label="下一个">${DOWN}</button><button type="button" class="icon-btn" data-f="close" title="关闭（Esc）" aria-label="关闭">${CLOSE}</button>`;
  host.appendChild(bar);
  const input = $("input", bar), count = $(".find-count", bar);
  let ranges = [], current = -1, query = "", timer = 0, opened = false;

  // Every place the words are, across the text as it is drawn (a place may span a bold word or a code span).
  function search() {
    ranges = [];
    const q = query.toLowerCase();
    if (q) {
      const nodes = [];
      let text = "";
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest("script, style, button, .fold-btn") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let n; (n = walker.nextNode());) { nodes.push({ node: n, start: text.length }); text += n.data; }
      const lower = text.toLowerCase();
      let ni = 0;
      for (let i = lower.indexOf(q); i >= 0 && ranges.length < MAX; i = lower.indexOf(q, i + q.length)) {
        while (ni < nodes.length - 1 && nodes[ni + 1].start <= i) ni++;
        const end = i + q.length;
        let ej = ni;
        while (ej < nodes.length - 1 && nodes[ej + 1].start < end) ej++;
        const s = nodes[ni], t = nodes[ej];
        const r = document.createRange();
        try {
          r.setStart(s.node, i - s.start);
          r.setEnd(t.node, Math.min(t.node.data.length, end - t.start));
          ranges.push(r);
        } catch { /* a node gone meanwhile */ }
      }
    }
    paint();
  }
  function paint() {
    if (current >= ranges.length) current = ranges.length - 1;
    if (current < 0 && ranges.length) current = 0;
    count.textContent = query ? (ranges.length ? `${current + 1}/${ranges.length}${ranges.length >= MAX ? "+" : ""}` : "无结果") : "";
    bar.classList.toggle("none", Boolean(query) && !ranges.length);
    if (!highlights) return;
    CSS.highlights.set("cp-find", new Highlight(...ranges.filter((r, i) => i !== current)));
    if (ranges[current]) CSS.highlights.set("cp-find-current", new Highlight(ranges[current])); else CSS.highlights.delete("cp-find-current");
  }
  function clearMarks() {
    if (!highlights) return;
    CSS.highlights.delete("cp-find");
    CSS.highlights.delete("cp-find-current");
  }
  // the current place on screen: what folds it unfolded, scrolled to the middle
  function reveal() {
    const r = ranges[current];
    if (!r) return;
    const el = r.startContainer.parentElement;
    const details = el?.closest("details");
    if (details && !details.open) details.open = true;
    const fold = el?.closest(".fold");
    if (fold && !fold.classList.contains("open")) fold.querySelector("[data-fold]")?.click();
    const box = r.getBoundingClientRect(), view = scroller.getBoundingClientRect();
    if (box.top < view.top + 60 || box.bottom > view.bottom - 60) scroller.scrollTop += box.top - view.top - view.height / 2;
    if (!highlights) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
  }
  function go(step) {
    if (!ranges.length) return;
    current = (current + step + ranges.length) % ranges.length;
    paint();
    reveal();
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      query = input.value;
      current = -1;
      search();
      // (the first place below where one is reading, as the browser's own find does)
      const top = scroller.getBoundingClientRect().top;
      const below = ranges.findIndex((r) => r.getBoundingClientRect().top >= top);
      current = below >= 0 ? below : ranges.length - 1;
      paint();
      reveal();
    }, 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); go(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(-1); }
  });
  bar.addEventListener("click", (e) => {
    const f = e.target.closest("[data-f]")?.dataset.f;
    if (f === "prev") go(-1);
    else if (f === "next") go(1);
    else if (f === "close") close();
  });

  // the conversation drawn anew (a message streaming, a tool finishing): the places found again, the current one kept
  // where it was as well as it can be
  const watch = new MutationObserver(() => {
    if (!opened || !query) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const keep = current;
      search();
      current = Math.min(Math.max(0, keep), ranges.length - 1);
      paint();
    }, 300);
  });
  watch.observe(root, { childList: true, subtree: true, characterData: true });

  function open() {
    opened = true;
    bar.classList.remove("hidden");
    button?.setAttribute("aria-pressed", "true");
    // (words selected in the conversation: looked for at once)
    const sel = String(getSelection() || "").trim();
    if (sel && sel.length < 200 && !sel.includes("\n") && root.contains(getSelection().anchorNode)) input.value = sel;
    input.focus();
    input.select();
    if (input.value && input.value !== query) input.dispatchEvent(new Event("input"));
    else if (query) { search(); paint(); }
  }
  function close() {
    opened = false;
    bar.classList.add("hidden");
    button?.setAttribute("aria-pressed", "false");
    clearMarks();
  }
  button?.addEventListener("click", () => (opened ? close() : open()));
  // Ctrl+F on the conversation's page (not in the panel's editor or terminal, which have their own)
  const onKey = (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return;
    if (!host.isConnected || e.target.closest?.(".dock, .modal-back")) return;
    e.preventDefault();
    open();
  };
  document.addEventListener("keydown", onKey);
  // the box opened on `q`, at its first place in the conversation (from the top); how many places there are
  function show(q) {
    opened = true;
    bar.classList.remove("hidden");
    button?.setAttribute("aria-pressed", "true");
    input.value = q;
    query = q;
    current = -1;
    search();
    current = ranges.length ? 0 : -1;
    paint();
    reveal();
    return ranges.length;
  }
  return {
    open, close, show,
    dispose() { watch.disconnect(); clearTimeout(timer); clearMarks(); document.removeEventListener("keydown", onKey); bar.remove(); },
  };
}
