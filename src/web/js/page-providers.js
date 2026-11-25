// 模型与供应商: the providers connected, their models, and which ones the model menus show.

import { esc, api, toast, fail, fmtTokens, fmtUsd, ago, $, $$ } from "./util.js";
import { modal } from "./dialogs.js";
import { page } from "./router.js";
import { popMenu } from "./composer.js";

export async function providers() {
  const el = page('<h1>模型与供应商</h1><p class="sub">和终端里的 /connect、/model 是同一份配置</p><div id="body"><div class="empty">正在加载…</div></div>');
  let p;
  try { p = await api("/api/providers"); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  drawProviders(el, p);
}

let modelTab = null; // the provider whose tab 模型列表 shows (kept across redraws; a provider just connected gets it)
function drawProviders(el, p) {
  $("#body", el).innerHTML = `<div id="pbody">
      <div class="section-head"><div><h2>默认设置</h2><p>新会话用的模型和思考强度，选了就保存。会话里的 /model、/effort 只改那一个会话（并记住给下次用）；已经开着的会话要 /model default 或重启才换</p></div></div>
      <div class="panel" id="defaults"><div class="panel-pad muted">正在读取…</div></div>
      <div class="section-head"><div><h2>模型列表</h2><p>勾选的模型出现在会话的模型菜单里，也是「默认模型」的选项（都不勾就列出全部）。列表只在点「刷新模型列表」时更新</p></div><div class="actions head-actions"><input type="search" id="modelFilter" placeholder="搜索模型…" style="width:180px"><button class="button secondary small" id="refreshModels" title="重新向 7bit.fun 和各供应商拉取模型列表">刷新模型列表</button><button class="button small" id="addProvider" title="连接 7bit.fun、DeepSeek、Kimi、OpenRouter 等供应商，或你自己的兼容接口">添加供应商</button></div></div>
      <div id="modelLists"><div class="panel panel-pad muted">正在读取…</div></div></div>`;
  loadModelLists(el, p);
  // 添加供应商: any built-in provider or 7bit.fun (one connected already: another account of it), or one of the
  // user's own
  $("#addProvider", el).addEventListener("click", (e) => {
    const others = (base) => p.custom.filter((c) => c.preset === base && c.connected).length;
    const again = "已连接 · 再添加一个账号";
    popMenu(e.currentTarget, [
      { key: "preset", title: "选择供应商", items: [
        { label: "7bit.fun", description: p.gateway.connected ? again : `${p.gateway.url} · Claude、GPT 等模型`, value: "7bit" },
        ...p.presets.map((x) => ({ label: x.providerName || x.name, description: x.connected ? again : x.baseUrl, value: x.id })),
      ] },
      { key: "custom", title: "", items: [{ label: "自定义供应商…", description: "任何兼容 Anthropic 或 OpenAI 的接口", value: "" }] },
    ], (key, value) => {
      if (key === "custom") return connectDialog(el, null);
      if (value === "7bit") {
        if (!p.gateway.connected) return gatewayDialog(el, p);
        return connectDialog(el, null, { instanceOf: "7bit", template: { name: "7bit.fun", baseUrl: p.gateway.url }, count: 1 + others("7bit") });
      }
      const x = p.presets.find((y) => y.id === value);
      if (!x) return;
      if (!x.connected) return connectDialog(el, x);
      connectDialog(el, null, { instanceOf: x.id, template: { name: x.providerName || x.name, baseUrl: x.baseUrl, keyless: x.keyless }, count: 1 + others(x.id) });
    }, { dropdown: true });
  });
  // (from the first-run notice: the menu opens by itself)
  if (sessionStorage.getItem("cpOpenAdd")) { sessionStorage.removeItem("cpOpenAdd"); setTimeout(() => { if (el.isConnected) $("#addProvider", el)?.click(); }, 60); }
  $("#refreshModels", el).addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = "正在刷新…";
    try {
      const r = await api("/api/models/refresh", { method: "POST", body: {} });
      const parts = [...(r.gateway ? [{ name: "7bit.fun", ...r.gateway }] : []), ...r.providers];
      const ok = parts.filter((x) => !x.error).map((x) => `${x.name} ${x.count} 个`);
      const bad = parts.filter((x) => x.error).map((x) => `${x.name}（${x.error}）`);
      if (!parts.length) toast("还没有连接任何供应商", "error");
      else toast([ok.length ? `已刷新：${ok.join("，")}` : "", bad.length ? `失败：${bad.join("，")}` : ""].filter(Boolean).join("；"), bad.length && !ok.length ? "error" : "ok");
      if (el.isConnected) drawProviders(el, r.view);
    } catch (err) { fail(err); b.disabled = false; b.textContent = "刷新模型列表"; }
  });
}

