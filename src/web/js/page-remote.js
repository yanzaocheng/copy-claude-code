// 远程访问: the console from elsewhere through https://<prefix>.7bit.fun, and 跨电脑互发任务 (the computers trusted to send
// tasks).

import { esc, api, toast, fail, fmtTime, ago, ICON, $, $$ } from "./util.js";
import { modal } from "./dialogs.js";
import { view, page } from "./router.js";
import { ws, loadWorkspace } from "./workspace.js";

export async function remotePage() {
  const el = page('<h1>远程访问</h1><p class="sub">在手机或别的电脑上，通过你自己的域名（https://&lt;前缀&gt;.7bit.fun）打开这台电脑的控制台，要输入密码</p><div id="body"><div class="empty">正在加载…</div></div>');
  let v;
  try { v = await api("/api/remote"); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  // the address's prefix (kept by the account at the gateway), asked once
  const h = v.gateway ? await api("/api/remote/handle").catch((e) => ({ error: e.message })) : null;
  if (!el.isConnected) return;
  drawRemote(el, v, h);
  const timer = setInterval(async () => { try { const next = await api("/api/remote"); if (JSON.stringify(next.tunnel) !== JSON.stringify(v.tunnel)) { v = next; drawRemote(el, v, h); } } catch { /* next time */ } }, 3000);
  view.cleanup = () => clearInterval(timer);
}

const HANDLE_RULE = /^[a-z][a-z0-9-]{1,18}[a-z0-9]$/;
const HANDLE_HINT = "3–20 个小写字母、数字或 -，字母开头、不以 - 结尾";

function drawRemote(el, v, h) {
  // without 7bit.fun there is no address: only the way to connect it
  if (!v.gateway) {
    $("#body", el).innerHTML = `<div class="panel panel-pad"><div style="font-weight:650;margin-bottom:6px">远程访问需要 7bit.fun 网关</div><p class="muted" style="margin:0 0 14px;font-size:13px">访问地址 https://&lt;前缀&gt;.7bit.fun 由网关提供：连接 7bit.fun 后，就能在这里选一个自己的域名前缀并开启。</p><button class="button" id="rConnectGw">去连接 7bit.fun</button></div>`;
    $("#rConnectGw", el).addEventListener("click", () => { sessionStorage.setItem("cpOpenAdd", "1"); location.hash = "#/providers"; });
    return;
  }
  const t = v.tunnel || {};
  const domain = h?.domain || "7bit.fun";
  const prefixField = (id) => `<label class="field" style="margin:0">域名前缀<small>${HANDLE_HINT}；要唯一</small>
        <span class="prefix-row"><span class="mono muted">https://</span><input id="${id}" class="mono" maxlength="20" autocomplete="off" spellcheck="false" placeholder="例如 yanzc" value="${h && !h.auto ? esc(h.handle) : ""}"><span class="mono muted">.${esc(domain)}</span></span></label>`;
  const state = !v.enabled ? ["off", "已关闭"] : t.status === "online" ? ["ok", "已开启"] : t.status === "error" ? ["off", "没有接上"] : ["warn", "正在连接"];
  const device = (ua) => { const s = String(ua || ""); return /iPhone|iPad/.test(s) ? "iPhone / iPad" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows" : /Mac OS/.test(s) ? "Mac" : s.slice(0, 40) || "未知设备"; };
  $("#body", el).innerHTML = `
      <div class="panel panel-pad"><div class="actions" style="justify-content:space-between">
        <div><div class="muted" style="font-size:12.5px">状态</div><div style="font-size:18px;font-weight:650;margin-top:2px"><span class="pill ${state[0]}">${state[1]}</span>
          ${t.status === "online" && t.host ? ` <a href="https://${esc(t.host)}" target="_blank" rel="noopener" class="mono" style="font-size:15px">https://${esc(t.host)}</a>` : ""}</div>
          ${t.error ? `<div style="color:var(--danger);font-size:13px;margin-top:4px">${esc(t.error)}</div>` : ""}
          ${h?.error ? `<div style="color:var(--danger);font-size:13px;margin-top:4px">读不到域名前缀：${esc(h.error)}</div>` : ""}</div>
        <div class="actions">${v.enabled ? `<button class="button secondary" id="rRename">修改前缀</button><button class="button danger" id="rOff">关闭远程访问</button>` : ""}</div></div>
        ${v.enabled ? "" : `<div class="remote-setup">${prefixField("rHandle")}<div class="actions"><button class="button" id="rOn" ${v.hasPassword ? "" : "disabled"}>开启远程访问</button>${v.hasPassword ? "" : '<span class="muted" style="font-size:12.5px">先在下面设一个密码</span>'}<span class="modal-error" id="rErr"></span></div></div>`}
        <p class="muted" style="font-size:12.5px;margin:12px 0 0">开启后这台电脑的控制台服务常驻后台；电脑休眠或关机时打不开。开机后想马上能连，就打开下面的「开机自动启动」；不开的话，claude-pro 的任何会话启动时也会重新接上。</p></div>
      <div class="panel panel-pad" id="rAuto"><span class="muted">正在读取开机启动设置…</span></div>
      <div class="section-head"><div><h2>密码</h2><p>${v.hasPassword ? "已设置。改密码会让所有已登录的设备退出。" : `还没有设置：开启前先设一个（至少 ${v.minPassword} 位）。`}</p></div></div>
      <form class="panel panel-pad actions" id="rPwForm"><input type="password" id="rPw1" placeholder="新密码" autocomplete="new-password" style="flex:1;min-width:180px"><input type="password" id="rPw2" placeholder="再输一次" autocomplete="new-password" style="flex:1;min-width:180px"><button class="button" type="submit">${v.hasPassword ? "修改密码" : "设置密码"}</button></form>
      <div class="section-head"><div><h2>已登录的设备</h2><p>${v.sessions.length} 台</p></div>${v.sessions.length ? '<button class="button danger small" id="rLogoutAll">全部退出</button>' : ""}</div>
      <div class="panel">${v.sessions.length ? `<table class="list"><tbody>${v.sessions.map((s) => `<tr><td>${esc(device(s.ua))}</td><td class="mono">${esc(s.ip || "")}</td><td>最近 ${esc(ago(s.lastSeen))}</td><td class="num muted">${s.remember ? "记住 30 天" : "1 天"}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">没有</div>'}</div>
      <div class="section-head"><h2>最近的登录</h2></div>
      <div class="panel">${v.logins.length ? `<table class="list"><tbody>${v.logins.map((l) => `<tr><td>${l.ok ? '<span class="pill ok">成功</span>' : '<span class="pill off">密码错误</span>'}</td><td>${esc(device(l.ua))}</td><td class="mono">${esc(l.ip || "")}</td><td class="num">${esc(fmtTime(l.at))}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">还没有人登录过</div>'}</div>
      <div class="section-head"><div><h2>跨电脑互发任务</h2><p>你其他电脑上的会话发来任务时，像远程桌面一样先征得这里同意：允许本次连接、始终信任这台电脑或拒绝。同一台电脑上的会话之间直接执行</p></div></div>
      <div class="panel panel-pad" id="rDevices"><span class="muted">正在读取…</span></div>`;
  drawDevices(el);
  // 开机自动启动: the console started at log-in (a shortcut in Startup, a LaunchAgent, an XDG autostart entry)
  const drawAuto = (a) => {
    const box = $("#rAuto", el);
    if (!box) return;
    const head = '<div class="auto-head"><div><div style="font-weight:650">开机自动启动</div><div class="muted" style="font-size:12.5px;margin-top:2px">电脑开机、登录后在后台启动控制台，手机马上就能连。没开远程访问时，没人用 30 分钟后它会自己退出。</div></div>';
    if (!a.supported) {
      box.innerHTML = `${head}</div><p class="muted" style="font-size:13px;margin:12px 0 6px">这台电脑没有图形桌面，没有「登录时启动」的地方。要开机启动，把下面这行加进 <code>crontab -e</code>：</p><pre class="auto-cmd">${esc(a.hint)}</pre>`;
      return;
    }
    const how = { windows: "「启动」文件夹里的快捷方式", macos: "LaunchAgent", linux: "桌面的自启动项" }[a.kind] || "";
    box.innerHTML = `${head}<label class="switch"><input type="checkbox" id="rAutoOn" role="switch"${a.enabled ? " checked" : ""}><span class="switch-track" aria-hidden="true"></span><span class="sr-only">开机自动启动</span></label></div>${a.enabled ? `<div class="muted" style="font-size:12px;margin-top:10px">${esc(how)}：<span class="mono">${esc(a.file)}</span></div>` : ""}`;
    $("#rAutoOn", box).addEventListener("change", async (e) => {
      const on = e.target.checked;
      e.target.disabled = true;
      try {
        drawAuto(await api("/api/autostart", { method: "POST", body: { enabled: on } }));
        toast(on ? "已设置开机自动启动" : "已取消开机自动启动");
      } catch (err) { e.target.checked = !on; e.target.disabled = false; fail(err); }
    });
  };
  api("/api/autostart").then(drawAuto).catch((e) => { const box = $("#rAuto", el); if (box) box.innerHTML = `<span class="muted">读不到开机启动设置：${esc(e.message)}</span>`; });

  const post = async (body, done) => {
    const next = await api("/api/remote", { method: "POST", body });
    if (body.handle && h) Object.assign(h, { handle: body.handle, auto: false, error: null });
    drawRemote(el, next, h);
    if (done) toast(done);
  };
  // the prefix typed, checked here as the gateway will: none needed when the user chose one before
  const typedHandle = (input, err) => {
    const value = input.value.trim().toLowerCase();
    if (!value && h && !h.auto) return h.handle;
    if (!value) { err("先填一个域名前缀"); input.focus(); return null; }
    if (!HANDLE_RULE.test(value)) { err(`域名前缀要是 ${HANDLE_HINT}`); input.focus(); return null; }
    return value;
  };
  $("#rOn", el)?.addEventListener("click", async (e) => {
    const b = e.currentTarget, errBox = $("#rErr", el), err = (m) => { errBox.textContent = m; };
    err("");
    const handle = typedHandle($("#rHandle", el), err);
    if (!handle) return;
    b.disabled = true;
    try { await post({ ...(handle !== h?.handle ? { handle } : {}), enabled: true }, `远程访问已开启：https://${handle}.${domain}，正在连接网关…`); }
    catch (ex) { err(ex.message); b.disabled = false; }
  });
  $("#rHandle", el)?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#rOn", el)?.click(); });
  $("#rRename", el)?.addEventListener("click", () => {
    const m = modal({
      title: "修改域名前缀", sub: `现在是 https://${h?.handle || "…"}.${domain}；改后旧地址就打不开了`,
      body: prefixField("rNewHandle"),
      foot: '<span class="modal-error"></span><button class="button secondary" data-close>取消</button><button class="button" id="rSaveHandle">保存</button>',
    });
    const input = $("#rNewHandle", m.el);
    input.focus(); input.select();
    const save = async () => {
      const err = (msg) => { $(".modal-error", m.el).textContent = msg; };
      err("");
      const handle = typedHandle(input, err);
      if (!handle) return;
      if (handle === h?.handle) return m.close();
      try { await post({ handle }, `已改为 https://${handle}.${domain}，正在重新连接…`); m.close(); } catch (ex) { err(ex.message); }
    };
    $("#rSaveHandle", m.el).addEventListener("click", save);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  });
  $("#rOff", el)?.addEventListener("click", () => { if (confirm("关闭远程访问？外网就打不开这台电脑的控制台了。")) post({ enabled: false }, "远程访问已关闭").catch(fail); });
  $("#rLogoutAll", el)?.addEventListener("click", () => { if (confirm("让所有已登录的设备退出？")) post({ logoutAll: true }, "都已退出").catch(fail); });
  $("#rPwForm", el).addEventListener("submit", (e) => {
    e.preventDefault();
    const a = $("#rPw1", el).value, b = $("#rPw2", el).value;
    if (a.length < v.minPassword) return toast(`密码至少 ${v.minPassword} 位`, "error");
    if (a !== b) return toast("两次输入不一样", "error");
    post({ password: a }, "密码已保存，所有已登录的设备都已退出").catch(fail);
  });
}

// 跨电脑互发任务: this computer, how tasks from the others are taken, the computers trusted (see devices.js)
async function drawDevices(el, d = null) {
  const box = $("#rDevices", el);
  if (!box) return;
  try { d ||= await api("/api/devices"); } catch (e) { box.innerHTML = `<span class="muted">读不到：${esc(e.message)}</span>`; return; }
  if (!box.isConnected) return;
  box.innerHTML = `<div class="dev-me"><div><div class="muted" style="font-size:12.5px">这台电脑</div><div style="font-weight:650;margin-top:2px">${esc(d.me.name)}</div>${d.me.id ? `<div class="mono faint" style="font-size:12px" title="设备 ID：第一次用到时生成，之后不变；发出的任务都用它签名">设备 ${esc(d.me.id)}</div>` : ""}</div>
        <label class="field" style="margin:0;min-width:240px">来自其他电脑的任务<select id="devPolicy"><option value="ask"${d.policy === "ask" ? " selected" : ""}>每次询问（已信任的电脑除外）</option><option value="account"${d.policy === "account" ? " selected" : ""}>同一账号的电脑直接执行</option></select></label></div>
      <div style="font-weight:650;margin:16px 0 6px">已信任的电脑</div>
      ${d.devices.length ? `<table class="list"><tbody>${d.devices.map((x) => `<tr><td><strong>${esc(x.name)}</strong> <span class="mono faint" style="font-size:12px">${esc(x.id.slice(0, 8))}</span></td><td class="muted">信任于 ${esc(fmtTime(x.trustedAt))}</td><td class="muted">${x.lastSeen ? `最近任务 ${esc(ago(x.lastSeen))}` : ""}</td><td class="num"><button class="button danger small" data-untrust="${esc(x.id)}" data-name="${esc(x.name)}">撤销</button></td></tr>`).join("")}</tbody></table>`
        : '<div class="muted" style="font-size:13px">还没有。其他电脑请求执行任务时选「始终信任这台电脑」，它就会出现在这里。</div>'}`;
  $("#devPolicy", box).addEventListener("change", async (e) => {
    const policy = e.target.value;
    if (policy === "account" && !confirm("同一账号的任何电脑（包括用你的网关 Key 连上的）发来的任务都会直接执行，不再询问。确定？")) { e.target.value = d.policy; return; }
    try { drawDevices(el, await api("/api/devices/policy", { method: "POST", body: { policy } })); toast(policy === "account" ? "同账号电脑的任务将直接执行" : "未信任电脑的任务会先询问"); } catch (err) { e.target.value = d.policy; fail(err); }
  });
  $$("[data-untrust]", box).forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`不再信任「${b.dataset.name}」？它之后发来的任务会先询问。`)) return;
    try { drawDevices(el, await api("/api/devices/remove", { method: "POST", body: { id: b.dataset.untrust } })); toast("已撤销"); } catch (err) { fail(err); }
  }));
}

