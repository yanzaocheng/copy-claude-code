// 新会话: a new conversation, in a directory chosen here.

import { esc, api, toast, fail, shortPath, ICON, $ } from "./util.js";
import { modal } from "./dialogs.js";
import { page } from "./router.js";
import { ws, projectKey, baseName, loadWorkspace } from "./workspace.js";
import { draftImages, draftText, saveDraft, composer, popMenu, modelMenuItems } from "./composer.js";
import { mobileLayout } from "./main.js";

// The folder browser (添加工作区, 其他目录…): in the page, so on top and at once, and the same from a phone (the
// folders are those of the computer claude-pro runs on). The places on the side, the path in pieces, the folder's
// subfolders (filtered as typed); the folder shown is the one chosen.
let dirPlaces = null; // (asked once a page load)
const samePath = (a, b) => Boolean(a && b) && a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
function pathCrumbs(p) {
  const win = /^[a-z]:[\\/]?/i.test(p);
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const out = win ? [] : [{ name: "/", path: "/" }];
  let acc = win ? "" : "/";
  parts.forEach((seg, i) => {
    acc = win ? (i === 0 ? `${seg}\\` : `${acc.replace(/\\?$/, "\\")}${seg}`) : `${acc.replace(/\/?$/, "/")}${seg}`;
    out.push({ name: seg, path: acc });
  });
  return out;
}
export function browseProjectDirectories(initial, onSelect, { title = "选择项目目录", action = "选择这个目录" } = {}) {
  const up = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  const m = modal({
    title, sub: "运行 claude-pro 的电脑上的目录",
    body: `<div class="dirp"><nav class="dirp-side" data-places><div class="muted">正在读取…</div></nav><section class="dirp-main">
        <div class="dirp-bar"><button type="button" class="icon-btn" data-up title="上一级" aria-label="上一级" disabled>${up}</button><div class="dirp-crumbs" data-crumbs></div></div>
        <input type="search" class="dirp-filter" data-filter placeholder="筛选当前目录里的文件夹…" autocomplete="off">
        <div class="dirp-list" data-list aria-live="polite"></div></section></div>`,
    foot: `<span class="dirp-chosen" data-chosen></span><button type="button" class="button secondary" data-close>取消</button><button type="button" class="button" data-use disabled>${esc(action)}</button>`,
  });
  const list = $("[data-list]", m.el), use = $("[data-use]", m.el), filter = $("[data-filter]", m.el);
  let listing = null, request = 0;
  const drawSide = () => {
    if (!dirPlaces) return;
    const group = (label, items) => (items.length ? `<div class="dirp-group">${label}</div>${items.map((p) => `<button type="button" class="dirp-place${samePath(p.path, listing?.cwd) ? " active" : ""}" data-go="${esc(p.path)}" title="${esc(p.path)}">${ICON.folder}<span>${esc(p.name)}</span></button>`).join("")}` : "");
    $("[data-places]", m.el).innerHTML = group("位置", dirPlaces.places) + group("磁盘", dirPlaces.drives) + group("最近的项目", dirPlaces.recent);
  };
  const drawList = () => {
    if (!listing) return;
    const q = filter.value.trim().toLowerCase();
    const rows = listing.dirs.map((d, n) => ({ d, n })).filter(({ d }) => !q || d.name.toLowerCase().includes(q));
    list.innerHTML = rows.map(({ d, n }) => `<button type="button" class="dirp-row${d.hidden ? " dim" : ""}" data-i="${n}">${ICON.folder}<span>${esc(d.name)}</span>${ICON.chevron}</button>`).join("")
      || `<div class="dirp-empty">${q ? "没有符合的文件夹" : "这里没有子文件夹，可以直接选择这个目录"}</div>`;
  };
  async function load(cwd, fallback = null) {
    const id = ++request;
    list.innerHTML = '<div class="dirp-empty">正在读取…</div>';
    try {
      const next = await api(`/api/projects/directories?cwd=${encodeURIComponent(cwd)}`);
      if (id !== request || !m.el.isConnected) return;
      listing = next;
      filter.value = "";
      $("[data-up]", m.el).disabled = !next.parent;
      $("[data-crumbs]", m.el).innerHTML = pathCrumbs(next.cwd).map((c, i, all) => (i === all.length - 1 ? `<span class="dirp-crumb current">${esc(c.name)}</span>` : `<button type="button" class="dirp-crumb" data-go="${esc(c.path)}">${esc(c.name)}</button><span class="dirp-sep">›</span>`)).join("");
      $("[data-chosen]", m.el).textContent = next.cwd;
      $("[data-chosen]", m.el).title = next.cwd;
      use.disabled = false;
      drawSide();
      drawList();
      if (!mobileLayout.matches) filter.focus();
    } catch (e) {
      if (id !== request) return;
      if (fallback) return load(fallback);
      list.innerHTML = `<div class="dirp-empty">${esc(e.message)}</div>`;
    }
  }
  m.el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-go")) load(b.dataset.go);
    else if (b.hasAttribute("data-up") && listing?.parent) load(listing.parent);
    else if (b.hasAttribute("data-i") && listing?.dirs[b.dataset.i]) load(listing.dirs[b.dataset.i].path);
    else if (b.hasAttribute("data-use") && listing?.cwd) { onSelect(listing.cwd); m.close(); }
  });
  filter.addEventListener("input", drawList);
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("[data-i]", list)?.click(); } // (the first match)
    else if (e.key === "Backspace" && !filter.value && listing?.parent) load(listing.parent);
  });
  (async () => {
    try { dirPlaces ||= await api("/api/projects/directories"); } catch { dirPlaces = { places: [], drives: [], recent: [], start: null }; }
    if (!m.el.isConnected) return;
    drawSide();
    const start = dirPlaces.start || dirPlaces.places[0]?.path;
    if (initial) load(initial, start); else if (start) load(start); else list.innerHTML = '<div class="dirp-empty">在左边选一个位置</div>';
  })();
}

