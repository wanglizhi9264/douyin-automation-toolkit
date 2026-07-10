import { sendPageRequest } from "../shared/events.js";
import { addLog, getAll, putItems } from "../shared/db.js";
import { DEFAULT_CONFIG, importProgress, loadConfig, saveConfig, summarize } from "../shared/state.js";
import { describeVideoCandidate, pickVideoCandidates, pickVideoUrl } from "../shared/api.js";
import { chooseDownloadTarget, downloadUrl, getStoredDownloadTarget, readTextFile, writeFile } from "../shared/download.js";

const $ = (id) => document.getElementById(id);
let configHydrated = false;
let stopRequested = false;
let running = false;
let downloadRunning = false;
let downloadPauseRequested = false;
let downloadBatchState = {
  total: 0,
  completed: 0,
  currentIndex: null,
  currentAwemeId: "",
  currentResolution: "",
  phase: "idle",
};
let downloadRecordCache = {
  targetKey: "",
  record: null,
};
let currentView = "home";
let currentDownloadScope = "liked";

async function getSelectedFollowingAuthors() {
  const result = await chrome.storage.local.get(["selectedFollowingAuthors"]);
  return Array.isArray(result.selectedFollowingAuthors) ? result.selectedFollowingAuthors : [];
}

async function setSelectedFollowingAuthors(authorUids) {
  await chrome.storage.local.set({
    selectedFollowingAuthors: [...new Set((authorUids || []).filter(Boolean).map(String))],
  });
}

const SUCCESS_STATUSES = new Set(["favorited", "already_favorited", "skipped_inaccessible"]);
const RUNNABLE_STATUSES = new Set([
  "pending",
  "processing",
  "paused_unverified",
  "paused_unavailable",
  "paused_unclickable",
  "paused_rate_limited",
  "blocked",
]);
const RATE_LIMIT_CODES = new Set([3009008]);

function setGlobalStatus(text) {
  $("runtimeStatus").textContent = text;
}

function setFavoriteStatus(text) {
  $("favoriteRuntimeStatus").textContent = text;
}

function setDownloadStatus(text) {
  $("downloadRuntimeStatus").textContent = text;
  $("downloadTaskPhase").textContent = text;
}

function setView(view) {
  currentView = view;
  $("homeView").classList.toggle("hidden", view !== "home");
  $("downloadTaskView").classList.toggle("hidden", view !== "download-task");
}

function updateDownloadBatchProgress() {
  const state = downloadBatchState;
  if (!state.total) {
    $("downloadBatchProgress").innerHTML = "尚未开始下载";
    $("downloadTaskProgress").innerHTML = "尚未开始下载";
    return;
  }
  const currentLine = state.currentIndex == null
    ? ""
    : `当前：#${escapeHtml(state.currentIndex)} ${escapeHtml(state.currentAwemeId || "")}`;
  const resolutionLine = state.currentResolution ? `分辨率：${escapeHtml(state.currentResolution)}` : "";
  const progressHtml = [
    `状态：${escapeHtml(state.phase)}`,
    `进度：${escapeHtml(state.completed)} / ${escapeHtml(state.total)}`,
    currentLine,
    resolutionLine,
  ].filter(Boolean).join("<br>");
  $("downloadBatchProgress").innerHTML = progressHtml;
  $("downloadTaskProgress").innerHTML = progressHtml;
}

function getDownloadRecordPath() {
  return "data/.appdata/download-state.json";
}

function getDownloadReportPath() {
  return "本地库.html";
}

function getSourceFolder(source) {
  if (source === "bookmarked") return "data/收藏";
  if (source === "following") return "data/关注/视频";
  return "data/点赞";
}

function getDownloadScopeDefinition(scope) {
  if (scope === "bookmarked") {
    return {
      key: "bookmarked",
      label: "收藏视频",
      startText: "已点击开始下载收藏视频，正在检查可下载项目",
      emptyText: "没有待下载的收藏视频",
      isEligible: (item) => item.source === "bookmarked" && item.downloadStatus !== "downloaded",
    };
  }
  if (scope === "following") {
    return {
      key: "following",
      label: "关注列表视频",
      startText: "已点击开始下载关注列表视频，正在检查可下载项目",
      emptyText: "没有待下载的关注列表视频",
      isEligible: (item, context = {}) => {
        if (item.source !== "following" || item.downloadStatus === "downloaded") return false;
        const selected = context.selectedFollowingAuthors || [];
        if (!selected.length) return true;
        return selected.includes(String(item.authorUid || ""));
      },
    };
  }
  return {
    key: "liked",
    label: "喜欢视频",
    startText: "已点击开始下载喜欢视频，正在检查可下载项目",
    emptyText: "没有待下载的喜欢视频",
    isEligible: (item) => ["favorited", "already_favorited"].includes(item.status) && item.downloadStatus !== "downloaded",
  };
}

function renderDownloadTaskHeader(scope) {
  const scopeDef = getDownloadScopeDefinition(scope);
  $("downloadTaskScopeStatus").textContent = scopeDef.label;
  $("downloadTaskTitle").textContent = scopeDef.label;
  $("downloadTaskScope").textContent = scopeDef.label;
}

function buildMediaBase(item) {
  return String(item.awemeId);
}

function getTargetCacheKey(target) {
  if (!target || target.kind !== "filesystem") return target?.kind || "";
  return `filesystem:${target.label || ""}:${target.selectedAt || ""}`;
}

async function readDownloadRecord(target) {
  if (target?.kind !== "filesystem") return null;
  try {
    const text = await readTextFile(target, getDownloadRecordPath());
    if (!text) return null;
    const record = JSON.parse(text);
    return Array.isArray(record?.items) ? record : null;
  } catch {
    return null;
  }
}

async function getCachedDownloadRecord(target, { force = false } = {}) {
  const key = getTargetCacheKey(target);
  if (!force && key && downloadRecordCache.targetKey === key) {
    return downloadRecordCache.record;
  }
  const record = await readDownloadRecord(target);
  downloadRecordCache = { targetKey: key, record };
  return record;
}

function setCachedDownloadRecord(target, record) {
  downloadRecordCache = {
    targetKey: getTargetCacheKey(target),
    record,
  };
}

