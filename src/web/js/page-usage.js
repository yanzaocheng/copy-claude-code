// 用量: costs and tokens by day, model and project.

import { esc, api, fmtTokens, fmtUsd, ago, shortPath, $$, $ } from "./util.js";
import { view, page } from "./router.js";

export async function usage() {
  const days = Number(sessionStorage.getItem("usageDays")) || 30;
  const period = days === 1 ? "今天" : `近 ${days} 天`;
  const el = page(`<h1>用量</h1><p class="sub">按天、模型、项目统计（来自每次请求的运行记录；有价格的模型才算得出花费）</p>
      <div class="toolbar">${[1, 7, 30, 90].map((d) => `<button class="button ${d === days ? "" : "secondary"} small" data-days="${d}">${d === 1 ? "今天" : `近 ${d} 天`}</button>`).join("")}<span style="flex:1"></span><label class="muted" style="font-size:13px">图表：<select id="metric"><option value="cost">花费</option><option value="tokens">tokens</option><option value="requests">请求数</option></select></label></div><div id="body"><div class="empty">正在统计…</div></div>`);
  $$("[data-days]", el).forEach((b) => b.addEventListener("click", () => { sessionStorage.setItem("usageDays", b.dataset.days); view.cleanup?.(); view.cleanup = null; usage(); }));
  let u;
  try { u = await api(`/api/usage?days=${days}`); } catch (e) { $("#body", el).innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  if (!el.isConnected) return; // (another page was opened meanwhile: what it leaves behind is its own)
  const total = u.days.reduce((a, d) => ({ cost: a.cost + d.cost, requests: a.requests + d.requests, tokens: a.tokens + d.input + d.output + d.cacheRead + d.cacheWrite }), { cost: 0, requests: 0, tokens: 0 });
  const table = (rows, label) => rows.length ? `<table class="list"><thead><tr><th>${label}</th><th class="num">请求</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存读</th><th class="num">缓存写</th><th class="num">花费</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="mono" style="word-break:break-all">${esc(shortPath(r.key))}</td><td class="num">${r.requests}</td><td class="num">${fmtTokens(r.input)}</td><td class="num">${fmtTokens(r.output)}</td><td class="num">${fmtTokens(r.cacheRead)}</td><td class="num">${fmtTokens(r.cacheWrite)}</td><td class="num">${r.cost ? fmtUsd(r.cost) : "—"}${r.unpriced ? ` <span class="faint" title="${r.unpriced} 次请求的模型没有价格">*</span>` : ""}</td></tr>`).join("")}
    </tbody></table>` : '<div class="empty">没有记录</div>';
  $("#body", el).innerHTML = `<div class="cards">
        <div class="panel stat"><div class="label">花费（${period}，按价格估算）</div><div class="value">${fmtUsd(total.cost)}</div></div>
        <div class="panel stat"><div class="label">请求</div><div class="value">${total.requests}</div></div>
        <div class="panel stat"><div class="label">tokens（含缓存）</div><div class="value">${fmtTokens(total.tokens)}</div></div>
        <div class="panel stat"><div class="label">所有会话累计花费</div><div class="value">${fmtUsd(u.totalSessionCost)}</div><div class="hint">会话自己记录的花费，不限时间</div></div></div>
      <div class="section-head"><h2>${days === 1 ? "每小时" : "每天"}</h2></div><div class="panel panel-pad"><svg class="chart" id="chart"></svg></div>
      <div class="section-head"><h2>按模型</h2></div><div class="panel">${table(u.models, "模型")}</div>
      <div class="section-head"><h2>按项目</h2></div><div class="panel">${table(u.projects, "项目")}</div>
      <div class="section-head"><h2>花费最多的会话（${period}）</h2></div><div class="panel">${u.sessions.length ? `<table class="list"><tbody>${u.sessions.map((s) => `<tr${s.dir ? ` class="click" data-open="${esc(s.dir)}/${esc(s.id)}"` : ""}><td class="title-cell"><strong>${esc(s.title || "（已删除的会话）")}</strong><div class="path">${esc(s.cwd || s.dir ? shortPath(s.cwd || s.dir) : s.id)}</div></td><td>${s.mtime ? ago(s.mtime) : ""}</td><td class="num">${s.requests} 次</td><td class="num">${s.cost ? fmtUsd(s.cost) : "—"}${s.unpriced ? ` <span class="faint" title="${s.unpriced} 次请求的模型没有价格">*</span>` : ""}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">没有记录</div>'}</div>`;
  const drawChart = () => {
    const metric = $("#metric", el).value;
    const val = (d) => (metric === "cost" ? d.cost : metric === "tokens" ? d.input + d.output + d.cacheRead + d.cacheWrite : d.requests);
    const svg = $("#chart", el);
    const series = days === 1 && u.hours ? u.hours : u.days; // (today: by hour)
    const w = svg.clientWidth || 900, h = 220, pad = { l: 56, r: 10, t: 10, b: 26 };
    const max = Math.max(...series.map(val), metric === "cost" ? 0.01 : 1);
    const bw = (w - pad.l - pad.r) / series.length;
    const fmt = (v) => (metric === "cost" ? fmtUsd(v) : fmtTokens(v));
    let s = "";
    for (let i = 0; i <= 4; i++) { const y = pad.t + ((h - pad.t - pad.b) * i) / 4; s += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}"/><text x="${pad.l - 6}" y="${y + 3}" text-anchor="end">${esc(fmt(max * (1 - i / 4)))}</text>`; }
    const label = (d) => (series === u.days ? d.key.slice(5) : d.key.slice(0, 2));
    const every = Math.max(1, Math.ceil(series.length / (w < 520 ? 6 : 12)));
    series.forEach((d, i) => {
      const v = val(d);
      const bh = ((h - pad.t - pad.b) * v) / max;
      const x = pad.l + i * bw;
      s += `<rect class="bar" x="${x + bw * 0.15}" y="${h - pad.b - bh}" width="${Math.max(1, bw * 0.7)}" height="${Math.max(0, bh)}"><title>${esc(d.key)}：${esc(fmt(v))} · ${d.requests} 次请求</title></rect>`;
      if (i % every === 0) s += `<text x="${x + bw / 2}" y="${h - 8}" text-anchor="middle">${esc(label(d))}</text>`;
    });
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.innerHTML = s;
  };
  drawChart();
  $("#metric", el).addEventListener("change", drawChart);
  window.addEventListener("resize", drawChart);
  view.cleanup = () => window.removeEventListener("resize", drawChart);
  $("#body", el).addEventListener("click", (e) => { const r = e.target.closest("[data-open]"); if (r) location.hash = `#/session/${r.dataset.open}`; });
}
