import { addLog, clearItems, getAll, getConfig, putItems, recentLogs, setConfig } from "./db.js";

export const DEFAULT_CONFIG = {
  batchSize: 100,
  auditRecent: 120,
  minDelayMs: 300,
  maxDelayMs: 900,
  syncLikedBeforeRun: false,
  continueOnAuditFailure: true,
  maxConsecutiveAuditFailures: 6,
  downloadCovers: true,
  skipExistingDownloads: true,
  downloadPreferBestQuality: true,
  downloadUseSavedFolder: true,
};

const SUCCESS_STATUSES = new Set(["favorited", "already_favorited", "skipped_inaccessible"]);

export async function loadConfig() {
  return await getConfig("main", DEFAULT_CONFIG);
}

export async function saveConfig(config) {
  await setConfig("main", { ...DEFAULT_CONFIG, ...config });
}

export async function importProgress(progress) {
  const rawItems = Array.isArray(progress.items) ? progress.items : [];
  const now = new Date().toISOString();
  const items = rawItems
    .filter((item) => item.source === "favorite_api" && item.videoId)
    .map((item) => ({
      awemeId: String(item.videoId),
      index: Number(item.index ?? 0),
      source: "liked",
      status: item.status || "pending",
      collectStat: item.collectStat ?? null,
      desc: item.desc || "",
      authorUid: item.authorUid || "",
      authorName: item.author || item.authorName || "",
      url: item.url || `https://www.douyin.com/video/${item.videoId}`,
      coverUrl: item.coverUrl || "",
      videoUrl: item.videoUrl || "",
      downloadStatus: item.downloadStatus || "not_started",
      lastError: item.lastError || "",
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now,
    }));
  await clearItems();
  await putItems(items);
  await addLog(`已导入 ${items.length} 条现有进度`);
  await setConfig("lastImport", {
    importedAt: now,
    sourceUpdatedAt: progress.updatedAt || null,
    cursor: progress.cursor || null,
  });
  return items.length;
}

export async function summarize({ items: suppliedItems = null } = {}) {
  const [items, config, logs, lastImport] = await Promise.all([
    suppliedItems ? Promise.resolve(suppliedItems) : getAll("items"),
    loadConfig(),
    recentLogs(),
    getConfig("lastImport", null),
  ]);
  const counts = {};
  let likedTotal = 0;
  let likedSyncedTo = -1;
  let success = 0;
  let pending = 0;
  let runnableFavorite = 0;
  let paused = 0;
  let auditPending = 0;
  let eligible = 0;
  let downloaded = 0;
  let downloadPending = 0;
  let failed = 0;
  let cursor = null;
  let downloadCursor = null;
  for (const item of items) {
    const status = item.status || "unknown";
    counts[status] = (counts[status] || 0) + 1;
    const updatedAt = String(item.updatedAt || "");
    if (!cursor || updatedAt > String(cursor.updatedAt || "")) cursor = item;
    if (item.source === "liked" || item.source === "favorite_api") {
      likedTotal += 1;
      likedSyncedTo = Math.max(likedSyncedTo, Number(item.index ?? -1));
    }
    if (SUCCESS_STATUSES.has(item.status)) success += 1;
    if (item.status === "pending") pending += 1;
    const isPaused = String(item.status || "").startsWith("paused") || item.status === "blocked";
    if (isPaused) paused += 1;
    if (!SUCCESS_STATUSES.has(item.status) && !isPaused) runnableFavorite += 1;
    if (item.status === "pending" && String(item.lastError || "").includes("审计发现未真正收藏")) auditPending += 1;
    const isEligible = ["favorited", "already_favorited"].includes(item.status);
    if (isEligible) eligible += 1;
    if (item.downloadStatus === "downloaded") downloaded += 1;
    if (isEligible && item.downloadStatus !== "downloaded") downloadPending += 1;
    if (item.downloadStatus === "failed") failed += 1;
    if (
      item.downloadStatus && item.downloadStatus !== "not_started"
      && (!downloadCursor || updatedAt > String(downloadCursor.updatedAt || ""))
    ) downloadCursor = item;
  }
  const favorite = {
    total: likedTotal,
    completed: success,
    pending: runnableFavorite,
    paused,
    auditPending,
    cursor: cursor,
  };
  const download = {
    eligible,
    downloaded,
    pending: downloadPending,
    failed,
    cursor: downloadCursor,
  };
  return {
    config,
    counts,
    total: items.length,
    likedTotal,
    likedSyncedTo,
    success,
    pending,
    paused,
    auditPending,
    cursor,
    favorite,
    download,
    lastImport,
    logs,
  };
}