function buildDownloadRecord(items, state) {
  const eligibleItems = items
    .filter((item) => ["favorited", "already_favorited"].includes(item.status))
    .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  return {
    generatedAt: new Date().toISOString(),
    likedTotal: items.filter((item) => item.source === "liked" || item.source === "favorite_api").length,
    eligibleTotal: eligibleItems.length,
    downloadedTotal: eligibleItems.filter((item) => item.downloadStatus === "downloaded").length,
    pendingTotal: eligibleItems.filter((item) => item.downloadStatus !== "downloaded").length,
    failedTotal: eligibleItems.filter((item) => item.downloadStatus === "failed").length,
    current: {
      index: state.currentIndex,
      awemeId: state.currentAwemeId,
      resolution: state.currentResolution,
      phase: state.phase,
      completed: state.completed,
      total: state.total,
    },
    items: eligibleItems.map((item) => ({
      awemeId: item.awemeId,
      index: item.index,
      status: item.status,
      downloadStatus: item.downloadStatus || "not_started",
      desc: item.desc || "",
      authorName: item.authorName || "",
      resolution: item.downloadQualityLabel || "",
      width: item.downloadWidth || 0,
      bitrate: item.downloadBitrate || 0,
      size: item.downloadSize || 0,
      videoPath: item.downloadVideoPath || "",
      coverPath: item.downloadCoverPath || "",
      url: item.url || "",
      lastError: item.lastError || "",
      updatedAt: item.updatedAt || "",
    })),
  };
}

function buildDownloadReportHtml(record, folderLabel = "") {
  const rows = record.items.map((item) => `
    <tr>
      <td>${item.index ?? ""}</td>
      <td>${item.awemeId}</td>
      <td>${escapeHtml(item.downloadStatus)}</td>
      <td>${escapeHtml(item.resolution || "-")}</td>
      <td>${escapeHtml(item.authorName || "-")}</td>
      <td>${escapeHtml(item.desc || "-")}</td>
    </tr>
  `).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Douyin Backup Report</title>
  <style>
    :root { color-scheme: light; --bg:#f5f5f7; --panel:#fff; --text:#1d1d1f; --muted:#6e6e73; --line:#d8d8de; }
    * { box-sizing:border-box; }
    body { margin:0; padding:24px; font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif; color:var(--text); background:var(--bg); }
    .wrap { max-width:1200px; margin:0 auto; }
    .hero { background:var(--panel); border:1px solid var(--line); border-radius:18px; padding:20px; margin-bottom:16px; }
    .stats { display:grid; grid-template-columns:repeat(4,minmax(140px,1fr)); gap:12px; margin-top:16px; }
    .stat { background:#fbfbfd; border:1px solid var(--line); border-radius:14px; padding:14px; }
    .label { color:var(--muted); font-size:12px; }
    .value { font-size:28px; font-weight:700; margin-top:6px; }
    table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:18px; overflow:hidden; }
    th, td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { background:#fbfbfd; font-size:12px; color:var(--muted); }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <h1 style="margin:0;">抖音下载记录</h1>
      <p style="margin:8px 0 0;color:var(--muted);">文件夹：${escapeHtml(folderLabel || "已授权目录")} · 生成时间：${escapeHtml(record.generatedAt)}</p>
      <p style="margin:8px 0 0;color:var(--muted);">当前阶段：${escapeHtml(record.current.phase || "-")} · 当前条目：#${escapeHtml(record.current.index ?? "-")} · 当前分辨率：${escapeHtml(record.current.resolution || "-")}</p>
      <div class="stats">
        <div class="stat"><div class="label">总喜欢</div><div class="value">${record.likedTotal}</div></div>
        <div class="stat"><div class="label">可下载</div><div class="value">${record.eligibleTotal}</div></div>
        <div class="stat"><div class="label">已下载</div><div class="value">${record.downloadedTotal}</div></div>
        <div class="stat"><div class="label">待下载</div><div class="value">${record.pendingTotal}</div></div>
      </div>
    </section>
    <table>
      <thead><tr><th>#</th><th>Aweme</th><th>下载状态</th><th>分辨率</th><th>作者</th><th>描述</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

async function persistDownloadArtifacts(target, batchState) {
  if (target.kind !== "filesystem") return;
  const items = await getAll("items");
  const record = buildDownloadRecord(items, batchState);
  await writeFile(target, getDownloadRecordPath(), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(target, getDownloadReportPath(), buildDownloadReportHtml(record, target.label || ""));
  await writeLocalDatabaseFiles(target, items, record);
  setCachedDownloadRecord(target, record);
}

function buildLocalDatabase(items, record) {
  const eligibleItems = items.filter((item) => ["favorited", "already_favorited"].includes(item.status));
  const downloaded = eligibleItems.filter((item) => item.downloadStatus === "downloaded");
  const authors = {};
  const videos = {};
  const texts = {};
  for (const item of eligibleItems) {
    if (item.authorUid) {
      authors[item.authorUid] = {
        uid: item.authorUid,
        nickname: item.authorName || "",
      };
    }
    videos[item.awemeId] = {
      awemeId: item.awemeId,
      authorUid: item.authorUid || "",
      createTime: item.createTime || 0,
      source: item.source || "liked",
      status: item.status || "",
      downloadStatus: item.downloadStatus || "not_started",
      video: item.downloadVideoPath || "",
      cover: item.downloadCoverPath || "",
      width: item.downloadWidth || 0,
      bitrate: item.downloadBitrate || 0,
      quality: item.downloadQualityLabel || "",
      size: item.downloadSize || 0,
      url: item.url || "",
      updatedAt: item.updatedAt || "",
    };
    texts[item.awemeId] = item.desc || "";
  }
  return {
    db_likes: {
      schemaVersion: 1,
      generatedAt: record.generatedAt,
      likes: {
        total: eligibleItems.length,
        downloaded: downloaded.map((item) => item.awemeId),
        pending: eligibleItems.filter((item) => item.downloadStatus !== "downloaded").map((item) => item.awemeId),
        failed: eligibleItems.filter((item) => item.downloadStatus === "failed").map((item) => item.awemeId),
      },
    },
    db_authors: authors,
    db_videos: videos,
    db_texts: texts,
  };
}

async function writeLocalDatabaseFiles(target, items, record) {
  const db = buildLocalDatabase(items, record);
  await writeFile(target, "data/.appdata/db_likes.json", `${JSON.stringify(db.db_likes, null, 2)}\n`);
  await writeFile(target, "data/.appdata/db_authors.json", `${JSON.stringify(db.db_authors, null, 2)}\n`);
  await writeFile(target, "data/.appdata/db_videos.json", `${JSON.stringify(db.db_videos, null, 2)}\n`);
  await writeFile(target, "data/.appdata/db_texts.json", `${JSON.stringify(db.db_texts, null, 2)}\n`);
  await writeFile(target, "说明.txt", [
    "抖音收藏备份助手",
    "",
    "data/点赞/视频 保存视频文件",
    "data/点赞/封面 保存封面文件",
    "data/.appdata 保存本地数据库和下载状态",
    "本地库.html 可用于查看下载概览",
    "",
  ].join("\n"));
}

async function recoverDownloadedItemsFromFolderRecord(target) {
  if (target.kind !== "filesystem") return 0;
  const record = await getCachedDownloadRecord(target, { force: true });
  if (!record) return 0;
  const items = await getAll("items");
  const byId = new Map((record.items || []).map((item) => [String(item.awemeId), item]));
  const patched = items
    .map((item) => {
      const recordItem = byId.get(String(item.awemeId));
      if (!recordItem || recordItem.downloadStatus !== "downloaded" || item.downloadStatus === "downloaded") return null;
      return patchItem(item, {
        downloadStatus: "downloaded",
        lastError: "",
        downloadQualityLabel: recordItem.resolution || item.downloadQualityLabel || "",
        downloadWidth: recordItem.width || item.downloadWidth || 0,
        downloadBitrate: recordItem.bitrate || item.downloadBitrate || 0,
      });
    })
    .filter(Boolean);
  if (patched.length) await putItems(patched);
  return patched.length;
}

async function resetDownloadStateForFreshFolder() {
  const items = await getAll("items");
  const patched = items
    .filter((item) => item.downloadStatus && item.downloadStatus !== "not_started")
    .map((item) => patchItem(item, {
      downloadStatus: "not_started",
      downloadQualityLabel: "",
      downloadWidth: 0,
      downloadBitrate: 0,
      lastError: String(item.lastError || "").startsWith("下载") ? "" : item.lastError,
    }));
  if (patched.length) await putItems(patched);
  return patched.length;
}

function logLine(text, meta = null) {
  addLog(text, "info", meta).then(render).catch(console.error);
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) resolve({ ok: false, error: error.message });
      else resolve(response || { ok: false, error: "empty response" });
    });
  });
}

