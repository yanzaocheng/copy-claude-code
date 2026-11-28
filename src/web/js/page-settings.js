// 设置: the settings files, as /config shows them.

import { esc, api, toast, fail, shortPath, $, $$ } from "./util.js";
import { page } from "./router.js";

const CHOICES = { effort: ["auto", "low", "medium", "high", "xhigh", "max"], promptCacheTtl: ["5m", "1h"], subagentPromptCacheTtl: ["5m", "1h"] };
// The settings' descriptions in Chinese (the terminal's /config has them in English, in config.js)
const ZH = {
  model: "默认模型，写成 供应商/模型（如 deepseek/deepseek-v4-pro）或 opus、sonnet。没设置时：连了 Claude 就用 opus，否则用第一个连接的供应商的模型。会话里的 /model 和 --model 会覆盖它",
  effort: "推理强度：auto、low、medium、high、xhigh、max。会话里的 /effort 和 --effort 会覆盖它",
  decisionModel: "决策模型，写成 供应商/模型（如 7bit/claude-fable-5-2）：会话照常用自己的模型干活，Plan、architect（关键架构决策）、reviewer（完成后审查）这三个子 agent 用它。留空或 off：不启用（没有 architect 和 reviewer，Plan 用会话模型）。改动在新会话或重启后生效",
  promptCacheTtl: "主对话的提示词缓存时长：5m 或 1h",
  subagentPromptCacheTtl: "子 agent、压缩和辅助请求的提示词缓存时长：5m 或 1h",
  cleanupPeriodDays: "会话最后一次使用后保留多少天（之后连同运行记录一起删除，和 Claude Code 一样；至少 1 天，想长期保留可以填 3650）",
  CLAUDE_PRO_MACHINE_NAME: "这台电脑在其他电脑的会话里显示的名字（如 公司、家里；默认是主机名）",
  CLAUDE_PRO_ATTACH: "设为 1（实验性）：终端里启动的会话也在控制台进程里运行，终端窗口只负责按键和画面（像 tmux）。所有会话共用一个进程，更新或改了源码时整体换新进程，终端自动重新接上",
  CLAUDE_PRO_CACHE_KEEPALIVE_HOURS: "Claude 模型用 1 小时缓存时：你离开期间在缓存过期前刷新它（读一次只要重写的 1/40），最多保持这么多小时（默认 8；0 关闭）",
  CLAUDE_PRO_BROWSER: "Browser 工具操作哪个浏览器：auto（默认，Edge、Chrome、Brave、Chromium 中第一个打开了远程调试的）、edge、chrome、brave、chromium、own（claude-pro 自己的 Chrome 配置，无需允许）、DevTools 地址，或 off（不提供 Browser 工具）",
  CLAUDE_PRO_PYTHON: "REPL 工具用的 Python（默认：Windows 上 python，其他系统 python3）",
  CLAUDE_PRO_VERIFY_COMMAND: "agent 改完文件后运行的命令（如 npm test），失败会发回给它修",
  CLAUDE_PRO_DISABLE_AUTO_MEMORY: "设为 1：关闭每个项目的自动记忆",
  CLAUDE_PRO_TRACE: "设为 0：关闭运行记录（默认开启，只记结构和用量，不记内容；用量页的数据来自它）",
};
const SCOPE_NAMES = { user: "用户（所有项目）", project: "项目（随仓库提交）", local: "项目本地（不提交）" };

export async function projectsSelect(id, selected, { allLabel = "只看用户级" } = {}) {
  let list = [];
  try { list = (await api("/api/projects")).projects; } catch { /* only the user's */ }
  return `<select id="${id}"><option value="">${esc(allLabel)}</option>${list.map((p) => `<option value="${esc(p.cwd)}"${p.cwd === selected ? " selected" : ""}>${esc(shortPath(p.cwd))}</option>`).join("")}</select>`;
}