export async function newView() {
  const el = page(`<div class="chat-page"><div class="welcome"><img class="welcome-logo" src="/favicon.svg" alt="" width="56" height="56"><h1>你好，今天要做什么？</h1><p class="muted">选一个项目目录，告诉它要做什么：你在这里看着它工作、随时给它发消息。</p></div><div class="chat-composer" id="ncomp"></div></div>`, "chat");
  let projects = [];
  try { projects = (await api("/api/projects")).projects; } catch { /* the folder chooser still works */ }
  if (!el.isConnected) return;
  let dir = localStorage.getItem("cpNewDir") || projects[0]?.cwd || "";
  let model, effort, configRequest = 0;
  const c = composer($("#ncomp", el), {
    placeholder: "描述你要它做的事，/命令 也可以。Enter 发送，Shift+Enter 换行",
    left: `<button type="button" class="chip" id="ndir" title="会话在哪个目录里工作">${ICON.folder}<span></span>${ICON.caret}</button>`,
    right: `<button type="button" class="chip" id="nmodel" title="选择模型"><span>模型</span>${ICON.caret}</button><button type="button" class="chip" id="neffort" title="选择思考强度"><span>思考强度</span>${ICON.caret}</button>`,
    onSend: async (text, images) => startSession(dir, text, images, { model, effort }),
    draftKey: "new",
  });
  const chip = $("#ndir", el);
  const paintDir = () => { $("span", chip).textContent = dir ? baseName(dir) : "选择目录"; chip.title = dir ? `会话在 ${dir} 里工作` : "选择目录"; };
  paintDir();
  const modelChip = $("#nmodel", el), effortChip = $("#neffort", el);
  const options = (kind) => api(`/api/live/new/options?${new URLSearchParams({ cwd: dir, kind, ...(model ? { model } : {}), ...(effort ? { effort } : {}) })}`);
  function paintChoices(info) {
    $("span", modelChip).textContent = info.model || "模型";
    modelChip.title = `选择模型${info.model ? `：${info.model}` : ""}`;
    $("span", effortChip).textContent = info.effort === "auto" || !info.effort ? "思考强度：自动" : `思考强度：${info.effort}`;
  }
  async function refreshChoices() {
    const seq = ++configRequest;
    try { const info = await options("summary"); if (el.isConnected && seq === configRequest) paintChoices(info); } catch { /* the menus can try again */ }
  }
  const selectDir = (value) => {
    if (!value || !el.isConnected) return;
    dir = value;
    localStorage.setItem("cpNewDir", dir);
    paintDir();
    refreshChoices();
  };
  for (const [anchor, kind] of [[modelChip, "models"], [effortChip, "efforts"]]) {
    anchor.addEventListener("click", async () => {
      const currentDir = dir;
      anchor.disabled = true;
      try {
        const info = await options(kind);
        if (!el.isConnected || dir !== currentDir) return;
        const isModel = kind === "models";
        const items = isModel ? modelMenuItems(info.models) : (info.efforts || []).map((item) => ({ ...item, label: item.value === "default" ? "项目默认" : item.label, current: item.value === info.effortChoice }));
        if (!items.length) return toast(isModel ? "没有可选的模型" : "这个模型不能调推理强度");
        popMenu(anchor, [{ key: kind, title: isModel ? "模型" : "思考强度", items }], (_, value) => {
          if (isModel) { if (model !== value) effort = undefined; model = value; }
          else effort = value;
          refreshChoices();
        });
      } catch (e) { fail(e); } finally { anchor.disabled = false; }
    });
  }
  refreshChoices();
  chip.addEventListener("click", () => {
    popMenu(chip, [
      { key: "dir", title: "最近的项目", items: projects.slice(0, 12).map((p) => ({ label: baseName(p.cwd), description: shortPath(p.cwd), value: p.cwd, current: p.cwd === dir })) },
      { key: "other", title: "", items: [{ label: "其他目录…", value: "" }] },
    ], async (key, value) => {
      if (key !== "other") return selectDir(value);
      browseProjectDirectories(dir, selectDir, { title: "新会话的目录", action: "在这个目录里开始" });
    });
  });
  if (!mobileLayout.matches) c.input.focus();
}