function configFromForm() {
  return {
    batchSize: Number($("batchSize").value || DEFAULT_CONFIG.batchSize),
    auditRecent: Number($("auditRecent").value || DEFAULT_CONFIG.auditRecent),
    minDelayMs: Number($("minDelayMs").value || DEFAULT_CONFIG.minDelayMs),
    maxDelayMs: Number($("maxDelayMs").value || DEFAULT_CONFIG.maxDelayMs),
    syncLikedBeforeRun: $("syncLikedBeforeRun").checked,
    downloadCovers: $("downloadCovers").checked,
    downloadPreferBestQuality: $("downloadPreferBestQuality").checked,
    downloadUseSavedFolder: $("downloadUseSavedFolder").checked,
  };
}

function fillConfig(config) {
  $("batchSize").value = config.batchSize ?? DEFAULT_CONFIG.batchSize;
  $("auditRecent").value = config.auditRecent ?? DEFAULT_CONFIG.auditRecent;
  $("minDelayMs").value = config.minDelayMs ?? DEFAULT_CONFIG.minDelayMs;
  $("maxDelayMs").value = config.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs;
  $("syncLikedBeforeRun").checked = Boolean(config.syncLikedBeforeRun);
  $("downloadCovers").checked = Boolean(config.downloadCovers);
  $("downloadPreferBestQuality").checked = Boolean(config.downloadPreferBestQuality);
  $("downloadUseSavedFolder").checked = Boolean(config.downloadUseSavedFolder);
}

function renderLogs(logs) {
  const latest = logs[logs.length - 1];
  $("latestLog").innerHTML = latest
    ? `<span style="color:#8e8e93">${escapeHtml((latest.createdAt || "").slice(11, 19))}</span> ${escapeHtml(latest.text)}`
    : "暂无日志";
  $("log").innerHTML = [...logs].reverse().map((entry) => {
    const time = (entry.createdAt || "").slice(11, 19);
    return `<div><span style="color:#8e8e93">${escapeHtml(time)}</span> ${escapeHtml(entry.text)}</div>`;
  }).join("");
  $("log").scrollTop = 0;
}

function buildFollowingAuthors(items) {
  const grouped = new Map();
  for (const item of items) {
    if (item.source !== "following" || !item.authorUid) continue;
    const key = String(item.authorUid);
    const entry = grouped.get(key) || {
      authorUid: key,
      authorName: item.authorName || "未命名作者",
      total: 0,
      pending: 0,
      downloaded: 0,
    };
    entry.total += 1;
    if (item.downloadStatus === "downloaded") entry.downloaded += 1;
    else entry.pending += 1;
    if (!entry.authorName && item.authorName) entry.authorName = item.authorName;
    grouped.set(key, entry);
  }
  return [...grouped.values()].sort((a, b) => b.pending - a.pending || b.total - a.total || a.authorName.localeCompare(b.authorName));
}

