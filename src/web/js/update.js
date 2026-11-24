// Updates of claude-pro from npm, which the user starts from the version in the sidebar.

import { api, toast, fail, $ } from "./util.js";

let updateInfo, updateTimer, clickedVersion;
const updateButton = $("#brandUpdate");
export function paintBrandUpdate(info) {
  updateInfo = info;
  if (info.runningVersion) $("#brandVersion").textContent = `v${info.runningVersion}`;
  const busy = info.status === "updating" || info.status === "restarting";
  const available = info.status === "available" || info.status === "installed";
  updateButton.classList.toggle("hidden", !available && !busy);
  updateButton.disabled = busy;
  updateButton.textContent = busy ? "…" : "↑";
  updateButton.title = busy ? (info.status === "updating" ? `正在安装 v${info.version}` : `等待加载 v${info.version}`) : available ? `${info.status === "installed" ? "加载" : "更新到"} v${info.version}` : "";
  updateButton.setAttribute("aria-label", updateButton.title);
  if (clickedVersion && !busy) {
    if (info.runningVersion === clickedVersion) { toast(`已更新到 v${info.runningVersion}，刷新网页可加载新版界面`); clickedVersion = null; }
    else if (info.error && available) { fail(new Error(info.error)); clickedVersion = null; }
    else if (info.status === "current" || info.status === "dev") clickedVersion = null;
  }
  scheduleUpdateCheck(busy || clickedVersion ? 2500 : info.status === "error" ? 60_000 : 15 * 60_000);
}

export function scheduleUpdateCheck(delay = 0) {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    try { paintBrandUpdate(await api("/api/update")); }
    catch { scheduleUpdateCheck(clickedVersion ? 2500 : 60_000); }
  }, delay);
}

updateButton.addEventListener("click", async () => {
  if (!updateInfo || updateButton.disabled) return;
  const { status, version } = updateInfo;
  const promptText = status === "installed" ? `加载已安装的 v${version}？控制台会在会话空闲后重启。` : `在运行 claude-pro 的电脑上安装 v${version}？只会在会话空闲时开始。`;
  if (!confirm(promptText)) return;
  clearTimeout(updateTimer);
  updateButton.disabled = true;
  try {
    clickedVersion = version;
    paintBrandUpdate(await api("/api/update", { method: "POST", body: { version } }));
  } catch (e) {
    clickedVersion = null;
    paintBrandUpdate(updateInfo);
    fail(e);
  }
});
