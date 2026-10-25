import { getStoredDownloadTarget, rememberDownloadTarget } from "../shared/download.js";
import { addLog } from "../shared/db.js";

const statusNode = document.getElementById("status");
const button = document.getElementById("pickBtn");

button.addEventListener("click", pickArchiveFolder);

async function readArchiveSummary(handle) {
  try {
    const dataDirectory = await handle.getDirectoryHandle("data", { create: false });
    const appDataDirectory = await dataDirectory.getDirectoryHandle(".appdata", { create: false });
    try {
      const countsHandle = await appDataDirectory.getFileHandle("download-counts.json", { create: false });
      const countsFile = JSON.parse(await (await countsHandle.getFile()).text());
      const counts = countsFile?.counts || {};
      const downloaded = ["liked", "bookmarked", "following"]
        .reduce((sum, scope) => sum + Math.max(0, Number(counts[scope] || 0)), 0);
      return { exists: true, downloaded, pending: 0, scope: "", userName: "" };
    } catch {}
    const stateHandle = await appDataDirectory.getFileHandle("download-state.json", { create: false });
    const state = JSON.parse(await (await stateHandle.getFile()).text());
    return {
      exists: true,
      downloaded: Math.max(0, Number(state?.downloadedTotal || 0)),
      pending: Math.max(0, Number(state?.pendingTotal || 0)),
      scope: state?.current?.scope || "",
      userName: state?.user?.nickname || "",
    };
  } catch {
    return { exists: false, downloaded: 0, pending: 0, scope: "", userName: "" };
  }
}

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
    const archive = await readArchiveSummary(handle);
    if (!archive.exists) {
      const accepted = window.confirm(
        `“${handle.name || "所选文件夹"}”中没有检测到历史下载记录。\n\n`
        + "使用它会创建一个全新的下载库，并从头建立进度。是否继续？",
      );
      if (!accepted) {
        statusNode.textContent = "已保留原下载目录，没有切换到新文件夹。";
        return;
      }
    }
    await initializeArchiveFolder(handle);
    await rememberDownloadTarget(handle, handle.name || "");
    await addLog(
      archive.exists
        ? `已选择历史下载目录，将继续下载：${handle.name || "已选择文件夹"}`
        : `已创建新下载目录：${handle.name || "已选择文件夹"}`,
      "info",
      {
      type: archive.exists ? "download_target_resume_selected" : "download_target_new_selected",
      folderName: handle.name || "",
      downloaded: archive.downloaded,
      pending: archive.pending,
      scope: archive.scope,
      },
    );
    statusNode.textContent = archive.exists
      ? `已找到历史记录：${archive.downloaded} 个已完成${archive.pending ? `，${archive.pending} 个待处理` : ""}。\n已切换并将从原进度继续，正在返回抖音…`
      : `已创建新下载库：${handle.name || "未命名文件夹"}\n正在返回抖音…`;
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
