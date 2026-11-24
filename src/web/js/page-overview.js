// 概览: the overview page.

import { esc, api, fmtBytes, fmtUsd, $ } from "./util.js";
import { page } from "./router.js";
import { paintBrandUpdate } from "./update.js";

export async function overview() {
  const el = page('<h1>概览</h1><p class="sub">这台电脑上的 claude-pro</p><div class="empty">正在加载…</div>');
  let o;
  try { o = await api("/api/overview"); } catch (e) { el.innerHTML = `<h1>概览</h1><div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  $("#brandVersion").textContent = `v${o.version}`;
  const gw = o.gateway;
  el.innerHTML = `<h1>概览</h1><p class="sub">这台电脑上的 claude-pro · ${esc(o.host)}</p>
      <div class="cards">
        <a class="panel stat" href="#/new"><div class="label">运行中的会话</div><div class="value">${o.running}</div><div class="hint">${o.busy ? `${o.busy} 个正在工作` : "都空闲"}</div></a>
        <a class="panel stat" href="#/sessions"><div class="label">会话记录</div><div class="value">${o.sessions}</div><div class="hint">${o.projects} 个项目 · 占用 ${fmtBytes(o.storage)}</div></a>
        <a class="panel stat" href="#/providers"><div class="label">默认模型</div><div class="value" style="font-size:16px;word-break:break-all">${esc(o.remembered?.model || o.model)}</div><div class="hint">推理强度 ${esc(o.remembered?.effort || o.effort)}${o.remembered?.model ? " · 来自 /model 记住的选择" : ""}</div></a>
        <a class="panel stat" href="#/providers"><div class="label">7bit.fun 余额</div><div class="value">${gw ? (gw.balance != null ? fmtUsd(gw.balance) : "—") : "未连接"}</div><div class="hint">${gw ? esc(gw.account?.email || gw.account?.name || gw.key) : "在「模型与供应商」里连接"}${gw?.accountError ? ` · ${esc(gw.accountError)}` : ""}</div></a>
      </div>
      <div class="section-head"><h2>版本与位置</h2><button class="button secondary small" id="checkUpdate">检查更新</button></div>
      <div class="panel panel-pad"><dl class="kv">
        <dt>版本</dt><dd>v${esc(o.version)} <span id="updateState" class="muted"></span></dd>
        <dt>安装位置</dt><dd class="mono">${esc(o.installDir)}${o.sourceCheckout ? ' <span class="pill accent">源码</span>' : ""}</dd>
        <dt>配置目录</dt><dd class="mono">${esc(o.configDir)}</dd>
        <dt>Node</dt><dd>${esc(o.node)} · ${esc(o.platform)}</dd>
      </dl></div>
      <div class="section-head"><h2>已连接的供应商</h2><a class="button secondary small" href="#/providers">管理</a></div>
      <div class="panel">${gw || o.providers.length ? `<table class="list"><tbody>
        ${gw ? `<tr><td><strong>7bit.fun</strong></td><td class="muted">${esc(gw.url)}</td><td class="num">${esc(gw.key)}</td></tr>` : ""}
        ${o.providers.map((p) => `<tr><td><strong>${esc(p.name)}</strong></td><td class="muted">${p.models} 个模型</td><td class="num mono">${esc(p.id)}/…</td></tr>`).join("")}
      </tbody></table>` : '<div class="empty">还没有连接任何供应商</div>'}</div>`;
  $("#checkUpdate").addEventListener("click", async () => {
    $("#updateState").textContent = "检查中…";
    const u = await api("/api/update?check=1").catch((e) => ({ status: "error", error: e.message }));
    paintBrandUpdate(u);
    const state = $("#updateState", el);
    if (state) state.textContent = { dev: "· 源码版通过 Git 更新", current: "· 已是最新", available: `· 有新版本 ${u.version}，请点击版本号旁的更新按钮`, installed: `· 新版本 ${u.version} 已安装，点击版本号旁的按钮加载`, updating: "· 正在安装", restarting: "· 等待控制台加载新版", error: `· 检查失败：${u.error}` }[u.status] || "";
  });
}
