import { rememberDownloadTarget } from "../shared/download.js";
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

button.addEventListener("click", pickFolder);