// 模型列表: the kept lists, a tab per provider (nothing is asked of the providers here: see 刷新模型列表); each
// tab says how its provider is connected, with 更换 Key / 模型 and 断开.
async function loadModelLists(el, p) {
  const box = $("#modelLists", el);
  let r;
  try { r = await api("/api/models/kept"); } catch (e) {
    box.innerHTML = `<div class="panel panel-pad muted">读取失败：${esc(e.message)}</div>`;
    $("#defaults", el).innerHTML = `<div class="panel-pad muted">读取失败：${esc(e.message)}</div>`;
    return;
  }
  if (!el.isConnected) return;
  const current = r.remembered?.model || r.current;
  const picked = new Set(r.picked || []);
  const price = (m) => (m.price ? `$${m.price.input} / $${m.price.output}` : "—");
  const pickedNote = () => (picked.size ? `菜单显示勾选的 ${picked.size} 个` : "菜单显示全部");
  const providerOf = (id) => [...(p?.presets || []), ...(p?.custom || [])].find((x) => x.id === id);
  if (!r.groups.some((g) => g.id === modelTab)) modelTab = r.groups[0]?.id || null;
  const head = (g) => {
    const x = providerOf(g.id);
    const when = `${g.models.length} 个模型${g.at ? ` · ${esc(ago(g.at))}更新` : ""}`;
    if (g.id === "7bit" && p?.gateway) {
      // (the balance comes after: GET /api/gateway/account)
      return `<div class="mg-head"><div class="meta">${esc(p.gateway.url)} · Key ${esc(p.gateway.key)}<span id="gwAccount">${p.gateway.account?.email ? ` · ${esc(p.gateway.account.email)}` : ""}</span> · 余额 <strong id="gwBalance">…</strong> · ${when}</div>
          <div class="actions"><button class="button secondary small" data-gateway="change">更换 Key</button><button class="button danger small" data-gateway="remove">断开</button><a class="button secondary small" href="${esc(p.gateway.keyPage)}" target="_blank" rel="noopener">获取 Key</a></div></div>`;
    }
    if (!x) return `<div class="mg-head"><div class="meta">${when}</div></div>`;
    return `<div class="mg-head"><div class="meta">${esc(x.protocol === "openai" ? "OpenAI 协议" : "Anthropic 协议")} · ${esc(x.baseUrl)} · Key ${esc(x.key || "（无需）")} · ${when}</div>
        <div class="actions"><button class="button secondary small" data-connect="${esc(x.id)}">更换 Key / 模型</button><button class="button danger small" data-remove="${esc(x.id)}">断开</button>${x.keyPage ? `<a class="button secondary small" href="${esc(x.keyPage)}" target="_blank" rel="noopener">获取 Key</a>` : ""}</div></div>`;
  };
  box.innerHTML = r.groups.length ? `<div class="mtabs" role="tablist">${r.groups.map((g) => `<button type="button" role="tab" data-tab="${esc(g.id)}" aria-selected="${g.id === modelTab}" class="${g.id === modelTab ? "active" : ""}">${esc(g.name)}<span class="count">${g.models.length}</span></button>`).join("")}</div>` + r.groups.map((g) => `<div class="panel model-group" role="tabpanel" data-group="${esc(g.id)}"${g.id === modelTab ? "" : " hidden"}>
      ${head(g)}<div class="empty no-match" hidden>这个供应商里没有匹配的模型</div>
      ${g.models.length ? `<table class="list"><thead><tr><th class="pick" title="勾选的模型出现在会话的模型菜单里">菜单</th><th>模型</th><th class="num">上下文</th><th class="num">最大输出</th><th>推理强度</th><th class="num" title="每百万 token 的美元价：输入 / 输出">价格（输入/输出）</th></tr></thead><tbody>
        ${g.models.map((m) => `<tr class="click" data-model="${esc(m.ref)}" data-text="${esc([m.ref, m.name, m.vendor].filter(Boolean).join(" ").toLowerCase())}"><td class="pick"><input type="checkbox" data-pick="${esc(m.ref)}" aria-label="在会话的模型菜单里显示 ${esc(m.ref)}"${picked.has(m.ref) ? " checked" : ""}></td><td class="title-cell"><strong class="mono">${esc(m.ref)}${m.ref === current ? ' <span class="pill ok def-pill">默认</span>' : ""}</strong>${m.name || m.vendor ? `<div class="path">${esc([m.name, m.vendor].filter(Boolean).join(" · "))}</div>` : ""}</td><td class="num">${m.window ? fmtTokens(m.window) : "—"}</td><td class="num">${m.maxOutput ? fmtTokens(m.maxOutput) : "—"}</td><td>${m.efforts.length ? esc(m.efforts.join(" · ")) : '<span class="faint">—</span>'}</td><td class="num">${price(m)}</td></tr>`).join("")}
      </tbody></table>` : '<div class="empty">还没有拉取过模型列表：点「刷新模型列表」</div>'}</div>`).join("") : '<div class="panel panel-pad muted">还没有连接供应商：点「添加供应商」</div>';
  if (r.groups.length) box.insertAdjacentHTML("afterbegin", `<div class="pick-bar"><span id="pickedNote">${pickedNote()}</span><button type="button" class="button secondary small" id="clearPicked"${picked.size ? "" : " hidden"}>清除勾选</button></div>`);
  // 默认设置: the default model, among the models ticked below (all when none is), and the default effort; each
  // saved when chosen (settings.json), and what a session's /model or /effort remembered of it forgotten
  let defModel = r.remembered?.model || r.current;
  let defEffort = p?.remembered?.effort || p?.effort || "auto";
  let remembered = { model: r.remembered?.model || null, effort: p?.remembered?.effort || null };
  const allModels = r.groups.flatMap((g) => g.models.map((m) => ({ ref: m.ref, group: g.name, name: m.name })));
  const paintDefaults = () => {
    const dbox = $("#defaults", el);
    if (!dbox) return;
    const choices = picked.size ? allModels.filter((m) => picked.has(m.ref)) : allModels;
    const groups = [...new Set(choices.map((m) => m.group))];
    const listed = choices.some((m) => m.ref === defModel);
    const efforts = ["auto", "low", "medium", "high", "xhigh", "max"];
    dbox.innerHTML = `<div class="def-row"><div class="def-label"><strong>默认模型</strong><small>选项是下面「模型列表」里勾选的模型${picked.size ? `（${picked.size} 个）` : "（没勾选：列出全部）"}</small></div>
          <div><select id="defModel">${listed || !defModel ? "" : `<option value="${esc(defModel)}" selected>${esc(defModel)}（当前）</option>`}${groups.map((gname) => `<optgroup label="${esc(gname)}">${choices.filter((m) => m.group === gname).map((m) => `<option value="${esc(m.ref)}"${m.ref === defModel ? " selected" : ""}>${esc(m.ref)}${m.name ? ` · ${esc(m.name)}` : ""}</option>`).join("")}</optgroup>`).join("")}</select>
          ${remembered.model ? `<div class="def-note">现在生效的是会话里 /model 记住的选择；在这里选一次就以这里为准</div>` : ""}</div></div>
        <div class="def-row"><div class="def-label"><strong>思考强度</strong><small>auto 用模型自己的默认；不支持的模型会取最接近的一档</small></div>
          <div><select id="defEffort">${efforts.map((x) => `<option${x === defEffort ? " selected" : ""}>${x}</option>`).join("")}${efforts.includes(defEffort) ? "" : `<option selected>${esc(defEffort)}</option>`}</select>
          ${remembered.effort ? `<div class="def-note">现在生效的是会话里 /effort 记住的选择；在这里选一次就以这里为准</div>` : ""}</div></div>`;
    $("#defModel", dbox).onchange = async (e) => {
      const value = e.target.value;
      try {
        await api("/api/settings", { method: "POST", body: { scope: "user", key: "model", value } });
        if (remembered.model) await api("/api/remembered", { method: "POST", body: { model: null } });
        defModel = value;
        remembered.model = null;
        for (const pill of $$(".def-pill", box)) pill.remove();
        $(`tr[data-model="${CSS.escape(value)}"] .title-cell strong`, box)?.insertAdjacentHTML("beforeend", ' <span class="pill ok def-pill">默认</span>');
        toast(`默认模型已改为 ${value}`);
      } catch (err) { fail(err); }
      paintDefaults();
    };
    $("#defEffort", dbox).onchange = async (e) => {
      const value = e.target.value;
      try {
        await api("/api/settings", { method: "POST", body: { scope: "user", key: "effort", value } });
        if (remembered.effort) await api("/api/remembered", { method: "POST", body: { effort: null } });
        defEffort = value;
        remembered.effort = null;
        toast(`默认思考强度已改为 ${value}`);
      } catch (err) { fail(err); }
      paintDefaults();
    };
  };
  paintDefaults();
  let saving = Promise.resolve();
  const savePicked = () => {
    const models = [...picked];
    $("#pickedNote", box).textContent = pickedNote();
    $("#clearPicked", box).hidden = !picked.size;
    paintDefaults(); // (its choices are the ticked models)
    saving = saving.then(() => api("/api/models/picked", { method: "POST", body: { models } })).catch((e) => fail(e));
  };
  box.onchange = (e) => {
    const cb = e.target.closest("input[data-pick]");
    if (!cb) return;
    if (cb.checked) picked.add(cb.dataset.pick); else picked.delete(cb.dataset.pick);
    savePicked();
  };
  $("#clearPicked", box)?.addEventListener("click", () => {
    picked.clear();
    for (const cb of $$("input[data-pick]", box)) cb.checked = false;
    savePicked();
    toast("已清除勾选：会话的模型菜单显示全部模型");
  });
  if ($("#gwBalance", box)) {
    api("/api/gateway/account").then((a) => {
      const b = $("#gwBalance", box);
      if (!b) return;
      b.textContent = a.balance != null ? fmtUsd(a.balance) : "—";
      if (a.error) b.title = `查询失败：${a.error}`;
      if (a.email && !$("#gwAccount", box).textContent) $("#gwAccount", box).textContent = ` · ${a.email}`;
    }).catch(() => { const b = $("#gwBalance", box); if (b) b.textContent = "—"; });
  }
  const filter = $("#modelFilter", el);
  // searching: every tab says how many of its models match; the tab shown lists them
  const apply = () => {
    const q = filter.value.trim().toLowerCase();
    for (const g of $$(".model-group", box)) {
      const rows = $$("tr[data-model]", g);
      let shown = 0;
      for (const tr of rows) { const hit = !q || tr.dataset.text.includes(q); tr.hidden = !hit; shown += hit; }
      $(".no-match", g).hidden = !q || !rows.length || shown > 0;
      const tab = $(`[data-tab="${CSS.escape(g.dataset.group)}"] .count`, box);
      if (tab) tab.textContent = q ? `${shown}/${rows.length}` : rows.length;
    }
  };
  const show = (id) => {
    modelTab = id;
    for (const t of $$("[data-tab]", box)) { const on = t.dataset.tab === id; t.classList.toggle("active", on); t.setAttribute("aria-selected", String(on)); }
    for (const g of $$(".model-group", box)) g.hidden = g.dataset.group !== id;
  };
  filter.oninput = apply;
  apply();
  box.onclick = async (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) return show(tab.dataset.tab);
    const gw = e.target.closest("[data-gateway]");
    if (gw?.dataset.gateway === "change") return gatewayDialog(el, p);
    if (gw?.dataset.gateway === "remove") {
      if (!confirm("断开 7bit.fun？保存的 Key 会删除：它的模型不能用了，远程访问也连不上了。（和配对的电脑互发任务不受影响，它不靠任何账号。）")) return;
      try { drawProviders(el, await api("/api/gateway", { method: "DELETE" })); toast("已断开 7bit.fun"); } catch (err) { fail(err); }
      return;
    }
    const c = e.target.closest("[data-connect]"), rm = e.target.closest("[data-remove]");
    if (c) return connectDialog(el, providerOf(c.dataset.connect));
    if (rm) {
      const x = providerOf(rm.dataset.remove);
      if (!confirm(`断开 ${x?.name || rm.dataset.remove}？保存的 Key 会删除，它的模型也从列表里去掉。`)) return;
      try { drawProviders(el, await api(`/api/providers/${encodeURIComponent(rm.dataset.remove)}`, { method: "DELETE" })); toast("已断开"); } catch (err) { fail(err); }
      return;
    }
    if (e.target.closest(".pick")) return; // (the checkbox itself)
    // a click on the row ticks (or unticks) the model
    const cb = e.target.closest("tr[data-model]")?.querySelector("input[data-pick]");
    if (!cb) return;
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
  };
}

