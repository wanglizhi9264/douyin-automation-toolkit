import {
  getStoredDownloadTarget,
  rememberDownloadTarget,
} from "../shared/download.js";
import { inspectFolder } from "../archive/fs.js";
import { Repository } from "../archive/repository.js";
const statusNode = document.getElementById("status"),
  button = document.getElementById("pickBtn");
button.addEventListener("click", async () => {
  button.disabled = true;
  statusNode.textContent = "正在打开文件夹选择器…";
  try {
    const stored = await getStoredDownloadTarget();
    const handle = await showDirectoryPicker({
      startIn: stored?.handle || "videos",
      mode: "readwrite",
    });
    const info = await inspectFolder(handle);
    const repo = await Repository.open({ handle, kind: "filesystem" });
    await navigator.locks.request(
      "douyin-archive-" + repo.state.id,
      { ifAvailable: true },
      async (lock) => {
        if (!lock)
          throw new Error("这个备份库正在使用，请先暂停另一个标签页的任务");
        await repo.initialize();
      },
    );
    await rememberDownloadTarget(handle, handle.name || "");
    statusNode.textContent =
      info.kind === "empty"
        ? "备份文件夹已准备好，正在返回抖音…"
        : `已找到备份记录：${repo.stats.unique.toLocaleString()} 个作品。正在返回抖音…`;
    const tabId = Number(
      new URLSearchParams(location.search).get("returnTabId") || 0,
    );
    if (tabId > 0)
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    setTimeout(() => window.close(), 700);
  } catch (error) {
    statusNode.textContent =
      error.name === "AbortError"
        ? "已取消选择。"
        : "选择失败：" + error.message;
  } finally {
    button.disabled = false;
  }
});
