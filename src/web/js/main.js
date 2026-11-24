// The console's page (see server.js): one page, routed by the address's #fragment. This module starts it; the others
// are its parts.

import { esc, main, api, toast, fail, $ } from "./util.js";
import { modal } from "./dialogs.js";
import { view, route } from "./router.js";
import { loadWorkspace, wireSidebar } from "./workspace.js";
import { scheduleUpdateCheck } from "./update.js";

const theme = localStorage.getItem("cpTheme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.dataset.theme = theme;
$("#themeToggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("cpTheme", next);
});
window.addEventListener("hashchange", route);
wireSidebar();
// the account's menu: settings and the other pages
export function showUserMenu(open) {
  $("#userMenu").classList.toggle("hidden", !open);
  $("#sideMe").classList.toggle("open", open);
  $("#sideMe").setAttribute("aria-expanded", String(open));
}
$("#sideMe").addEventListener("click", () => showUserMenu($("#userMenu").classList.contains("hidden")));
document.addEventListener("mousedown", (e) => { if (!e.target.closest("#userMenu, #sideMe")) showUserMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") showUserMenu(false); });
export const mobileLayout = matchMedia("(max-width: 860px)");
const drawer = $(".side"), mobileMenu = $("#menuBtn");
export function setDrawer(open, { focus = false } = {}) {
  const mobile = mobileLayout.matches;
  open = mobile && open;
  if (focus && !open) mobileMenu.focus({ preventScroll: true });
  $(".app").classList.toggle("nav-open", open);
  mobileMenu.setAttribute("aria-expanded", String(open));
  drawer.inert = mobile && !open;
  main.inert = open;
  if (open && focus) $("#drawerClose")?.focus({ preventScroll: true });
  if (!open) showUserMenu(false);
}
const toggleDrawer = () => {
  view.closeMenu?.();
  setDrawer(!$(".app").classList.contains("nav-open"), { focus: true });
};
mobileMenu.addEventListener("click", toggleDrawer);
$("#drawerClose")?.addEventListener("click", toggleDrawer);
$("#sideBackdrop").addEventListener("click", () => { view.closeMenu?.(); setDrawer(false, { focus: true }); });
drawer.addEventListener("click", (e) => { if (e.target.closest('a[href^="#/"]')) { view.closeMenu?.(); setDrawer(false); } });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !view.closeMenu && !$(".modal-back") && $(".app").classList.contains("nav-open")) setDrawer(false, { focus: true }); });
mobileLayout.addEventListener("change", () => { view.closeMenu?.(); setDrawer(false); syncVisualHeight(); });
function syncVisualHeight() {
  const viewport = window.visualViewport;
  if (!mobileLayout.matches || !viewport || Math.abs(viewport.scale - 1) > 0.03) { document.documentElement.style.removeProperty("--visible-height"); return; }
  document.documentElement.style.setProperty("--visible-height", `${Math.round(viewport.height)}px`);
}
window.visualViewport?.addEventListener("resize", syncVisualHeight);
// 收起侧栏 (desktop): its button, the rail's, Ctrl+B (⌘B); kept for the next visits
const sideCollapsed = () => $(".app").classList.contains("side-collapsed");
function setSideHidden(hidden, { focus = false } = {}) {
  view.closeMenu?.();
  showUserMenu(false);
  $("#tip")?.classList.add("hidden");
  $(".app").classList.toggle("side-collapsed", hidden);
  $("#sideHide").setAttribute("aria-expanded", String(!hidden));
  $("#sideShow").setAttribute("aria-expanded", String(!hidden));
  try { if (hidden) localStorage.setItem("cpSideHidden", "1"); else localStorage.removeItem("cpSideHidden"); } catch { /* private mode */ }
  if (focus) (hidden ? $("#sideShow") : $("#sideHide")).focus({ preventScroll: true });
}
setSideHidden(localStorage.getItem("cpSideHidden") === "1");
$("#sideHide").addEventListener("click", () => setSideHidden(true, { focus: true }));
$("#sideShow").addEventListener("click", () => setSideHidden(false, { focus: true }));
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "b" || mobileLayout.matches) return;
  e.preventDefault();
  setSideHidden(!sideCollapsed());
});
setDrawer(false);
syncVisualHeight();
$("#logoutBtn").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); location.reload(); });
// The console took up new code (an update, an edit): this page is the old one, and the API may differ from it.
let pageCode = null, toldReload = false;
function noteServerCode(p) {
  if (!p?.code) return;
  pageCode ??= p.code;
  if (p.code === pageCode || toldReload) return;
  toldReload = true;
  const el = document.createElement("div");
  el.className = "reload-note"; // (not .toast: toast() reuses and removes that one)
  el.innerHTML = `控制台已更新到 v${esc(p.version)}：<button type="button" class="button small" data-reload>刷新页面</button>`;
  el.querySelector("[data-reload]").addEventListener("click", () => location.reload());
  document.body.appendChild(el);
}
// New code waits for the sessions to be idle, and a background agent may run long: said at the top with what holds
// it up, and a button that ends those agents. A turn running is not shown: it ends by itself and the switch follows.
// (Background programs are not in the way: they keep running and the new console takes them over.)
let pendingDismissed = "";
function notePending(p) {
  const old = $("#pendingNote");
  const pending = p?.pending;
  const held = (pending?.blockers || []).filter((b) => b.background.length);
  const key = held.map((b) => b.name + ":" + b.background.map((x) => x.id).join(",")).join("|");
  if (!pending || !held.length || key === pendingDismissed) { old?.remove(); return; }
  const what = held.map((b) => `<strong>${esc(b.title)}</strong>（${b.background.map((x) => `后台 agent「${esc(x.label)}」`).join("、")}）`).join("；");
  const others = (pending.blockers || []).filter((b) => !b.background.length && (b.turn || b.dialog || b.queued)).length;
  const html = `<span class="pending-text">新版本 v${esc(pending.version)} 已就绪，等这些会话空闲后自动切换：${what}${others ? `；另有 ${others} 个会话正在工作，完成后会自动继续` : ""}</span><button type="button" class="button small" data-clear>结束后台 agent 并更新</button><button type="button" class="icon-btn" data-dismiss title="先不管" aria-label="关闭">✕</button>`;
  const el = old || Object.assign(document.createElement("div"), { id: "pendingNote", className: "reload-note pending-note" });
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = html;
  el.querySelector("[data-dismiss]").addEventListener("click", () => { pendingDismissed = key; el.remove(); });
  el.querySelector("[data-clear]").addEventListener("click", async (e) => {
    if (!confirm(`结束这些后台 agent？${held.map((b) => b.background.map((x) => `\n· ${b.title}：${x.label}`).join("")).join("")}\n\n它们做到一半的工作会丢掉；后台程序（开发服务器等）不受影响，会继续运行。`)) return;
    e.currentTarget.disabled = true;
    try {
      const r = await api("/api/update/clear", { method: "POST", body: {} });
      el.remove();
      toast(`已结束 ${r.ended} 个后台 agent，控制台空闲后切换到新版本`);
    } catch (err) { fail(err); e.currentTarget.disabled = false; }
  });
  if (!old) document.body.appendChild(el);
}
// 安装为桌面应用: the browser's own install prompt (Chrome, Edge), offered in the settings menu while it can be
// shown; not inside the installed app itself
let installPrompt = null;
const installItem = $("#installApp");
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  installItem.classList.remove("hidden");
});
addEventListener("appinstalled", () => { installPrompt = null; installItem.classList.add("hidden"); toast("已安装：桌面和开始菜单里有 claude-pro 了"); });
installItem.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice.catch(() => ({}));
  if (outcome === "accepted") { installPrompt = null; installItem.classList.add("hidden"); }
});

