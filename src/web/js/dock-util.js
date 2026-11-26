// What the parts of the panel (dock*.js) share: paths as the console's computer writes them, file icons, copying,
// a menu where the pointer is.

import { toast, shortPath } from "./util.js";
import { popMenu } from "./composer.js";

const EXT_COLORS = {
  js: "#d4a017", mjs: "#d4a017", cjs: "#d4a017", jsx: "#2fa7c9", ts: "#3178c6", tsx: "#2fa7c9", json: "#7f9f3a", md: "#4a7fd6",
  py: "#3b77a8", html: "#e4572e", htm: "#e4572e", css: "#8e5bd6", scss: "#c6538c", vue: "#3fae7c", go: "#00a3c4", rs: "#c8673a",
  java: "#d9822b", kt: "#8e5bd6", c: "#5c7fb8", h: "#5c7fb8", cpp: "#5c7fb8", cs: "#6a8f3a", sh: "#4f9a46", bash: "#4f9a46",
  ps1: "#3a6fb5", bat: "#7a7a7a", cmd: "#7a7a7a", yml: "#c9465f", yaml: "#c9465f", toml: "#a0715a", xml: "#d9822b", svg: "#e09a2d",
  png: "#a65cc4", jpg: "#a65cc4", jpeg: "#a65cc4", gif: "#a65cc4", webp: "#a65cc4", ico: "#a65cc4", sql: "#c67a1b", lock: "#9a948c",
};
// a file's icon, tinted by its kind
export function fileIcon(name) {
  const ext = String(name).toLowerCase().split(".").pop();
  const color = EXT_COLORS[ext] || "var(--faint)";
  return `<svg class="fi" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="${color}" fill-opacity=".12"/><path d="M14 3v5h5"/></svg>`;
}
export const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';

// a workspace's key: its folder, as the sidebar compares them (workspace.js projectKey)
export const workspaceKey = (cwd) => shortPath(cwd || "").toLowerCase().replace(/\/+$/, "");

export const sepOf = (p) => (String(p).includes("\\") ? "\\" : "/");
export const joinPath = (dir, name) => {
  const sep = sepOf(dir);
  return dir.endsWith(sep) ? dir + name : dir + sep + String(name).replace(/[\\/]/g, sep);
};
export const parentOf = (p) => {
  const sep = sepOf(p);
  const s = p.length > 1 ? p.replace(/[\\/]+$/, "") : p;
  const i = s.lastIndexOf(sep);
  if (i < 0) return p;
  if (i === 0) return sep;
  return i === 2 && /^[a-z]:/i.test(s) ? s.slice(0, 3) : s.slice(0, i);
};
export const baseOf = (p) => String(p).replace(/[\\/]+$/, "").split(/[\\/]/).pop();
// whether two paths name the same file (on Windows, whatever their case)
export const samePath = (a, b) => (/^[a-z]:|\\/i.test(String(a)) ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
// `p` relative to the workspace, as shown (forward slashes), or the whole path when outside it
export function relativeTo(root, p) {
  const r = shortPath(root).replace(/\/+$/, ""), f = shortPath(p);
  return f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : f;
}

export async function copyText(text, what = "路径") {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制${what}`);
  } catch { prompt(`请手动复制${what}`, text); }
}

// A menu where the pointer is (popMenu places it by an element: one made there for it).
export function menuAt(x, y, items, onPick) {
  const a = document.createElement("span");
  a.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:230px;height:1px;pointer-events:none`;
  document.body.appendChild(a);
  popMenu(a, [{ key: "m", title: "", items }], (k, v) => onPick(v), { dropdown: true });
  a.remove();
}