// Connect 7bit.fun, or change its key: the gateway checks the key (its account), and its model list comes with it.
function gatewayDialog(el, p) {
  const again = p.gateway.connected;
  const m = modal({
    title: again ? `${p.gateway.name || "7bit.fun"}：名称与 Key` : "连接 7bit.fun", sub: p.gateway.url,
    body: `<label class="field">名称<small>显示在 tab 里</small><input id="gName" maxlength="40" value="${esc(p.gateway.name || "7bit.fun")}"></label>
        <label class="field">API Key<small>${again ? "留空则继续用已保存的 Key；" : ""}在网关网页「API 密钥」里创建</small><input type="password" id="gKey" autocomplete="off" placeholder="${again ? "留空：用已保存的" : "粘贴 7bit.fun 的 API Key"}"></label>
        <a class="button secondary small" href="${esc(p.gateway.keyPage)}" target="_blank" rel="noopener">获取 Key</a>`,
    foot: `<span class="modal-error"></span><button class="button secondary" data-close>取消</button><button class="button" id="gConnect">${again ? "保存" : "连接"}</button>`,
  });
  const input = $("#gKey", m.el);
  (again ? $("#gName", m.el) : input).focus();
  const go = async () => {
    const apiKey = input.value.trim();
    const name = $("#gName", m.el).value.trim();
    const err = $(".modal-error", m.el);
    if (!apiKey && !again) { err.textContent = "请先粘贴 Key"; return; }
    const b = $("#gConnect", m.el);
    b.disabled = true;
    b.textContent = "正在验证…";
    err.textContent = "";
    try {
      const view = await api("/api/gateway", { method: "POST", body: { ...(apiKey ? { apiKey } : {}), name } });
      m.close();
      toast(again ? "已保存" : `已连接 ${name || "7bit.fun"}`);
      modelTab = "7bit";
      drawProviders(el, view);
    } catch (ex) { err.textContent = ex.message; b.disabled = false; b.textContent = again ? "保存" : "连接"; }
  };
  $("#gConnect", m.el).addEventListener("click", go);
  for (const i of [input, $("#gName", m.el)]) i.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
}

