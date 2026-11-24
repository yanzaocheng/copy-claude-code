// Terminal output (ANSI colours) and Markdown as HTML, as the gateway's page draws them.

import { esc } from "./util.js";

const BASIC = ["#0c0c0c", "#cd3131", "#0dbc79", "#b5a10a", "#2472c8", "#bc3fbc", "#11a8cd", "#a0a0a0", "#666666", "#f14c4c", "#23d18b", "#b5a10a", "#3b8eea", "#d670d6", "#29b8db", "#8a8a8a"];
function color256(value) {
  let n = Number(value) || 0;
  if (n < 16) return BASIC[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  n -= 16;
  const scale = [0, 95, 135, 175, 215, 255];
  return `rgb(${scale[Math.floor(n / 36)]},${scale[Math.floor(n / 6) % 6]},${scale[n % 6]})`;
}
export function ansi(line) {
  line = String(line == null ? "" : line);
  let out = "";
  let style = {};
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g;
  const add = (text) => {
    if (!text) return;
    let fg = style.fg, bg = style.bg;
    if (style.inverse) { const old = fg; fg = bg || "var(--rc-bg)"; bg = old || "var(--rc-fg)"; }
    // A background is the terminal's diff (dark red and green for a dark terminal): shown as the page's own added /
    // removed colours, with its text in the page's colour, so that it reads on a light page as on a dark one.
    let tone = "";
    if (bg && !style.inverse) {
      const rgb = /rgb\((\d+),(\d+),(\d+)\)/.exec(bg) || /^#(..)(..)(..)$/.exec(bg);
      const [r, g] = rgb ? [rgb[1], rgb[2]].map((v) => (v.length === 2 && rgb[0].startsWith("#") ? parseInt(v, 16) : Number(v))) : [0, 0];
      const b = rgb ? (rgb[0].startsWith("#") ? parseInt(rgb[3], 16) : Number(rgb[3])) : 0;
      tone = g > r + 12 ? "a-add" : r > g + 12 ? "a-del" : "a-bg";
      if (tone !== "a-bg" && r + g + b > 300) tone += " a-word"; // the changed words, brighter than their line
      bg = null;
      fg = null;
    }
    const classes = [tone, style.bold && "a-b", style.dim && !tone && "a-d", style.italic && "a-i", style.underline && "a-u", style.strike && "a-s"].filter(Boolean);
    const css = (fg ? `color:${fg};` : "") + (bg ? `background:${bg};` : "");
    const attrs = (classes.length ? ` class="${classes.join(" ")}"` : "") + (css ? ` style="${esc(css)}"` : "");
    out += attrs ? `<span${attrs}>${esc(text)}</span>` : esc(text);
  };
  let last = 0, m;
  while ((m = re.exec(line))) {
    add(line.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] === undefined) continue;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) style = {};
      else if (code === 1) style.bold = true;
      else if (code === 2) style.dim = true;
      else if (code === 22) style.bold = style.dim = false;
      else if (code === 3) style.italic = true;
      else if (code === 23) style.italic = false;
      else if (code === 4) style.underline = true;
      else if (code === 24) style.underline = false;
      else if (code === 7) style.inverse = true;
      else if (code === 27) style.inverse = false;
      else if (code === 9) style.strike = true;
      else if (code === 29) style.strike = false;
      else if (code >= 30 && code <= 37) style.fg = BASIC[code - 30];
      else if (code >= 90 && code <= 97) style.fg = BASIC[code - 82];
      else if (code >= 40 && code <= 47) style.bg = BASIC[code - 40];
      else if (code >= 100 && code <= 107) style.bg = BASIC[code - 92];
      else if (code === 39) style.fg = null;
      else if (code === 49) style.bg = null;
      else if (code === 38 || code === 48) {
        let color = null;
        if (codes[i + 1] === 2) { color = `rgb(${codes[i + 2] | 0},${codes[i + 3] | 0},${codes[i + 4] | 0})`; i += 4; }
        else if (codes[i + 1] === 5) { color = color256(codes[i + 2]); i += 2; }
        if (code === 38) style.fg = color; else style.bg = color;
      }
    }
  }
  add(line.slice(last));
  return out;
}
export const ansiLines = (lines) => (Array.isArray(lines) ? lines : []).map(ansi).join("\n");
export const plain = (s) => String(s || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""); // eslint-disable-line no-control-regex

function inline(source) {
  const codes = [];
  const text = String(source == null ? "" : source).replace(/\u0000/g, "").replace(/`([^`]+)`/g, (_, code) => { codes.push(code); return `\u0000${codes.length - 1}\u0000`; });
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}
export function md(source) {
  const lines = String(source == null ? "" : source).replace(/\r\n/g, "\n").split("\n");
  let html = "", para = [], i = 0;
  const flush = () => { if (para.length) { html += `<p>${para.map(inline).join("<br>")}</p>`; para = []; } };
  const row = /^\s*\|.*\|\s*$/;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      html += `<pre>${esc(body.join("\n"))}</pre>`;
      continue;
    }
    if (row.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const rows = [];
      while (i < lines.length && row.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      html += "<table><thead><tr>" + cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>"
        + rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); html += `<h${Math.min(4, h[1].length)}>${inline(h[2])}</h${Math.min(4, h[1].length)}>`; i++; continue; }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) { flush(); html += `<div class="li" style="padding-left:${Math.min(li[1].length, 12) * 0.5}em"><span class="bullet">${/\d/.test(li[2]) ? esc(li[2]) : "•"}</span><span>${inline(li[3])}</span></div>`; i++; continue; }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) { flush(); html += `<blockquote>${inline(q[1])}</blockquote>`; i++; continue; }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line);
    i++;
  }
  flush();
  return html;
}
