// 记忆与指令: CLAUDE.md files and the auto memory.

import { esc, api, fmtBytes, shortPath, $, $$ } from "./util.js";
import { openEditor } from "./dialogs.js";
import { page } from "./router.js";

export async function memory() {
  const el = page('<h1>记忆与指令</h1><p class="sub">CLAUDE.md（你写给 agent 的长期指令）和 agent 自动记下的记忆。改动从下一个新会话（或 /clear、/compact 之后）开始生效</p><div id="body"><div class="empty">正在加载…</div></div>');
  let m;
  try { m = await api("/api/memory"); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  const open = new Set(JSON.parse(sessionStorage.getItem("memoryOpen") || "[]"));
  $("#body", el).innerHTML = `<div class="section-head"><h2>全局指令</h2></div>
      <div class="panel"><div class="file-row"><span class="name">~/.claude-pro/CLAUDE.md</span><span class="desc">所有项目都会加载</span><button class="button small ${m.user.exists ? "secondary" : ""}" data-edit="${esc(m.user.path)}">${m.user.exists ? "编辑" : "新建"}</button></div></div>
      <div class="section-head"><div><h2>各项目</h2><p>${m.projects.length} 个有会话记录的项目</p></div><input type="search" id="q" placeholder="筛选项目…"></div>
      <div class="panel">${m.projects.map((p) => `<details class="proj" data-path="${esc(p.cwd.toLowerCase())}"${open.has(p.cwd) ? " open" : ""} data-cwd="${esc(p.cwd)}"><summary><strong class="mono" style="font-size:13px">${esc(shortPath(p.cwd))}</strong>${p.exists ? "" : '<span class="pill off">目录不在了</span>'}<span class="muted" style="margin-left:auto;font-size:12px">${p.memory.length} 条记忆 · ${p.instructions.filter((f) => f.exists).length} 个指令文件 · ${p.sessions} 个会话</span></summary><div>
        ${p.instructions.filter((f) => f.exists || f.name === "CLAUDE.md").map((f) => `<div class="file-row"><span class="name">${esc(f.name)}</span><span class="desc">${f.name === "CLAUDE.local.md" ? "只在本机，不提交" : "项目指令"}</span>${p.exists ? `<button class="button small ${f.exists ? "secondary" : ""}" data-edit="${esc(f.path)}">${f.exists ? "编辑" : "新建"}</button>` : ""}</div>`).join("")}
        ${p.memory.length ? p.memory.map((f) => `<div class="file-row"><span class="name">记忆/${esc(f.name)}</span><span class="desc">${f.name === "MEMORY.md" ? "索引：每个会话都会加载" : fmtBytes(f.size)}</span><button class="button secondary small" data-edit="${esc(f.path)}" data-deletable="1">编辑</button></div>`).join("") : '<div class="file-row"><span class="desc">还没有自动记忆</span></div>'}
      </div></details>`).join("") || '<div class="empty">没有项目</div>'}</div>`;
  $("#q", el).addEventListener("input", (e) => { const q = e.target.value.toLowerCase(); $$("details.proj", el).forEach((d) => d.classList.toggle("hidden", !d.dataset.path.includes(q))); });
  $$("details.proj", el).forEach((d) => d.addEventListener("toggle", () => {
    if (d.open) open.add(d.dataset.cwd); else open.delete(d.dataset.cwd);
    sessionStorage.setItem("memoryOpen", JSON.stringify([...open]));
  }));
  $("#body", el).addEventListener("click", (e) => {
    const b = e.target.closest("[data-edit]");
    if (b) openEditor(b.dataset.edit, { title: "编辑", deletable: Boolean(b.dataset.deletable), onSaved: memory });
  });
}