// Connect a provider: a built-in one (x; connected already: its key, model or name changed), another account of one
// or of 7bit.fun (instanceOf, with its template and how many are connected), or with neither one of the user's own.
// 名称 → key → models → test → saved.
function connectDialog(el, x, { instanceOf = null, template = null, count = 0 } = {}) {
  const custom = !x && !instanceOf;
  const base = x || template;
  const defaultName = x ? x.name : instanceOf ? `${template.name} ${count + 1}` : "";
  const m = modal({
    title: custom ? "添加自定义供应商" : x ? (x.connected ? `${x.name}：名称、Key 与模型` : `连接 ${x.name}`) : `再添加一个 ${template.name} 账号`,
    sub: custom ? "任何兼容 Anthropic Messages 或 OpenAI Chat Completions 的接口" : `${base.baseUrl}`,
    body: `<label class="field">名称<small>${custom ? "显示在 tab 和模型菜单里；英文名同时是模型前缀，比如 myrelay/gpt-5" : "显示在 tab 和模型菜单里"}</small><input id="cName" maxlength="40" value="${esc(defaultName)}" placeholder="${custom ? "myrelay" : esc(base.name)}"></label>
        ${custom ? `<label class="field">协议<select id="cProto"><option value="openai">OpenAI 兼容（/chat/completions）</option><option value="anthropic">Anthropic 兼容（/v1/messages）</option></select></label>
        <label class="field">地址<input id="cUrl" placeholder="https://api.example.com/v1"></label>` : ""}
        <label class="field">API Key${x?.connected ? "<small>留空则继续用已保存的 Key</small>" : base?.keyless ? "<small>这个供应商不需要 Key</small>" : ""}<input type="password" id="cKey" autocomplete="off" placeholder="${x?.connected ? "留空：用已保存的" : "粘贴 Key"}"></label>
        <div class="actions"><button class="button secondary" id="cCheck">检查 Key 并列出模型</button></div>
        <div id="cModels" style="margin-top:14px"></div>`,
    foot: '<span class="modal-error"></span><button class="button secondary" data-close>取消</button><button class="button" id="cConnect" disabled>测试并连接</button>',
  });
  let checked = null;
  const err = (t) => { $(".modal-error", m.el).textContent = t || ""; };
  const target = () => (custom ? { custom: { name: $("#cName", m.el).value, protocol: $("#cProto", m.el).value, baseUrl: $("#cUrl", m.el).value } } : instanceOf ? { instanceOf } : { id: x.id });
  (x?.connected ? $("#cName", m.el) : custom ? $("#cName", m.el) : $("#cKey", m.el)).focus();
  $("#cCheck", m.el).addEventListener("click", async (e) => {
    err("");
    e.target.disabled = true;
    e.target.textContent = "检查中…";
    try {
      checked = await api("/api/providers/check", { method: "POST", body: { ...target(), apiKey: $("#cKey", m.el).value } });
      const list = checked.models || [];
      $("#cModels", m.el).innerHTML = list.length
        ? `<input type="search" id="cFilter" placeholder="筛选 ${list.length} 个模型" style="width:100%;margin-bottom:8px"><div class="model-list">${list.map((mm, i) => `<label data-name="${esc(mm.id.toLowerCase())}"><input type="radio" name="cm" value="${i}"${mm.id === checked.current || (!checked.current && i === 0) ? " checked" : ""}> <span class="mono">${esc(mm.id)}</span><small>${[mm.window ? `${fmtTokens(mm.window)} 上下文` : "", mm.price ? `$${mm.price.input}/$${mm.price.output} 每百万` : ""].filter(Boolean).join(" · ")}</small></label>`).join("")}</div>`
        : '<label class="field">它没有列出模型：填写要用的模型名<input id="cManual" placeholder="模型 id"></label>';
      $("#cModels", m.el).insertAdjacentHTML("beforeend", '<label class="muted" style="display:block;margin-top:10px;font-size:13px"><input type="checkbox" id="cUse" checked> 连接后设为当前使用的模型（和 /model 一样）</label>');
      $("#cFilter", m.el)?.addEventListener("input", (ev) => { const q = ev.target.value.toLowerCase(); $$(".model-list label", m.el).forEach((l) => l.classList.toggle("hidden", !l.dataset.name.includes(q))); });
      $("#cConnect", m.el).disabled = false;
    } catch (ex) { err(ex.message); } finally { e.target.disabled = false; e.target.textContent = "检查 Key 并列出模型"; }
  });
  $("#cConnect", m.el).addEventListener("click", async (e) => {
    err("");
    const list = checked?.models || [];
    const picked = $("input[name=cm]:checked", m.el);
    const model = picked ? list[Number(picked.value)].id : $("#cManual", m.el)?.value.trim();
    if (!model) return err("请选择或填写一个模型");
    e.target.disabled = true;
    e.target.textContent = `正在测试 ${model}…`;
    try {
      const p = await api("/api/providers/connect", { method: "POST", body: { ...target(), name: $("#cName", m.el).value, apiKey: $("#cKey", m.el).value, model, models: list.length ? list : [{ id: model }], authHeader: checked?.authHeader, useNow: $("#cUse", m.el)?.checked } });
      m.close();
      toast(`已连接，模型 ${model} 测试通过`);
      modelTab = p.connected || modelTab; // (its tab is the one shown)
      drawProviders(el, p);
    } catch (ex) { err(ex.message); e.target.disabled = false; e.target.textContent = "测试并连接"; }
  });
}
