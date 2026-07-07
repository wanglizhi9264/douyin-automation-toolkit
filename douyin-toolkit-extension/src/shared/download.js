export async function chooseDownloadTarget({ preferBrowserDownloads = true } = {}) {
  if (preferBrowserDownloads && globalThis.chrome?.downloads?.download) {
    return { kind: "downloads" };
  }

  if (globalThis.showDirectoryPicker) {
    try {
      return {
        kind: "filesystem",
        handle: await showDirectoryPicker({ mode: "readwrite" }),
      };
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("已取消选择下载目录");
      if (!globalThis.chrome?.downloads?.download) {
        throw new Error(`目录写入不可用：${error.message}`);
      }
    }
  }
  if (globalThis.chrome?.downloads?.download) return { kind: "downloads" };
  throw new Error("当前浏览器不支持目录写入，也没有 downloads 权限");
}

function downloadWithChromeDownloads(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(downloadId);
    });
  });
}

export async function writeFile(target, relativePath, data) {
  if (target.kind === "downloads") {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const url = URL.createObjectURL(blob);
    try {
      await downloadWithChromeDownloads({
        url,
        filename: relativePath,
        conflictAction: "uniquify",
        saveAs: false,
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    return;
  }

  const parts = relativePath.split("/").filter(Boolean);
  const fileName = parts.pop();
  let dir = target.handle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const file = await dir.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(data);
  await writable.close();
}