let pingTick = 0;
api("/api/ping").then((p) => {
  noteServerCode(p);
  notePending(p);
  $("#brandVersion").textContent = `v${p.version}`;
  if (p.machine) $("#sideMe").title = `设置与更多 · ${p.machine}`;
  $("#remoteLinks").classList.toggle("hidden", !p.remote); // opened through 远程访问: switch computer, log out
  if (p.repo) { $("#repoLink").href = p.repo; $("#repoLink").classList.remove("hidden"); $("#repoSep").classList.remove("hidden"); }
  route();
  loadWorkspace();
  scheduleUpdateCheck();
  noticeNoProvider();
}).catch(() => {});
// A first start (nothing connected, not even 7bit.fun): said at once, with the way to the page that adds one. Once a
// browser session, and not on that page.
function noticeNoProvider() {
  if (sessionStorage.getItem("cpNoProviderShown")) return;
  api("/api/providers").then((v) => {
    if (v.gateway?.connected || [...(v.presets || []), ...(v.custom || [])].some((x) => x.connected)) return;
    if (location.hash.startsWith("#/providers") || sessionStorage.getItem("cpNoProviderShown")) return;
    sessionStorage.setItem("cpNoProviderShown", "1");
    const m = modal({
      title: "先添加一个模型供应商",
      body: `<p style="margin:0 0 10px">claude-pro 需要连上至少一个模型供应商才能工作：7bit.fun、DeepSeek、Kimi、OpenAI、OpenRouter……也可以是任何兼容 Anthropic 或 OpenAI 接口的服务。</p><p class="muted" style="margin:0;font-size:13px">添加之后，在「模型与供应商」里还能勾选会话里要用的模型、设置默认模型。</p>`,
      foot: '<button class="button secondary" data-close>稍后</button><button class="button" id="goAddProvider">添加供应商</button>',
    });
    $("#goAddProvider", m.el).addEventListener("click", () => {
      m.close();
      sessionStorage.setItem("cpOpenAdd", "1");
      if (location.hash === "#/providers") route(); else location.hash = "#/providers";
    });
    $("#goAddProvider", m.el).focus();
  }).catch(() => {});
}
// the sidebar follows the sessions (and keeps the server from stopping while the page is open)
setInterval(() => {
  const visible = document.visibilityState === "visible";
  if (visible) loadWorkspace();
  if (!visible || ++pingTick % 6 === 0) api("/api/ping").then((p) => { noteServerCode(p); notePending(p); }).catch(() => {}); // (every 30 s while looked at)
}, 5000);
