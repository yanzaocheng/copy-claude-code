// 扩展: tools, MCP servers, skills, agents.

import { esc, api, toast, fail, ICON, $ } from "./util.js";
import { modal, openEditor } from "./dialogs.js";
import { page } from "./router.js";
import { draftText, saveDraft } from "./composer.js";
import { projectsSelect } from "./page-settings.js";

export async function extensions() {
  const project = sessionStorage.getItem("extProject") || "";
  const el = page(`<h1>扩展</h1><p class="sub">内置工具、技能、子 agent、MCP 和 hooks。新会话会加载改动</p>
      <div class="toolbar"><span class="muted" style="font-size:13px">项目：</span>${await projectsSelect("proj", project)}</div><div id="body"><div class="empty">正在加载…</div></div>`);
  $("#proj", el).addEventListener("change", (e) => { sessionStorage.setItem("extProject", e.target.value); extensions(); });
  let x;
  try { x = await api(`/api/extensions${project ? `?project=${encodeURIComponent(project)}` : ""}`); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  const scopePill = (s) => `<span class="pill${s === "built-in" ? "" : s === "user" ? " accent" : " ok"}">${{ "built-in": "内置", user: "用户", project: "项目" }[s] || esc(s)}</span>`;
  const list = (items, kind) => items.length ? items.map((i) => `<div class="file-row"><span class="name">${esc(i.name)}</span>${scopePill(i.scope)}<span class="desc" title="${esc(i.description)}">${esc(i.description)}</span>${i.path ? `<button class="button secondary small" data-edit="${esc(i.path)}">编辑</button>` : ""}</div>`).join("") : '<div class="file-row"><span class="desc">还没有</span></div>';
  // 新建: a new conversation with the request written for the model (it knows the formats and asks what is missing)
  const aiBtn = (kind) => `<button class="button secondary small" data-ai="${kind}" title="打开新会话，写好要求交给模型去做">${ICON.agent}让 AI 新建</button>`;
  // 内置工具: what every request gives the model, in a line each (the whole description on hover)
  const tools = x.tools || [];
  const toolRows = tools.map((t) => {
    const first = (t.description.split(/\n/).find((l) => l.trim()) || "").replace(/^[-\s]+/, "").split(/(?<=\.)\s/)[0];
    return `<div class="file-row"><span class="name">${esc(t.name)}</span><span class="desc" title="${esc(t.description.slice(0, 1200))}">${esc(TOOL_ZH[t.name] || first)}</span></div>`;
  }).join("");
  $("#body", el).innerHTML = `
      <div class="section-head"><div><h2>内置工具<span class="card-count" style="margin-left:8px;vertical-align:2px">${tools.length + (x.selfRestart ? 1 : 0)}</span></h2><p>每次请求都会发给模型、由模型决定何时调用的工具，写在程序里（不是 MCP）。鼠标停在说明上可以看到发给模型的原文</p></div></div>
      <div class="panel">${toolRows || '<div class="file-row"><span class="desc">读不到工具清单</span></div>'}${x.selfRestart ? `<div class="file-row"><span class="name">Restart</span><span class="desc">${esc(TOOL_ZH.Restart)}</span></div>` : ""}
        <div class="file-row"><span class="desc">另外：配置了 MCP 服务器时，它们的工具会以 mcp__服务器名__工具名 加进这个清单；子 agent 用的是它定义里 tools 列出的那些。</span></div></div>
      <div class="section-head"><div><h2>技能</h2><p>skills/&lt;名字&gt;/SKILL.md：模型按描述决定何时用 Skill 工具加载</p></div>${aiBtn("skill")}</div><div class="panel">${list(x.skills, "skill")}</div>
      <div class="section-head"><div><h2>子 agent</h2><p>agents/*.md：Task 工具可以把任务交给它们</p></div>${aiBtn("agent")}</div><div class="panel">${list(x.agents, "agent")}</div>
      <div class="section-head"><div><h2>MCP</h2><p>别的工具要装 MCP 才有的常用能力，这里已经内置，不用安装；也可以接入外部 MCP 服务器，它们的工具会加进上面的清单</p></div>${aiBtn("mcp")}</div>
      <div class="panel">${BUILTIN_MCP.filter((b) => tools.some((t) => t.name === b.tool)).map((b) => `<div class="file-row"><span class="name" style="font-family:inherit;font-weight:600">${esc(b.name)}</span><span class="pill">内置</span><span class="desc" title="${esc(b.tools)}">${esc(b.desc)}${b.like ? `<span class="faint"> · 相当于 ${esc(b.like)}</span>` : ""}</span></div>`).join("")}
        <div class="file-row mcp-sub"><span class="desc"><strong>外部 MCP 服务器</strong> · 环境变量和请求头的值不会显示</span></div>
        ${x.mcp.length ? x.mcp.map((s, i) => `<div class="file-row"><span class="name">${esc(s.name)}</span><span class="pill">${esc(s.scope)}</span><span class="desc mono">${esc(s.spec?.url || [s.spec?.command, ...(s.spec?.args || [])].filter(Boolean).join(" "))}</span>${s.scope === "user" || s.scope === ".mcp.json" ? `<button class="button secondary small" data-mcp="${i}">编辑</button>` : `<button class="button secondary small" data-edit="${esc(s.file)}">编辑文件</button>`}</div>`).join("") : '<div class="file-row"><span class="desc">还没有添加外部 MCP 服务器</span></div>'}</div>
      <div class="section-head"><div><h2>Hooks</h2><p>在工具调用前后、提交消息时等运行的命令，写在设置文件的 hooks 里</p></div></div>
      <div class="panel">${x.hooks.length ? x.hooks.map((h) => `<div class="file-row"><span class="name">${esc(h.event)}</span><span class="pill">${esc(h.scope)}</span><span class="desc mono">${esc(JSON.stringify(h.entries))}</span><button class="button secondary small" data-edit="${esc(h.file)}">编辑文件</button></div>`).join("") : `<div class="file-row"><span class="desc">没有 hooks。要添加，编辑设置文件的 "hooks" 字段</span><button class="button secondary small" data-edit="${esc(x.settingsFiles.user)}">编辑用户设置文件</button></div>`}</div>`;
  $("#body", el).addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-edit]"), ai = e.target.closest("[data-ai]"), mc = e.target.closest("[data-mcp]");
    if (ed) openEditor(ed.dataset.edit, { title: "编辑", deletable: !/\.json$/i.test(ed.dataset.edit), onSaved: extensions });
    if (ai) askModelToCreate(ai.dataset.ai, { project, settingsFile: x.settingsFiles?.user || "" });
    if (mc) mcpDialog(x, x.mcp[Number(mc.dataset.mcp)], project);
  });
}

