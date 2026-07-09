import { getConfig, setConfig } from "./db.js";

function canUseBrowserDownloads() {
  return Boolean(
    globalThis.chrome?.runtime?.sendMessage
    || globalThis.chrome?.downloads?.download
  );
}

export async function getStoredDownloadTarget() {
  const target = await getConfig("downloadTarget", null);
  if (!target?.handle) return null;
  try {
    const permission = await target.handle.queryPermission?.({ mode: "readwrite" });
    return {
      kind: "filesystem",
      handle: target.handle,
      label: target.label || "",
      selectedAt: target.selectedAt || "",
      permission: permission || "unknown",
    };
  } catch {
    return null;
  }
}

export async function rememberDownloadTarget(handle, label = "") {
  await setConfig("downloadTarget", {
    handle,
    label,
    selectedAt: new Date().toISOString(),
  });
}

export async function clearStoredDownloadTarget() {
  await setConfig("downloadTarget", null);
}

export async function chooseDownloadTarget({ preferBrowserDownloads = true, preferSavedFolder = true } = {}) {
  if (preferSavedFolder) {
    const stored = await getStoredDownloadTarget();
    if (stored?.permission === "granted") return stored;
  }

  if (preferBrowserDownloads && canUseBrowserDownloads()) {
    return { kind: "downloads" };
  }

  if (globalThis.showDirectoryPicker) {
    try {
      const handle = await showDirectoryPicker({ mode: "readwrite" });
      await rememberDownloadTarget(handle, handle.name || "");
      return {
        kind: "filesystem",
        handle,
        label: handle.name || "",
        permission: "granted",
      };
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("已取消选择下载目录");
      if (!canUseBrowserDownloads()) {
        throw new Error(`目录写入不可用：${error.message}`);
      }
    }
  }
  if (canUseBrowserDownloads()) return { kind: "downloads" };
  throw new Error("当前浏览器不支持目录写入，也没有 downloads 权限");
}

function downloadWithChromeDownloads(options) {
  return new Promise((resolve, reject) => {
    if (globalThis.chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "DOWNLOAD_URL", ...options }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "download failed"));
          return;
        }
        resolve(response.downloadId);
      });
      return;
    }

    if (globalThis.chrome?.downloads?.download) {
      chrome.downloads.download(options, (downloadId) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(downloadId);
      });
      return;
    }

    const anchor = document.createElement("a");
    anchor.href = options.url;
    anchor.download = options.filename.split("/").pop() || "download";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    resolve(null);
  });
}

export async function writeFile(target, relativePath, data) {
  if (target.kind === "downloads") {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const url = data instanceof Blob ? URL.createObjectURL(blob) : `data:application/json;charset=utf-8,${encodeURIComponent(String(data))}`;
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

export async function readTextFile(target, relativePath) {
  if (target.kind !== "filesystem") return null;
  const parts = relativePath.split("/").filter(Boolean);
  const fileName = parts.pop();
  let dir = target.handle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: false });
  }
  const file = await dir.getFileHandle(fileName, { create: false });
  return await (await file.getFile()).text();
}

export async function downloadUrl(target, relativePath, url) {
  if (target.kind === "downloads") {
    await downloadWithChromeDownloads({
      url,
      filename: relativePath,
      conflictAction: "uniquify",
      saveAs: false,
    });
    return;
  }

  let response;
  try {
    response = await fetch(url, {
      credentials: "omit",
      mode: "cors",
      headers: { "accept": "*/*" },
    });
  } catch (error) {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return "unknown-host";
      }
    })();
    throw new Error(`抓取失败(${host})：${error?.message || "Failed to fetch"}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.size) throw new Error("0 字节");
  await writeFile(target, relativePath, blob);
}
