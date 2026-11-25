// 我的电脑: the computers paired with this one (devices.js on the server), pairing another (a code shown here or typed
// here), and the requests of the paired computers set to ask first, shown on top of every page.

import { esc, api, toast, fail, fmtTime, ago, ICON, $, $$ } from "./util.js";
import { modal } from "./dialogs.js";
import { view, page } from "./router.js";
import { ws, loadWorkspace } from "./workspace.js";

export async function devicesPage() {
  const el = page(`<div class="page-head"><div><h1>我的电脑</h1><p class="sub">和你的其他电脑配对后，两边的会话可以互相 @、互发任务。像远程桌面一样：一台显示配对码，另一台输入。不需要任何账号，用哪家模型都可以；消息端到端加密，中转服务器看不到内容。</p></div><button class="button" id="devAdd">${ICON.plus || ""}添加电脑</button></div><div id="body"><div class="empty">正在加载…</div></div>`);
  $("#devAdd", el).addEventListener("click", () => addComputer(el));
  await draw(el);
  // (sessions come and go on the other computers: their count is asked again now and then)
  const timer = setInterval(() => { if (!document.querySelector(".modal-back")) draw(el); }, 15_000);
  view.cleanup = () => clearInterval(timer);
}

async function draw(el, d = null) {
  const box = $("#body", el);
  if (!box) return;
  try { d ||= await api("/api/devices"); } catch (e) { box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  if (!box.isConnected) return;
  const state = (x) => (x.sessions == null ? '<span class="muted">—</span>'
    : x.sessions ? `<span class="pill ok">在线 · ${x.sessions} 个会话</span>` : `<span class="pill off">没有会话在线</span>${x.lastSeen ? ` <span class="muted" style="font-size:12px">最近 ${esc(ago(x.lastSeen))}</span>` : ""}`);
  box.innerHTML = `
    <div class="panel panel-pad dev-me"><div><div class="muted" style="font-size:12.5px">本机</div><div style="font-weight:650;margin-top:2px">${esc(d.me.name)}</div>${d.me.id ? `<div class="mono faint" style="font-size:12px" title="设备 ID：第一次用到时生成，之后不变">设备 ${esc(d.me.id)}</div>` : ""}</div>
      <div class="muted" style="font-size:12.5px;max-width:420px">同一台电脑上的会话之间直接互发任务，不需要配对。在设置里改 <span class="mono">CLAUDE_PRO_MACHINE_NAME</span> 可以给本机起个好认的名字。</div></div>
    <div class="section-head"><div><h2>已配对的电脑</h2><p>${d.devices.length} 台</p></div></div>
    <div class="panel">${d.devices.length ? `<table class="list"><tbody>${d.devices.map((x) => `<tr>
        <td><strong>${esc(x.name)}</strong> <span class="mono faint" style="font-size:12px">${esc(x.id.slice(0, 8))}</span></td>
        <td>${state(x)}</td>
        <td><label class="dev-mode">发来的任务 <select data-mode="${esc(x.id)}"><option value="run"${x.mode === "run" ? " selected" : ""}>直接执行</option><option value="ask"${x.mode === "ask" ? " selected" : ""}>每次询问</option></select></label></td>
        <td class="muted">配对于 ${esc(fmtTime(x.pairedAt))}</td>
        <td class="num"><button class="button danger small" data-unpair="${esc(x.id)}" data-name="${esc(x.name)}">取消配对</button></td></tr>`).join("")}</tbody></table>`
      : '<div class="empty">还没有配对的电脑。点右上角「添加电脑」：在一台上显示配对码，到另一台上输入。</div>'}</div>`;
  $$("[data-mode]", box).forEach((s) => s.addEventListener("change", async () => {
    try { draw(el, await api("/api/devices/mode", { method: "POST", body: { id: s.dataset.mode, mode: s.value } })); toast(s.value === "ask" ? "它发来的任务会先问你" : "它发来的任务会直接执行"); } catch (err) { fail(err); }
  }));
  $$("[data-unpair]", box).forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`取消和「${b.dataset.name}」的配对？两边的会话就不能再互发任务了，它那边也会删掉本机。`)) return;
    try { draw(el, await api("/api/devices/remove", { method: "POST", body: { id: b.dataset.unpair } })); toast("已取消配对"); } catch (err) { fail(err); }
  }));
}