// The built-in tools in a few Chinese words (扩展's 内置工具; what the model reads is their English description)
const TOOL_ZH = {
  Task: "把复杂的多步任务交给子 agent，可以在后台运行",
  Skill: "加载一个技能（下面「技能」里写好的做事说明）",
  TaskOutput: "查看后台 agent 的状态和结果",
  TaskStop: "停止一个后台 agent",
  Bash: "运行终端命令（git、npm、构建、测试等），可以放到后台",
  BashOutput: "读取后台命令的输出",
  KillShell: "结束一个后台命令",
  REPL: "在常驻的 Python / Node.js 进程里运行代码，变量和数据保留到下次",
  Processes: "列出本机进程（端口、命令行），或结束进程",
  Glob: "按文件名模式找文件",
  Grep: "按内容搜索文件（ripgrep）",
  Read: "读取文件，也能看图片和 notebook",
  Edit: "在文件里精确替换一段文字",
  MultiEdit: "一次在同一个文件里做多处替换",
  Write: "写入文件（新建或整个覆盖）",
  NotebookEdit: "编辑 Jupyter notebook 的单元格",
  WebFetch: "抓取网页，按要求提取内容",
  WebSearch: "联网搜索",
  Browser: "操作真实的浏览器：打开网页、点击、输入、截图",
  TodoWrite: "维护当前任务的待办清单（就是对话下方的「待办」）",
  AskUserQuestion: "向你提问、让你在几个选项里选",
  Effort: "遇到难题时调高自己本次的思考强度",
  ListPeers: "列出其他 claude-pro 会话（本机、你的其他电脑、联系人）",
  MessagePeer: "给其他会话发任务或问题，答复自动发回",
  Restart: "改了 claude-pro 自身代码后重启加载（只有源码版有）",
};

// What other agents get from MCP servers and claude-pro has built in (扩展's MCP section): shown while its tool is
// there (Browser can be turned off).
const BUILTIN_MCP = [
  { tool: "Browser", tools: "Browser", name: "浏览器", desc: "打开网页、点击、输入、截图，可以用你已登录的浏览器", like: "Playwright / Chrome DevTools MCP" },
  { tool: "WebSearch", tools: "WebSearch", name: "联网搜索", desc: "搜索并汇总结果，附来源", like: "Brave / Tavily 等搜索 MCP" },
  { tool: "WebFetch", tools: "WebFetch", name: "抓取网页", desc: "读取网页正文，按要求提取内容", like: "Fetch MCP" },
  { tool: "Read", tools: "Read · Write · Edit · MultiEdit · Glob · Grep", name: "文件系统", desc: "读写、修改、搜索本机文件", like: "Filesystem MCP" },
  { tool: "REPL", tools: "REPL", name: "代码执行", desc: "常驻的 Python / Node.js 进程，处理数据、跑脚本", like: "代码执行类 MCP" },
  { tool: "Processes", tools: "Processes", name: "进程管理", desc: "查看进程和占用的端口，结束进程", like: "系统 / 进程类 MCP" },
  { tool: "MessagePeer", tools: "ListPeers · MessagePeer", name: "多会话协作", desc: "和本机、你配对过的其他电脑上的 claude-pro 会话互发任务", like: "" },
];

