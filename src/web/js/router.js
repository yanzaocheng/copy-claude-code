// Routing by the address's #fragment, and the view on screen (what it leaves behind when another opens).

import { main, $$, $ } from "./util.js";
import { overview } from "./page-overview.js";
import { sessions, sessionView } from "./page-sessions.js";
import { markActive } from "./workspace.js";
import { newView } from "./page-new.js";
import { liveView } from "./page-live.js";
import { remotePage } from "./page-remote.js";
import { providers } from "./page-providers.js";
import { settings } from "./page-settings.js";
import { memory } from "./page-memory.js";
import { extensions } from "./page-extensions.js";
import { usage } from "./page-usage.js";
import { showUserMenu, setDrawer } from "./main.js";

// what the current view leaves behind (timers, streams), and how to close a menu that is open
export const view = { cleanup: null, closeMenu: null };
export function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("?")[0].split("/").map(decodeURIComponent); // (?tab=… is the view's own)
  const page = parts[0] || "new";
  $$("#nav a, .side-new").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
  $("#sideMe").classList.toggle("active", $$("#nav a").some((a) => a.dataset.nav === page)); // a page of its menu
  showUserMenu(false);
  markActive();
  $("#tip")?.classList.add("hidden");
  view.closeMenu?.();
  if (view.cleanup) { try { view.cleanup(); } catch { /* ignore */ } view.cleanup = null; }
  main.scrollTop = 0;
  setDrawer(false);
  const views = { new: newView, remote: remotePage, overview, sessions, session: () => sessionView(parts[1], parts[2]), live: () => (parts[1] ? liveView(parts[1]) : newView()), providers, settings, memory, extensions, usage };
  (views[page] || newView)();
}
// mode: true = full width, "chat" = the conversation layout (full height, its own scrolling)
export const page = (html, mode = false) => { main.innerHTML = `<div class="page${mode === "chat" ? " chat" : mode ? " wide" : ""}">${html}</div>`; return $(".page", main); };