function renderFollowingAuthors(authors, selectedAuthorUids) {
  const selected = new Set(selectedAuthorUids || []);
  $("followingSelectionStatus").textContent = authors.length
    ? `已选 ${authors.filter((author) => selected.has(author.authorUid)).length} / ${authors.length}`
    : "未选择";
  $("followingSelectionMeta").textContent = authors.length
    ? "勾选后，“下载关注列表视频”只会下载这些作者；如果一个都不选，则默认下载全部关注作者。"
    : "当前还没有可供勾选的关注作者数据。";
  $("followingAuthorList").innerHTML = authors.map((author) => `
    <label class="selection-item">
      <input type="checkbox" class="following-author-checkbox" value="${escapeHtml(author.authorUid)}" ${selected.has(author.authorUid) ? "checked" : ""} />
      <span class="selection-main">
        <div class="selection-title">${escapeHtml(author.authorName || "未命名作者")}</div>
        <div class="selection-subtitle">UID: ${escapeHtml(author.authorUid)} · 共 ${author.total} 条 · 待下载 ${author.pending} 条 · 已下载 ${author.downloaded} 条</div>
      </span>
    </label>
  `).join("");
  for (const node of document.querySelectorAll(".following-author-checkbox")) {
    node.addEventListener("change", async () => {
      const values = [...document.querySelectorAll(".following-author-checkbox:checked")].map((input) => input.value);
      await setSelectedFollowingAuthors(values);
      renderFollowingAuthors(authors, values);
    });
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

async function render() {
  const state = await summarize();
  const items = await getAll("items");
  const followingAuthors = buildFollowingAuthors(items);
  const selectedFollowingAuthors = await getSelectedFollowingAuthors();
  const storedTarget = await getStoredDownloadTarget();
  const folderRecord = storedTarget?.permission === "granted"
    ? await getCachedDownloadRecord(storedTarget)
    : null;
  if (!configHydrated && !document.activeElement?.matches("input")) {
    fillConfig(state.config);
    configHydrated = true;
  }
  const recordCurrent = folderRecord?.current || null;
  const recordItems = Array.isArray(folderRecord?.items) ? folderRecord.items : [];
  const recordCursorItem = [...recordItems]
    .filter((item) => item.downloadStatus && item.downloadStatus !== "not_started")
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
  $("likedSummaryCount").textContent = folderRecord?.likedTotal ?? 0;
  $("likedSummaryCursor").textContent = recordCurrent?.total
    ? `${recordCurrent.completed || 0} / ${recordCurrent.total || 0}`
    : "-";
  $("totalCount").textContent = state.total;
  $("successCount").textContent = state.favorite.completed;
  $("pendingCount").textContent = state.favorite.pending;
  $("pausedCount").textContent = state.favorite.paused;
  $("auditPendingCount").textContent = state.favorite.auditPending;
  $("downloadEligibleCount").textContent = folderRecord?.eligibleTotal ?? 0;
  $("downloadedCount").textContent = folderRecord?.downloadedTotal ?? 0;
  $("downloadPendingCount").textContent = folderRecord?.pendingTotal ?? 0;
  $("downloadFailedCount").textContent = folderRecord?.failedTotal ?? 0;
  $("downloadSummaryCursor").textContent = downloadBatchState.currentIndex != null
    ? `#${downloadBatchState.currentIndex}`
    : (recordCursorItem?.index != null ? `#${recordCursorItem.index}` : "-");
  $("downloadSummaryResolution").textContent = downloadBatchState.currentResolution
    || recordCursorItem?.resolution
    || "-";
  $("downloadTaskCursor").textContent = downloadBatchState.currentIndex != null
    ? `#${downloadBatchState.currentIndex}`
    : (recordCursorItem?.index != null ? `#${recordCursorItem.index}` : "-");
  $("downloadTaskResolution").textContent = downloadBatchState.currentResolution || recordCursorItem?.resolution || "-";
  $("favoriteCursorBox").innerHTML = state.favorite.cursor
    ? [
      `Index: ${escapeHtml(state.favorite.cursor.index)}`,
      `状态: ${escapeHtml(state.favorite.cursor.status)}`,
      `作品: ${escapeHtml(state.favorite.cursor.awemeId)}`,
      `描述: ${escapeHtml(state.favorite.cursor.desc || "")}`,
      state.favorite.cursor.lastError ? `错误: ${escapeHtml(state.favorite.cursor.lastError)}` : "",
    ].filter(Boolean).join("<br>")
    : "尚无数据";
  $("downloadCursorBox").innerHTML = recordCursorItem
    ? [
      `Index: ${escapeHtml(recordCursorItem.index)}`,
      `下载状态: ${escapeHtml(recordCursorItem.downloadStatus || "not_started")}`,
      `作品: ${escapeHtml(recordCursorItem.awemeId)}`,
      `描述: ${escapeHtml(recordCursorItem.desc || "")}`,
      recordCursorItem.lastError ? `错误: ${escapeHtml(recordCursorItem.lastError)}` : "",
    ].filter(Boolean).join("<br>")
    : (storedTarget?.permission === "granted" ? "当前文件夹还没有下载记录" : "尚无数据");
  $("downloadTargetMeta").innerHTML = storedTarget?.permission === "granted"
    ? [
      `已记住文件夹：${escapeHtml(storedTarget.label || "已授权文件夹")}`,
      `授权时间：${escapeHtml((storedTarget.selectedAt || "").replace("T", " ").slice(0, 19) || "未知")}`,
      folderRecord ? "检测到该文件夹已有下载记录，后续会按记录继续。" : "该文件夹还没有下载记录文件，开始下载时会从 0 建立记录。",
      `当前勾选该选项时，下载会直接写入这个文件夹，不会出现在浏览器下载记录里。`,
    ].join("<br>")
    : "当前未记住可用文件夹；先点击“选择文件夹”授权目录，否则无法以无浏览器下载记录的方式开始下载。";
  $("downloadTaskTargetMeta").innerHTML = $("downloadTargetMeta").innerHTML;
  $("downloadTaskCursorBox").innerHTML = $("downloadCursorBox").innerHTML;
  renderDownloadTaskHeader(currentDownloadScope);
  renderFollowingAuthors(followingAuthors, selectedFollowingAuthors);
  updateDownloadBatchProgress();
  renderLogs(state.logs);
  updateButtons();
}

async function saveCurrentConfig() {
  await saveConfig({ ...await loadConfig(), ...configFromForm() });
}

function updateButtons() {
  $("favoriteBtn").disabled = running;
  $("auditBtn").disabled = running;
  $("downloadBtn").disabled = downloadRunning;
  $("downloadBookmarkedBtn").disabled = downloadRunning;
  $("downloadFollowingBtn").disabled = downloadRunning;
  $("pauseDownloadBtn").disabled = !downloadRunning;
  $("pauseDownloadTaskBtn").disabled = !downloadRunning;
  $("stopBtn").disabled = !running;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(config) {
  const min = Number(config.minDelayMs ?? DEFAULT_CONFIG.minDelayMs);
  const max = Number(config.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs);
  return Math.floor(min + Math.random() * Math.max(0, max - min + 1));
}

function resultError(result) {
  return result?.statusMsg || result?.text || result?.error || `HTTP ${result?.httpStatus || "unknown"}`;
}

function isRateLimited(result) {
  const text = `${result?.statusMsg || ""} ${result?.text || ""}`;
  return RATE_LIMIT_CODES.has(Number(result?.statusCode)) || /稍后再试|速度太快|频繁|rate/i.test(text);
}

function patchItem(item, changes) {
  return {
    ...item,
    ...changes,
    lastError: changes.lastError ?? item.lastError ?? "",
    updatedAt: new Date().toISOString(),
  };
}

async function saveItem(item) {
  await putItems([item]);
}

async function recoverDownloadedItemsFromLogs() {
  const [items, logs] = await Promise.all([getAll("items"), getAll("logs")]);
  const downloadedById = new Map();
  for (const entry of logs) {
    if (entry?.meta?.type === "download_success" && entry.meta.awemeId) {
      downloadedById.set(String(entry.meta.awemeId), entry.meta);
    }
  }
  const patched = items
    .filter((item) => downloadedById.has(String(item.awemeId)) && item.downloadStatus !== "downloaded")
    .map((item) => patchItem(item, {
      downloadStatus: "downloaded",
      lastError: "",
      videoUrl: item.videoUrl || downloadedById.get(String(item.awemeId)).videoUrl || "",
    }));
  if (patched.length) await putItems(patched);
  return patched.length;
}

async function loadRunnableItems(limit) {
  const items = await getAll("items");
  return items
    .filter((item) => !SUCCESS_STATUSES.has(item.status) && RUNNABLE_STATUSES.has(item.status || "pending"))
    .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
    .slice(0, limit);
}

async function processFavoriteItem(item) {
  setGlobalStatus("收藏中");
  setFavoriteStatus("收藏中");
  await saveItem(patchItem(item, { status: "processing", lastError: "" }));

  const detail = await sendPageRequest("FETCH_AWEME_DETAIL", { awemeId: item.awemeId }, 30000);
  if (detail.ok && detail.collectStat === 1) {
    const updated = patchItem(item, {
      status: "already_favorited",
      collectStat: 1,
      desc: detail.desc || item.desc,
      authorName: detail.authorName || item.authorName,
      authorUid: detail.authorUid || item.authorUid,
      coverUrl: detail.coverUrl || item.coverUrl,
      lastError: "",
    });
    await saveItem(updated);
    return { ok: true, status: updated.status, auditedCandidate: false };
  }

  if (!detail.ok && Number(detail.statusCode) === 2053) {
    const updated = patchItem(item, { status: "skipped_inaccessible", lastError: "作品不可访问，按规则跳过" });
    await saveItem(updated);
    return { ok: true, status: updated.status, auditedCandidate: false };
  }

  if (!detail.ok && isRateLimited(detail)) {
    const updated = patchItem(item, { status: "paused_rate_limited", lastError: resultError(detail) });
    await saveItem(updated);
    return { ok: false, pause: true, reason: updated.lastError };
  }

  const collect = await sendPageRequest("COLLECT_AWEME", { awemeId: item.awemeId }, 30000);
  if (collect.ok) {
    const updated = patchItem(item, {
      status: "favorited",
      collectStat: 1,
      desc: detail.desc || item.desc,
      authorName: detail.authorName || item.authorName,
      authorUid: detail.authorUid || item.authorUid,
      coverUrl: detail.coverUrl || item.coverUrl,
      lastError: "",
    });
    await saveItem(updated);
    return { ok: true, status: updated.status, auditedCandidate: true };
  }

  const status = isRateLimited(collect) ? "paused_rate_limited" : "paused_unverified";
  const updated = patchItem(item, { status, lastError: resultError(collect) });
  await saveItem(updated);
  return { ok: false, pause: true, reason: updated.lastError };
}

async function runFavoriteBatch() {
  if (running) return;
  running = true;
  stopRequested = false;
  updateButtons();
  try {
    setGlobalStatus("收藏中");
    setFavoriteStatus("收藏中");
    await saveCurrentConfig();
    const config = await loadConfig();
    const items = await loadRunnableItems(config.batchSize);
    if (!items.length) {
      setGlobalStatus("空闲");
      setFavoriteStatus("空闲");
      logLine("没有待收藏项目");
      return;
    }
    logLine(`开始收藏批次：${items.length} 条`);
    let completed = 0;
    let newlyFavorited = 0;
    for (const item of items) {
      if (stopRequested) {
        logLine("用户停止，已保存当前进度");
        break;
      }
      const result = await processFavoriteItem(item);
      completed += result.ok ? 1 : 0;
      newlyFavorited += result.auditedCandidate ? 1 : 0;
      await render();
      if (result.pause) {
        setGlobalStatus("收藏暂停");
        setFavoriteStatus("已暂停");
        logLine(`暂停：#${item.index} ${item.awemeId} ${result.reason}`);
        break;
      }
      await sleep(randomDelay(config));
    }
    logLine(`收藏批次结束：成功推进 ${completed} 条`);
    if (!stopRequested && config.auditRecent > 0 && newlyFavorited > 0) {
      await runAudit(Math.min(config.auditRecent, newlyFavorited), { silentStart: true, config });
    } else if (!stopRequested && config.auditRecent > 0) {
      logLine("本轮没有新的收藏成功，跳过自动审计");
    }
  } catch (error) {
    setGlobalStatus("收藏异常");
    setFavoriteStatus("异常");
    logLine(`收藏流程异常：${error.message}`);
  } finally {
    if (!stopRequested) {
      setFavoriteStatus("空闲");
      setGlobalStatus("空闲");
    }
    running = false;
    stopRequested = false;
    updateButtons();
    await render();
  }
}

async function auditOne(item) {
  const detail = await sendPageRequest("FETCH_AWEME_DETAIL", { awemeId: item.awemeId }, 30000);
  if (detail.ok && detail.collectStat === 1) {
    await saveItem(patchItem(item, {
      collectStat: 1,
      desc: detail.desc || item.desc,
      authorName: detail.authorName || item.authorName,
      authorUid: detail.authorUid || item.authorUid,
      coverUrl: detail.coverUrl || item.coverUrl,
      lastError: "",
    }));
    return { ok: true };
  }
  if (!detail.ok && Number(detail.statusCode) === 2053) {
    await saveItem(patchItem(item, { status: "skipped_inaccessible", lastError: "审计时作品不可访问，按规则跳过" }));
    return { ok: true };
  }
  if (isRateLimited(detail)) {
    await saveItem(patchItem(item, { status: "paused_rate_limited", lastError: resultError(detail) }));
    return { ok: false, pause: true, reason: resultError(detail) };
  }
  await saveItem(patchItem(item, {
    status: "pending",
    collectStat: detail.collectStat ?? item.collectStat ?? null,
    lastError: `审计发现未真正收藏：${resultError(detail)}`,
  }));
  return { ok: false };
}

async function runAudit(limit, { silentStart = false, config = DEFAULT_CONFIG } = {}) {
  setGlobalStatus("审计中");
  setFavoriteStatus("审计中");
  const items = (await getAll("items"))
    .filter((item) => item.status === "favorited" || item.status === "already_favorited")
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, Number(limit || DEFAULT_CONFIG.auditRecent));
  if (!silentStart) logLine(`开始审计最近 ${items.length} 条`);
  let repaired = 0;
  for (const item of items) {
    if (stopRequested) break;
    const result = await auditOne(item);
    if (!result.ok) repaired += 1;
    if (result.pause) {
      setGlobalStatus("审计暂停");
      setFavoriteStatus("已暂停");
      logLine(`审计暂停：#${item.index} ${item.awemeId} ${result.reason}`);
      break;
    }
    await sleep(randomDelay(config));
  }
  logLine(`审计结束：返工 ${repaired} 条`);
  setFavoriteStatus("空闲");
  setGlobalStatus("空闲");
  await render();
}

async function runAuditFromButton() {
  if (running) return;
  running = true;
  stopRequested = false;
  updateButtons();
  try {
    await saveCurrentConfig();
    const config = await loadConfig();
    await runAudit(config.auditRecent, { config });
  } catch (error) {
    setGlobalStatus("审计异常");
    setFavoriteStatus("异常");
    logLine(`审计流程异常：${error.message}`);
  } finally {
    running = false;
    stopRequested = false;
    updateButtons();
    await render();
  }
}

function paddedIndex(item) {
  return String(Number(item.index ?? 0) + 1).padStart(6, "0");
}

async function chooseDownloadCandidate(item, candidates, { allowFallback = true } = {}) {
  if (!candidates.length) {
    throw new Error("未找到可下载视频地址");
  }
  const errors = [];
  const limit = allowFallback ? Math.min(candidates.length, 3) : 1;
  for (let i = 0; i < limit; i += 1) {
    const candidate = candidates[i];
    downloadBatchState.currentResolution = describeVideoCandidate(candidate);
    updateDownloadBatchProgress();
    try {
      const precheck = await sendPageRequest("PRECHECK_URL", {
        url: candidate.url,
        options: { expected: "video" },
      }, 30000);
      logLine(`视频预检通过：#${item.index} ${item.awemeId} ${precheck.sizeLabel || ""} ${precheck.contentType || ""} ${describeVideoCandidate(candidate)}`, {
        type: i === 0 ? "download_precheck_success" : "download_precheck_candidate_success",
        awemeId: item.awemeId,
        index: item.index,
        candidateRank: i + 1,
        contentType: precheck.contentType || "",
        contentLength: precheck.contentLength || 0,
        url: candidate.url,
        quality: candidate,
      });
      return { candidate, precheck, rank: i + 1 };
    } catch (error) {
      errors.push(`#${i + 1} ${describeVideoCandidate(candidate)} ${error.message}`);
      logLine(`视频预检失败：#${item.index} ${item.awemeId} 候选${i + 1} ${describeVideoCandidate(candidate)} ${error.message}`, {
        type: "download_precheck_candidate_failed",
        awemeId: item.awemeId,
        index: item.index,
        candidateRank: i + 1,
        url: candidate.url,
        error: error.message,
        quality: candidate,
      });
    }
  }
  throw new Error(`没有可用的视频候选：${errors.join(" | ")}`);
}

async function downloadOne(item, rootHandle, config) {
  downloadBatchState.currentIndex = item.index;
  downloadBatchState.currentAwemeId = item.awemeId;
  downloadBatchState.phase = "下载中";
  await saveItem(patchItem(item, { downloadStatus: "downloading", lastError: "" }));
  let videoUrl = item.videoUrl || "";
  let coverUrl = item.coverUrl || "";
  let detail = null;
  let candidate = null;
  let fallbackCandidate = null;
  let rankedCandidates = [];
  if (config.downloadPreferBestQuality || !videoUrl || (config.downloadCovers && !coverUrl)) {
    detail = await sendPageRequest("FETCH_AWEME_DETAIL", { awemeId: item.awemeId }, 30000);
    if (!detail.ok) throw new Error(`详情获取失败：${resultError(detail)}`);
    rankedCandidates = pickVideoCandidates(detail.aweme, { preferBestQuality: config.downloadPreferBestQuality });
    candidate = rankedCandidates[0] || null;
    fallbackCandidate = pickVideoUrl(detail.aweme, { preferBestQuality: false });
    videoUrl = candidate?.url || videoUrl;
    coverUrl = detail.coverUrl || coverUrl;
  }
  if (!videoUrl) throw new Error("未找到可下载视频地址");
  if (!candidate && detail?.aweme) {
    rankedCandidates = pickVideoCandidates(detail.aweme, { preferBestQuality: config.downloadPreferBestQuality });
    candidate = rankedCandidates[0] || null;
  }
  if (!rankedCandidates.length && candidate?.url) rankedCandidates = [candidate];
  downloadBatchState.currentResolution = describeVideoCandidate(candidate);
  updateDownloadBatchProgress();

  const sourceFolder = getSourceFolder(item.source);
  const base = buildMediaBase(item);
  const videoPath = `${sourceFolder}/视频/${base}.mp4`;
  const coverPath = `${sourceFolder}/封面/${base}.jpg`;
  const manifestPath = `data/.appdata/manifests/${base}.json`;
  let videoPrecheck = null;
  let selectedCandidateRank = 1;
  try {
    const selected = await chooseDownloadCandidate(item, rankedCandidates.length ? rankedCandidates : [{ ...candidate, url: videoUrl }], {
      allowFallback: Boolean(config.downloadPreferBestQuality),
    });
    candidate = selected.candidate;
    videoUrl = candidate.url;
    videoPrecheck = selected.precheck;
    selectedCandidateRank = selected.rank;
    if (rootHandle.kind === "filesystem") {
      await sendPageRequest("DOWNLOAD_TO_FOLDER", {
        rootHandle: rootHandle.handle,
        relativePath: videoPath,
        url: videoUrl,
        options: { expected: "video" },
      }, 120000);
    } else {
      await downloadUrl(rootHandle, videoPath, videoUrl);
    }
  } catch (error) {
    const canFallback = config.downloadPreferBestQuality
      && fallbackCandidate?.url
      && fallbackCandidate.url !== videoUrl;
    if (!canFallback) throw error;
    logLine(`顶配候选不可用，回退普通画质重试：#${item.index} ${item.awemeId} ${error.message}`, {
      type: "download_retry_fallback",
      awemeId: item.awemeId,
      index: item.index,
      failedUrl: videoUrl,
      fallbackUrl: fallbackCandidate.url,
    });
    candidate = fallbackCandidate;
    videoUrl = fallbackCandidate.url;
    downloadBatchState.currentResolution = describeVideoCandidate(candidate);
    updateDownloadBatchProgress();
    const fallbackPrecheck = await sendPageRequest("PRECHECK_URL", {
      url: videoUrl,
      options: { expected: "video" },
    }, 30000);
    videoPrecheck = fallbackPrecheck;
    selectedCandidateRank = 99;
    logLine(`回退视频预检通过：#${item.index} ${item.awemeId} ${fallbackPrecheck.sizeLabel || ""}`, {
      type: "download_precheck_fallback_success",
      awemeId: item.awemeId,
      index: item.index,
      contentType: fallbackPrecheck.contentType || "",
      contentLength: fallbackPrecheck.contentLength || 0,
      url: videoUrl,
    });
    if (rootHandle.kind === "filesystem") {
      await sendPageRequest("DOWNLOAD_TO_FOLDER", {
        rootHandle: rootHandle.handle,
        relativePath: videoPath,
        url: videoUrl,
        options: { expected: "video" },
      }, 120000);
    } else {
      await downloadUrl(rootHandle, videoPath, videoUrl);
    }
  }

  if (config.downloadCovers && coverUrl) {
    await sendPageRequest("PRECHECK_URL", {
      url: coverUrl,
      options: { expected: "image" },
    }, 30000);
    if (rootHandle.kind === "filesystem") {
      await sendPageRequest("DOWNLOAD_TO_FOLDER", {
        rootHandle: rootHandle.handle,
        relativePath: coverPath,
        url: coverUrl,
        options: { expected: "image" },
      }, 120000);
    } else {
      await downloadUrl(rootHandle, coverPath, coverUrl);
    }
  }

  const manifest = {
    awemeId: item.awemeId,
    index: item.index,
    source: item.source,
    status: item.status,
    desc: detail?.desc || item.desc || "",
    authorName: detail?.authorName || item.authorName || "",
    authorUid: detail?.authorUid || item.authorUid || "",
    createTime: detail?.createTime || item.createTime || 0,
    url: item.url,
    downloadedAt: new Date().toISOString(),
    selectedCandidateRank,
    selectedQuality: candidate,
    candidates: rankedCandidates.slice(0, 5),
    precheck: videoPrecheck,
    files: {
      video: videoPath,
      cover: config.downloadCovers && coverUrl ? coverPath : null,
    },
  };
  await writeFile(rootHandle, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await saveItem(patchItem(item, {
    videoUrl,
    coverUrl,
    downloadStatus: "downloaded",
    downloadQualityLabel: describeVideoCandidate(candidate),
    downloadWidth: candidate?.width || 0,
    downloadHeight: candidate?.height || 0,
    downloadBitrate: candidate?.bitrate || 0,
    downloadCodec: candidate?.codec || "",
    downloadFps: candidate?.fps || 0,
    downloadCandidateRank: selectedCandidateRank,
    downloadSize: videoPrecheck.contentLength || candidate?.size || 0,
    downloadVideoPath: videoPath,
    downloadCoverPath: config.downloadCovers && coverUrl ? coverPath : "",
    authorUid: detail?.authorUid || item.authorUid || "",
    authorName: detail?.authorName || item.authorName || "",
    createTime: detail?.createTime || item.createTime || 0,
    lastError: "",
  }));
  logLine(`下载成功：#${item.index} ${item.awemeId} ${describeVideoCandidate(candidate)}`, {
    type: "download_success",
    awemeId: item.awemeId,
    index: item.index,
    videoUrl,
    quality: candidate ? {
      codec: candidate.codec,
      width: candidate.width,
      height: candidate.height,
      fps: candidate.fps,
      bitrate: candidate.bitrate,
      size: candidate.size,
      source: candidate.source,
    } : null,
    candidateRank: selectedCandidateRank,
    targetKind: rootHandle.kind,
    folderName: rootHandle.label || "",
  });
}

async function runDownloadBatch(scope = "liked") {
  if (downloadRunning) return;
  downloadRunning = true;
  downloadPauseRequested = false;
  currentDownloadScope = scope;
  setView("download-task");
  const scopeDef = getDownloadScopeDefinition(scope);
  downloadBatchState = {
    total: 0,
    completed: 0,
    currentIndex: null,
    currentAwemeId: "",
    phase: "准备下载",
  };
  updateButtons();
  setGlobalStatus("下载中");
  setDownloadStatus("准备下载");
  updateDownloadBatchProgress();
  logLine(scopeDef.startText, { type: "download_scope_start", scope: scopeDef.key });
  try {
    await saveCurrentConfig();
    const config = await loadConfig();
    const rootHandle = await chooseDownloadTarget({
      preferBrowserDownloads: !config.downloadUseSavedFolder,
      preferSavedFolder: config.downloadUseSavedFolder,
    });
    if (config.downloadUseSavedFolder && rootHandle.kind !== "filesystem") {
      throw new Error("未找到可用的已授权文件夹。请先点击“选择文件夹”，后续下载才不会出现在浏览器下载记录里。");
    }
    const folderRecord = rootHandle.kind === "filesystem"
      ? await getCachedDownloadRecord(rootHandle, { force: true })
      : null;
    if (rootHandle.kind === "filesystem") {
      if (folderRecord) {
        const recoveredFromFolder = await recoverDownloadedItemsFromFolderRecord(rootHandle);
        if (recoveredFromFolder) logLine(`已从文件夹记录恢复 ${recoveredFromFolder} 条下载完成记录`, { type: "download_recovered_from_folder", count: recoveredFromFolder });
      } else {
        const resetCount = await resetDownloadStateForFreshFolder();
        logLine(`该文件夹没有下载记录文件，本次按新任务从 0 开始${resetCount ? `，已重置本地 ${resetCount} 条旧下载标记` : ""}`, {
          type: "download_folder_fresh_start",
          folderName: rootHandle.label || "",
          resetCount,
        });
      }
    } else {
      const recovered = await recoverDownloadedItemsFromLogs();
      if (recovered) logLine(`已从日志恢复 ${recovered} 条下载完成记录`, { type: "download_recovered", count: recovered });
    }
    const selectedFollowingAuthors = scope === "following" ? await getSelectedFollowingAuthors() : [];
    const items = (await getAll("items"))
      .filter((item) => scopeDef.isEligible(item, { selectedFollowingAuthors }))
      .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
      .slice(0, Number(config.batchSize || DEFAULT_CONFIG.batchSize));
    if (!items.length) {
      downloadBatchState.phase = "空闲";
      setGlobalStatus("空闲");
      setDownloadStatus("空闲");
      updateDownloadBatchProgress();
      logLine(scopeDef.emptyText, { type: "download_scope_empty", scope: scopeDef.key });
      return;
    }
    downloadBatchState.total = items.length;
    downloadBatchState.completed = 0;
    if (rootHandle.kind === "downloads") {
      const uiResult = await sendRuntimeMessage({ type: "SET_DOWNLOAD_UI", enabled: false });
      if (!uiResult?.ok) {
        logLine(`隐藏浏览器下载提示失败：${uiResult?.error || "unknown"}`);
      }
    }
    setDownloadStatus("下载中");
    downloadBatchState.phase = rootHandle.kind === "downloads" ? "下载到浏览器目录" : "下载到已选文件夹";
    updateDownloadBatchProgress();
    await persistDownloadArtifacts(rootHandle, downloadBatchState);
    logLine(rootHandle.kind === "downloads"
      ? `开始下载${scopeDef.label}批次：${items.length} 条，保存到浏览器下载目录`
      : `开始下载${scopeDef.label}批次：${items.length} 条，保存到文件夹 ${rootHandle.label || "已授权目录"}`, {
        type: "download_batch_started",
        count: items.length,
        scope: scopeDef.key,
        targetKind: rootHandle.kind,
        folderName: rootHandle.label || "",
        preferBestQuality: Boolean(config.downloadPreferBestQuality),
    });
    let downloaded = 0;
    for (const item of items) {
      if (downloadPauseRequested) {
        downloadBatchState.phase = "已暂停";
        logLine(`${scopeDef.label}下载已暂停：完成 ${downloaded}/${items.length} 条`, {
          type: "download_paused",
          completed: downloaded,
          total: items.length,
          scope: scopeDef.key,
        });
        break;
      }
      try {
        await downloadOne(item, rootHandle, config);
        downloaded += 1;
        downloadBatchState.completed = downloaded;
        await persistDownloadArtifacts(rootHandle, downloadBatchState);
      } catch (error) {
        await saveItem(patchItem(item, { downloadStatus: "failed", lastError: `下载失败：${error.message}` }));
        logLine(`${scopeDef.label}下载失败：#${item.index} ${item.awemeId} ${error.message}`, {
          type: "download_failed",
          awemeId: item.awemeId,
          index: item.index,
          error: error.message,
          scope: scopeDef.key,
        });
        await persistDownloadArtifacts(rootHandle, downloadBatchState);
      }
      updateDownloadBatchProgress();
      await render();
      await sleep(randomDelay(config));
    }
    if (!downloadPauseRequested) {
      downloadBatchState.phase = "已完成";
      await persistDownloadArtifacts(rootHandle, downloadBatchState);
      logLine(`${scopeDef.label}下载批次结束：完成 ${downloaded} 条`, {
        type: "download_batch_finished",
        completed: downloaded,
        scope: scopeDef.key,
      });
    }
  } catch (error) {
    downloadBatchState.phase = "异常";
    setGlobalStatus("下载异常");
    setDownloadStatus("异常");
    updateDownloadBatchProgress();
    logLine(`下载流程异常：${error.message}`);
  } finally {
    await sendRuntimeMessage({ type: "SET_DOWNLOAD_UI", enabled: true });
    if (!downloadPauseRequested && downloadBatchState.phase !== "异常") {
      setDownloadStatus("空闲");
      setGlobalStatus("空闲");
    } else if (downloadPauseRequested) {
      setDownloadStatus("已暂停");
      setGlobalStatus("下载暂停");
    }
    downloadRunning = false;
    downloadPauseRequested = false;
    downloadBatchState.currentIndex = null;
    downloadBatchState.currentAwemeId = "";
    downloadBatchState.currentResolution = "";
    updateButtons();
    await render();
  }
}

$("profileBtn").addEventListener("click", async () => {
  try {
    setGlobalStatus("检测中");
    const result = await sendPageRequest("GET_SELF_PROFILE", {}, 30000);
    const user = result?.json?.user || result?.json?.user_info || result?.json;
    setGlobalStatus(result.ok ? "已连接" : "异常");
    $("pageMeta").textContent = result.ok
      ? `抖音页面已连接：${user?.nickname || user?.uid || "已登录"}`
      : `检测失败：${result.statusMsg || result.text || result.httpStatus}`;
    logLine(result.ok ? "登录检测成功" : "登录检测失败");
  } catch (error) {
    setGlobalStatus("异常");
    $("pageMeta").textContent = error.message;
    logLine(`登录检测异常：${error.message}`);
  }
});

$("importBtn").addEventListener("click", () => $("importFile").click());

$("importFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const progress = JSON.parse(await file.text());
    const count = await importProgress(progress);
    setGlobalStatus("已导入");
    logLine(`导入完成：${count} 条`);
    await render();
  } catch (error) {
    setGlobalStatus("导入失败");
    logLine(`导入失败：${error.message}`);
  } finally {
    event.target.value = "";
  }
});

$("favoriteBtn").addEventListener("click", async () => {
  await runFavoriteBatch();
});

$("stopBtn").addEventListener("click", () => {
  stopRequested = true;
  setGlobalStatus("停止中");
  setFavoriteStatus("停止中");
  setDownloadStatus("停止中");
});

$("auditBtn").addEventListener("click", async () => {
  await runAuditFromButton();
});

$("downloadBtn").addEventListener("click", async () => {
  await runDownloadBatch("liked");
});

$("downloadBookmarkedBtn").addEventListener("click", async () => {
  await runDownloadBatch("bookmarked");
});

$("downloadFollowingBtn").addEventListener("click", async () => {
  await runDownloadBatch("following");
});

$("selectAllFollowingBtn").addEventListener("click", async () => {
  const authors = buildFollowingAuthors(await getAll("items"));
  const values = authors.map((author) => author.authorUid);
  await setSelectedFollowingAuthors(values);
  renderFollowingAuthors(authors, values);
});

$("clearFollowingSelectionBtn").addEventListener("click", async () => {
  const authors = buildFollowingAuthors(await getAll("items"));
  await setSelectedFollowingAuthors([]);
  renderFollowingAuthors(authors, []);
});

$("pauseDownloadBtn").addEventListener("click", () => {
  if (!downloadRunning) return;
  downloadPauseRequested = true;
  downloadBatchState.phase = "暂停中";
  setDownloadStatus("暂停中");
  setGlobalStatus("下载暂停中");
  updateDownloadBatchProgress();
});

$("pauseDownloadTaskBtn").addEventListener("click", () => {
  if (!downloadRunning) return;
  downloadPauseRequested = true;
  downloadBatchState.phase = "暂停中";
  setDownloadStatus("暂停中");
  setGlobalStatus("下载暂停中");
  updateDownloadBatchProgress();
});

$("backToHomeBtn").addEventListener("click", () => {
  setView("home");
});

$("restartCurrentDownloadBtn").addEventListener("click", async () => {
  await runDownloadBatch(currentDownloadScope);
});

$("closeBtn").addEventListener("click", () => {
  parent.postMessage({ source: "douyin-toolkit-sidebar", type: "CLOSE_SIDEBAR" }, "*");
});

$("pickFolderBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "OPEN_FOLDER_PICKER_TAB" }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      logLine(`打开文件夹选择页失败：${chrome.runtime.lastError?.message || response?.error || "unknown"}`);
      return;
    }
    logLine("已打开文件夹选择页，选择后会记住并复用该目录", {
      type: "download_target_picker_opened",
      tabId: response.tabId || null,
    });
  });
});

for (const id of ["batchSize", "auditRecent", "minDelayMs", "maxDelayMs", "syncLikedBeforeRun", "downloadCovers", "downloadPreferBestQuality", "downloadUseSavedFolder"]) {
  $(id).addEventListener("change", saveCurrentConfig);
}

window.addEventListener("douyin-toolkit-boot", (event) => {
  setGlobalStatus("已注入");
  $("pageMeta").textContent = event.detail?.href || "抖音页面已连接";
});

await render();
setInterval(render, 2500);