export async function settings() {
  const project = sessionStorage.getItem("settingsProject") || "";
  const el = page(`<h1>设置</h1><p class="sub">和 /config、claude-pro config 是同一份设置。改动对新会话生效；已经开着的会话大多要重启才会读到</p>
      <div class="toolbar"><span class="muted" style="font-size:13px">项目：</span>${await projectsSelect("proj", project)}<input type="search" id="q" placeholder="筛选设置…"></div><div id="body"><div class="empty">正在加载…</div></div>`);
  $("#proj", el).addEventListener("change", (e) => { sessionStorage.setItem("settingsProject", e.target.value); settings(); });
  let s;
  try { s = await api(`/api/settings${project ? `?project=${encodeURIComponent(project)}` : ""}`); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  const sourceName = (src) => {
    if (src === "default") return "默认值";
    if (src === "process environment") return "进程环境变量";
    if (/flag$/.test(src)) return "命令行参数";
    for (const [scope, file] of Object.entries(s.files)) if (file === src) return SCOPE_NAMES[scope];
    return src;
  };
  const row = (e) => {
    const scopes = e.userOnly || !s.project ? ["user"] : ["user", "project", "local"];
    const set = Object.entries(e.scopes).filter(([, v]) => v != null);
    const input = CHOICES[e.key]
      ? `<select data-value>${CHOICES[e.key].map((c) => `<option${String(e.value) === c ? " selected" : ""}>${c}</option>`).join("")}</select>`
      : `<input data-value value="${esc(e.value ?? "")}" placeholder="${e.default != null ? `默认 ${esc(e.default)}` : "未设置"}">`;
    return `<div class="setting" data-key="${esc(e.key)}" data-search="${esc(`${e.key} ${e.description} ${ZH[e.key] || ""}`.toLowerCase())}"><div><div class="key">${esc(e.key)}</div><div class="desc" title="${esc(e.description || "")}">${esc(ZH[e.key] || e.description || "")}</div></div>
        <div><div class="now">当前：<strong class="mono">${e.value == null || e.value === "" ? "（未设置）" : esc(e.value)}</strong> <span class="pill${e.source === "default" ? "" : " accent"}">${esc(sourceName(e.source))}</span>
          ${(s.project ? set : []).map(([scope, v]) => `<span class="pill" title="${esc(s.files[scope])}">${esc(SCOPE_NAMES[scope])}：${esc(v)}</span>`).join(" ")}</div>
        <div class="row">${input}<select data-scope>${scopes.map((sc) => `<option value="${sc}">${esc(SCOPE_NAMES[sc])}</option>`).join("")}</select><button class="button small" data-save>保存</button>${set.length ? '<button class="button secondary small" data-unset>恢复默认</button>' : ""}</div></div></div>`;
  };
  const basic = s.entries.filter((e) => e.basic), advanced = s.entries.filter((e) => !e.basic);
  $("#body", el).innerHTML = `${s.remembered?.model || s.remembered?.effort ? `<div class="panel panel-pad" style="margin-bottom:14px">/model、/effort 记住的选择会覆盖下面的 model、effort：<strong class="mono">${esc([s.remembered.model, s.remembered.effort].filter(Boolean).join(" · "))}</strong> <button class="button secondary small" id="forget">清除记住的选择</button></div>` : ""}
      <div class="section-head"><h2>常用设置</h2></div><div class="panel">${basic.map(row).join("")}</div>
      <div class="section-head"><div><h2>高级设置</h2><p>写在设置文件的 env 里；进程环境变量会覆盖它们</p></div></div><div class="panel">${advanced.map(row).join("")}</div>
      <p class="faint" style="font-size:12px;margin-top:12px">设置文件：${Object.entries(s.files).map(([k, f]) => `${esc(SCOPE_NAMES[k])} <span class="mono">${esc(f)}</span>`).join(" · ")}</p>`;
  $("#q", el).addEventListener("input", (e) => { const q = e.target.value.toLowerCase(); $$(".setting", el).forEach((n) => n.classList.toggle("hidden", !n.dataset.search.includes(q))); });
  $("#forget", el)?.addEventListener("click", async () => { try { await api("/api/remembered", { method: "POST", body: { model: null, effort: null } }); toast("已清除"); settings(); } catch (e) { fail(e); } });
  $("#body", el).addEventListener("click", async (e) => {
    const box = e.target.closest(".setting");
    if (!box) return;
    const key = box.dataset.key;
    const scope = $("[data-scope]", box).value;
    try {
      if (e.target.closest("[data-save]")) {
        const raw = $("[data-value]", box).value;
        const value = key === "cleanupPeriodDays" ? Number(raw) : raw;
        await api("/api/settings", { method: "POST", body: { key, value, scope, project } });
        toast(`${key} 已保存`);
        settings();
      } else if (e.target.closest("[data-unset]")) {
        for (const [sc, v] of Object.entries((s.entries.find((x) => x.key === key) || {}).scopes || {})) if (v != null) await api("/api/settings", { method: "POST", body: { key, unset: true, scope: sc, project } });
        toast(`${key} 已恢复默认`);
        settings();
      }
    } catch (err) { fail(err); }
  });
}
