import { getStoredDownloadTarget, rememberDownloadTarget } from "../shared/download.js";
import { addLog } from "../shared/db.js";

const statusNode = document.getElementById("status");
const button = document.getElementById("pickBtn");

async function pickFolder() {
  statusNode.textContent = "正在打开文件夹选择器…";
  try {
    const handle = await showDirectoryPicker({ mode: "readwrite" });
    await rememberDownloadTarget(handle, handle.name || "");
    await addLog(`下载目录已更新：${handle.name || "已选择文件夹"}`, "info", {
      type: "download_target_selected",
      folderName: handle.name || "",
    });
    statusNode.textContent = `已记住文件夹：${handle.name || "未命名文件夹"}\n可以关闭这个页面，回到抖音侧边栏继续下载。`;
  } catch (error) {
    if (error?.name === "AbortError") {
      statusNode.textContent = "已取消选择。";
      return;
    }
    statusNode.textContent = `选择失败：${error.message}`;
  }
}

button.addEventListener("click", pickArchiveFolder);
async function initializeArchiveFolder(handle) {
  const dataDirectory = await handle.getDirectoryHandle("data", { create: true });
  await dataDirectory.getDirectoryHandle(".appdata", { create: true });
}

async function returnToDouyinTab() {
  const returnTabId = Number(new URLSearchParams(location.search).get("returnTabId") || 0);
  if (returnTabId > 0) {
    await chrome.tabs.update(returnTabId, { active: true }).catch(() => {});
  }
}

async function pickArchiveFolder() {
  statusNode.textContent = "\u6b63\u5728\u6253\u5f00\u6587\u4ef6\u5939\u9009\u62e9\u5668\u2026";
  try {
    const stored = await getStoredDownloadTarget();
    const handle = await showDirectoryPicker({
      startIn: stored?.handle || "videos",
      mode: "readwrite",
    });
    await initializeArchiveFolder(handle);
    await rememberDownloadTarget(handle, handle.name || "");
    await addLog("\u4e0b\u8f7d\u76ee\u5f55\u5df2\u66f4\u65b0\uff1a" + (handle.name || "\u5df2\u9009\u62e9\u6587\u4ef6\u5939"), "info", {
      type: "download_target_selected",
      folderName: handle.name || "",
    });
    statusNode.textContent = "\u5df2\u8bb0\u4f4f\u5e76\u521d\u59cb\u5316\u6587\u4ef6\u5939\uff1a"
      + (handle.name || "\u672a\u547d\u540d\u6587\u4ef6\u5939") + "\n\u6b63\u5728\u8fd4\u56de\u6296\u97f3\u2026";
    await returnToDouyinTab();
    setTimeout(() => window.close(), 800);
  } catch (error) {
    if (error?.name === "AbortError") {
      statusNode.textContent = "\u5df2\u53d6\u6d88\u9009\u62e9\u3002";
      return;
    }
    statusNode.textContent = "\u9009\u62e9\u5931\u8d25\uff1a" + (error?.message || String(error));
  }
}
