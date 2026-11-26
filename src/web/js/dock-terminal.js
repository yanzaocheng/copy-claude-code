// A terminal of the panel (dock.js): xterm.js (src/web/vendor, loaded with the first terminal) on a shell the console's
// terminal host runs (pty.js, pty-host.js). The screen comes as an event stream: first as it is now, then the output;
// what is typed goes back in order, gathered while a request is on its way (through 远程访问 a request takes a
// while). The stream reconnects by itself when the console restarts, and the screen is drawn again from the host's.
// Only a terminal shown keeps its stream (a hidden one lets it go after a while and takes the screen again when shown):
// a browser opens at most six connections to the console, and a stream held by each terminal would leave none for the
// page's requests.

import { esc, api, fail, $ } from "./util.js";
import { copyText } from "./dock-files.js";

let xtLoad = null;
function loadXterm() {
  if (!document.querySelector('link[href="/vendor/xterm.css"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/vendor/xterm.css";
    document.head.appendChild(link);
  }
  return (xtLoad ||= import("/vendor/xterm.js"));
}

const LIGHT = {
  background: "#fbfaf8", foreground: "#1f1d1a", cursor: "#1f1d1a", cursorAccent: "#fbfaf8", selectionBackground: "rgba(201, 100, 66, .25)",
  black: "#1f1d1a", red: "#c4352b", green: "#2b7d3a", yellow: "#946200", blue: "#2160c4", magenta: "#a03ca0", cyan: "#0e7c86", white: "#77716a",
  brightBlack: "#5f5a54", brightRed: "#d6463b", brightGreen: "#33934a", brightYellow: "#ad7600", brightBlue: "#2f74de", brightMagenta: "#b84cb8", brightCyan: "#13919c", brightWhite: "#a69f96",
};
const DARK = {
  background: "#1a1917", foreground: "#ece9e3", cursor: "#ece9e3", cursorAccent: "#1a1917", selectionBackground: "rgba(217, 128, 95, .35)",
  black: "#3a3833", red: "#f0786d", green: "#8fcf7e", yellow: "#e9c46a", blue: "#6aaaf0", magenta: "#cf8be0", cyan: "#5fc4cc", white: "#d2cdc5",
  brightBlack: "#77726a", brightRed: "#ff958a", brightGreen: "#a8e096", brightYellow: "#f4d58a", brightBlue: "#8cc0ff", brightMagenta: "#e0a6ee", brightCyan: "#7fd8df", brightWhite: "#f6f3ee",
};
const themeNow = () => (document.documentElement.dataset.theme === "dark" ? DARK : LIGHT);
const terms = new Set();
new MutationObserver(() => { for (const t of terms) t.options.theme = themeNow(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

// ctx: {cwd, windowsPty, setTitle(text, tip), closeTab(), onExit()}; info: the terminal as the host has it
export function terminalPane(ctx, info) {
  const id = info.id;
  const el = document.createElement("div");
  el.className = "dock-pane term";
  el.innerHTML = `<div class="term-notes"></div><div class="term-host"></div>`;
  const host = $(".term-host", el);
  const notes = $(".term-notes", el);
  let term = null, fit = null, es = null, ro = null, opened = false, shown = false, disposed = false, exited = Boolean(info.exited);
  let queue = "", sending = false, fitTimer = 0, lastSize = "", idleTimer = 0, closed = false;
  ctx.setTitle(info.label, `${info.label} · ${info.cwd}`);

  function showNote(kind, html, actions = {}) {
    notes.innerHTML = `<div class="term-note ${kind}">${html}</div>`;
    notes.onclick = (e) => { const b = e.target.closest("[data-note]"); if (b) actions[b.dataset.note]?.(); };
  }
  const clearNote = () => { notes.innerHTML = ""; };

  async function pump() {
    if (sending) return;
    sending = true;
    while (queue && !disposed) {
      const data = queue;
      queue = "";
      try { await api(`/api/terminals/${id}/input`, { method: "POST", body: { data } }); } catch (e) {
        if (e.status === 404) { queue = ""; gone(); break; }
      }
    }
    sending = false;
  }
  const send = (data) => { if (exited || disposed) return; queue += data; pump(); };

  function doFit() {
    if (!term || !fit || !shown || !host.clientWidth || !host.clientHeight) return;
    try { fit.fit(); } catch { return; }
    const size = `${term.cols}x${term.rows}`;
    if (size === lastSize) return;
    lastSize = size;
    if (!exited) api(`/api/terminals/${id}/resize`, { method: "POST", body: { cols: term.cols, rows: term.rows } }).catch(() => {});
  }

  const disconnect = () => { es?.close(); es = null; };
  function gone() {
    exited = true;
    closed = true;
    disconnect();
    showNote("err", `这个终端已经关闭。<button type="button" class="button secondary small" data-note="close">关闭标签页</button>`, { close: () => ctx.closeTab() });
  }

  function connect() {
    const source = new EventSource(`/api/terminals/${id}/events`);
    es = source;
    source.onmessage = (e) => {
      if (source !== es) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === "snapshot") {
        clearNote();
        term.reset();
        if (msg.cols && msg.rows && (msg.cols !== term.cols || msg.rows !== term.rows)) term.resize(msg.cols, msg.rows);
        lastSize = `${term.cols}x${term.rows}`;
        term.write(msg.d || "", () => doFit());
        if (msg.info?.exited) exited = true;
      } else if (msg.t === "out") term.write(msg.d);
      else if (msg.t === "exit") {
        exited = true;
        ctx.onExit?.();
        showNote("info", `进程已结束${msg.code != null ? `（退出码 ${esc(msg.code)}）` : ""}。<button type="button" class="button secondary small" data-note="close">关闭标签页</button>`, { close: () => ctx.closeTab() });
      } else if (msg.t === "closed") { closed = true; disconnect(); ctx.closeTab({ force: true }); }
    };
    source.onerror = () => {
      if (disposed || source !== es) return;
      if (source.readyState === EventSource.CLOSED) gone(); // (refused: the host no longer has it)
      else if (!exited) showNote("warn", "正在重新连接…");
    };
    source.onopen = () => { if (source === es && !exited) clearNote(); };
  }

  async function openTerm() {
    if (opened) return;
    opened = true;
    let xt;
    try { xt = await loadXterm(); } catch (e) { fail(e); return; }
    if (disposed) return;
    term = new xt.Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "Consolas, monospace",
      fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, allowProposedApi: true, theme: themeNow(),
      ...(ctx.windowsPty ? { windowsPty: ctx.windowsPty } : {}),
    });
    fit = new xt.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new xt.WebLinksAddon((ev, uri) => window.open(uri, "_blank", "noopener")));
    const uni = new xt.Unicode11Addon();
    term.loadAddon(uni);
    term.unicode.activeVersion = "11";
    // Ctrl+C copies a selection (and is ^C without one), Ctrl+V pastes (the browser's paste reaches xterm); the
    // panel's own keys (Ctrl+P, Ctrl+`) are left to the page
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
      if (!mod) return true;
      const k = e.key.toLowerCase();
      if (k === "c" && (e.shiftKey || term.hasSelection())) { copyText(term.getSelection(), "选中的文字"); term.clearSelection(); e.preventDefault(); return false; }
      if (k === "v") return false;
      if (e.code === "Backquote" || k === "`" || (k === "p" && !e.shiftKey)) return false;
      return true;
    });
    term.open(host);
    terms.add(term);
    term.onData(send);
    term.onBinary(send);
    ro = new ResizeObserver(() => { clearTimeout(fitTimer); fitTimer = setTimeout(doFit, 40); });
    ro.observe(host);
    doFit();
    connect();
    if (shown) term.focus();
  }

  return {
    el,
    id,
    get exited() { return exited; },
    activate() {
      shown = true;
      clearTimeout(idleTimer);
      if (!opened) { openTerm(); return; }
      if (term && !es && !closed) connect();
      doFit();
      term?.focus();
    },
    deactivate() {
      shown = false;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { if (!shown) disconnect(); }, 5000);
    },
    focus() { term?.focus(); },
    canClose: () => exited || confirm("关闭这个终端会结束它里面运行的程序。确定关闭？"),
    dispose({ kill = true } = {}) {
      disposed = true;
      clearTimeout(idleTimer);
      disconnect();
      ro?.disconnect();
      clearTimeout(fitTimer);
      if (term) { terms.delete(term); term.dispose(); }
      if (kill) api(`/api/terminals/${id}`, { method: "DELETE" }).catch(() => {});
    },
    persist: () => ({ k: "term", id }),
  };
}