// 让 AI 新建: the new conversation's box with the request (where the file goes, its format), the project's directory
// chosen when the page shows one; what the thing should do is left for the user to write at the end.
function askModelToCreate(kind, { project, settingsFile }) {
  const sep = settingsFile.includes("\\") ? "\\" : "/";
  const userDir = settingsFile ? settingsFile.slice(0, settingsFile.lastIndexOf(sep)) : "~/.claude-pro";
  const dir = project ? `${project}${sep}.claude-pro` : userDir;
  const where = project ? `项目 ${project}` : "用户级（所有项目都能用）";
  const text = {
    skill: `帮我新建一个技能，放在${where}：${dir}${sep}skills${sep}<名字>${sep}SKILL.md。frontmatter 写 name 和 description（description 说清楚什么时候该用它），正文写步骤和说明。信息不够就先问我。\n\n这个技能用来：`,
    agent: `帮我新建一个子 agent，放在${where}：${dir}${sep}agents${sep}<名字>.md。frontmatter 写 name、description（什么时候把任务交给它）和 tools，正文是它的系统提示词。信息不够就先问我。\n\n这个子 agent 负责：`,
    mcp: `帮我添加一个 MCP 服务器，写进${project ? `项目的 ${project}${sep}.mcp.json` : ` ${settingsFile || "用户设置文件"} 的 "mcpServers"`}（写法和 Claude Code 的 mcpServers 一样：stdio 用 command/args/env，远程用 type: "http" 和 url/headers）。需要安装或填密钥就告诉我，先别把密钥写进会提交的文件。\n\n要接入的服务：`,
  }[kind];
  if (!text) return;
  if (draftText("new").trim() && !confirm("新会话输入框里还有没发送的内容，用这段要求替换它吗？")) return;
  saveDraft("new", text, []);
  if (project) localStorage.setItem("cpNewDir", project);
  location.hash = "#/new";
}

function mcpDialog(x, server, project) {
  const spec = server ? server.spec : { command: "npx", args: ["-y", "some-mcp-server"] };
  const m = modal({
    title: server ? `MCP 服务器：${server.name}` : "添加 MCP 服务器", sub: server ? server.file : "",
    body: `<label class="field">名字<input id="mName" value="${esc(server?.name || "")}"${server ? " disabled" : ""}></label>
        ${server ? "" : `<label class="field">放在<select id="mScope"><option value="user">用户设置（所有项目）</option>${project ? `<option value="project">项目的 .mcp.json（${esc(project)}）</option>` : ""}</select></label>`}
        <label class="field">配置（JSON，和 Claude Code 的 mcpServers 写法一样）<small>stdio：{"command","args","env"}；远程：{"type":"http","url","headers"}</small><textarea id="mSpec" class="editor" style="min-height:220px">${esc(JSON.stringify(spec, null, 2))}</textarea></label>`,
    foot: `<span class="modal-error"></span>${server ? '<button class="button danger" id="mDel">删除</button>' : ""}<button class="button secondary" data-close>取消</button><button class="button" id="mSave">保存</button>`,
  });
  const scope = () => (server ? (server.scope === ".mcp.json" ? "project" : "user") : $("#mScope", m.el).value);
  $("#mSave", m.el).addEventListener("click", async () => {
    let parsed;
    try { parsed = JSON.parse($("#mSpec", m.el).value); } catch (e) { $(".modal-error", m.el).textContent = `JSON 有误：${e.message}`; return; }
    try { await api("/api/mcp", { method: "POST", body: { name: $("#mName", m.el).value.trim(), scope: scope(), project, spec: parsed } }); m.close(); toast("已保存：新会话会启动它"); extensions(); } catch (e) { $(".modal-error", m.el).textContent = e.message; }
  });
  $("#mDel", m.el)?.addEventListener("click", async () => {
    if (!confirm(`删除 MCP 服务器 ${server.name}？`)) return;
    try { await api("/api/mcp", { method: "POST", body: { name: server.name, scope: scope(), project, remove: true } }); m.close(); toast("已删除"); extensions(); } catch (e) { fail(e); }
  });
}