// 添加电脑: show a code here (the other computer types it), or type the code the other one shows.
function addComputer(el) {
  let poll = null;
  let showing = false;
  const m = modal({
    title: "添加电脑",
    sub: "一台显示配对码，另一台输入，两台就配对好了",
    body: `<div class="tabs" role="tablist"><a href="#" data-tab="show" class="active">显示配对码</a><a href="#" data-tab="type">输入配对码</a></div><div id="pairPane"></div>`,
    onClose: () => { clearInterval(poll); if (showing) api("/api/pair/cancel", { method: "POST" }).catch(() => {}); draw(el); },
  });
  const pane = $("#pairPane", m.el);
  const tabs = $$("[data-tab]", m.el);
  const select = (name) => {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    clearInterval(poll);
    if (showing && name !== "show") { api("/api/pair/cancel", { method: "POST" }).catch(() => {}); showing = false; }
    if (name === "show") showCode(); else typeCode();
  };
  tabs.forEach((t) => t.addEventListener("click", (e) => { e.preventDefault(); select(t.dataset.tab); }));

  const done = (device) => {
    showing = false;
    clearInterval(poll);
    pane.innerHTML = `<div class="pair-done">${ICON.check || "✔"}<div><div style="font-weight:650">已与「${esc(device.name)}」配对</div><div class="muted" style="font-size:13px;margin-top:4px">两边的会话现在可以互相 @、互发任务了。它的任务默认直接执行，可以在列表里改成「每次询问」。</div></div></div><div class="actions" style="justify-content:flex-end;margin-top:14px"><button class="button" data-close>完成</button></div>`;
    toast(`已与「${device.name}」配对`);
  };

  async function showCode() {
    pane.innerHTML = '<div class="empty">正在生成配对码…</div>';
    let p;
    try { p = await api("/api/pair/open", { method: "POST" }); } catch (e) { pane.innerHTML = `<div class="pair-error">${esc(e.message)}</div><div class="actions"><button class="button" id="pairAgain">重试</button></div>`; $("#pairAgain", pane).addEventListener("click", showCode); return; }
    showing = true;
    const code = String(p.code).replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");
    pane.innerHTML = `<div class="pair-code mono" aria-label="配对码">${esc(code)}</div>
      <div class="pair-left muted" id="pairLeft"></div>
      <ol class="pair-steps"><li>到另一台电脑上打开 claude-pro 控制台：<b>我的电脑 → 添加电脑 → 输入配对码</b>，填上面的 9 位数字</li><li>或者在那台电脑的终端会话里输入 <span class="mono">/pair ${esc(p.code)}</span></li></ol>
      <div class="pair-wait"><span class="spinner"></span>等待另一台电脑输入…</div>
      <p class="muted" style="font-size:12px;margin:10px 0 0">配对码 10 分钟内有效，输错 3 次就作废。只告诉你自己：知道它的人能在这 10 分钟里把他的电脑配对进来。</p>`;
    const left = () => { const s = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000)); const box = $("#pairLeft", pane); if (box) box.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} 后失效`; };
    left();
    poll = setInterval(async () => {
      left();
      let st;
      try { st = (await api("/api/pair")).pairing; } catch { return; }
      if (!st || st.state === "waiting") return;
      clearInterval(poll);
      if (st.state === "paired") return done(st.device);
      showing = false;
      pane.innerHTML = `<div class="pair-error">${esc(st.error || "配对没有完成")}</div><div class="actions"><button class="button" id="pairAgain">重新生成配对码</button></div>`;
      $("#pairAgain", pane).addEventListener("click", showCode);
    }, 1500);
  }

  function typeCode() {
    pane.innerHTML = `<label class="field">另一台电脑上显示的配对码<input id="pairInput" class="mono pair-input" inputmode="numeric" autocomplete="off" maxlength="13" placeholder="482 913 706"></label>
      <div class="actions"><button class="button" id="pairJoin">配对</button><span class="modal-error" id="pairErr"></span></div>`;
    const input = $("#pairInput", pane);
    input.focus();
    const join = async () => {
      const err = $("#pairErr", pane);
      err.textContent = "";
      const digits = input.value.replace(/\D/g, "");
      if (digits.length !== 9) { err.textContent = "配对码是 9 位数字"; input.focus(); return; }
      const b = $("#pairJoin", pane);
      b.disabled = true; b.textContent = "正在配对…";
      try { done((await api("/api/pair/join", { method: "POST", body: { code: digits } })).device); }
      catch (e) { err.textContent = e.message; b.disabled = false; b.textContent = "配对"; }
    };
    $("#pairJoin", pane).addEventListener("click", join);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
  }
  showCode();
}

// A paired computer set to ask first wants one of the sessions here to run a task (see App.askPeerTask): shown on top
// of every page, whatever session is open, and answered as the session's dialog.
const authAnswered = new Set();
export function drawAuthRequests() {
  let stack = $("#authStack");
  const requests = [];
  for (const l of ws.live) for (const r of l.status?.authRequests || []) if (!authAnswered.has(`${l.peerId}:${r.id}`)) requests.push({ ...r, live: l });
  if (!requests.length) { stack?.remove(); return; }
  if (!stack) { stack = document.createElement("div"); stack.id = "authStack"; stack.className = "auth-stack"; stack.setAttribute("role", "alert"); document.body.append(stack); }
  const key = (r) => `${r.live.peerId}:${r.id}`;
  const shown = new Set(requests.map(key));
  for (const card of $$(".auth-card", stack)) if (!shown.has(card.dataset.key)) card.remove();
  const LABELS = { once: "允许这一次", decline: "拒绝" };
  for (const r of requests) {
    if ($(`.auth-card[data-key="${CSS.escape(key(r))}"]`, stack)) continue;
    const target = r.live.status?.title || r.live.name || "会话";
    const card = document.createElement("div");
    card.className = "auth-card";
    card.dataset.key = key(r);
    card.innerHTML = `<h3>${ICON.shield}配对的电脑请求执行任务</h3>
        <div class="auth-from">「<strong>${esc(r.machine)}</strong>」上的会话 @${esc(r.from)} 想让这里的「${esc(target)}」执行：</div>
        <div class="auth-text">${esc(r.text)}</div>
        <div class="auth-device muted">这台电脑设置为「每次询问」，可以在「我的电脑」里改成直接执行</div>
        <div class="actions">${r.options.map((o) => `<button class="button${o.value === "decline" ? " danger" : ""} small" data-index="${o.index}">${LABELS[o.value] || esc(o.value)}</button>`).join("")}<a class="auth-view" href="#/live/${esc(r.live.peerId)}">查看会话</a></div>`;
    $$("[data-index]", card).forEach((b) => b.addEventListener("click", async () => {
      $$("button", card).forEach((x) => { x.disabled = true; });
      try {
        await api(`/api/live/${r.live.peerId}/dialog`, { method: "POST", body: { id: r.id, index: Number(b.dataset.index) } });
        authAnswered.add(key(r));
        card.remove();
        if (!$(".auth-card", stack)) stack.remove();
        toast(r.options[Number(b.dataset.index)]?.value === "decline" ? "已拒绝，对方会收到通知" : "已允许，任务开始执行");
        loadWorkspace();
      } catch (err) { $$("button", card).forEach((x) => { x.disabled = false; }); fail(err); }
    }));
    stack.append(card);
  }
}
