import { getConfig, setConfig } from "./db.js";

function canUseBrowserDownloads() {
  return Boolean(
    globalThis.chrome?.runtime?.sendMessage
    || globalThis.chrome?.downloads?.download
  );
}

export async function resolveDownloadTargetRecord(target, { requestPermission = false } = {}) {
  if (!target?.handle) return null;
  try {
    let permission = await target.handle.queryPermission?.({ mode: "readwrite" });
    if (permission === "prompt" && requestPermission && target.handle.requestPermission) {
      try {
        permission = await target.handle.requestPermission({ mode: "readwrite" });
      } catch {
        permission = "prompt";
      }
    }
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

export async function getStoredDownloadTarget(options = {}) {
  const target = await getConfig("downloadTarget", null);
  return resolveDownloadTargetRecord(target, options);
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
  let stored = null;
  if (preferSavedFolder) {
    stored = await getStoredDownloadTarget({ requestPermission: true });
    if (stored?.permission === "granted") return stored;
  }

  if (preferBrowserDownloads && canUseBrowserDownloads()) {
    return { kind: "downloads" };
  }

  if (globalThis.showDirectoryPicker) {
    try {
      const handle = await showDirectoryPicker({
        startIn: stored?.handle || "videos",
        mode: "readwrite",
      });
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
          reject(new Error((response?.error || "download failed") + " [state=" + (response?.state || "unknown") + ", id=" + (response?.downloadId ?? "none") + "]"));
          return;
        }
        resolve(response);
      });
      return;
    }

    if (globalThis.chrome?.downloads?.download) {
      chrome.downloads.download(options, (downloadId) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve({ ok: true, downloadId, state: "queued" });
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
    resolve({ ok: true, downloadId: null, state: "anchor" });
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

export async function downloadVerifiedMedia(target, relativePath, url, {
  expected = "video",
  headerTimeoutMs = 30000,
  totalTimeoutMs = 120000,
} = {}) {
  if (target?.kind !== "filesystem" || !target.handle) {
    throw new Error("\u5a92\u4f53\u6587\u4ef6\u5fc5\u987b\u5199\u5165\u5df2\u6388\u6743\u6587\u4ef6\u5939");
  }
  const controller = new AbortController();
  let phase = "request";
  const headerTimeout = setTimeout(() => controller.abort(), headerTimeoutMs);
  const totalTimeout = setTimeout(() => controller.abort(), totalTimeoutMs);
  try {
    const response = await fetch(url, {
      credentials: "omit",
      signal: controller.signal,
      headers: { "accept": "*/*" },
    });
    phase = "download";
    clearTimeout(headerTimeout);
    const contentType = response.headers.get("content-type") || "";
    const contentLength = Number(response.headers.get("content-length") || 0);
    const acceptRanges = response.headers.get("accept-ranges") || "";
    if (response.status === 206) {
      throw new Error("\u5a92\u4f53\u8bf7\u6c42\u5931\u8d25\uff1a\u610f\u5916\u6536\u5230\u5206\u6bb5\u54cd\u5e94 206");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error("\u5a92\u4f53\u8bf7\u6c42\u5931\u8d25\uff1aHTTP " + response.status);
    }
    if (expected === "video" && !contentType.includes("video/mp4")) {
      throw new Error("\u5a92\u4f53\u8bf7\u6c42\u5931\u8d25\uff1a\u89c6\u9891 MIME \u4e3a " + (contentType || "unknown"));
    }
    if (expected === "image" && !contentType.startsWith("image/")) {
      throw new Error("\u5a92\u4f53\u8bf7\u6c42\u5931\u8d25\uff1a\u5c01\u9762 MIME \u4e3a " + (contentType || "unknown"));
    }
    if (expected === "video" && !contentLength) {
      throw new Error("\u5a92\u4f53\u8bf7\u6c42\u5931\u8d25\uff1a\u672a\u8fd4\u56de\u89c6\u9891\u5927\u5c0f");
    }
    const blob = await response.blob();
    if (!blob.size) {
      throw new Error("\u5a92\u4f53\u8bf7\u6c42\u5931\u8d25\uff1a0 \u5b57\u8282");
    }
    if (contentLength && blob.size !== contentLength) {
      throw new Error("\u5a92\u4f53\u8bf7\u6c42\u5931\u8d25\uff1a\u5927\u5c0f\u4e0d\u4e00\u81f4 " + blob.size + "/" + contentLength);
    }
    phase = "write";
    await writeFile(target, relativePath, blob);
    return {
      ok: true,
      size: blob.size,
      contentType: blob.type || contentType,
      precheck: {
        ok: true,
        httpStatus: response.status,
        contentType,
        contentLength: blob.size,
        acceptRanges,
        sizeLabel: (blob.size / 1024 / 1024).toFixed(1) + "MB",
      },
    };
  } catch (error) {
    controller.abort();
    if (error?.name === "AbortError") {
      if (phase === "request") {
        throw new Error("\u7b49\u5f85\u5a92\u4f53\u54cd\u5e94\u8d85\u8fc7 " + Math.round(headerTimeoutMs / 1000) + " \u79d2");
      }
      throw new Error("\u5a92\u4f53\u4e0b\u8f7d\u8d85\u8fc7 " + Math.round(totalTimeoutMs / 1000) + " \u79d2");
    }
    const message = error?.message || String(error);
    if (message.startsWith("\u5a92\u4f53\u8bf7\u6c42\u5931\u8d25")) throw error;
    if (phase === "write") {
      throw new Error("\u6587\u4ef6\u5199\u5165\u5931\u8d25\uff1a" + message);
    }
    let host = "unknown-host";
    try {
      host = new URL(url).host;
    } catch {}
    throw new Error("\u6269\u5c55\u6293\u53d6\u5931\u8d25(" + host + ")\uff1a" + message);
  } finally {
    clearTimeout(headerTimeout);
    clearTimeout(totalTimeout);
  }
}

export async function downloadUrl(target, relativePath, url) {
  if (target.kind === "downloads") {
    return await downloadWithChromeDownloads({
      url,
      filename: relativePath,
      conflictAction: "uniquify",
      saveAs: false,
    });
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
  return {
    ok: true,
    state: "complete",
    filename: relativePath,
    bytesReceived: blob.size,
    totalBytes: blob.size,
    contentType: blob.type || response.headers.get("content-type") || "",
  };
}