// A computer asking to run a task in one of the sessions here (see App.askPeerTask): shown on top of every page,
// whatever session is open, as a remote desktop program asks before a connection; answered as the session's dialog.
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
  const LABELS = { once: "允许本次连接", always: "始终信任这台电脑", decline: "拒绝" };
  for (const r of requests) {
    if ($(`.auth-card[data-key="${CSS.escape(key(r))}"]`, stack)) continue;
    const target = r.live.status?.title || r.live.name || "会话";
    const device = r.verified ? `<span class="pill ok">设备已验证</span> <span class="mono faint">${esc(String(r.device).slice(0, 8))}</span>`
      : r.signed ? '<span class="pill off">签名校验失败：可能不是它自称的那台电脑</span>' : '<span class="pill warn">无法识别设备（对方是旧版 claude-pro）</span>';
    const card = document.createElement("div");
    card.className = "auth-card";
    card.dataset.key = key(r);
    card.innerHTML = `<h3>${ICON.shield}另一台电脑请求执行任务</h3>
        <div class="auth-from">电脑「<strong>${esc(r.machine)}</strong>」上的会话 @${esc(r.from)} 想让这里的「${esc(target)}」执行：</div>
        <div class="auth-text">${esc(r.text)}</div>
        <div class="auth-device">${device}</div>
        <div class="actions">${r.options.map((o) => `<button class="button${o.value === "decline" ? " danger" : o.value === "always" ? " secondary" : ""} small" data-index="${o.index}">${LABELS[o.value] || esc(o.value)}</button>`).join("")}<a class="auth-view" href="#/live/${esc(r.live.peerId)}">查看会话</a></div>`;
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