export const pendingFirstSends = new Set();
export function queueFirstMessage(peerId, text, images = []) {
  const key = `live:${peerId}`;
  if (draftText(key) || draftImages.has(key)) throw new Error("该会话已有未发送的草稿，本条消息仍保留在当前输入框");
  saveDraft(key, text, images.map((img) => ({ ...img, url: `data:${img.media_type};base64,${img.data}` })));
  pendingFirstSends.add(peerId);
}

// What a project would run or change (see projectRisk in config.js), shown before its first session: resolves true
// (trust it), false (start without them).
function askProjectTrust(dir, trust) {
  const labels = { mcp: "MCP 服务器（会启动的程序）", hooks: "hooks（会执行的命令）", env: "环境变量（可以改网关、shell 等）" };
  const rows = Object.entries(labels).map(([k, label]) => [label, trust.items.filter((i) => i.kind === k).map((i) => i.name)]).filter(([, n]) => n.length);
  const files = [...new Set(trust.items.map((i) => i.file))];
  return new Promise((resolve) => {
    let answered = false;
    const m = modal({
      title: "信任这个项目吗？", sub: dir,
      body: `<p style="margin:0 0 10px">这个项目带有会在本机运行程序或改变设置的配置，只在你信得过它时启用（比如是你自己的项目）。</p>
          ${rows.map(([label, names]) => `<div class="file-row"><span class="name" style="min-width:auto">${esc(label)}</span><span class="desc mono">${esc(names.join("、"))}</span></div>`).join("")}
          <p class="muted" style="font-size:12.5px;margin:10px 0 0">来自 ${files.map((f) => `<code>${esc(f)}</code>`).join("、")}。配置改了会再问。</p>`,
      foot: '<button class="button secondary" data-no>这次不启用</button><button class="button" data-yes>信任并启用</button>',
      onClose: () => { if (!answered) resolve(false); },
    });
    const done = (v) => { answered = true; m.close(); resolve(v); };
    $("[data-yes]", m.el).addEventListener("click", () => done(true));
    $("[data-no]", m.el).addEventListener("click", () => done(false));
  });
}

// A new session in `dir`, run by the console; it is opened here and the message goes to it.
export async function startSession(dir, text, images, choices = {}) {
  if (!dir) throw new Error("先选一个目录");
  const here = location.hash;
  const before = new Set(ws.live.map((r) => r.peerId));
  let r;
  try { r = await api("/api/live/new", { method: "POST", body: { cwd: dir, ...choices } }); }
  catch (e) {
    // a project whose hooks, MCP servers or env are not trusted yet: asked here, then started with the answer
    if (e.status !== 409 || !e.data?.trust) throw e;
    const trust = await askProjectTrust(dir, e.data.trust);
    r = await api("/api/live/new", { method: "POST", body: { cwd: dir, ...choices, trust, trustHash: e.data.trust.hash } });
  }
  localStorage.setItem("cpNewDir", r.cwd);
  const until = Date.now() + 30_000;
  let found = r.peerId ? { peerId: r.peerId } : null;
  while (!found && Date.now() < until) {
    await new Promise((res) => setTimeout(res, 1000));
    try { found = (await api("/api/live")).sessions.find((x) => !before.has(x.peerId) && projectKey(x.status?.cwd || x.cwd) === projectKey(r.cwd)); } catch { /* again */ }
  }
  if (!found) throw new Error("会话 30 秒内没有上线：可能是启动出错了，在终端里运行 claude-pro 看看");
  if (text || images?.length) queueFirstMessage(found.peerId, text, images);
  loadWorkspace({ afterPending: true });
  if (location.hash === here) location.hash = `#/live/${found.peerId}`;
}
