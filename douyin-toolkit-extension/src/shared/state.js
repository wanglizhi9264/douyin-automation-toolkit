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
  const success = items.filter((item) => SUCCESS_STATUSES.has(item.status)).length;
  const pending = items.filter((item) => item.status === "pending").length;
  const paused = items.filter((item) => String(item.status || "").startsWith("paused") || item.status === "blocked");
  const auditPending = items.filter((item) => item.status === "pending" && String(item.lastError || "").includes("审计发现未真正收藏"));
  const cursor = [...items].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
  return {
    config,
    counts,
    total: items.length,
    success,
    pending,
    paused: paused.length,
    auditPending: auditPending.length,
    cursor,
    lastImport,
    logs,
  };
}
