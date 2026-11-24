// Images for a message, as pasting one in the terminal: picked, pasted or dropped, shrunk to what the API takes.

import { esc } from "./util.js";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGES = 6;
const encode = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
// {media_type, data (base64), size, url}: scaled down to 2000 px on the longer edge (the model sees no more), at most 5 MB
export async function prepareImage(file) {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error("只支持 PNG、JPEG、GIF、WebP 图片");
  let blob = file;
  if (file.type !== "image/gif") {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (bitmap && (Math.max(bitmap.width, bitmap.height) > 2000 || file.size > 2.5 * 1024 * 1024)) {
      const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      blob = (await encode(canvas, file.type === "image/png" ? "image/png" : "image/jpeg", 0.9)) || file;
      if (blob.size > 2.5 * 1024 * 1024) {
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        blob = (await encode(canvas, "image/jpeg", 0.85)) || blob;
      }
    }
    bitmap?.close?.();
  }
  if (blob.size > 5 * 1024 * 1024) throw new Error("图片太大：缩小后仍超过 5 MB");
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
  return { media_type: IMAGE_TYPES.includes(blob.type) ? blob.type : file.type, data, size: blob.size, url: URL.createObjectURL(blob) };
}

// A tool's output: whole, but folded to its first lines when it is long (展开 shows the rest, 收起 folds it again).
const FOLD_LINES = 5;
export function folded(html) {
  const n = html.split("\n").length;
  if (n <= FOLD_LINES + 2) return `<pre>${html}</pre>`;
  return `<div class="fold"><pre>${html}</pre><button type="button" class="fold-btn" data-fold>展开全部 · ${n} 行</button></div>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-fold]");
  if (!b) return;
  const box = b.closest(".fold");
  const open = box.classList.toggle("open");
  b.textContent = open ? "收起" : `展开全部 · ${box.querySelector("pre").textContent.split("\n").length} 行`;
  if (!open) box.scrollIntoView({ block: "nearest" });
});

// An image of the conversation (or of the message box) opens in a box over the page: Esc, a click or ✕ closes it.
function zoomImage(src) {
  const back = document.createElement("div");
  back.className = "zoom";
  back.innerHTML = `<img src="${esc(src)}" alt="图片"><button type="button" class="zoom-close" aria-label="关闭">✕</button>`;
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  back.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(back);
}
document.addEventListener("click", (e) => {
  const img = e.target.closest("img[data-zoom], .thumb img");
  if (!img) return;
  e.preventDefault();
  zoomImage(img.src);
});
