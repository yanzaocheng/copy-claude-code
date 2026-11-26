// 源代码管理, under the file tree of the panel's workbench (dock-workbench.js), as in VS Code: the branch and how far it
// is from its upstream (click: switch or make a branch), a box for the commit message (Ctrl+Enter commits; with
// nothing staged, everything is committed once asked), and the changes: 合并冲突, 暂存的更改, 更改. A change opens
// as a diff (dock-editor.js diffPane); each one, and each group, can be staged, unstaged, discarded. The status is
// asked again every few seconds while the section is shown and open (git.js; without taking the index lock).

import { esc, api, toast, fail, $ } from "./util.js";
import { modal } from "./dialogs.js";
import { popMenu } from "./composer.js";
import { fileIcon, baseOf, copyText, menuAt } from "./dock-util.js";

const REFRESH_MS = 5000;
const STATUS = { M: ["已修改", "mod"], A: ["已添加", "add"], D: ["已删除", "del"], R: ["已重命名", "add"], C: ["已复制", "add"], U: ["未跟踪", "add"], T: ["类型改变", "mod"], "!": ["冲突", "del"] };
const CHEV = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const BRANCH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11.2 8.3"/></svg>';
const I = (d, w = 15) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  refresh: I('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  pull: I('<path d="M12 4v12M6 11l6 6 6-6M5 21h14"/>'),
  push: I('<path d="M12 20V8M6 13l6-6 6 6M5 3h14"/>'),
  more: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  stage: I('<path d="M12 5v14M5 12h14"/>'),
  unstage: I('<path d="M5 12h14"/>'),
  discard: I('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  open: I('<path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>'),
  check: I('<path d="m5 12 5 5L20 7"/>', 14),
};

// ctx: {cwd, openDiff({root, rel, staged}), openFile(path), reveal(path)}
export function gitPanel(ctx) {
  const el = document.createElement("div");
  el.className = "wb-git";
  el.innerHTML = `<div class="sec-head" data-sec><span class="sec-chev">${CHEV}</span><span class="sec-title">源代码管理</span><span class="sec-count"></span><span class="sec-gap"></span><span class="sec-acts"><button type="button" class="icon-btn" data-g="refresh" title="刷新">${ICONS.refresh}</button><button type="button" class="icon-btn" data-g="pull" title="拉取（git pull）">${ICONS.pull}</button><button type="button" class="icon-btn" data-g="push" title="推送（git push）">${ICONS.push}</button><button type="button" class="icon-btn" data-g="more" title="更多">${ICONS.more}</button></span></div>
    <div class="git-body"><div class="ft-note">正在读取…</div></div>`;
  const body = $(".git-body", el);
  let st = null, timer = 0, shown = false, busy = "", sig = "";
  let open = localStorage.getItem("cpDockGitOpen") !== "0";
  let message = "";
  const collapsed = new Set(); // groups folded: "conflicts" | "staged" | "changes"
  el.classList.toggle("closed", !open);

  const all = (list) => list.map((c) => c.rel);
  const post = async (what, extra = {}) => api(`/api/git/${what}`, { method: "POST", body: { cwd: ctx.cwd, ...extra } });
  async function act(label, fn) {
    if (busy) return;
    busy = label;
    paintBusy();
    try { await fn(); } catch (e) { failLong(e); } finally { busy = ""; paintBusy(); await refresh(true); }
  }
  // git's own message can be long (a hook, a rejected push): shown whole
  function failLong(e) {
    const text = String(e?.message || e);
    if (text.length < 120 && !text.includes("\n")) { fail(e); return; }
    modal({ title: "git 没有完成", body: `<pre class="git-err">${esc(text)}</pre>`, foot: '<button type="button" class="button" data-close>知道了</button>' });
  }
  function paintBusy() {
    el.classList.toggle("busy", Boolean(busy));
    const b = $(".git-busy", el);
    if (b) b.textContent = busy ? `${busy}…` : "";
  }

  function row(c, group) {
    const [label, cls] = STATUS[c.status] || [c.status, "mod"];
    const name = baseOf(c.rel), dir = c.rel.slice(0, Math.max(0, c.rel.length - name.length - 1));
    const acts = group === "staged"
      ? `<button type="button" class="icon-btn" data-a="open" title="打开文件">${ICONS.open}</button><button type="button" class="icon-btn" data-a="unstage" title="取消暂存">${ICONS.unstage}</button>`
      : `<button type="button" class="icon-btn" data-a="open" title="打开文件">${ICONS.open}</button>${group === "changes" ? `<button type="button" class="icon-btn" data-a="discard" title="放弃更改">${ICONS.discard}</button>` : ""}<button type="button" class="icon-btn" data-a="stage" title="${group === "conflicts" ? "标记为已解决（暂存）" : "暂存更改"}">${ICONS.stage}</button>`;
    return `<div class="git-row${c.status === "D" ? " gone" : ""}" data-rel="${esc(c.rel)}" data-group="${group}" title="${esc(`${c.rel} · ${label}${c.orig ? `（原来是 ${c.orig}）` : ""}`)}">${fileIcon(name)}<span class="git-name">${esc(name)}</span><span class="git-dir">${esc(dir)}</span><span class="git-acts">${acts}</span><span class="git-st ${cls}">${esc(c.status === "U" ? "U" : c.status)}</span></div>`;
  }
  function group(key, title, list, acts) {
    if (!list.length) return "";
    const folded = collapsed.has(key);
    return `<div class="git-group${folded ? " folded" : ""}" data-gk="${key}"><span class="sec-chev">${CHEV}</span><span>${title}</span><span class="git-gacts">${acts}</span><span class="git-n">${list.length}</span></div>${folded ? "" : list.map((c) => row(c, key)).join("")}`;
  }

  function draw() {
    if (!st) return;
    const count = st.repo ? st.staged.length + st.changes.length + st.conflicts.length : 0;
    $(".sec-count", el).textContent = count ? String(count) : "";
    $(".sec-acts", el).hidden = !st.repo;
    if (!st.repo) {
      body.innerHTML = `<div class="git-empty"><p>这个文件夹不是 Git 仓库。</p><button type="button" class="button small" data-g="init">初始化仓库</button></div>`;
      return;
    }
    const focusedBox = document.activeElement?.classList?.contains("git-msg");
    const box = $(".git-msg", el);
    if (box) message = box.value;
    const sync = st.upstream ? `${st.behind ? ` ↓${st.behind}` : ""}${st.ahead ? ` ↑${st.ahead}` : ""}` : " · 未发布";
    const nothingStaged = !st.staged.length;
    const canCommit = st.staged.length || st.changes.length;
    body.innerHTML = `<div class="git-top"><button type="button" class="git-branch" data-g="branch" title="${esc(st.upstream ? `${st.branch || "（分离的 HEAD）"} → ${st.upstream}：点击切换分支` : "点击切换或新建分支")}">${BRANCH}<span>${esc(st.branch || "（分离的 HEAD）")}</span><span class="git-sync">${esc(sync)}</span></button><span class="git-busy"></span></div>
      <div class="git-commit"><textarea class="git-msg" rows="1" placeholder="提交信息（Ctrl+Enter 提交）" title="提交到「${esc(st.branch || "HEAD")}」" spellcheck="false"></textarea><button type="button" class="button small git-commit-btn" data-g="commit"${canCommit ? "" : " disabled"} title="${nothingStaged && canCommit ? "没有暂存的更改：会先暂存全部更改" : ""}">${ICONS.check}${nothingStaged && canCommit ? "全部提交" : "提交"}</button></div>
      <div class="git-list">${group("conflicts", "合并冲突", st.conflicts, "")}${group("staged", "暂存的更改", st.staged, `<button type="button" class="icon-btn" data-ga="unstage" title="全部取消暂存">${ICONS.unstage}</button>`)}${group("changes", "更改", st.changes, `<button type="button" class="icon-btn" data-ga="discard" title="放弃所有更改">${ICONS.discard}</button><button type="button" class="icon-btn" data-ga="stage" title="暂存所有更改">${ICONS.stage}</button>`)}${count ? "" : '<div class="ft-note">没有更改</div>'}${st.truncated ? '<div class="ft-note">更改太多，只列出了前 5000 个</div>' : ""}</div>`;
    const area = $(".git-msg", el);
    area.value = message;
    fit(area);
    if (focusedBox) { area.focus(); area.setSelectionRange(area.value.length, area.value.length); }
    paintBusy();
  }
  const fit = (area) => { area.style.height = "auto"; area.style.height = `${Math.min(160, area.scrollHeight + 2)}px`; };

  async function refresh(force = false) {
    if (!force && (!shown || !open || document.visibilityState !== "visible")) return;
    try {
      const next = await api(`/api/git/status?cwd=${encodeURIComponent(ctx.cwd)}`);
      const s = JSON.stringify(next);
      if (s === sig) return;
      sig = s;
      st = next;
      draw(); // (what is typed in the message box, and the cursor in it, live through it)
    } catch (e) { body.innerHTML = `<div class="ft-note err">${esc(e.message)}</div>`; sig = ""; }
  }

  // ---- what is done
  const changeOf = (target) => {
    const r = target.closest("[data-rel]");
    if (!r || !st?.repo) return null;
    const list = r.dataset.group === "staged" ? st.staged : r.dataset.group === "conflicts" ? st.conflicts : st.changes;
    const c = list.find((x) => x.rel === r.dataset.rel);
    return c && { ...c, group: r.dataset.group };
  };
  const pathOf = (rel) => `${st.root}${st.root.includes("\\") ? "\\" : "/"}${rel.replace(/\//g, st.root.includes("\\") ? "\\" : "/")}`;
  function confirmDiscard(list) {
    const untracked = list.filter((c) => c.status === "U").length;
    return new Promise((resolve) => {
      const one = list.length === 1;
      const m = modal({
        title: one ? `放弃「${baseOf(list[0].rel)}」的更改？` : `放弃 ${list.length} 个文件的更改？`,
        body: `<p style="margin:0">${untracked ? `其中 ${untracked} 个新文件会移到回收站；` : ""}${list.length > untracked ? "已跟踪文件的修改会丢掉，回到暂存区（或上次提交）里的样子，不能撤销。" : ""}</p>`,
        foot: '<button type="button" class="button secondary" data-close>取消</button><button type="button" class="button danger" data-ok>放弃更改</button>',
        onClose: () => resolve(false),
      });
      const ok = $("[data-ok]", m.el);
      ok.focus();
      ok.addEventListener("click", () => { resolve(true); m.close(); });
    });
  }
  const stage = (list) => act("正在暂存", () => post("stage", { paths: all(list) }));
  const unstage = (list) => act("正在取消暂存", () => post("unstage", { paths: all(list) }));
  async function discard(list) {
    if (!list.length || !(await confirmDiscard(list))) return;
    act("正在放弃更改", () => post("discard", { items: list.map((c) => ({ rel: c.rel, untracked: c.status === "U" })) }));
  }
  async function commit() {
    const area = $(".git-msg", el);
    const text = (area?.value || "").trim();
    if (!st?.repo || busy) return;
    if (!text) { toast("先写提交信息"); area?.focus(); return; }
    const everything = !st.staged.length;
    if (everything && !st.changes.length) { toast("没有可以提交的更改"); return; }
    act("正在提交", async () => {
      const r = await post("commit", { message: text, all: everything });
      message = "";
      if (area) area.value = "";
      toast(`已提交 ${r.hash} 到「${st.branch || "HEAD"}」`);
    });
  }
  async function branchMenu(anchor) {
    let list;
    try { list = (await api(`/api/git/branches?cwd=${encodeURIComponent(ctx.cwd)}`)).branches; } catch (e) { fail(e); return; }
    popMenu(anchor, [
      { key: "b", title: "切换分支", items: list.map((b) => ({ label: b, value: b, current: b === st.branch })) },
      { key: "n", title: "", items: [{ label: "新建分支…", description: "从当前所在的提交新建，并切换过去", value: "" }] },
    ], (k, v) => {
      if (k === "n") newBranch();
      else if (v !== st.branch) act(`正在切换到 ${v}`, () => post("checkout", { branch: v }));
    }, { dropdown: true });
  }
  function newBranch() {
    const m = modal({
      title: "新建分支", sub: `从「${st.branch || "HEAD"}」新建，并切换过去`,
      body: '<input class="git-newbranch" style="width:100%" placeholder="分支名，比如 feature/login" spellcheck="false">',
      foot: '<button type="button" class="button secondary" data-close>取消</button><button type="button" class="button" data-ok>新建并切换</button>',
    });
    const input = $(".git-newbranch", m.el);
    input.focus();
    const go = () => {
      const name = input.value.trim();
      if (!name) return;
      m.close();
      act(`正在新建 ${name}`, () => post("checkout", { branch: name, create: true }));
    };
    $("[data-ok]", m.el).addEventListener("click", go);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
  }

  el.addEventListener("click", (e) => {
    const g = e.target.closest("[data-g]")?.dataset.g;
    if (g) {
      e.stopPropagation();
      if (g === "refresh") { sig = ""; refresh(true); }
      else if (g === "pull") act("正在拉取", () => post("pull"));
      else if (g === "push") act("正在推送", () => post("push"));
      else if (g === "commit") commit();
      else if (g === "branch") branchMenu(e.target.closest("[data-g]"));
      else if (g === "init") act("正在初始化", () => post("init"));
      else if (g === "more") {
        const has = st?.repo;
        popMenu(e.target.closest("[data-g]"), [{ key: "m", title: "", items: [
          { label: "抓取", description: "git fetch --prune", value: "fetch" },
          { label: "拉取", description: "git pull", value: "pull" },
          { label: "推送", description: st?.upstream ? "git push" : "还没有上游：推送并建立跟踪（git push -u）", value: "push" },
          { label: "切换分支…", value: "branch" }, { label: "新建分支…", value: "newbranch" },
          ...(has && st.changes.length ? [{ label: "暂存所有更改", value: "stageall" }] : []),
          ...(has && st.staged.length ? [{ label: "全部取消暂存", value: "unstageall" }] : []),
          ...(has && st.changes.length ? [{ label: "放弃所有更改", value: "discardall", danger: true }] : []),
        ] }], (k, v) => {
          if (v === "fetch" || v === "pull" || v === "push") act({ fetch: "正在抓取", pull: "正在拉取", push: "正在推送" }[v], () => post(v));
          else if (v === "branch") branchMenu($(".git-branch", el) || e.target);
          else if (v === "newbranch") newBranch();
          else if (v === "stageall") stage(st.changes);
          else if (v === "unstageall") unstage(st.staged);
          else if (v === "discardall") discard(st.changes);
        }, { dropdown: true });
      }
      return;
    }
    if (e.target.closest("[data-sec]")) {
      open = !open;
      localStorage.setItem("cpDockGitOpen", open ? "1" : "0");
      el.classList.toggle("closed", !open);
      if (open) refresh(true);
      return;
    }
    const gk = e.target.closest("[data-gk]");
    if (gk) {
      const ga = e.target.closest("[data-ga]")?.dataset.ga;
      const key = gk.dataset.gk;
      const list = key === "staged" ? st.staged : key === "conflicts" ? st.conflicts : st.changes;
      if (ga === "stage") stage(list);
      else if (ga === "unstage") unstage(list);
      else if (ga === "discard") discard(list);
      else { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); draw(); }
      return;
    }
    const c = changeOf(e.target);
    if (!c) return;
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "open") ctx.openFile(pathOf(c.rel));
    else if (a === "stage") stage([c]);
    else if (a === "unstage") unstage([c]);
    else if (a === "discard") discard([c]);
    else ctx.openDiff({ rel: c.rel, staged: c.group === "staged" });
  });
  el.addEventListener("contextmenu", (e) => {
    const c = changeOf(e.target);
    if (!c) return;
    e.preventDefault();
    const items = [{ label: "打开更改", value: "diff" }, { label: "打开文件", value: "open" }];
    if (c.group === "staged") items.push({ label: "取消暂存", value: "unstage" });
    else items.push({ label: c.group === "conflicts" ? "标记为已解决（暂存）" : "暂存更改", value: "stage" });
    if (c.group === "changes") items.push({ label: "放弃更改", value: "discard", danger: true });
    items.push({ label: "在文件列表中显示", value: "reveal" }, { label: "复制路径", value: "copy" }, { label: "复制相对路径", value: "copyrel" });
    menuAt(e.clientX, e.clientY, items, (v) => {
      if (v === "diff") ctx.openDiff({ rel: c.rel, staged: c.group === "staged" });
      else if (v === "open") ctx.openFile(pathOf(c.rel));
      else if (v === "stage") stage([c]);
      else if (v === "unstage") unstage([c]);
      else if (v === "discard") discard([c]);
      else if (v === "reveal") ctx.reveal(pathOf(c.rel));
      else if (v === "copy") copyText(pathOf(c.rel));
      else if (v === "copyrel") copyText(c.rel, "相对路径");
    });
  });
  el.addEventListener("input", (e) => { if (e.target.classList.contains("git-msg")) { message = e.target.value; fit(e.target); } });
  el.addEventListener("keydown", (e) => {
    if (e.target.classList.contains("git-msg") && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
  });

  return {
    el,
    get open() { return open; },
    activate() {
      shown = true;
      refresh(true);
      clearInterval(timer);
      timer = setInterval(refresh, REFRESH_MS);
    },
    deactivate() { shown = false; clearInterval(timer); },
    refresh: () => refresh(true),
    dispose() { clearInterval(timer); },
  };
}
