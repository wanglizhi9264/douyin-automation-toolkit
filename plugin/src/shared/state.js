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

export async function summarize() {
  const [items, config, logs, lastImport] = await Promise.all([
    getAll("items"),
    loadConfig(),
    recentLogs(),
    getConfig("lastImport", null),
  ]);
  const counts = {};
  for (const item of items) counts[item.status || "unknown"] = (counts[item.status || "unknown"] || 0) + 1;
  const favoriteApiItems = items.filter((item) => item.source === "liked" || item.source === "favorite_api");
  const success = items.filter((item) => SUCCESS_STATUSES.has(item.status)).length;
  const pending = items.filter((item) => item.status === "pending").length;
  const paused = items.filter((item) => String(item.status || "").startsWith("paused") || item.status === "blocked");
  const auditPending = items.filter((item) => item.status === "pending" && String(item.lastError || "").includes("审计发现未真正收藏"));
  const sortedByUpdate = [...items].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const cursor = sortedByUpdate[0] || null;
  const favorite = {
    total: favoriteApiItems.length,
    completed: items.filter((item) => SUCCESS_STATUSES.has(item.status)).length,
    pending: items.filter((item) => !SUCCESS_STATUSES.has(item.status) && item.status !== "blocked" && !String(item.status || "").startsWith("paused")).length,
    paused: paused.length,
    auditPending: auditPending.length,
    cursor: cursor,
  };
  const download = {
    eligible: items.filter((item) => ["favorited", "already_favorited"].includes(item.status)).length,
    downloaded: items.filter((item) => item.downloadStatus === "downloaded").length,
    pending: items.filter((item) => ["favorited", "already_favorited"].includes(item.status) && item.downloadStatus !== "downloaded").length,
    failed: items.filter((item) => item.downloadStatus === "failed").length,
    cursor: sortedByUpdate.find((item) => item.downloadStatus && item.downloadStatus !== "not_started") || null,
  };
  return {
    config,
    counts,
    total: items.length,
    likedTotal: favoriteApiItems.length,
    likedSyncedTo: favoriteApiItems.length ? Math.max(...favoriteApiItems.map((item) => Number(item.index ?? -1))) : -1,
    success,
    pending,
    paused: paused.length,
    auditPending: auditPending.length,
    cursor,
    favorite,
    download,
    lastImport,
    logs,
  };
}
