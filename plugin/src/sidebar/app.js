import { sendPageRequest } from "../shared/events.js";
import { addLog, getAll, getConfig, putItems, setConfig } from "../shared/db.js";
import { DEFAULT_CONFIG, importProgress, loadConfig, saveConfig, summarize } from "../shared/state.js";
import {
  describeVideoCandidate,
  extractMediaParts,
  mediaTypeForParts,
  normalizeAweme,
  pickVideoCandidates,
  pickVideoUrl,
} from "../shared/api.js";
import { chooseDownloadTarget, downloadUrl, downloadVerifiedMedia, getStoredDownloadTarget, readTextFile, writeFile } from "../shared/download.js";
import { recoverDownloadedRecords } from "../shared/download-record.js";
import { createDownloadIndex, markIndexCompleted, serializeDownloadIndex } from "../shared/download-index.js";
import { buildLocalLibraryHtml } from "../shared/report.js";
import {
  advanceLikedScanState,
  createLikedScanState,
  LIKED_PAGE_MAX_RETRIES,
  LIKED_PAGE_MIN_INTERVAL_MS,
  LIKED_PAGE_SIZE,
  likedRetryDelayMs,
  normalizeLikedPageItems,
  parseLikedProfile,
  reconcileLikedLocalIds,
} from "../shared/liked-sync.js";
import {
  advanceBookmarkedScanState,
  BOOKMARKED_PAGE_MAX_RETRIES,
  BOOKMARKED_PAGE_MIN_INTERVAL_MS,
  BOOKMARKED_PAGE_SIZE,
  bookmarkedRetryDelayMs,
  createBookmarkedScanState,
  normalizeBookmarkedPageItems,
  parseBookmarkedProfile,
} from "../shared/bookmarked-sync.js";
import {
  createPerformanceTracker,
  formatPerformanceSummary,
  recordPerformanceSample,
  summarizePerformance,
} from "../shared/performance.js";

const $ = (id) => document.getElementById(id);
let configHydrated = false;
let stopRequested = false;
let running = false;
let downloadRunning = false;
let oneClickRunning = false;
const SHARED_CONVERSATION_NAME = "王立志";
let downloadPauseRequested = false;
let downloadBatchState = {
  scope: "liked",
  total: 0,
  completed: 0,
  sessionCompleted: 0,
  inspected: 0,
  currentOrder: 0,
  currentIndex: null,
  currentAwemeId: "",
  currentResolution: "",
  phase: "idle",
};
let downloadRecordCache = {
  targetKey: "",
  record: null,
  loadingPromise: null,
};
let localFolderCountCache = { targetKey: "", loadedAt: 0, counts: null, loadingPromise: null };
let downloadIndexCache = { targetKey: "", index: null, loadingPromise: null };
let compactWriteQueue = {
  targetKey: "",
  target: null,
  entries: new Map(),
  timer: null,
  flushing: null,
};
let currentView = "download";
let currentDownloadScope = "liked";

let activePerformanceTracker = null;
let lastPerformanceSummary = null;
let activeDownloadTarget = null;
const CANDIDATE_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
let artifactCheckpoint = {
  targetKey: "",
  itemsSinceFull: 0,
  lastFullAt: 0,
};
let scheduledRenderTimer = null;
let remoteProfileCache = { result: null, loadedAt: 0 };
let remoteProfileRequestInFlight = null;
let bookmarkedOverviewCache = { page: null, loadedAt: 0 };
let bookmarkedOverviewInFlight = null;
const BOOKMARKED_OVERVIEW_MAX_AGE_MS = 60 * 1000;
let remoteProfileSummary = {
  status: "idle",
  likedTotal: null,
  bookmarkedTotal: null,
  nickname: "",
  durationMs: 0,
  loadedAt: "",
  error: "",
};

function timingNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function recordStage(stage, durationMs, meta = {}) {
  return recordPerformanceSample(activePerformanceTracker, stage, durationMs, meta);
}

async function timedStage(stage, task, meta = {}) {
  const startedAt = timingNow();
  try {
    const result = await task();
    recordStage(stage, timingNow() - startedAt, { ...meta, ok: true });
    return result;
  } catch (error) {
    recordStage(stage, timingNow() - startedAt, {
      ...meta,
      ok: false,
      error: error?.message || String(error),
    });
    throw error;
  }
}

async function waitTracked(stage, delayMs, meta = {}) {
  const delay = Math.max(0, Number(delayMs || 0));
  if (!delay) return;
  await timedStage(stage, () => sleep(delay), { ...meta, scheduledMs: delay });
}

function currentPerformanceSummary() {
  return activePerformanceTracker
    ? summarizePerformance(activePerformanceTracker)
    : lastPerformanceSummary;
}
function recordMediaTimings(result, {
  kind = "video",
  awemeId = "",
  candidateRank = 0,
} = {}) {
  const timings = result?.timings;
  if (!timings) return;
  const meta = {
    kind,
    awemeId,
    candidateRank,
    bytes: Number(result?.size || 0),
  };
  recordStage(`${kind}_request`, timings.requestMs, { ...meta, bytes: 0, ok: true });
  recordStage(`${kind}_transfer`, timings.transferMs, { ...meta, ok: true });
  recordStage(`${kind}_write`, timings.writeMs, { ...meta, bytes: 0, ok: true });
}

async function finalizeDownloadPerformance() {
  const tracker = activePerformanceTracker;
  const target = activeDownloadTarget;
  if (!tracker) return;
  try {
    lastPerformanceSummary = summarizePerformance(tracker);
    if (target?.kind === "filesystem") {
      await writeFile(
        target,
        "data/.appdata/performance-summary.json",
        JSON.stringify(lastPerformanceSummary, null, 2) + "\n",
      );
    }
    logLine("\u4e0b\u8f7d\u6027\u80fd\u7edf\u8ba1\uff1a" + formatPerformanceSummary(lastPerformanceSummary), {
      type: "download_performance_summary",
      summary: lastPerformanceSummary,
    });
  } catch (error) {
    lastPerformanceSummary = summarizePerformance(tracker);
    logLine("\u6027\u80fd\u7edf\u8ba1\u5199\u5165\u5931\u8d25\uff1a" + (error?.message || String(error)), {
      type: "download_performance_summary_failed",
      error: error?.message || String(error),
    });
  } finally {
    activePerformanceTracker = null;
    activeDownloadTarget = null;
  }
}
function scheduleRender(delayMs = 120) {
  // Download progress is updated directly. Rebuilding the entire sidebar here
  // would recreate the author checkboxes for every page/log entry and flicker.
  if (downloadRunning) return;
  if (scheduledRenderTimer != null) return;
  scheduledRenderTimer = setTimeout(() => {
    scheduledRenderTimer = null;
    render().catch(console.error);
  }, delayMs);
}

function profileUser(result) {
  return result?.json?.user || result?.json?.user_info || result?.json || null;
}

function optionalUserCount(user, keys) {
  for (const key of keys) {
    if (user?.[key] == null || user[key] === "") continue;
    const value = Number(user[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

async function requestSelfProfile({ maxAgeMs = 0, reason = "summary" } = {}) {
  const age = Date.now() - Number(remoteProfileCache.loadedAt || 0);
  if (remoteProfileCache.result?.ok && maxAgeMs > 0 && age >= 0 && age <= maxAgeMs) {
    recordStage("profile_cache", 0, { reason, ok: true });
    return remoteProfileCache.result;
  }
  if (remoteProfileRequestInFlight) {
    recordStage("profile_request_join", 0, { reason, ok: true });
    return await remoteProfileRequestInFlight;
  }
  remoteProfileSummary = { ...remoteProfileSummary, status: "loading", error: "" };
  scheduleRender();
  const startedAt = timingNow();
  remoteProfileRequestInFlight = sendPageRequest("GET_SELF_PROFILE", {}, 30000);
  let result;
  try {
    result = await remoteProfileRequestInFlight;
  } finally {
    remoteProfileRequestInFlight = null;
  }
  const durationMs = timingNow() - startedAt;
  recordStage("profile_api", durationMs, { reason, ok: Boolean(result?.ok) });
  remoteProfileCache = { result, loadedAt: Date.now() };
  const user = profileUser(result);
  if (result?.ok && user) {
    remoteProfileSummary = {
      status: "loaded",
      likedTotal: optionalUserCount(user, ["favoriting_count", "favoritingCount"]) ?? 0,
      bookmarkedTotal: optionalUserCount(user, [
        "collect_count", "collection_count", "aweme_collect_count", "collectCount",
      ]),
      nickname: String(user.nickname || user.name || ""),
      durationMs,
      loadedAt: new Date().toISOString(),
      error: "",
    };
  } else {
    const profileError = resultError(result);
    remoteProfileSummary = {
      ...remoteProfileSummary,
      status: "failed",
      durationMs,
      loadedAt: new Date().toISOString(),
      error: profileError,
    };
  }
  scheduleRender();
  return result;
}
async function requestBookmarkedOverview({
  maxAgeMs = BOOKMARKED_OVERVIEW_MAX_AGE_MS,
  reason = "summary",
} = {}) {
  const age = Date.now() - Number(bookmarkedOverviewCache.loadedAt || 0);
  if (
    bookmarkedOverviewCache.page?.ok
    && age >= 0
    && age <= maxAgeMs
  ) {
    recordStage("bookmarked_overview_cache", 0, { reason, ok: true });
    return bookmarkedOverviewCache.page;
  }
  if (bookmarkedOverviewInFlight) {
    recordStage("bookmarked_overview_join", 0, { reason, ok: true });
    return bookmarkedOverviewInFlight;
  }
  bookmarkedOverviewInFlight = timedStage(
    "bookmarked_overview_api",
    () => sendPageRequest("FETCH_BOOKMARKED_PAGE", {
      cursor: 0,
      count: BOOKMARKED_PAGE_SIZE,
    }, 60000),
    { reason },
  );
  let page;
  try {
    page = await bookmarkedOverviewInFlight;
  } finally {
    bookmarkedOverviewInFlight = null;
  }
  if (!page?.ok || !Array.isArray(page.awemeList)) {
    throw new Error(resultError(page));
  }
  lastBookmarkedPageRequestAt = Date.now();
  bookmarkedOverviewCache = { page, loadedAt: Date.now() };
  if (page.hasTotal || Number(page.total || 0) > 0) {
    remoteProfileSummary = {
      ...remoteProfileSummary,
      bookmarkedTotal: Number(page.total || 0),
      bookmarkedTotalSource: "listcollection",
    };
    scheduleRender();
  }
  return page;
}

function cachedBookmarkedFirstPage() {
  const age = Date.now() - Number(bookmarkedOverviewCache.loadedAt || 0);
  if (age < 0 || age > BOOKMARKED_OVERVIEW_MAX_AGE_MS) return null;
  return bookmarkedOverviewCache.page?.ok ? bookmarkedOverviewCache.page : null;
}

async function refreshRemoteProfileSummary({ silent = false } = {}) {
  try {
    const result = await requestSelfProfile({ reason: "sidebar_summary" });
    if (!result?.ok) throw new Error(resultError(result));
    if (remoteProfileSummary.bookmarkedTotal == null) {
      await requestBookmarkedOverview({ reason: "sidebar_summary" });
    }
    if (!silent) {
      logLine(
        "Official counts loaded: liked=" + remoteProfileSummary.likedTotal
          + " bookmarked=" + (remoteProfileSummary.bookmarkedTotal ?? "unknown")
          + " in " + Math.round(remoteProfileSummary.durationMs) + "ms",
        {
          type: "remote_profile_summary_loaded",
          likedTotal: remoteProfileSummary.likedTotal,
          bookmarkedTotal: remoteProfileSummary.bookmarkedTotal,
          durationMs: remoteProfileSummary.durationMs,
        },
      );
    }
  } catch (error) {
    if (!silent) {
      logLine("Official counts failed: " + (error?.message || String(error)), {
        type: "remote_profile_summary_failed",
        error: error?.message || String(error),
      });
    }
  }
}

let selectedFollowingAuthorsCache = null;

async function getSelectedFollowingAuthors() {
  if (Array.isArray(selectedFollowingAuthorsCache)) return [...selectedFollowingAuthorsCache];
  const result = await chrome.storage.local.get(["selectedFollowingAuthors"]);
  selectedFollowingAuthorsCache = Array.isArray(result.selectedFollowingAuthors)
    ? [...new Set(result.selectedFollowingAuthors.filter(Boolean).map(String))]
    : [];
  return [...selectedFollowingAuthorsCache];
}

async function setSelectedFollowingAuthors(authorUids) {
  selectedFollowingAuthorsCache = [...new Set((authorUids || []).filter(Boolean).map(String))];
  await chrome.storage.local.set({
    selectedFollowingAuthors: selectedFollowingAuthorsCache,
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
  const normalized = view === "favorite" ? "favorite" : "download";
  currentView = normalized;
  $("downloadView").classList.toggle("hidden", normalized !== "download");
  $("favoriteView").classList.toggle("hidden", normalized !== "favorite");
  $("downloadTabBtn").classList.toggle("active", normalized === "download");
  $("favoriteTabBtn").classList.toggle("active", normalized === "favorite");
}

let followingSyncInFlight = null;

function normalizeFollowingAuthor(user) {
  const uid = String(user?.uid || user?.id || "");
  const secUid = String(user?.sec_uid || user?.secUid || user?.sec_user_id || "");
  if (!uid || !secUid) return null;
  return {
    uid,
    secUid,
    nickname: String(user?.nickname || user?.name || "未命名作者"),
    awemeCount: Math.max(0, Number(user?.aweme_count || user?.awemeCount || 0)),
  };
}

async function getCachedFollowingAuthors() {
  const value = await getConfig("followingAuthors", []);
  return Array.isArray(value) ? value : [];
}

async function syncFollowingAuthors({ force = false } = {}) {
  if (followingSyncInFlight) return await followingSyncInFlight;
  followingSyncInFlight = (async () => {
    const cached = await getCachedFollowingAuthors();
    const updatedAt = Number(await getConfig("followingAuthorsUpdatedAt", 0)) || 0;
    if (!force && cached.length && Date.now() - updatedAt < 10 * 60 * 1000) return cached;
    const profileResult = await requestSelfProfile({ maxAgeMs: 5 * 60 * 1000, reason: "following_list" });
    if (!profileResult?.ok) throw new Error(`读取关注列表前无法确认账号：${resultError(profileResult)}`);
    const profile = profileUser(profileResult) || {};
    const userId = String(profile.uid || profile.id || "");
    const secUid = String(profile.sec_uid || profile.secUid || profile.sec_user_id || "");
    if (!userId || !secUid) throw new Error("当前账号缺少关注列表所需的 user_id 或 sec_uid");
    const authors = [];
    const seen = new Set();
    let offset = 0;
    let maxTime = 0;
    let minTime = 0;
    let pageNumber = 0;
    for (;;) {
      const page = await sendPageRequest("FETCH_FOLLOWING_PAGE", {
        userId,
        secUid,
        offset,
        count: 20,
        maxTime,
        minTime,
      }, 60000);
      if (!page?.ok || !Array.isArray(page.users)) throw new Error(`读取关注列表失败：${resultError(page)}`);
      pageNumber += 1;
      for (const raw of page.users) {
        const author = normalizeFollowingAuthor(raw);
        if (!author || seen.has(author.uid)) continue;
        seen.add(author.uid);
        authors.push(author);
      }
      logLine(`同步关注作者：第 ${pageNumber} 页，累计 ${authors.length} 人`, {
        type: "following_page_checked",
        page: pageNumber,
        count: authors.length,
      });
      if (!page.hasMore || !page.users.length) break;
      const nextOffset = Number(page.offset ?? (offset + page.users.length));
      const nextMaxTime = page.maxTime ?? maxTime;
      const nextMinTime = page.minTime ?? minTime;
      if (nextOffset === offset && String(nextMaxTime) === String(maxTime) && String(nextMinTime) === String(minTime)) {
        throw new Error("关注列表游标没有前进，已停止以避免死循环");
      }
      offset = nextOffset;
      maxTime = nextMaxTime;
      minTime = nextMinTime;
      await waitTracked("following_list_wait", 1200, { page: pageNumber });
    }
    await Promise.all([
      setConfig("followingAuthors", authors),
      setConfig("followingAuthorsUpdatedAt", Date.now()),
    ]);
    return authors;
  })();
  try {
    return await followingSyncInFlight;
  } finally {
    followingSyncInFlight = null;
  }
}

function updateDownloadBatchProgress() {
  const state = downloadBatchState;
  if (!state.total) {
    $("downloadBatchProgress").innerHTML = "尚未开始下载";
    $("downloadTaskProgress").innerHTML = "尚未开始下载";
    $("downloadTaskTotal").textContent = "0";
    $("downloadTaskCompleted").textContent = "0";
    $("downloadTaskCursor").textContent = "-";
    $("downloadTaskChecked").textContent = "-";
    return;
  }
  $("downloadTaskTotal").textContent = String(state.total);
  $("downloadTaskCompleted").textContent = String(state.completed);
  $("downloadTaskCursor").textContent = state.currentOrder ? `${state.currentOrder} / ${state.total}` : "-";
  $("downloadTaskChecked").textContent = state.inspected ? `${state.inspected} / ${state.total}` : "-";
  const currentLine = state.currentIndex == null
    ? ""
    : `当前：第 ${escapeHtml(state.currentOrder || "-")} 个 · #${escapeHtml(state.currentIndex)} ${escapeHtml(state.currentAwemeId || "")}`;
  const resolutionLine = state.currentResolution ? `分辨率：${escapeHtml(state.currentResolution)}` : "";
  const progressHtml = [
    `状态：${escapeHtml(state.phase)}`,
    `总体完成：${escapeHtml(state.completed)} / ${escapeHtml(state.total)}`,
    `本次新增：${escapeHtml(state.sessionCompleted || 0)} · 已检查：${escapeHtml(state.inspected || 0)}`,
    currentLine,
    resolutionLine,
  ].filter(Boolean).join("<br>");
  $("downloadBatchProgress").innerHTML = progressHtml;
  $("downloadTaskProgress").innerHTML = progressHtml;
}

function getDownloadRecordPath() {
  return "data/.appdata/download-state.json";
}

function getDownloadProgressPath() {
  return "data/.appdata/download-progress.json";
}

function getDownloadCountsPath() {
  return "data/.appdata/download-counts.json";
}

function getDownloadIndexPath() {
  return "data/.appdata/download-index.json";
}

function getDownloadReportPath() {
  return "本地库.html";
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resetCompactWriteQueue(target) {
  const targetKey = getTargetCacheKey(target);
  if (compactWriteQueue.targetKey === targetKey) return;
  if (compactWriteQueue.timer) clearTimeout(compactWriteQueue.timer);
  compactWriteQueue = {
    targetKey,
    target,
    entries: new Map(),
    timer: null,
    flushing: null,
  };
}

async function flushCompactWrites(target = compactWriteQueue.target) {
  if (!target || target.kind !== "filesystem") return;
  resetCompactWriteQueue(target);
  if (compactWriteQueue.timer) {
    clearTimeout(compactWriteQueue.timer);
    compactWriteQueue.timer = null;
  }
  if (compactWriteQueue.flushing) await compactWriteQueue.flushing;
  if (!compactWriteQueue.entries.size) return;
  const entries = [...compactWriteQueue.entries.entries()];
  compactWriteQueue.entries.clear();
  compactWriteQueue.flushing = Promise.all(
    entries.map(([path, content]) => writeFile(target, path, content)),
  );
  try {
    await compactWriteQueue.flushing;
  } finally {
    compactWriteQueue.flushing = null;
    if (compactWriteQueue.entries.size && !compactWriteQueue.timer) {
      compactWriteQueue.timer = setTimeout(() => {
        compactWriteQueue.timer = null;
        void flushCompactWrites(target);
      }, 1200);
    }
  }
}

function scheduleCompactWrite(target, path, content) {
  if (target?.kind !== "filesystem") return;
  resetCompactWriteQueue(target);
  compactWriteQueue.target = target;
  compactWriteQueue.entries.set(path, content);
  if (compactWriteQueue.timer) return;
  compactWriteQueue.timer = setTimeout(() => {
    compactWriteQueue.timer = null;
    void flushCompactWrites(target);
  }, 1200);
}

function getSourceFolder(source) {
  if (source === "bookmarked") return "data/收藏";
  if (source === "following") return "data/关注";
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
    isEligible: (item) => ["liked", "favorite_api"].includes(item.source) && item.downloadStatus !== "downloaded",
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
    try {
      const progressText = await readTextFile(target, getDownloadProgressPath());
      const progress = progressText ? JSON.parse(progressText) : null;
      if (progress?.current && String(progress.generatedAt || "") >= String(record.generatedAt || "")) {
        record.current = { ...(record.current || {}), ...progress.current };
      }
    } catch {}
    return Array.isArray(record?.items) ? record : null;
  } catch {
    return null;
  }
}

async function getCachedDownloadRecord(target, { force = false } = {}) {
  const key = getTargetCacheKey(target);
  if (!force && key && downloadRecordCache.targetKey === key) {
    if (downloadRecordCache.record) return downloadRecordCache.record;
    if (downloadRecordCache.loadingPromise) return await downloadRecordCache.loadingPromise;
  }
  const loadingPromise = readDownloadRecord(target);
  downloadRecordCache = { targetKey: key, record: null, loadingPromise };
  try {
    const record = await loadingPromise;
    downloadRecordCache = { targetKey: key, record, loadingPromise: null };
    return record;
  } catch (error) {
    downloadRecordCache = { targetKey: key, record: null, loadingPromise: null };
    throw error;
  }
}

async function readDownloadProgressRecord(target) {
  if (target?.kind !== "filesystem") return null;
  try {
    const text = await readTextFile(target, getDownloadProgressPath());
    const progress = text ? JSON.parse(text) : null;
    return progress?.current ? progress : null;
  } catch {
    return null;
  }
}

function setCachedDownloadRecord(target, record) {
  downloadRecordCache = {
    targetKey: getTargetCacheKey(target),
    record,
    loadingPromise: null,
  };
}

function buildDownloadRecord(items, state, previousRecord = null) {
  const eligibleItems = items
    .filter((item) => ["favorited", "already_favorited"].includes(item.status))
    .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  const currentRecordItems = eligibleItems.map((item) => ({
    awemeId: item.awemeId,
    index: item.index,
    source: item.source || "liked",
    status: item.status,
    downloadStatus: item.downloadStatus || "not_started",
    mediaType: item.mediaType || "video",
    mediaCount: Number(item.mediaCount || item.mediaParts?.length || 1),
    downloadedPartCount: Number(item.downloadedPartCount || 0),
    mediaPaths: Array.isArray(item.downloadMediaPaths) ? item.downloadMediaPaths : [],
    imagePaths: Array.isArray(item.downloadImagePaths) ? item.downloadImagePaths : [],
    downloadedMediaParts: item.downloadedMediaParts || {},
    mediaParts: Array.isArray(item.mediaParts) ? item.mediaParts : [],
    desc: item.desc || "",
    authorUid: item.authorUid || "",
    authorName: item.authorName || "",
    createTime: item.createTime || 0,
    resolution: item.downloadQualityLabel || "",
    width: item.downloadWidth || 0,
    height: item.downloadHeight || 0,
    bitrate: item.downloadBitrate || 0,
    codec: item.downloadCodec || "",
    fps: item.downloadFps || 0,
    size: item.downloadSize || 0,
    candidateRank: item.downloadCandidateRank || 0,
    qualityFallbackReason: item.downloadQualityFallbackReason || "",
    videoPath: item.downloadVideoPath || "",
    coverPath: item.downloadCoverPath || "",
    url: item.url || "",
    lastError: item.lastError || "",
    updatedAt: item.updatedAt || "",
  }));
  const recordKey = (item) => `${downloadRecordItemScope(item)}:${String(item.awemeId || "")}`;
  const mergedItems = new Map();
  for (const item of previousRecord?.items || []) mergedItems.set(recordKey(item), item);
  for (const item of currentRecordItems) mergedItems.set(recordKey(item), item);
  const recordItems = [...mergedItems.values()].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  const likedRecordTotal = recordItems.filter((item) => downloadRecordItemScope(item) === "liked").length;
  const bookmarkedRecordTotal = recordItems.filter((item) => downloadRecordItemScope(item) === "bookmarked").length;
  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    likedTotal: Math.max(items.filter((item) => item.source === "liked" || item.source === "favorite_api").length, likedRecordTotal),
    bookmarkedTotal: Math.max(items.filter((item) => item.source === "bookmarked").length, bookmarkedRecordTotal),
    eligibleTotal: recordItems.length,
    downloadedTotal: recordItems.filter((item) => item.downloadStatus === "downloaded").length,
    pendingTotal: recordItems.filter((item) => item.downloadStatus !== "downloaded").length,
    failedTotal: recordItems.filter((item) => item.downloadStatus === "failed").length,
    current: {
      index: state.currentIndex,
      scope: state.scope || currentDownloadScope,
      awemeId: state.currentAwemeId,
      resolution: state.currentResolution,
      phase: state.phase,
      completed: state.completed,
      total: state.total,
    },
    items: recordItems,
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

async function persistDownloadArtifacts(target, batchState, {
  forceFull = false,
  itemCompleted = false,
} = {}) {
  if (target.kind !== "filesystem") return { full: false };
  const startedAt = timingNow();
  const targetKey = getTargetCacheKey(target);
  if (artifactCheckpoint.targetKey !== targetKey) {
    artifactCheckpoint = {
      targetKey,
      itemsSinceFull: 0,
      lastFullAt: Date.now(),
    };
  }
  if (itemCompleted) artifactCheckpoint.itemsSinceFull += 1;
  const progress = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    current: {
      index: batchState.currentIndex,
      scope: batchState.scope || currentDownloadScope,
      awemeId: batchState.currentAwemeId,
      resolution: batchState.currentResolution,
      phase: batchState.phase,
      completed: batchState.completed,
      total: batchState.total,
      inspected: batchState.inspected,
      sessionCompleted: batchState.sessionCompleted || 0,
    },
  };
  scheduleCompactWrite(target, getDownloadProgressPath(), JSON.stringify(progress));
  if (itemCompleted) {
    await updateLocalFolderCount(
      target,
      batchState.scope || currentDownloadScope,
      batchState.completed,
    );
  }
  const now = Date.now();
  // The compact progress/count/index files are the download hot path. The
  // legacy full state is only rebuilt at a safe pause or task completion.
  const shouldWriteState = forceFull;
  if (!shouldWriteState) {
    recordStage("progress_checkpoint_write", timingNow() - startedAt, { ok: true, itemCompleted });
    return { full: false, record: downloadRecordCache.record };
  }
  await flushCompactWrites(target);
  const [items, profileUid, profileNickname, localCounts] = await Promise.all([
    getAll("items"),
    getConfig("likedSyncProfileUid", ""),
    getConfig("likedSyncProfileNickname", ""),
    getLocalFolderCounts(target),
  ]);
  const record = buildDownloadRecord(items, batchState, downloadRecordCache.record);
  record.localCounts = localCounts;
  record.user = {
    uid: profileUid || "",
    nickname: profileNickname || "",
  };
  record.performance = currentPerformanceSummary();
  await writeFile(target, getDownloadRecordPath(), JSON.stringify(record));
  setCachedDownloadRecord(target, record);
  recordStage("checkpoint_write", timingNow() - startedAt, {
    ok: true,
    items: items.length,
    itemCompleted,
  });

  artifactCheckpoint.itemsSinceFull = 0;
  artifactCheckpoint.lastFullAt = now;
  if (!forceFull) return { full: false, record };

  const fullStartedAt = timingNow();
  const performance = currentPerformanceSummary();
  await Promise.all([
    writeFile(target, getDownloadReportPath(), buildLocalLibraryHtml(record, target.label || "")),
    writeLocalDatabaseFiles(target, items, record),
    performance
      ? writeFile(target, "data/.appdata/performance-summary.json", JSON.stringify(performance, null, 2) + "\n")
      : Promise.resolve(),
  ]);
  recordStage("artifact_full_write", timingNow() - fullStartedAt, {
    ok: true,
    items: items.length,
    logs: 0,
  });
  return { full: true, record };
}

function buildLocalDatabase(items, record) {
  const eligibleItems = items.filter((item) => ["favorited", "already_favorited"].includes(item.status));
  const likedItems = eligibleItems.filter((item) => ["liked", "favorite_api"].includes(item.source));
  const bookmarkedItems = eligibleItems.filter((item) => item.source === "bookmarked");
  const downloadedLikes = likedItems.filter((item) => item.downloadStatus === "downloaded");
  const downloadedBookmarked = bookmarkedItems.filter((item) => item.downloadStatus === "downloaded");
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
      mediaType: item.mediaType || "video",
      mediaCount: Number(item.mediaCount || item.mediaParts?.length || 1),
      downloadedPartCount: Number(item.downloadedPartCount || 0),
      mediaPaths: Array.isArray(item.downloadMediaPaths) ? item.downloadMediaPaths : [],
      imagePaths: Array.isArray(item.downloadImagePaths) ? item.downloadImagePaths : [],
      downloadedMediaParts: item.downloadedMediaParts || {},
      video: item.downloadVideoPath || "",
      cover: item.downloadCoverPath || "",
      width: item.downloadWidth || 0,
      bitrate: item.downloadBitrate || 0,
      quality: item.downloadQualityLabel || "",
      size: item.downloadSize || 0,
      candidateRank: item.downloadCandidateRank || 0,
      qualityFallbackReason: item.downloadQualityFallbackReason || "",
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
        total: likedItems.length,
        downloaded: downloadedLikes.map((item) => item.awemeId),
        pending: likedItems.filter((item) => item.downloadStatus !== "downloaded").map((item) => item.awemeId),
        failed: likedItems.filter((item) => item.downloadStatus === "failed").map((item) => item.awemeId),
      },
    },
    db_bookmarked: {
      schemaVersion: 1,
      generatedAt: record.generatedAt,
      bookmarked: {
        total: bookmarkedItems.length,
        downloaded: downloadedBookmarked.map((item) => item.awemeId),
        pending: bookmarkedItems.filter((item) => item.downloadStatus !== "downloaded").map((item) => item.awemeId),
        failed: bookmarkedItems.filter((item) => item.downloadStatus === "failed").map((item) => item.awemeId),
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
  await writeFile(target, "data/.appdata/db_bookmarked.json", JSON.stringify(db.db_bookmarked, null, 2) + "\n");
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

async function recoverDownloadedItemsFromFolderRecord(target, defaultSource = "liked", suppliedRecord = null) {
  if (target.kind !== "filesystem") return 0;
  const record = suppliedRecord || await getCachedDownloadRecord(target);
  if (!record) return 0;
  const items = await getAll("items");
  const recovered = recoverDownloadedRecords(items, record.items, { defaultSource });
  if (recovered.length) await putItems(recovered);
  return recovered.length;
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
  addLog(text, "info", meta).then(() => scheduleRender()).catch(console.error);
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return String(url || "").slice(0, 300);
  }
}

function sanitizeDiagnostic(value, key = "") {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/url/i.test(key) || /^https?:\/\//i.test(value)) return safeUrl(value);
    return value.length > 4000 ? value.slice(0, 4000) + "...[truncated]" : value;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeDiagnostic(entry, key));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeDiagnostic(childValue, childKey),
    ]));
  }
  return String(value);
}

async function exportDiagnosticLogs() {
  const [logs, items] = await Promise.all([getAll("logs"), getAll("items")]);
  const failedItems = items
    .filter((item) => item.downloadStatus === "failed" || item.lastError)
    .map((item) => ({
      awemeId: item.awemeId,
      index: item.index,
      source: item.source,
      downloadStatus: item.downloadStatus,
      lastError: item.lastError,
      updatedAt: item.updatedAt,
    }));
  const report = sanitizeDiagnostic({
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    page: location.href,
    userAgent: navigator.userAgent,
    downloadState: downloadBatchState,
    config: configFromForm(),
    failedItems,
    logs,
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const storedTarget = await getStoredDownloadTarget();
  const target = storedTarget?.permission === "granted" ? storedTarget : { kind: "downloads" };
  const path = target.kind === "filesystem" ? "data/.appdata/logs/diagnostic-" + stamp + ".json" : "douyin-toolkit-logs/diagnostic-" + stamp + ".json";
  const result = await writeFile(
    target,
    path,
    JSON.stringify(report, null, 2) + "\n",
  );
  logLine("\u8bca\u65ad\u65e5\u5fd7\u5df2\u5bfc\u51fa", { type: "diagnostic_logs_exported", download: result });
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
    downloadUseSavedFolder: true,
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
  $("downloadUseSavedFolder").disabled = true;
}

function renderLogs(logs) {
const beijingTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatLogTime(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : beijingTimeFormatter.format(date);
}

  const latest = logs[logs.length - 1];
  $("latestLog").innerHTML = latest
    ? `<span style="color:#8e8e93">${escapeHtml(formatLogTime(latest.createdAt))}</span> ${escapeHtml(latest.text)}`
    : "暂无日志";
  $("log").innerHTML = [...logs].reverse().map((entry) => {
    const time = formatLogTime(entry.createdAt);
    return `<div><span style="color:#8e8e93">${escapeHtml(time)}</span> ${escapeHtml(entry.text)}</div>`;
  }).join("");
  $("log").scrollTop = 0;
  $("downloadTaskLatestLog").innerHTML = $("latestLog").innerHTML;
  $("downloadTaskLog").innerHTML = $("log").innerHTML;
  $("downloadTaskLog").scrollTop = 0;
}

function buildFollowingAuthors(items, officialAuthors = []) {
  const grouped = new Map();
  const officialUids = new Set((officialAuthors || []).map((author) => String(author?.uid || "")).filter(Boolean));
  for (const author of officialAuthors || []) {
    if (!author?.uid) continue;
    grouped.set(String(author.uid), {
      authorUid: String(author.uid),
      secUid: String(author.secUid || ""),
      authorName: author.nickname || "未命名作者",
      total: Math.max(0, Number(author.awemeCount || 0)),
      pending: Math.max(0, Number(author.awemeCount || 0)),
      downloaded: 0,
    });
  }
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
    if (!officialUids.has(key)) entry.total += 1;
    if (item.downloadStatus === "downloaded") entry.downloaded += 1;
    else if (!officialUids.has(key)) entry.pending += 1;
    if (officialUids.has(key)) entry.pending = Math.max(0, entry.total - entry.downloaded);
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
    ? "请选择要同步和下载的作者；未选择时不会启动，避免误下载全部关注作者。"
    : "还没有作者数据，请点击“刷新”从抖音读取关注列表。";
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

function downloadRecordItemScope(item) {
  const paths = [
    item.videoPath,
    item.coverPath,
    ...(Array.isArray(item.mediaPaths) ? item.mediaPaths : []),
    ...(Array.isArray(item.imagePaths) ? item.imagePaths : []),
  ].filter(Boolean).join("/");
  if (paths.includes("data/点赞/")) return "liked";
  if (paths.includes("data/收藏/")) return "bookmarked";
  if (paths.includes("data/关注/")) return "following";
  if (item.source === "favorite_api") return "liked";
  return item.source || "liked";
}

function summarizeLocalDownloads(recordItems, scope) {
  const scoped = recordItems.filter((item) => downloadRecordItemScope(item) === scope);
  const unique = new Map(scoped.map((item) => [String(item.awemeId || item.index || ""), item]));
  const values = [...unique.values()];
  return {
    total: values.length,
    downloaded: values.filter((item) => item.downloadStatus === "downloaded").length,
    failed: values.filter((item) => item.downloadStatus === "failed").length,
  };
}

async function getNestedDirectory(root, parts) {
  let current = root;
  for (const part of parts) current = await current.getDirectoryHandle(part, { create: false });
  return current;
}

async function collectWorkIds(directory, { includeNestedVideo = false } = {}) {
  const ids = new Set();
  const incompleteIds = new Set();
  try {
    for await (const entry of directory.values()) {
      if (entry.kind === "directory") {
        if (includeNestedVideo && entry.name === "视频") {
          const nested = await collectWorkIds(entry);
          for (const id of nested) ids.add(id);
        } else {
          ids.add(entry.name);
        }
        continue;
      }
      if (entry.name.endsWith(".resume.json")) {
        incompleteIds.add(entry.name.replace(/\.resume\.json$/i, "").replace(/\.[^.]+$/, "").replace(/-\d+$/, ""));
        continue;
      }
      if (!/\.(mp4|jpe?g|png|webp)$/i.test(entry.name)) continue;
      ids.add(entry.name.replace(/\.[^.]+$/, "").replace(/-\d+$/, ""));
    }
  } catch {}
  for (const id of incompleteIds) ids.delete(id);
  return ids;
}

async function getScopeWorkIds(root, scope) {
  const base = scope === "liked"
    ? ["data", "点赞"]
    : (scope === "bookmarked" ? ["data", "收藏"] : ["data", "关注"]);
  const ids = new Set();
  for (const leaf of ["视频", "图片"]) {
    try {
      const directory = await getNestedDirectory(root, [...base, leaf]);
      const found = await collectWorkIds(directory, { includeNestedVideo: scope === "following" });
      for (const id of found) ids.add(id);
    } catch {}
  }
  return ids;
}

async function countScopeFiles(root, scope) {
  return (await getScopeWorkIds(root, scope)).size;
}

async function writeDownloadIndex(target, index, { delayed = false } = {}) {
  const content = JSON.stringify(serializeDownloadIndex(index));
  if (delayed) scheduleCompactWrite(target, getDownloadIndexPath(), content);
  else await writeFile(target, getDownloadIndexPath(), content);
  downloadIndexCache = { targetKey: getTargetCacheKey(target), index, loadingPromise: null };
}

async function getDownloadIndex(target) {
  if (target?.kind !== "filesystem") return createDownloadIndex();
  const targetKey = getTargetCacheKey(target);
  if (downloadIndexCache.targetKey === targetKey && downloadIndexCache.index) return downloadIndexCache.index;
  if (downloadIndexCache.targetKey === targetKey && downloadIndexCache.loadingPromise) {
    return await downloadIndexCache.loadingPromise;
  }
  const loadingPromise = (async () => {
    try {
      const text = await readTextFile(target, getDownloadIndexPath());
      const raw = text ? JSON.parse(text) : null;
      if (raw?.schemaVersion === 1) return createDownloadIndex(raw);
    } catch {}
    const [liked, bookmarked, following, uid, nickname] = await Promise.all([
      getScopeWorkIds(target.handle, "liked"),
      getScopeWorkIds(target.handle, "bookmarked"),
      getScopeWorkIds(target.handle, "following"),
      getConfig("likedSyncProfileUid", ""),
      getConfig("likedSyncProfileNickname", ""),
    ]);
    const hasExistingMedia = liked.size + bookmarked.size + following.size > 0;
    const migrated = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      user: hasExistingMedia ? { uid: uid || "", nickname: nickname || "" } : { uid: "", nickname: "" },
      scopes: { liked, bookmarked, following },
    };
    await writeDownloadIndex(target, migrated);
    return migrated;
  })();
  downloadIndexCache = { targetKey, index: null, loadingPromise };
  try {
    const index = await loadingPromise;
    downloadIndexCache = { targetKey, index, loadingPromise: null };
    return index;
  } catch (error) {
    downloadIndexCache = { targetKey, index: null, loadingPromise: null };
    throw error;
  }
}

async function markDownloadIndexCompleted(target, scope, awemeId) {
  if (target?.kind !== "filesystem" || !awemeId) return;
  const index = await getDownloadIndex(target);
  if (!markIndexCompleted(index, scope, awemeId)) return;
  await writeDownloadIndex(target, index, { delayed: true });
}

async function reconcilePageItemsWithFolderIds(items, folderIds) {
  const patched = [];
  const reconciled = items.map((item) => {
    const exists = folderIds?.has(String(item.awemeId || ""));
    if (exists && item.downloadStatus === "downloaded") return item;
    if (!exists && item.downloadStatus !== "downloaded") return item;
    const next = patchItem(item, {
      downloadStatus: exists ? "downloaded" : "not_started",
      lastError: "",
    });
    patched.push(next);
    return next;
  });
  if (patched.length) await putItems(patched);
  return reconciled;
}

async function getLocalFolderCounts(target) {
  if (target?.kind !== "filesystem" || !target.handle) return { liked: 0, bookmarked: 0, following: 0, likedCurrent: 0, likedArchived: 0, likedReconciledAt: "" };
  const targetKey = getTargetCacheKey(target);
  if (
    localFolderCountCache.targetKey === targetKey
    && localFolderCountCache.counts
    && Date.now() - localFolderCountCache.loadedAt < 5 * 60 * 1000
  ) return localFolderCountCache.counts;
  if (localFolderCountCache.targetKey === targetKey && localFolderCountCache.loadingPromise) {
    return await localFolderCountCache.loadingPromise;
  }
  const loadingPromise = (async () => {
    try {
      const text = await readTextFile(target, getDownloadCountsPath());
      const saved = text ? JSON.parse(text) : null;
      if (saved?.schemaVersion === 1 && saved.counts) {
        return {
          liked: Math.max(0, Number(saved.counts.liked || 0)),
          bookmarked: Math.max(0, Number(saved.counts.bookmarked || 0)),
          following: Math.max(0, Number(saved.counts.following || 0)),
          likedCurrent: Math.max(0, Number(saved.counts.likedCurrent || 0)),
          likedArchived: Math.max(0, Number(saved.counts.likedArchived || 0)),
          likedReconciledAt: String(saved.counts.likedReconciledAt || ""),
        };
      }
    } catch {}
    const [liked, bookmarked, following] = await Promise.all([
      countScopeFiles(target.handle, "liked"),
      countScopeFiles(target.handle, "bookmarked"),
      countScopeFiles(target.handle, "following"),
    ]);
    const counts = { liked, bookmarked, following, likedCurrent: 0, likedArchived: 0, likedReconciledAt: "" };
    await writeFile(target, getDownloadCountsPath(), JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      counts,
    })).catch(() => {});
    return counts;
  })();
  localFolderCountCache = { targetKey, loadedAt: 0, counts: null, loadingPromise };
  try {
    const counts = await loadingPromise;
    localFolderCountCache = { targetKey, loadedAt: Date.now(), counts, loadingPromise: null };
    return counts;
  } catch (error) {
    localFolderCountCache = { targetKey, loadedAt: 0, counts: null, loadingPromise: null };
    throw error;
  }
}

async function saveLocalFolderCounts(target, counts, { delayed = true } = {}) {
  const next = {
    liked: Math.max(0, Number(counts?.liked || 0)),
    bookmarked: Math.max(0, Number(counts?.bookmarked || 0)),
    following: Math.max(0, Number(counts?.following || 0)),
    likedCurrent: Math.max(0, Number(counts?.likedCurrent || 0)),
    likedArchived: Math.max(0, Number(counts?.likedArchived || 0)),
    likedReconciledAt: String(counts?.likedReconciledAt || ""),
  };
  localFolderCountCache = {
    targetKey: getTargetCacheKey(target),
    loadedAt: Date.now(),
    counts: next,
    loadingPromise: null,
  };
  const content = JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    counts: next,
  });
  if (delayed) scheduleCompactWrite(target, getDownloadCountsPath(), content);
  else await writeFile(target, getDownloadCountsPath(), content);
  return next;
}

async function updateLocalFolderCount(target, scope, completed) {
  if (target?.kind !== "filesystem" || !["liked", "bookmarked", "following"].includes(scope)) return;
  const counts = await getLocalFolderCounts(target);
  const next = {
    ...counts,
    [scope]: Math.max(Number(counts[scope] || 0), Number(completed || 0)),
  };
  await saveLocalFolderCounts(target, next);
}

async function bindFolderToCurrentAccount(target, index) {
  const profileResult = await requestSelfProfile({ maxAgeMs: 5 * 60 * 1000, reason: "folder_account_binding" });
  if (!profileResult?.ok) {
    throw new Error(`无法确认当前抖音账号：${resultError(profileResult)}`);
  }
  const user = profileUser(profileResult) || {};
  const currentUserId = String(user.uid || user.id || user.sec_uid || user.secUid || user.sec_user_id || "");
  const nickname = String(user.nickname || user.name || "");
  if (!currentUserId) throw new Error("当前抖音账号缺少用户标识，已停止写入下载文件夹");
  const folderUserId = String(index?.user?.uid || "");
  if (folderUserId && folderUserId !== currentUserId) {
    throw new Error(
      `该文件夹已绑定另一个抖音账号${index?.user?.nickname ? `：${index.user.nickname}` : ""}，请更换文件夹`,
    );
  }
  if (!folderUserId || String(index?.user?.nickname || "") !== nickname) {
    index.user = { uid: currentUserId, nickname };
    await writeDownloadIndex(target, index);
  }
  return index;
}

async function ensureDailyLightweightBackup(target, index, batchState = downloadBatchState) {
  if (target?.kind !== "filesystem") return false;
  const date = localDateKey();
  const path = `data/.appdata/backups/${date}/download-metadata.json`;
  try {
    if (await readTextFile(target, path)) return false;
  } catch {}
  const counts = await getLocalFolderCounts(target);
  const backup = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    date,
    user: index?.user || { uid: "", nickname: "" },
    counts,
    index: serializeDownloadIndex(index),
    current: {
      scope: batchState.scope || currentDownloadScope,
      completed: Number(batchState.completed || 0),
      total: Number(batchState.total || 0),
      phase: String(batchState.phase || ""),
    },
  };
  await writeFile(target, path, JSON.stringify(backup));
  return true;
}

async function renderContent() {
  const includeLibrary = currentView === "favorite"
    || (!downloadRunning && Boolean($("followingOptionsPanel").open));
  const items = includeLibrary ? await getAll("items") : [];
  const state = includeLibrary
    ? await summarize({ items })
    : {
      config: await loadConfig(),
      logs: [],
      total: 0,
      favorite: { completed: 0, pending: 0, paused: 0, auditPending: 0, cursor: null },
    };
  const officialFollowingAuthors = await getCachedFollowingAuthors();
  const followingAuthors = buildFollowingAuthors(items, officialFollowingAuthors);
  const selectedFollowingAuthors = await getSelectedFollowingAuthors();
  const storedTarget = await getStoredDownloadTarget();
  const folderCounts = storedTarget?.permission === "granted"
    ? await getLocalFolderCounts(storedTarget).catch((error) => {
      console.warn("读取本地下载数量失败", error);
      return { liked: 0, bookmarked: 0, following: 0 };
    })
    : { liked: 0, bookmarked: 0, following: 0 };
  const folderProgress = storedTarget?.permission === "granted"
    ? await readDownloadProgressRecord(storedTarget)
    : null;
  const folderRecord = storedTarget?.permission === "granted"
    ? {
      current: folderProgress?.current || null,
      items: [],
      eligibleTotal: folderCounts.liked + folderCounts.bookmarked + folderCounts.following,
      downloadedTotal: folderCounts.liked + folderCounts.bookmarked + folderCounts.following,
      pendingTotal: 0,
      failedTotal: 0,
    }
    : null;
  if (!configHydrated && !document.activeElement?.matches("input")) {
    fillConfig(state.config);
    configHydrated = true;
  }
  const recordCurrent = folderRecord?.current || null;
  const recordScope = recordCurrent?.scope || "liked";
  const folderCompletedForCurrentScope = Number(folderCounts[recordScope] || 0);
  const historicalCompleted = Math.max(Number(recordCurrent?.completed || 0), folderCompletedForCurrentScope);
  const recordItems = Array.isArray(folderRecord?.items) ? folderRecord.items : [];
  const likedLocal = summarizeLocalDownloads(recordItems, "liked");
  const bookmarkedLocal = summarizeLocalDownloads(recordItems, "bookmarked");
  const followingLocal = summarizeLocalDownloads(recordItems, "following");
  likedLocal.downloaded = Math.max(likedLocal.downloaded, folderCounts.liked);
  bookmarkedLocal.downloaded = Math.max(bookmarkedLocal.downloaded, folderCounts.bookmarked);
  followingLocal.downloaded = Math.max(followingLocal.downloaded, folderCounts.following);
  followingLocal.total = Math.max(followingLocal.total, folderCounts.following);
  const recordCursorItem = [...recordItems]
    .filter((item) => item.downloadStatus && item.downloadStatus !== "not_started")
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
  $("likedSummaryCount").textContent = remoteProfileSummary.likedTotal ?? "-";
  $("bookmarkedSummaryCount").textContent = remoteProfileSummary.bookmarkedTotal ?? "-";
  const hasReadableFolder = storedTarget?.permission === "granted";
  $("likedLocalDownloadedCount").textContent = hasReadableFolder ? String(likedLocal.downloaded) : "-";
  $("likedArchivedLocalCount").textContent = hasReadableFolder ? String(folderCounts.likedArchived || 0) : "-";
  $("likedArchivedLocalCount").title = folderCounts.likedReconciledAt
    ? `最近完整核对：${new Date(folderCounts.likedReconciledAt).toLocaleString("zh-CN")}`
    : "完成一次完整喜欢列表扫描后统计";
  $("bookmarkedLocalDownloadedCount").textContent = hasReadableFolder ? String(bookmarkedLocal.downloaded) : "-";
  $("followingLocalDownloadedCount").textContent = hasReadableFolder ? String(followingLocal.downloaded) : "-";
  $("followingSummaryCount").textContent = String(followingLocal.total);
  const likedCurrentLocal = folderCounts.likedReconciledAt
    ? Math.max(0, Number(folderCounts.likedCurrent || 0))
    : likedLocal.downloaded;
  $("likedLocalPendingCount").textContent = !hasReadableFolder || remoteProfileSummary.likedTotal == null
    ? "-"
    : String(Math.max(0, remoteProfileSummary.likedTotal - likedCurrentLocal));
  $("bookmarkedLocalPendingCount").textContent = !hasReadableFolder || remoteProfileSummary.bookmarkedTotal == null
    ? "-"
    : String(Math.max(0, remoteProfileSummary.bookmarkedTotal - bookmarkedLocal.downloaded));
  $("followingLocalPendingCount").textContent = hasReadableFolder
    ? String(Math.max(0, followingLocal.total - followingLocal.downloaded))
    : "-";
  $("remoteSummaryMeta").textContent = remoteProfileSummary.status === "loaded"
    ? "已连接" + (remoteProfileSummary.nickname ? " · " + remoteProfileSummary.nickname : "")
    : (remoteProfileSummary.status === "loading"
      ? "正在读取平台数量…"
      : (remoteProfileSummary.error || "暂未读取平台数量"));
  const performanceText = formatPerformanceSummary(currentPerformanceSummary())
    || "Performance timing starts with the next download task";
  $("performanceSummary").textContent = performanceText;
  $("downloadTaskPerformanceSummary").textContent = performanceText;
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
  updateDownloadBatchProgress();
  $("downloadTaskCursor").textContent = downloadBatchState.currentOrder
    ? `${downloadBatchState.currentOrder} / ${downloadBatchState.total || "-"}`
    : (recordCursorItem?.index != null ? `#${recordCursorItem.index}` : "-");
  $("downloadTaskChecked").textContent = downloadBatchState.inspected
    ? `${downloadBatchState.inspected} / ${downloadBatchState.total || "-"}`
    : (recordCurrent?.inspected ? String(recordCurrent.inspected) : "-");
  $("downloadTaskTotal").textContent = downloadBatchState.total
    ? String(downloadBatchState.total)
    : String(Math.max(Number(recordCurrent?.total || folderRecord?.eligibleTotal || 0), historicalCompleted));
  $("downloadTaskCompleted").textContent = String(
    downloadBatchState.total ? downloadBatchState.completed : historicalCompleted,
  );
  if (!downloadBatchState.total && recordCurrent?.total) {
    $("downloadTaskProgress").textContent = `上次进度：${historicalCompleted} / ${Math.max(Number(recordCurrent.total || 0), historicalCompleted)}`;
  }
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
    ? `<strong>${escapeHtml(storedTarget.label || "已授权文件夹")}</strong> · 已就绪，将按本地索引继续`
    : "未选择目录，开始下载前需要先授权";
  $("downloadTaskTargetMeta").innerHTML = $("downloadTargetMeta").innerHTML;
  $("downloadTaskCursorBox").innerHTML = $("downloadCursorBox").innerHTML;
  $("downloadTaskView").classList.toggle("hidden", !downloadRunning && !downloadBatchState.total && !recordCurrent?.total);
  renderDownloadTaskHeader(downloadBatchState.total ? currentDownloadScope : (recordCurrent?.scope || currentDownloadScope));
  renderFollowingAuthors(followingAuthors, selectedFollowingAuthors);
  renderLogs(state.logs);
  updateButtons();
}

async function render() {
  return await timedStage("ui_render", () => renderContent());
}
async function saveCurrentConfig() {
  await saveConfig({ ...await loadConfig(), ...configFromForm() });
}

function updateButtons() {
  $("favoriteBtn").disabled = running || oneClickRunning;
  $("auditBtn").disabled = running || oneClickRunning;
  $("downloadBtn").disabled = downloadRunning || oneClickRunning;
  $("downloadBookmarkedBtn").disabled = downloadRunning || oneClickRunning;
  $("continueDownloadBtn").disabled = downloadRunning || oneClickRunning;
  $("downloadFollowingBtn").disabled = downloadRunning || oneClickRunning;
  $("oneClickBackupBtn").disabled = downloadRunning || running || oneClickRunning;
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
  return result?.statusMsg
    || result?.text
    || result?.error
    || (result?.statusCode != null ? `抖音业务状态码 ${result.statusCode}（HTTP ${result?.httpStatus || "unknown"}）` : "")
    || `HTTP ${result?.httpStatus || "unknown"}`;
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
function createDownloadPausedError() {
  const error = new Error("用户已请求暂停，分段下载停在安全点");
  error.code = "DOWNLOAD_PAUSED";
  return error;
}

function isDownloadPausedError(error) {
  return error?.code === "DOWNLOAD_PAUSED";
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
      scheduleRender();
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

async function syncNextLikedPage(config) {
  logLine("\u672c\u5730\u65e0\u5f85\u4e0b\u8f7d\u8bb0\u5f55\uff0c\u6b63\u5728\u540c\u6b65\u4e0b\u4e00\u9875\u559c\u6b22\u5217\u8868", {
    type: "liked_sync_started",
  });
  const profile = await sendPageRequest("GET_SELF_PROFILE", {}, 30000);
  if (!profile?.ok) {
    throw new Error("\u559c\u6b22\u5217\u8868\u540c\u6b65\u5931\u8d25\uff1a\u65e0\u6cd5\u8bfb\u53d6\u5f53\u524d\u767b\u5f55\u7528\u6237\uff0c" + resultError(profile));
  }
  const user = profile?.json?.user || profile?.json?.user_info || profile?.json;
  const secUid = user?.sec_uid || user?.secUid || user?.sec_user_id || "";
  if (!secUid) {
    throw new Error("\u559c\u6b22\u5217\u8868\u540c\u6b65\u5931\u8d25\uff1a\u5f53\u524d\u7528\u6237\u7f3a\u5c11 sec_uid");
  }

  const cursor = await getConfig("likedSyncCursor", 0);
  const pageSize = Math.min(50, Math.max(10, Number(config.batchSize || 20)));
  const page = await sendPageRequest("FETCH_LIKED_PAGE", {
    secUid,
    maxCursor: cursor,
    count: pageSize,
  }, 60000);
  if (!page?.ok) {
    throw new Error("\u559c\u6b22\u5217\u8868\u540c\u6b65\u5931\u8d25\uff1a" + resultError(page));
  }

  const existingItems = await getAll("items");
  const existingById = new Map(existingItems.map((item) => [String(item.awemeId), item]));
  let nextIndex = existingItems.reduce((max, item) => Math.max(max, Number(item.index ?? -1)), -1) + 1;
  const syncedItems = page.awemeList
    .map((aweme) => {
      const normalized = normalizeAweme(aweme, nextIndex, "liked");
      if (!normalized.awemeId) return null;
      const existing = existingById.get(String(normalized.awemeId));
      if (!existing) nextIndex += 1;
      return {
        ...normalized,
        ...existing,
        source: existing?.source || "liked",
        videoUrl: normalized.videoUrl || existing?.videoUrl || "",
        coverUrl: normalized.coverUrl || existing?.coverUrl || "",
        updatedAt: new Date().toISOString(),
      };
    })
    .filter(Boolean);
  if (syncedItems.length) await putItems(syncedItems);
  await setConfig("likedSyncCursor", page.maxCursor || 0);
  await setConfig("likedSyncHasMore", Boolean(page.hasMore));
  logLine("\u559c\u6b22\u5217\u8868\u540c\u6b65\u5b8c\u6210\uff1a\u672c\u9875 " + syncedItems.length + " \u6761", {
    type: "liked_sync_finished",
    count: syncedItems.length,
    cursor: page.maxCursor || 0,
    hasMore: Boolean(page.hasMore),
  });
  return syncedItems.length;
}

let lastLikedPageRequestAt = 0;

async function startLikedScan() {
  const profileResult = await requestSelfProfile({ maxAgeMs: 5 * 60 * 1000, reason: "liked_scan" });
  if (!profileResult?.ok) {
    throw new Error("\u559c\u6b22\u5217\u8868\u540c\u6b65\u5931\u8d25\uff1a\u65e0\u6cd5\u8bfb\u53d6\u5f53\u524d\u767b\u5f55\u7528\u6237\uff0c" + resultError(profileResult));
  }
  const profile = parseLikedProfile(profileResult);
  if (!profile.secUid) {
    throw new Error("\u559c\u6b22\u5217\u8868\u540c\u6b65\u5931\u8d25\uff1a\u5f53\u524d\u7528\u6237\u7f3a\u5c11 sec_uid");
  }
  const state = createLikedScanState(profile);
  await Promise.all([
    setConfig("likedSyncCursor", 0),
    setConfig("likedSyncMinCursor", 0),
    setConfig("likedSyncHasMore", true),
    setConfig("likedSyncChecked", 0),
    setConfig("likedSyncProfileNickname", profile.nickname || ""),
    setConfig("likedSyncExpectedTotal", profile.expectedTotal),
    setConfig("likedSyncProfileUid", profile.uid || profile.secUid),
  ]);
  logLine(
    "\u5f00\u59cb\u4ece\u7b2c 1 \u9875\u68c0\u67e5\u559c\u6b22\u5217\u8868"
      + (profile.expectedTotal ? "\uff0c\u6296\u97f3\u663e\u793a\u603b\u6570 " + profile.expectedTotal : ""),
    {
      type: "liked_scan_started",
      expectedTotal: profile.expectedTotal,
      uid: profile.uid,
    },
  );
  return state;
}

async function waitForLikedPageSlot() {
  const waitMs = Math.max(0, LIKED_PAGE_MIN_INTERVAL_MS - (Date.now() - lastLikedPageRequestAt));
  if (waitMs > 0) await waitTracked("list_throttle_wait", waitMs, { scope: "liked" });
}

async function requestLikedPageWithRetry(state) {
  let lastError = null;
  for (let attempt = 1; attempt <= LIKED_PAGE_MAX_RETRIES; attempt += 1) {
    try {
      while (navigator.onLine === false) {
        await sleep(1000);
      }
      await waitForLikedPageSlot();
      lastLikedPageRequestAt = Date.now();
      const page = await timedStage("list_api", () => sendPageRequest("FETCH_LIKED_PAGE", {
        secUid: state.secUid,
        maxCursor: state.maxCursor,
        minCursor: state.minCursor,
        count: LIKED_PAGE_SIZE,
      }, 60000), { scope: "liked", page: state.page + 1, attempt });
      if (!page?.ok || !Array.isArray(page.awemeList)) {
        throw new Error(resultError(page));
      }
      advanceLikedScanState(state, page, 0);
      return page;
    } catch (error) {
      lastError = error;
      if (attempt >= LIKED_PAGE_MAX_RETRIES) break;
      const delayMs = likedRetryDelayMs(attempt);
      logLine(
        "\u559c\u6b22\u5217\u8868\u7b2c " + (state.page + 1) + " \u9875\u8bf7\u6c42\u5931\u8d25\uff0c"
          + Math.round(delayMs / 1000) + " \u79d2\u540e\u91cd\u8bd5\uff08" + attempt + "/" + LIKED_PAGE_MAX_RETRIES + "\uff09\uff1a"
          + (error?.message || String(error)),
        {
          type: "liked_page_retry",
          page: state.page + 1,
          attempt,
          maxCursor: state.maxCursor,
          minCursor: state.minCursor,
          error: error?.message || String(error),
        },
      );
      await waitTracked("list_retry_wait", delayMs, { scope: "liked", attempt });
    }
  }
  throw new Error(
    "\u559c\u6b22\u5217\u8868\u7b2c " + (state.page + 1) + " \u9875\u8fde\u7eed\u5931\u8d25 "
      + LIKED_PAGE_MAX_RETRIES + " \u6b21\uff0c\u6e38\u6807 max=" + state.maxCursor + " min=" + state.minCursor + "\uff1a"
      + (lastError?.message || String(lastError)),
  );
}

async function scanNextLikedPage(scanState) {
  const page = await requestLikedPageWithRetry(scanState);
  const existingItems = await getAll("items");
  const normalized = normalizeLikedPageItems(page.awemeList, existingItems, scanState.seenIds);
  if (normalized.items.length) await putItems(normalized.items);
  const nextState = advanceLikedScanState(scanState, page, normalized.items.length);
  await Promise.all([
    setConfig("likedSyncCursor", nextState.maxCursor),
    setConfig("likedSyncMinCursor", nextState.minCursor),
    setConfig("likedSyncHasMore", nextState.hasMore),
    setConfig("likedSyncChecked", nextState.checked),
    setConfig("likedSyncExpectedTotal", nextState.expectedTotal),
    setConfig("likedSyncUpdatedAt", new Date().toISOString()),
  ]);
  logLine(
    "\u68c0\u67e5\u559c\u6b22\u5217\u8868\uff1a\u7b2c " + nextState.page + " \u9875\uff0c\u672c\u9875 "
      + page.awemeList.length + " \u6761\uff0c\u53ef\u4e0b\u8f7d\u4f5c\u54c1 " + normalized.items.length
      + " \u6761\uff0c\u7d2f\u8ba1\u68c0\u67e5\u5230 " + nextState.checked
      + (nextState.expectedTotal ? "/" + nextState.expectedTotal : "")
      + (normalized.imageItems ? "\uff0c\u56fe\u6587 " + normalized.imageItems : "")
      + (normalized.multiVideoItems ? "\uff0c\u591a\u6bb5\u89c6\u9891 " + normalized.multiVideoItems : "")
      + (normalized.skippedUnsupported ? "\uff0c\u8df3\u8fc7\u4e0d\u652f\u6301 " + normalized.skippedUnsupported : ""),
    {
      type: "liked_page_checked",
      page: nextState.page,
      pageItems: page.awemeList.length,
      videoItems: normalized.items.length,
      mediaItems: normalized.items.length,
      imageItems: normalized.imageItems,
      multiVideoItems: normalized.multiVideoItems,
      skippedUnsupported: normalized.skippedUnsupported,
      checked: nextState.checked,
      expectedTotal: nextState.expectedTotal,
      skippedImages: normalized.skippedImages,
      skippedDuplicates: normalized.skippedDuplicates,
      maxCursor: nextState.maxCursor,
      minCursor: nextState.minCursor,
      hasMore: nextState.hasMore,
      finished: nextState.finished,
      fullScan: nextState.fullScan,
    },
  );
  return {
    state: nextState,
    items: normalized.items,
  };
}


let lastBookmarkedPageRequestAt = 0;

async function startBookmarkedScan() {
  const profileResult = await requestSelfProfile({ maxAgeMs: 5 * 60 * 1000, reason: "bookmarked_scan" });
  if (!profileResult?.ok) {
    throw new Error("\u6536\u85cf\u5217\u8868\u540c\u6b65\u5931\u8d25\uff1a\u65e0\u6cd5\u8bfb\u53d6\u5f53\u524d\u767b\u5f55\u7528\u6237\uff0c" + resultError(profileResult));
  }
  const parsedProfile = parseBookmarkedProfile(profileResult);
  const overview = cachedBookmarkedFirstPage()
    || (bookmarkedOverviewInFlight
      ? await requestBookmarkedOverview({ reason: "bookmarked_scan" })
      : null);
  const profile = {
    ...parsedProfile,
    expectedTotal: overview && (overview.hasTotal || Number(overview.total || 0) > 0)
      ? Number(overview.total || 0)
      : parsedProfile.expectedTotal,
  };
  if (!profile.uid && !profile.secUid) {
    throw new Error("\u6536\u85cf\u5217\u8868\u540c\u6b65\u5931\u8d25\uff1a\u5f53\u524d\u7528\u6237\u7f3a\u5c11\u8d26\u53f7\u6807\u8bc6");
  }
  const state = createBookmarkedScanState(profile);
  await Promise.all([
    setConfig("bookmarkedSyncCursor", 0),
    setConfig("bookmarkedSyncHasMore", true),
    setConfig("bookmarkedSyncChecked", 0),
    setConfig("bookmarkedSyncExpectedTotal", profile.expectedTotal),
    setConfig("bookmarkedSyncProfileUid", profile.uid || profile.secUid),
    setConfig("bookmarkedSyncProfileNickname", profile.nickname || ""),
    setConfig("likedSyncProfileUid", profile.uid || profile.secUid),
    setConfig("likedSyncProfileNickname", profile.nickname || ""),
  ]);
  logLine(
    "\u5f00\u59cb\u4ece\u7b2c 1 \u9875\u68c0\u67e5\u6536\u85cf\u5217\u8868"
      + (profile.expectedTotal ? "\uff0c\u6296\u97f3\u663e\u793a\u603b\u6570 " + profile.expectedTotal : ""),
    {
      type: "bookmarked_scan_started",
      expectedTotal: profile.expectedTotal,
      uid: profile.uid || profile.secUid,
    },
  );
  return state;
}

async function waitForBookmarkedPageSlot() {
  const waitMs = Math.max(0, BOOKMARKED_PAGE_MIN_INTERVAL_MS - (Date.now() - lastBookmarkedPageRequestAt));
  if (waitMs > 0) await waitTracked("list_throttle_wait", waitMs, { scope: "bookmarked" });
}

async function requestBookmarkedPageWithRetry(state) {
  const preview = state.page === 0 && String(state.cursor ?? 0) === "0"
    ? cachedBookmarkedFirstPage()
    : null;
  if (preview) {
    recordStage("bookmarked_first_page_cache", 0, {
      ok: true,
      total: Number(preview.total || 0),
      items: preview.awemeList.length,
    });
    return preview;
  }
  let lastError = null;
  for (let attempt = 1; attempt <= BOOKMARKED_PAGE_MAX_RETRIES; attempt += 1) {
    try {
      while (navigator.onLine === false) {
        await sleep(1000);
      }
      await waitForBookmarkedPageSlot();
      lastBookmarkedPageRequestAt = Date.now();
      const page = await timedStage("list_api", () => sendPageRequest("FETCH_BOOKMARKED_PAGE", {
        cursor: state.cursor,
        count: BOOKMARKED_PAGE_SIZE,
      }, 60000), { scope: "bookmarked", page: state.page + 1, attempt });
      if (!page?.ok || !Array.isArray(page.awemeList)) {
        throw new Error(resultError(page));
      }
      advanceBookmarkedScanState(state, page, 0);
      return page;
    } catch (error) {
      lastError = error;
      if (attempt >= BOOKMARKED_PAGE_MAX_RETRIES) break;
      const delayMs = bookmarkedRetryDelayMs(attempt);
      logLine(
        "\u6536\u85cf\u5217\u8868\u7b2c " + (state.page + 1) + " \u9875\u8bf7\u6c42\u5931\u8d25\uff0c"
          + Math.round(delayMs / 1000) + " \u79d2\u540e\u91cd\u8bd5\uff08" + attempt + "/" + BOOKMARKED_PAGE_MAX_RETRIES + "\uff09\uff1a"
          + (error?.message || String(error)),
        {
          type: "bookmarked_page_retry",
          page: state.page + 1,
          attempt,
          cursor: state.cursor,
          error: error?.message || String(error),
        },
      );
      await waitTracked("list_retry_wait", delayMs, { scope: "bookmarked", attempt });
    }
  }
  throw new Error(
    "\u6536\u85cf\u5217\u8868\u7b2c " + (state.page + 1) + " \u9875\u8fde\u7eed\u5931\u8d25 "
      + BOOKMARKED_PAGE_MAX_RETRIES + " \u6b21\uff0c\u6e38\u6807 cursor=" + state.cursor + "\uff1a"
      + (lastError?.message || String(lastError)),
  );
}

async function scanNextBookmarkedPage(scanState) {
  const page = await requestBookmarkedPageWithRetry(scanState);
  const existingItems = await getAll("items");
  const normalized = normalizeBookmarkedPageItems(page.awemeList, existingItems, scanState.seenIds);
  if (normalized.items.length) await putItems(normalized.items);
  const nextState = advanceBookmarkedScanState(scanState, page, normalized.items.length);
  if (page.hasTotal || Number(page.total || 0) > 0) {
    remoteProfileSummary = {
      ...remoteProfileSummary,
      bookmarkedTotal: Number(page.total || 0),
      bookmarkedTotalSource: "listcollection",
    };
    scheduleRender();
  }
  await Promise.all([
    setConfig("bookmarkedSyncCursor", nextState.cursor),
    setConfig("bookmarkedSyncHasMore", nextState.hasMore),
    setConfig("bookmarkedSyncChecked", nextState.checked),
    setConfig("bookmarkedSyncExpectedTotal", nextState.expectedTotal),
    setConfig("bookmarkedSyncUpdatedAt", new Date().toISOString()),
  ]);
  logLine(
    "\u68c0\u67e5\u6536\u85cf\u5217\u8868\uff1a\u7b2c " + nextState.page + " \u9875\uff0c\u672c\u9875 "
      + page.awemeList.length + " \u6761\uff0c\u53ef\u4e0b\u8f7d\u4f5c\u54c1 " + normalized.items.length
      + " \u6761\uff0c\u7d2f\u8ba1\u68c0\u67e5\u5230 " + nextState.checked
      + (nextState.expectedTotal ? "/" + nextState.expectedTotal : "")
      + (normalized.imageItems ? "\uff0c\u56fe\u6587 " + normalized.imageItems : "")
      + (normalized.multiVideoItems ? "\uff0c\u591a\u6bb5\u89c6\u9891 " + normalized.multiVideoItems : "")
      + (normalized.skippedUnsupported ? "\uff0c\u8df3\u8fc7\u4e0d\u652f\u6301 " + normalized.skippedUnsupported : ""),
    {
      type: "bookmarked_page_checked",
      page: nextState.page,
      pageItems: page.awemeList.length,
      videoItems: normalized.items.length,
      mediaItems: normalized.items.length,
      imageItems: normalized.imageItems,
      multiVideoItems: normalized.multiVideoItems,
      skippedUnsupported: normalized.skippedUnsupported,
      checked: nextState.checked,
      expectedTotal: nextState.expectedTotal,
      skippedImages: normalized.skippedImages,
      skippedDuplicates: normalized.skippedDuplicates,
      cursor: nextState.cursor,
      hasMore: nextState.hasMore,
      finished: nextState.finished,
      fullScan: nextState.fullScan,
    },
  );
  return {
    state: nextState,
    items: normalized.items,
  };
}

function shouldUseSegmentedDownload(item) {
  const parts = Array.isArray(item?.mediaParts) ? item.mediaParts : [];
  return parts.some((part) => part.kind === "image")
    || parts.filter((part) => part.kind === "video").length > 1;
}

function imageExtension(url) {
  try {
    const extension = new URL(url).pathname.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]?.toLowerCase();
    if (extension === "jpeg") return "jpg";
    if (["jpg", "png", "webp", "gif", "avif", "heic"].includes(extension)) return extension;
  } catch {}
  return "jpg";
}

function mediaPartPath(sourceFolder, base, part, total) {
  const width = Math.max(2, String(Math.max(1, total)).length);
  const order = String(Number(part.order || 1)).padStart(width, "0");
  if (part.kind === "image") {
    return `${sourceFolder}/图片/${base}/${order}.${imageExtension(part.url)}`;
  }
  return `${sourceFolder}/视频/${base}/${order}.mp4`;
}

function mediaPartCandidates(part, preferBestQuality) {
  const ranked = Array.isArray(part?.candidates) ? part.candidates.filter((entry) => entry?.url) : [];
  const fallback = part?.fallbackCandidate?.url ? part.fallbackCandidate : null;
  const ordered = preferBestQuality
    ? [...ranked, fallback]
    : [fallback || ranked[0]];
  return ordered
    .filter((entry) => entry?.url)
    .filter((entry, index, list) => list.findIndex((other) => other.url === entry.url) === index)
    .slice(0, preferBestQuality ? 4 : 1);
}

function mediaPartsNeedDetail(parts, config) {
  if (!parts.length) return true;
  if (!config.downloadPreferBestQuality) return false;
  return parts
    .filter((part) => part.kind === "video")
    .some((part) => {
      const age = Date.now() - Date.parse(part.candidatesFetchedAt || "");
      return !Array.isArray(part.candidates)
        || !part.candidates.length
        || !Number.isFinite(age)
        || age < 0
        || age > CANDIDATE_CACHE_MAX_AGE_MS;
    });
}

function mergeRefreshedMediaParts(existingParts, refreshedParts) {
  if (!existingParts.length) return refreshedParts;
  if (!refreshedParts.length) return existingParts;
  const refreshedById = new Map(refreshedParts.map((part) => [part.partId, part]));
  const merged = existingParts.map((part) => ({
    ...part,
    ...(refreshedById.get(part.partId) || {}),
  }));
  const known = new Set(merged.map((part) => part.partId));
  for (const part of refreshedParts) {
    if (!known.has(part.partId)) merged.push(part);
  }
  return merged.map((part, index) => ({ ...part, order: index + 1 }));
}

async function saveMediaPartProgress(item, rootHandle, mediaParts, progress) {
  Object.assign(item, {
    mediaType: mediaTypeForParts(mediaParts),
    mediaCount: mediaParts.length,
    mediaParts,
    downloadedMediaParts: progress,
    downloadedPartCount: mediaParts.filter((part) => progress[part.partId]?.status === "downloaded").length,
    downloadStatus: "downloading",
    lastError: "",
  });
  await saveItem(patchItem(item, {
    mediaType: item.mediaType,
    mediaCount: item.mediaCount,
    mediaParts,
    downloadedMediaParts: progress,
    downloadedPartCount: item.downloadedPartCount,
    downloadStatus: "downloading",
    lastError: "",
  }));
  await persistDownloadArtifacts(rootHandle, downloadBatchState);
}

async function downloadVideoPart(item, rootHandle, part, relativePath, config) {
  const candidates = mediaPartCandidates(part, Boolean(config.downloadPreferBestQuality));
  if (!candidates.length) {
    throw new Error(`第 ${part.order} 段视频没有可用候选`);
  }
  const errors = [];
  for (const [index, candidate] of candidates.entries()) {
    downloadBatchState.currentResolution = `第 ${part.order} 段 · ${describeVideoCandidate(candidate)}`;
    updateDownloadBatchProgress();
    const startedAt = timingNow();
    try {
      const result = await downloadVerifiedMedia(
        rootHandle,
        relativePath,
        candidate.url,
        { expected: "video" },
      );
      recordMediaTimings(result, {
        kind: "video",
        awemeId: item.awemeId,
        candidateRank: index + 1,
      });
      logLine(
        `分段视频下载成功：#${item.index} ${item.awemeId} 第 ${part.order} 段 ${describeVideoCandidate(candidate)}`,
        {
          type: "download_media_part_success",
          awemeId: item.awemeId,
          partId: part.partId,
          kind: "video",
          order: part.order,
          candidateRank: index + 1,
          path: relativePath,
          size: result.size || 0,
          quality: candidate,
        },
      );
      return {
        partId: part.partId,
        kind: "video",
        role: part.role || "segment",
        order: part.order,
        status: "downloaded",
        path: relativePath,
        size: Number(result.size || 0),
        contentType: result.contentType || "video/mp4",
        candidateRank: index + 1,
        quality: candidate,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      errors.push(`#${index + 1} ${error?.message || String(error)}`);
      recordStage("video_part_attempt_failed", timingNow() - startedAt, {
        ok: false,
        awemeId: item.awemeId,
        partId: part.partId,
        candidateRank: index + 1,
        error: error?.message || String(error),
      });
      logLine(
        `分段视频候选失败：#${item.index} ${item.awemeId} 第 ${part.order} 段候选 ${index + 1} ${error?.message || String(error)}`,
        {
          type: "download_media_part_candidate_failed",
          awemeId: item.awemeId,
          partId: part.partId,
          order: part.order,
          candidateRank: index + 1,
          error: error?.message || String(error),
        },
      );
    }
  }
  throw new Error(`第 ${part.order} 段视频下载失败：${errors.join(" | ")}`);
}

async function downloadImagePart(item, rootHandle, part, relativePath) {
  const result = await downloadVerifiedMedia(
    rootHandle,
    relativePath,
    part.url,
    { expected: "image" },
  );
  recordMediaTimings(result, {
    kind: "image",
    awemeId: item.awemeId,
  });
  logLine(
    `图文图片下载成功：#${item.index} ${item.awemeId} 第 ${part.order} 张`,
    {
      type: "download_media_part_success",
      awemeId: item.awemeId,
      partId: part.partId,
      kind: "image",
      order: part.order,
      path: relativePath,
      size: result.size || 0,
    },
  );
  return {
    partId: part.partId,
    kind: "image",
    role: part.role || "carousel",
    order: part.order,
    status: "downloaded",
    path: relativePath,
    size: Number(result.size || 0),
    contentType: result.contentType || "image/*",
    width: Number(part.width || 0),
    height: Number(part.height || 0),
    updatedAt: new Date().toISOString(),
  };
}

async function downloadSegmentedMediaItem(item, rootHandle, config) {
  if (rootHandle.kind !== "filesystem") {
    throw new Error("图文和多段视频必须下载到已授权文件夹");
  }
  let detail = null;
  let mediaParts = Array.isArray(item.mediaParts) ? item.mediaParts.filter((part) => part?.url) : [];
  if (mediaPartsNeedDetail(mediaParts, config)) {
    detail = await timedStage(
      "detail_api",
      () => sendPageRequest("FETCH_AWEME_DETAIL", { awemeId: item.awemeId }, 30000),
      { awemeId: item.awemeId, index: item.index, reason: "segmented_media" },
    );
    if (!detail?.ok) throw new Error(`详情获取失败：${resultError(detail)}`);
    mediaParts = mergeRefreshedMediaParts(
      mediaParts,
      extractMediaParts(detail.aweme),
    );
  }
  if (!mediaParts.length) throw new Error("作品详情中没有可下载的图片或视频段");

  item.mediaParts = mediaParts;
  item.mediaType = mediaTypeForParts(mediaParts);
  item.mediaCount = mediaParts.length;
  const progress = { ...(item.downloadedMediaParts || {}) };
  const sourceFolder = getSourceFolder(item.source);
  const base = buildMediaBase(item);

  for (const part of mediaParts) {
    if (downloadPauseRequested) throw createDownloadPausedError();
    if (progress[part.partId]?.status === "downloaded") {
      logLine(`跳过已完成媒体段：#${item.index} ${item.awemeId} ${part.partId}`, {
        type: "download_media_part_skipped",
        awemeId: item.awemeId,
        partId: part.partId,
        path: progress[part.partId].path || "",
      });
      continue;
    }
    const relativePath = mediaPartPath(sourceFolder, base, part, mediaParts.length);
    const record = part.kind === "image"
      ? await downloadImagePart(item, rootHandle, part, relativePath)
      : await downloadVideoPart(item, rootHandle, part, relativePath, config);
    progress[part.partId] = record;
    await saveMediaPartProgress(item, rootHandle, mediaParts, progress);
  }

  let coverPath = progress.cover?.path || "";
  const hasContentImages = mediaParts.some((part) => part.kind === "image");
  if (config.downloadCovers && item.coverUrl && !hasContentImages && !coverPath) {
    coverPath = `${sourceFolder}/封面/${base}.jpg`;
    const coverResult = await downloadVerifiedMedia(
      rootHandle,
      coverPath,
      item.coverUrl,
      { expected: "image" },
    );
    recordMediaTimings(coverResult, { kind: "cover", awemeId: item.awemeId });
    progress.cover = {
      partId: "cover",
      kind: "image",
      role: "cover",
      order: mediaParts.length + 1,
      status: "downloaded",
      path: coverPath,
      size: Number(coverResult.size || 0),
      contentType: coverResult.contentType || "image/*",
      updatedAt: new Date().toISOString(),
    };
    await saveMediaPartProgress(item, rootHandle, mediaParts, progress);
  }

  const completedParts = mediaParts.map((part) => progress[part.partId]).filter(Boolean);
  if (completedParts.length !== mediaParts.length) {
    throw new Error(`媒体分段未全部完成：${completedParts.length}/${mediaParts.length}`);
  }
  const videoRecords = completedParts.filter((part) => part.kind === "video");
  const imageRecords = completedParts.filter((part) => part.kind === "image");
  const mediaPaths = completedParts.map((part) => part.path);
  const firstVideo = videoRecords[0] || null;
  const firstQuality = firstVideo?.quality || null;
  const qualityLabel = [
    videoRecords.length ? `${videoRecords.length} 段视频` : "",
    imageRecords.length ? `${imageRecords.length} 张图片` : "",
  ].filter(Boolean).join(" + ");
  const manifestPath = `data/.appdata/manifests/${base}.json`;
  const manifest = {
    awemeId: item.awemeId,
    index: item.index,
    source: item.source,
    status: item.status,
    mediaType: mediaTypeForParts(mediaParts),
    mediaCount: mediaParts.length,
    desc: detail?.desc || item.desc || "",
    authorName: detail?.authorName || item.authorName || "",
    authorUid: detail?.authorUid || item.authorUid || "",
    createTime: detail?.createTime || item.createTime || 0,
    url: item.url,
    downloadedAt: new Date().toISOString(),
    parts: completedParts,
    files: {
      media: mediaPaths,
      videos: videoRecords.map((part) => part.path),
      images: imageRecords.map((part) => part.path),
      cover: coverPath || null,
    },
  };
  await timedStage(
    "manifest_write",
    () => writeFile(rootHandle, manifestPath, JSON.stringify(manifest, null, 2) + "\n"),
    { awemeId: item.awemeId, mediaType: manifest.mediaType },
  );

  Object.assign(item, {
    mediaType: manifest.mediaType,
    mediaCount: mediaParts.length,
    mediaParts,
    downloadedMediaParts: progress,
    downloadedPartCount: mediaParts.length,
    downloadMediaPaths: mediaPaths,
    downloadImagePaths: imageRecords.map((part) => part.path),
    downloadStatus: "downloaded",
    downloadQualityLabel: qualityLabel,
    downloadWidth: firstQuality?.width || 0,
    downloadHeight: firstQuality?.height || 0,
    downloadBitrate: firstQuality?.bitrate || 0,
    downloadCodec: firstQuality?.codec || "",
    downloadFps: firstQuality?.fps || 0,
    downloadCandidateRank: firstVideo?.candidateRank || 0,
    downloadSize: completedParts.reduce((sum, part) => sum + Number(part.size || 0), 0),
    downloadVideoPath: firstVideo?.path || "",
    downloadCoverPath: coverPath,
    authorUid: detail?.authorUid || item.authorUid || "",
    authorName: detail?.authorName || item.authorName || "",
    createTime: detail?.createTime || item.createTime || 0,
    lastError: "",
  });
  await saveItem(patchItem(item, {}));
  logLine(`分段作品下载成功：#${item.index} ${item.awemeId} ${qualityLabel}`, {
    type: "download_segmented_success",
    awemeId: item.awemeId,
    index: item.index,
    mediaType: item.mediaType,
    mediaCount: item.mediaCount,
    videoCount: videoRecords.length,
    imageCount: imageRecords.length,
    paths: mediaPaths,
  });
}

async function downloadOne(item, rootHandle, config) {

  downloadBatchState.inspected = Math.max(downloadBatchState.inspected, downloadBatchState.currentOrder || 0);
  downloadBatchState.currentIndex = item.index;
  downloadBatchState.currentAwemeId = item.awemeId;
  downloadBatchState.phase = "下载中";
  await saveItem(patchItem(item, { downloadStatus: "downloading", lastError: "" }));
  logLine("\u5f00\u59cb\u5904\u7406\u4e0b\u8f7d\uff1a#" + item.index + " " + item.awemeId, {
    type: "download_item_started",
    awemeId: item.awemeId,
    index: item.index,
    source: item.source,
    targetKind: rootHandle.kind,
  });
  if (shouldUseSegmentedDownload(item)) {
    await downloadSegmentedMediaItem(item, rootHandle, config);
    return;
  }
  let videoUrl = item.videoUrl || "";
  let coverUrl = item.coverUrl || "";
  let detail = null;
  const candidatesFetchedAt = Date.parse(item.videoCandidatesFetchedAt || "");
  const candidateAgeMs = Date.now() - candidatesFetchedAt;
  const cachedCandidatesFresh = Array.isArray(item.videoCandidates)
    && item.videoCandidates.length > 0
    && Number.isFinite(candidateAgeMs)
    && candidateAgeMs >= 0
    && candidateAgeMs <= CANDIDATE_CACHE_MAX_AGE_MS;
  let rankedCandidates = cachedCandidatesFresh ? item.videoCandidates.filter((entry) => entry?.url) : [];
  let fallbackCandidate = cachedCandidatesFresh && item.videoFallbackCandidate?.url
    ? item.videoFallbackCandidate
    : null;
  let candidate = config.downloadPreferBestQuality
    ? rankedCandidates[0] || null
    : fallbackCandidate || rankedCandidates[0] || null;
  if (candidate?.url) videoUrl = candidate.url;
  if (cachedCandidatesFresh) {
    recordStage("download_candidates_reused", 0, {
      ok: true,
      awemeId: item.awemeId,
      candidates: rankedCandidates.length,
      ageMs: candidateAgeMs,
    });
    logLine(
      `\u590d\u7528\u5217\u8868\u89c6\u9891\u5019\u9009\uff1a#${item.index} ${item.awemeId} ${rankedCandidates.length} \u4e2a\uff0c\u7701\u7565\u91cd\u590d\u8be6\u60c5\u8bf7\u6c42`,
      {
        type: "download_candidates_reused",
        awemeId: item.awemeId,
        index: item.index,
        candidates: rankedCandidates.length,
        ageMs: candidateAgeMs,
      },
    );
  }

  const needsDetail = !videoUrl
    || (config.downloadPreferBestQuality && !rankedCandidates.length)
    || (config.downloadCovers && !coverUrl);
  if (needsDetail) {
    logLine("\u6b63\u5728\u83b7\u53d6\u4f5c\u54c1\u8be6\u60c5\uff1a#" + item.index + " " + item.awemeId, {
      type: "download_detail_started",
      awemeId: item.awemeId,
      index: item.index,
    });
    detail = await timedStage(
      "detail_api",
      () => sendPageRequest("FETCH_AWEME_DETAIL", { awemeId: item.awemeId }, 30000),
      { awemeId: item.awemeId, index: item.index },
    );
    if (!detail.ok) throw new Error(`详情获取失败：${resultError(detail)}`);
    rankedCandidates = pickVideoCandidates(detail.aweme, {
      preferBestQuality: config.downloadPreferBestQuality,
    });
    fallbackCandidate = pickVideoUrl(detail.aweme, { preferBestQuality: false });
    candidate = config.downloadPreferBestQuality
      ? rankedCandidates[0] || fallbackCandidate
      : fallbackCandidate || rankedCandidates[0] || null;
    videoUrl = candidate?.url || videoUrl;
    coverUrl = detail.coverUrl || coverUrl;
  }
  if (!videoUrl) throw new Error("未找到可下载视频地址");
  if (!candidate) candidate = { url: videoUrl, source: "list" };
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
  let downloadedDirect = false;
  if (rootHandle.kind === "filesystem") {
    const primaryCandidates = rankedCandidates.length
      ? rankedCandidates
      : [{ ...candidate, url: videoUrl }];
    const directCandidates = [...primaryCandidates, fallbackCandidate]
      .filter((entry) => entry?.url)
      .filter((entry, index, list) => list.findIndex((other) => other.url === entry.url) === index);
    const directErrors = [];
    const directLimit = config.downloadPreferBestQuality ? Math.min(directCandidates.length, 4) : 1;
    for (let index = 0; index < directLimit; index += 1) {
      candidate = directCandidates[index];
      videoUrl = candidate.url;
      downloadBatchState.currentResolution = describeVideoCandidate(candidate);
      updateDownloadBatchProgress();
      const attemptStartedAt = timingNow();
      try {
        const result = await downloadVerifiedMedia(
          rootHandle,
          videoPath,
          videoUrl,
          { expected: "video" },
        );
        recordMediaTimings(result, {
          kind: "video",
          awemeId: item.awemeId,
          candidateRank: index + 1,
        });
        videoPrecheck = result.precheck || {
          ok: true,
          contentType: result.contentType || "video/mp4",
          contentLength: result.size || 0,
          sizeLabel: result.size ? (result.size / 1024 / 1024).toFixed(1) + "MB" : "",
        };
        selectedCandidateRank = index + 1;
        downloadedDirect = true;
        logLine(
          "\u89c6\u9891\u4e0b\u8f7d\u5e76\u6821\u9a8c\u901a\u8fc7\uff1a#" + item.index + " " + item.awemeId + " "
            + (videoPrecheck.sizeLabel || "") + " " + describeVideoCandidate(candidate),
          {
            type: "download_stream_validated",
            awemeId: item.awemeId,
            index: item.index,
            candidateRank: selectedCandidateRank,
            contentType: videoPrecheck.contentType || "",
            contentLength: videoPrecheck.contentLength || 0,
            quality: candidate,
          },
        );
        break;
      } catch (error) {
        recordStage("video_attempt_failed", timingNow() - attemptStartedAt, {
          ok: false,
          awemeId: item.awemeId,
          candidateRank: index + 1,
          error: error?.message || String(error),
        });
        directErrors.push("#" + (index + 1) + " " + describeVideoCandidate(candidate) + " " + error.message);
        logLine(
          "\u89c6\u9891\u4e0b\u8f7d\u5019\u9009\u5931\u8d25\uff1a#" + item.index + " " + item.awemeId
            + " \u5019\u9009 " + (index + 1) + " " + describeVideoCandidate(candidate) + " " + error.message,
          {
            type: "download_stream_candidate_failed",
            awemeId: item.awemeId,
            index: item.index,
            candidateRank: index + 1,
            error: error.message,
            quality: candidate,
          },
        );
      }
    }
    if (!downloadedDirect) {
      throw new Error("\u6ca1\u6709\u53ef\u7528\u7684\u89c6\u9891\u5019\u9009\uff1a" + directErrors.join(" | "));
    }
  }
  if (!downloadedDirect) try {
    const selected = await chooseDownloadCandidate(item, rankedCandidates.length ? rankedCandidates : [{ ...candidate, url: videoUrl }], {
      allowFallback: Boolean(config.downloadPreferBestQuality),
    });
    candidate = selected.candidate;
    videoUrl = candidate.url;
    videoPrecheck = selected.precheck;
    selectedCandidateRank = selected.rank;
    if (rootHandle.kind === "filesystem") {
      await downloadVerifiedMedia(
        rootHandle,
        videoPath,
        videoUrl,
        { expected: "video" },
      );
    } else {
      logLine("\u63d0\u4ea4 Chrome \u89c6\u9891\u4e0b\u8f7d\uff1a" + videoPath, {
        type: "download_video_submitted",
        awemeId: item.awemeId,
        path: videoPath,
        targetKind: rootHandle.kind,
      });
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
      await downloadVerifiedMedia(
        rootHandle,
        videoPath,
        videoUrl,
        { expected: "video" },
      );
    } else {
      logLine("\u63d0\u4ea4 Chrome \u56de\u9000\u89c6\u9891\u4e0b\u8f7d\uff1a" + videoPath, {
        type: "download_video_fallback_submitted",
        awemeId: item.awemeId,
        path: videoPath,
        targetKind: rootHandle.kind,
      });
      await downloadUrl(rootHandle, videoPath, videoUrl);
    }
  }

  if (config.downloadCovers && coverUrl) {
    if (rootHandle.kind === "filesystem") {
      const coverResult = await downloadVerifiedMedia(
        rootHandle,
        coverPath,
        coverUrl,
        { expected: "image" },
      );
      recordMediaTimings(coverResult, {
        kind: "cover",
        awemeId: item.awemeId,
      });
    } else {
      await sendPageRequest("PRECHECK_URL", {
        url: coverUrl,
        options: { expected: "image" },
      }, 30000);
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
  await timedStage(
    "manifest_write",
    () => writeFile(rootHandle, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
    { awemeId: item.awemeId },
  );

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

async function runLikedDownloadFlow(rootHandle, config, scopeDef, folderRecord = null, preparationStartedAt = timingNow()) {
  if (rootHandle.kind === "downloads") {
    const uiResult = await sendRuntimeMessage({ type: "SET_DOWNLOAD_UI", enabled: false });
    if (!uiResult?.ok) {
      logLine("\u9690\u85cf\u6d4f\u89c8\u5668\u4e0b\u8f7d\u63d0\u793a\u5931\u8d25\uff1a" + (uiResult?.error || "unknown"));
    }
  }

  let scanState = await startLikedScan();
  const currentUserId = String(scanState.uid || scanState.secUid || "");
  const folderUserId = String(folderRecord?.user?.uid || "");
  if (folderUserId && currentUserId && folderUserId !== currentUserId) {
    throw new Error(
      "\u8be5\u6587\u4ef6\u5939\u5c5e\u4e8e\u53e6\u4e00\u4e2a\u6296\u97f3\u8d26\u53f7"
        + (folderRecord?.user?.nickname ? "\uff1a" + folderRecord.user.nickname : "")
        + "\uff0c\u5df2\u505c\u6b62\u5199\u5165\uff1b\u8bf7\u4e3a\u5f53\u524d\u8d26\u53f7\u9009\u62e9\u65b0\u6587\u4ef6\u5939",
    );
  }
  if (!folderUserId && currentUserId) {
    const index = await getDownloadIndex(rootHandle);
    index.user = { uid: currentUserId, nickname: scanState.nickname || "" };
    await writeDownloadIndex(rootHandle, index);
  }
  const recoveredFromFolder = await recoverDownloadedItemsFromFolderRecord(rootHandle, "liked", folderRecord);
  if (recoveredFromFolder) {
    logLine(
      "\u5df2\u4ece\u6587\u4ef6\u5939\u8bb0\u5f55\u6062\u590d " + recoveredFromFolder + " \u6761\u5df2\u4e0b\u8f7d\u8bb0\u5f55",
      {
        type: "download_recovered_from_folder",
        count: recoveredFromFolder,
      },
    );
  }

  const downloadIndex = await getDownloadIndex(rootHandle);
  const likedFolderIds = downloadIndex.scopes.liked;
  const previouslyDownloaded = Math.max(
    await countDownloadedInScope("liked"),
    likedFolderIds.size,
  );
  const previousFullScanCount = Math.max(0, Number(await getConfig("likedSyncCompletedCount", 0)) || 0);
  const previousFullScanAt = String(await getConfig("likedSyncCompletedAt", "") || "");
  const canStopAtKnownBoundary = Boolean(
    previousFullScanAt
      && previousFullScanCount > 0
      && likedFolderIds.size >= previousFullScanCount,
  );
  logLine(`准备检查完成，耗时 ${((timingNow() - preparationStartedAt) / 1000).toFixed(1)} 秒，开始读取喜欢列表`, {
    type: "download_preparation_finished",
    scope: "liked",
    durationMs: timingNow() - preparationStartedAt,
  });
  downloadBatchState.total = Math.max(scanState.expectedTotal, previouslyDownloaded);
  downloadBatchState.completed = previouslyDownloaded;
  downloadBatchState.sessionCompleted = 0;
  downloadBatchState.inspected = 0;
  downloadBatchState.phase = "\u68c0\u67e5\u559c\u6b22\u5217\u8868";
  setDownloadStatus("\u68c0\u67e5\u4e2d");
  updateDownloadBatchProgress();
  await persistDownloadArtifacts(rootHandle, downloadBatchState);
  logLine(
    "\u5f00\u59cb\u68c0\u67e5\u5e76\u4e0b\u8f7d\u559c\u6b22\u89c6\u9891\uff0c\u5df2\u4e0b\u8f7d\u4f5c\u54c1\u4f1a\u81ea\u52a8\u8df3\u8fc7",
    {
      type: "liked_download_stream_started",
      expectedTotal: scanState.expectedTotal,
      targetKind: rootHandle.kind,
      folderName: rootHandle.label || "",
      preferBestQuality: Boolean(config.downloadPreferBestQuality),
    },
  );

  let downloaded = 0;
  let failed = 0;
  let attempted = 0;
  let pendingFound = 0;
  let consecutiveFailures = 0;
  let stoppedAtKnownBoundary = false;
  while (!scanState.finished && !downloadPauseRequested) {
    downloadBatchState.phase = stoppedAtKnownBoundary ? "核对消失留存" : "\u68c0\u67e5\u559c\u6b22\u5217\u8868";
    setDownloadStatus(stoppedAtKnownBoundary ? "核对留存" : "\u68c0\u67e5\u4e2d");
    updateDownloadBatchProgress();
    const pageResult = await scanNextLikedPage(scanState);
    scanState = pageResult.state;
    downloadBatchState.inspected = scanState.checked;
    downloadBatchState.total = Math.max(downloadBatchState.completed, scanState.expectedTotal, scanState.checked);
    updateDownloadBatchProgress();

    if (scanState.finished && !scanState.fullScan) {
      throw new Error(
        "\u559c\u6b22\u5217\u8868\u6e38\u6807\u5f02\u5e38\u7ed3\u675f\uff1amax=" + scanState.maxCursor
          + "\uff0chas_more=" + scanState.hasMore + "\uff0c\u5df2\u505c\u6b62\u4ee5\u907f\u514d\u8bef\u5224\u4e3a\u4e0b\u8f7d\u5b8c\u6210",
      );
    }
    if (scanState.finished && scanState.expectedTotal > 0 && scanState.rawChecked === 0) {
      throw new Error(
        "\u6296\u97f3\u663e\u793a\u559c\u6b22 " + scanState.expectedTotal
          + " \u6761\uff0c\u4f46\u559c\u6b22\u5217\u8868\u63a5\u53e3\u8fd4\u56de 0 \u6761\uff1b\u53ef\u80fd\u9700\u8981\u9a8c\u8bc1\u7801\u6216\u767b\u5f55\u72b6\u6001\u5df2\u5931\u6548",
      );
    }

    const reconciledPageItems = await reconcilePageItemsWithFolderIds(pageResult.items, likedFolderIds);
    const runnableItems = reconciledPageItems
      .filter((item) => scopeDef.isEligible(item))
      .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
    const reachedKnownBoundary = !stoppedAtKnownBoundary
      && canStopAtKnownBoundary
      && pageResult.items.length > 0
      && pageResult.items.every((item) => likedFolderIds.has(String(item.awemeId || "")))
      && runnableItems.length === 0;
    pendingFound += runnableItems.length;
    for (const item of runnableItems) {
      if (downloadPauseRequested) break;
      attempted += 1;
      downloadBatchState.currentOrder = attempted;
      downloadBatchState.currentIndex = item.index;
      downloadBatchState.currentAwemeId = item.awemeId;
      downloadBatchState.phase = "\u4e0b\u8f7d\u4e2d";
      setDownloadStatus("\u4e0b\u8f7d\u4e2d");
      updateDownloadBatchProgress();
      try {
        await downloadOne(item, rootHandle, config);
        await markDownloadIndexCompleted(rootHandle, "liked", item.awemeId);
        downloaded += 1;
        consecutiveFailures = 0;
        downloadBatchState.sessionCompleted = downloaded;
        downloadBatchState.completed = Math.min(downloadBatchState.total, previouslyDownloaded + downloaded);
      } catch (error) {
        if (isDownloadPausedError(error)) break;
        failed += 1;
        consecutiveFailures += 1;
        await saveItem(patchItem(item, {
          downloadStatus: "failed",
          lastError: "\u4e0b\u8f7d\u5931\u8d25\uff1a" + (error?.message || String(error)),
        }));
        logLine(
          "\u559c\u6b22\u89c6\u9891\u4e0b\u8f7d\u5931\u8d25\uff1a#" + item.index + " " + item.awemeId + " "
            + (error?.message || String(error)),
          {
            type: "download_failed",
            awemeId: item.awemeId,
            index: item.index,
            error: error?.message || String(error),
            scope: "liked",
          },
        );
      }
      await persistDownloadArtifacts(rootHandle, downloadBatchState, { itemCompleted: true });
      updateDownloadBatchProgress();
      scheduleRender();
      if (consecutiveFailures >= 8) {
        throw new Error("\u8fde\u7eed 8 \u4e2a\u89c6\u9891\u4e0b\u8f7d\u5931\u8d25\uff0c\u5df2\u505c\u6b62\u4ee5\u907f\u514d\u7ee7\u7eed\u89e6\u53d1\u9650\u5236");
      }
      await waitTracked("item_delay", randomDelay(config), { scope: "liked" });
    }
    if (reachedKnownBoundary && !downloadPauseRequested) {
      stoppedAtKnownBoundary = true;
      downloadBatchState.phase = "新作品检查完成 · 正在核对消失留存";
      setDownloadStatus("核对留存");
      updateDownloadBatchProgress();
      logLine(
        `已遇到连续 ${pageResult.items.length} 条本地已下载作品；新作品检查完成，继续完整核对已从喜欢列表消失的本地留存`,
        {
          type: "liked_incremental_boundary_reached",
          checked: scanState.checked,
          page: scanState.page,
          boundaryItems: pageResult.items.length,
          expectedTotal: scanState.expectedTotal,
        },
      );
    }
  }

  if (downloadPauseRequested) {
    downloadBatchState.phase = "\u5df2\u6682\u505c";
    await persistDownloadArtifacts(rootHandle, downloadBatchState, { forceFull: true });
    logLine(
      "\u559c\u6b22\u89c6\u9891\u4e0b\u8f7d\u5df2\u6682\u505c\uff1a\u68c0\u67e5\u5230 " + scanState.checked
        + "\uff0c\u672c\u6b21\u4e0b\u8f7d " + downloaded + "\uff0c\u5931\u8d25 " + failed,
      {
        type: "liked_download_paused",
        checked: scanState.checked,
        downloaded,
        failed,
      },
    );
    return;
  }

  let likedArchivedLocal = null;
  if (scanState.fullScan) {
    const { currentLocal, archivedLocal } = reconcileLikedLocalIds(likedFolderIds, scanState.seenIds);
    const counts = await getLocalFolderCounts(rootHandle);
    await saveLocalFolderCounts(rootHandle, {
      ...counts,
      liked: likedFolderIds.size,
      likedCurrent: currentLocal,
      likedArchived: archivedLocal,
      likedReconciledAt: new Date().toISOString(),
    });
    likedArchivedLocal = archivedLocal;
    logLine(
      `喜欢完整核对完成：抖音当前可读取 ${scanState.seenIds.size} 条，本地累计 ${likedFolderIds.size} 条，已从喜欢列表消失但本地仍保留 ${archivedLocal} 条`,
      {
        type: "liked_local_reconciliation_finished",
        remoteProfileTotal: scanState.expectedTotal,
        currentReadable: scanState.seenIds.size,
        localTotal: likedFolderIds.size,
        currentLocal,
        archivedLocal,
      },
    );
  }

  const allItems = await getAll("items");
  const likedItems = allItems.filter((item) => ["liked", "favorite_api"].includes(item.source));
  const alreadyDownloaded = likedItems.filter((item) => item.downloadStatus === "downloaded").length;
  downloadBatchState.phase = "\u5df2\u5b8c\u6210";
  if (scanState.fullScan) {
    await Promise.all([
      setConfig("likedSyncCompletedAt", new Date().toISOString()),
      setConfig("likedSyncCompletedCount", scanState.checked),
    ]);
  }
  await persistDownloadArtifacts(rootHandle, downloadBatchState, { forceFull: true });
  if (!pendingFound) {
    logLine(
      "\u559c\u6b22\u5217\u8868\u83b7\u53d6\u6210\u529f\uff1a\u68c0\u67e5\u5230 " + scanState.checked
        + " \u4e2a\u89c6\u9891\uff0c\u6ca1\u6709\u65b0\u7684\u5f85\u4e0b\u8f7d\u9879\u76ee\uff0c\u672c\u5730\u5df2\u4e0b\u8f7d " + alreadyDownloaded,
      {
        type: "liked_scan_no_new_downloads",
        checked: scanState.checked,
        alreadyDownloaded,
      },
    );
  }
  logLine(
    "\u559c\u6b22\u89c6\u9891\u4efb\u52a1\u5b8c\u6210\uff1a\u68c0\u67e5\u5230 " + scanState.checked
      + "\uff0c\u672c\u6b21\u4e0b\u8f7d " + downloaded + "\uff0c\u5931\u8d25 " + failed
      + "\uff0c\u672c\u5730\u5df2\u4e0b\u8f7d " + alreadyDownloaded,
    {
      type: "liked_download_stream_finished",
      checked: scanState.checked,
      rawChecked: scanState.rawChecked,
      downloaded,
      failed,
      alreadyDownloaded,
      expectedTotal: scanState.expectedTotal,
      pages: scanState.page,
      incrementalBoundary: stoppedAtKnownBoundary,
      likedArchivedLocal,
    },
  );
}


async function runBookmarkedDownloadFlow(rootHandle, config, scopeDef, folderRecord = null, preparationStartedAt = timingNow()) {
  let scanState = await startBookmarkedScan();
  const currentUserId = String(scanState.uid || scanState.secUid || "");
  const folderUserId = String(folderRecord?.user?.uid || "");
  if (folderUserId && currentUserId && folderUserId !== currentUserId) {
    throw new Error(
      "\u8be5\u6587\u4ef6\u5939\u5c5e\u4e8e\u53e6\u4e00\u4e2a\u6296\u97f3\u8d26\u53f7"
        + (folderRecord?.user?.nickname ? "\uff1a" + folderRecord.user.nickname : "")
        + "\uff0c\u5df2\u505c\u6b62\u5199\u5165\uff1b\u8bf7\u4e3a\u5f53\u524d\u8d26\u53f7\u9009\u62e9\u65b0\u6587\u4ef6\u5939",
    );
  }
  if (!folderUserId && currentUserId) {
    const index = await getDownloadIndex(rootHandle);
    index.user = { uid: currentUserId, nickname: scanState.nickname || "" };
    await writeDownloadIndex(rootHandle, index);
  }
  const recoveredFromFolder = await recoverDownloadedItemsFromFolderRecord(rootHandle, "bookmarked", folderRecord);
  if (recoveredFromFolder) {
    logLine(
      "\u5df2\u4ece\u6587\u4ef6\u5939\u8bb0\u5f55\u6062\u590d " + recoveredFromFolder + " \u6761\u6536\u85cf\u89c6\u9891\u5df2\u4e0b\u8f7d\u8bb0\u5f55",
      {
        type: "download_recovered_from_folder",
        scope: "bookmarked",
        count: recoveredFromFolder,
      },
    );
  }

  const downloadIndex = await getDownloadIndex(rootHandle);
  const bookmarkedFolderIds = downloadIndex.scopes.bookmarked;
  const previouslyDownloaded = Math.max(
    await countDownloadedInScope("bookmarked"),
    bookmarkedFolderIds.size,
  );
  logLine(`准备检查完成，耗时 ${((timingNow() - preparationStartedAt) / 1000).toFixed(1)} 秒，开始读取收藏列表`, {
    type: "download_preparation_finished",
    scope: "bookmarked",
    durationMs: timingNow() - preparationStartedAt,
  });
  downloadBatchState.total = Math.max(scanState.expectedTotal, previouslyDownloaded);
  downloadBatchState.completed = previouslyDownloaded;
  downloadBatchState.sessionCompleted = 0;
  downloadBatchState.inspected = 0;
  downloadBatchState.phase = "\u68c0\u67e5\u6536\u85cf\u5217\u8868";
  setDownloadStatus("\u68c0\u67e5\u4e2d");
  updateDownloadBatchProgress();
  await persistDownloadArtifacts(rootHandle, downloadBatchState);
  logLine(
    "\u5f00\u59cb\u68c0\u67e5\u5e76\u4e0b\u8f7d\u6536\u85cf\u89c6\u9891\uff0c\u5df2\u4e0b\u8f7d\u4f5c\u54c1\u4f1a\u81ea\u52a8\u8df3\u8fc7",
    {
      type: "bookmarked_download_stream_started",
      expectedTotal: scanState.expectedTotal,
      targetKind: rootHandle.kind,
      folderName: rootHandle.label || "",
      preferBestQuality: Boolean(config.downloadPreferBestQuality),
    },
  );

  let downloaded = 0;
  let failed = 0;
  let attempted = 0;
  let pendingFound = 0;
  let consecutiveFailures = 0;
  while (!scanState.finished && !downloadPauseRequested) {
    downloadBatchState.phase = "\u68c0\u67e5\u6536\u85cf\u5217\u8868";
    setDownloadStatus("\u68c0\u67e5\u4e2d");
    updateDownloadBatchProgress();
    const pageResult = await scanNextBookmarkedPage(scanState);
    scanState = pageResult.state;
    downloadBatchState.inspected = scanState.checked;
    downloadBatchState.total = Math.max(downloadBatchState.completed, scanState.expectedTotal, scanState.checked);
    updateDownloadBatchProgress();

    if (scanState.finished && !scanState.fullScan) {
      throw new Error(
        "\u6536\u85cf\u5217\u8868\u6e38\u6807\u5f02\u5e38\u7ed3\u675f\uff1acursor=" + scanState.cursor
          + "\uff0chas_more=" + scanState.hasMore + "\uff0c\u5df2\u505c\u6b62\u4ee5\u907f\u514d\u8bef\u5224\u4e3a\u4e0b\u8f7d\u5b8c\u6210",
      );
    }
    if (scanState.finished && scanState.expectedTotal > 0 && scanState.rawChecked === 0) {
      throw new Error(
        "\u6296\u97f3\u663e\u793a\u6536\u85cf " + scanState.expectedTotal
          + " \u6761\uff0c\u4f46\u6536\u85cf\u5217\u8868\u63a5\u53e3\u8fd4\u56de 0 \u6761\uff1b\u53ef\u80fd\u9700\u8981\u9a8c\u8bc1\u7801\u6216\u767b\u5f55\u72b6\u6001\u5df2\u5931\u6548",
      );
    }

    const reconciledPageItems = await reconcilePageItemsWithFolderIds(pageResult.items, bookmarkedFolderIds);
    const runnableItems = reconciledPageItems
      .filter((item) => scopeDef.isEligible(item))
      .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
    pendingFound += runnableItems.length;
    for (const item of runnableItems) {
      if (downloadPauseRequested) break;
      attempted += 1;
      downloadBatchState.currentOrder = attempted;
      downloadBatchState.currentIndex = item.index;
      downloadBatchState.currentAwemeId = item.awemeId;
      downloadBatchState.phase = "\u4e0b\u8f7d\u4e2d";
      setDownloadStatus("\u4e0b\u8f7d\u4e2d");
      updateDownloadBatchProgress();
      try {
        await downloadOne(item, rootHandle, config);
        await markDownloadIndexCompleted(rootHandle, "bookmarked", item.awemeId);
        downloaded += 1;
        consecutiveFailures = 0;
        downloadBatchState.sessionCompleted = downloaded;
        downloadBatchState.completed = Math.min(downloadBatchState.total, previouslyDownloaded + downloaded);
      } catch (error) {
        if (isDownloadPausedError(error)) break;
        failed += 1;
        consecutiveFailures += 1;
        await saveItem(patchItem(item, {
          downloadStatus: "failed",
          lastError: "\u4e0b\u8f7d\u5931\u8d25\uff1a" + (error?.message || String(error)),
        }));
        logLine(
          "\u6536\u85cf\u89c6\u9891\u4e0b\u8f7d\u5931\u8d25\uff1a#" + item.index + " " + item.awemeId + " "
            + (error?.message || String(error)),
          {
            type: "download_failed",
            awemeId: item.awemeId,
            index: item.index,
            error: error?.message || String(error),
            scope: "bookmarked",
          },
        );
      }
      await persistDownloadArtifacts(rootHandle, downloadBatchState, { itemCompleted: true });
      updateDownloadBatchProgress();
      scheduleRender();
      if (consecutiveFailures >= 8) {
        throw new Error("\u8fde\u7eed 8 \u4e2a\u6536\u85cf\u89c6\u9891\u4e0b\u8f7d\u5931\u8d25\uff0c\u5df2\u505c\u6b62\u4ee5\u907f\u514d\u7ee7\u7eed\u89e6\u53d1\u9650\u5236");
      }
      await waitTracked("item_delay", randomDelay(config), { scope: "bookmarked" });
    }
  }

  if (downloadPauseRequested) {
    downloadBatchState.phase = "\u5df2\u6682\u505c";
    await persistDownloadArtifacts(rootHandle, downloadBatchState, { forceFull: true });
    logLine(
      "\u6536\u85cf\u89c6\u9891\u4e0b\u8f7d\u5df2\u6682\u505c\uff1a\u68c0\u67e5\u5230 " + scanState.checked
        + "\uff0c\u672c\u6b21\u4e0b\u8f7d " + downloaded + "\uff0c\u5931\u8d25 " + failed,
      {
        type: "bookmarked_download_paused",
        checked: scanState.checked,
        downloaded,
        failed,
      },
    );
    return;
  }

  const allItems = await getAll("items");
  const bookmarkedItems = allItems.filter((item) => item.source === "bookmarked");
  const alreadyDownloaded = bookmarkedItems.filter((item) => item.downloadStatus === "downloaded").length;
  downloadBatchState.phase = "\u5df2\u5b8c\u6210";
  await Promise.all([
    setConfig("bookmarkedSyncCompletedAt", new Date().toISOString()),
    setConfig("bookmarkedSyncCompletedCount", scanState.checked),
  ]);
  await persistDownloadArtifacts(rootHandle, downloadBatchState, { forceFull: true });
  if (!pendingFound) {
    logLine(
      "\u6536\u85cf\u5217\u8868\u83b7\u53d6\u6210\u529f\uff1a\u68c0\u67e5\u5230 " + scanState.checked
        + " \u4e2a\u89c6\u9891\uff0c\u6ca1\u6709\u65b0\u7684\u5f85\u4e0b\u8f7d\u9879\u76ee\uff0c\u672c\u5730\u5df2\u4e0b\u8f7d " + alreadyDownloaded,
      {
        type: "bookmarked_scan_no_new_downloads",
        checked: scanState.checked,
        alreadyDownloaded,
      },
    );
  }
  logLine(
    "\u6536\u85cf\u89c6\u9891\u4efb\u52a1\u5b8c\u6210\uff1a\u68c0\u67e5\u5230 " + scanState.checked
      + "\uff0c\u672c\u6b21\u4e0b\u8f7d " + downloaded + "\uff0c\u5931\u8d25 " + failed
      + "\uff0c\u672c\u5730\u5df2\u4e0b\u8f7d " + alreadyDownloaded,
    {
      type: "bookmarked_download_stream_finished",
      checked: scanState.checked,
      rawChecked: scanState.rawChecked,
      downloaded,
      failed,
      alreadyDownloaded,
      expectedTotal: scanState.expectedTotal,
      pages: scanState.page,
    },
  );
}

async function syncFollowingAuthorWorks(authors, selectedAuthorUids) {
  const selected = new Set((selectedAuthorUids || []).map(String));
  const targets = (authors || []).filter((author) => selected.has(String(author.uid || "")));
  if (!targets.length) throw new Error("请先展开“关注作者范围”，刷新列表并至少勾选一位作者");
  const existingItems = await getAll("items");
  const existingById = new Map(
    existingItems
      .filter((item) => item.source === "following")
      .map((item) => [String(item.awemeId || ""), item]),
  );
  let nextIndex = existingItems.reduce((max, item) => Math.max(max, Number(item.index ?? -1)), -1) + 1;
  let synced = 0;
  for (let authorOrder = 0; authorOrder < targets.length; authorOrder += 1) {
    const author = targets[authorOrder];
    let maxCursor = 0;
    let pageNumber = 0;
    for (;;) {
      if (downloadPauseRequested) return synced;
      downloadBatchState.phase = `同步作者 ${authorOrder + 1}/${targets.length} · ${author.nickname}`;
      setDownloadStatus("同步作品");
      updateDownloadBatchProgress();
      const page = await sendPageRequest("FETCH_AUTHOR_AWEME_PAGE", {
        secUid: author.secUid,
        maxCursor,
        count: 18,
      }, 60000);
      if (!page?.ok || !Array.isArray(page.awemeList)) {
        throw new Error(`读取作者“${author.nickname}”作品失败：${resultError(page)}`);
      }
      pageNumber += 1;
      const pageItems = [];
      for (const aweme of page.awemeList) {
        const normalized = normalizeAweme(aweme, nextIndex, "following");
        if (!normalized.awemeId || !normalized.mediaParts?.length) continue;
        const existing = existingById.get(String(normalized.awemeId));
        const item = {
          ...(existing || {}),
          ...normalized,
          index: existing?.index ?? nextIndex,
          source: "following",
          authorUid: String(author.uid),
          authorName: author.nickname || normalized.authorName || "未命名作者",
          downloadStatus: existing?.downloadStatus || "not_started",
          downloadedMediaParts: existing?.downloadedMediaParts || {},
          downloadMediaPaths: existing?.downloadMediaPaths || [],
          downloadImagePaths: existing?.downloadImagePaths || [],
          downloadVideoPath: existing?.downloadVideoPath || "",
          downloadCoverPath: existing?.downloadCoverPath || "",
          lastError: existing?.lastError || "",
        };
        if (!existing) nextIndex += 1;
        existingById.set(String(item.awemeId), item);
        pageItems.push(item);
      }
      if (pageItems.length) await putItems(pageItems);
      synced += pageItems.length;
      logLine(`同步作者作品：${author.nickname} 第 ${pageNumber} 页，本页 ${pageItems.length} 条`, {
        type: "following_author_page_checked",
        authorUid: author.uid,
        page: pageNumber,
        count: pageItems.length,
      });
      const nextCursor = page.maxCursor ?? 0;
      if (!page.hasMore || !page.awemeList.length || String(nextCursor) === "0") break;
      if (String(nextCursor) === String(maxCursor)) throw new Error(`作者“${author.nickname}”作品游标没有前进`);
      maxCursor = nextCursor;
      await waitTracked("following_author_page_wait", 1200, { authorUid: author.uid, page: pageNumber });
    }
  }
  return synced;
}

function setOneClickStatus(text) {
  $("oneClickMeta").textContent = text;
}

async function likeSharedConversationWorks() {
  setOneClickStatus(`正在读取私信“${SHARED_CONVERSATION_NAME}”的分享记录…`);
  const scan = await sendPageRequest("SCAN_SHARED_CONVERSATION", {
    targetName: SHARED_CONVERSATION_NAME,
    maxPages: 200,
    likeMissing: true,
  }, 1_800_000);
  if (!scan?.ok || !Array.isArray(scan.awemeIds)) {
    throw new Error(scan?.error || `读取“${SHARED_CONVERSATION_NAME}”私信失败`);
  }
  const storedBinding = await getConfig("sharedConversationBinding", null);
  if (storedBinding?.conversationKey && scan.conversationKey && storedBinding.conversationKey !== scan.conversationKey) {
    throw new Error(`私信“${SHARED_CONVERSATION_NAME}”的账号标识与上次不同，已停止以避免处理同名用户`);
  }
  if (scan.conversationKey && !storedBinding?.conversationKey) {
    await setConfig("sharedConversationBinding", {
      name: SHARED_CONVERSATION_NAME,
      conversationKey: scan.conversationKey,
      boundAt: new Date().toISOString(),
    });
  }
  const ids = [...new Set(scan.awemeIds.map(String).filter((id) => /^\d{16,22}$/.test(id)))];
  if (!ids.length) {
    const diagnostics = scan.diagnostics || {};
    throw new Error(
      `已打开“${SHARED_CONVERSATION_NAME}”，但没有识别到分享作品（发现卡片 ${scan.processedCards || 0}，卡片打开失败 ${scan.cardFailures || 0}，消息节点 ${diagnostics.childCount || 0}，滚动高度 ${diagnostics.scrollHeight || 0}）。已停止，未进入后续下载`,
    );
  }
  const liked = Math.max(0, Number(scan.liked || 0));
  const alreadyLiked = Math.max(0, Number(scan.alreadyLiked || 0));
  const inaccessible = Math.max(0, Number(scan.cardFailures || 0));
  if (inaccessible > 0) {
    throw new Error(`有 ${inaccessible} 条分享未能打开或读取，当前扫描未完整完成；已停止后续下载`);
  }
  if (!scan.reachedHistoryStart) {
    throw new Error("私信历史尚未扫描到底，当前扫描未完整完成；已停止后续下载");
  }
  if (Number(scan.unknownLikeState || 0) > 0) {
    throw new Error(`有 ${scan.unknownLikeState} 条分享无法确认点赞状态，已停止以避免误取消点赞`);
  }
  logLine(`私信分享处理完成：发现 ${ids.length}，新增喜欢 ${liked}，已喜欢 ${alreadyLiked}，不可访问 ${inaccessible}`, {
    type: "shared_conversation_liked",
    targetName: SHARED_CONVERSATION_NAME,
    found: ids.length,
    liked,
    alreadyLiked,
    inaccessible,
    reachedHistoryStart: Boolean(scan.reachedHistoryStart),
  });
  return { found: ids.length, liked, alreadyLiked, inaccessible };
}

async function runOneClickBackup() {
  if (oneClickRunning || downloadRunning || running) return;
  const selectedAuthors = await getSelectedFollowingAuthors();
  if (!selectedAuthors.length) {
    $("followingOptionsPanel").open = true;
    setOneClickStatus("请先在“关注作者范围”中至少选择一位作者");
    return;
  }
  oneClickRunning = true;
  updateButtons();
  try {
    const shared = await likeSharedConversationWorks();
    setOneClickStatus(
      `分享扫描完成：发现 ${shared.found} · 新增喜欢 ${shared.liked} · 已喜欢 ${shared.alreadyLiked} · 不可访问 ${shared.inaccessible}，开始下载喜欢…`,
    );
    await runDownloadBatch("liked");
    if (String(downloadBatchState.phase).startsWith("异常") || downloadBatchState.phase === "已暂停") {
      throw new Error(`喜欢下载未完成：${downloadBatchState.phase}`);
    }
    setOneClickStatus("喜欢下载完成，开始下载收藏…");
    await runDownloadBatch("bookmarked");
    if (String(downloadBatchState.phase).startsWith("异常") || downloadBatchState.phase === "已暂停") {
      throw new Error(`收藏下载未完成：${downloadBatchState.phase}`);
    }
    setOneClickStatus("收藏下载完成，开始下载所选关注作者…");
    await runDownloadBatch("following");
    if (String(downloadBatchState.phase).startsWith("异常") || downloadBatchState.phase === "已暂停") {
      throw new Error(`关注作者下载未完成：${downloadBatchState.phase}`);
    }
    setOneClickStatus(
      `一键备份完成 · 私信发现 ${shared.found} · 新增喜欢 ${shared.liked} · 已喜欢 ${shared.alreadyLiked} · 不可访问 ${shared.inaccessible}`,
    );
  } catch (error) {
    const message = error?.message || String(error);
    setOneClickStatus(`一键备份停止：${message}`);
    setGlobalStatus("一键备份异常");
    logLine(`一键备份异常：${message}`, { type: "one_click_backup_failed", error: message });
  } finally {
    oneClickRunning = false;
    updateButtons();
  }
}


async function runDownloadBatch(scope = "liked") {
  if (downloadRunning) return;
  downloadRunning = true;
  downloadPauseRequested = false;
  currentDownloadScope = scope;
  activePerformanceTracker = createPerformanceTracker(scope);
  lastPerformanceSummary = null;
  activeDownloadTarget = null;
  setView("download");
  const scopeDef = getDownloadScopeDefinition(scope);
  downloadBatchState = {
    total: 0,
    completed: 0,
    sessionCompleted: 0,
    inspected: 0,
    currentOrder: 0,
    currentIndex: null,
    currentAwemeId: "",
    phase: "准备下载",
    scope,
  };
  updateButtons();
  setGlobalStatus("下载中");
  setDownloadStatus("准备下载");
  updateDownloadBatchProgress();
  logLine(scopeDef.startText, { type: "download_scope_start", scope: scopeDef.key });
  const preparationStartedAt = timingNow();
  let preparationLabel = "读取设置";
  const updatePreparationStatus = () => {
    if (!String(downloadBatchState.phase).startsWith("准备")) return false;
    const elapsed = ((timingNow() - preparationStartedAt) / 1000).toFixed(1);
    downloadBatchState.phase = `准备 · ${preparationLabel} · ${elapsed}s`;
    setDownloadStatus(downloadBatchState.phase);
    updateDownloadBatchProgress();
    return true;
  };
  const markPreparation = (label) => {
    preparationLabel = label;
    updatePreparationStatus();
  };
  const preparationTimer = setInterval(() => {
    if (!updatePreparationStatus()) clearInterval(preparationTimer);
  }, 1000);
  try {
    markPreparation("保存设置");
    await saveCurrentConfig();
    await setConfig("lastDownloadScope", scope);
    const config = await loadConfig();
    markPreparation("连接下载文件夹");
    const rootHandle = await timedStage(
      "folder_resolve",
      () => chooseDownloadTarget({
        preferBrowserDownloads: false,
        preferSavedFolder: true,
      }),
      { scope },
    );
    activeDownloadTarget = rootHandle;
    if (rootHandle.kind !== "filesystem") {
      throw new Error("未找到可用的已授权文件夹。请先点击“选择文件夹”，后续下载才不会出现在浏览器下载记录里。");
    }
    markPreparation("读取本地作品索引");
    let localIndex = await getDownloadIndex(rootHandle);
    const indexedTotal = [...Object.values(localIndex.scopes)].reduce((sum, ids) => sum + ids.size, 0);
    if (!indexedTotal) {
      const resetCount = await resetDownloadStateForFreshFolder();
      logLine(`当前目录是新下载库${resetCount ? `，已清除浏览器中的 ${resetCount} 条旧目录下载标记` : ""}`, {
        type: "download_folder_fresh_start",
        folderName: rootHandle.label || "",
        resetCount,
      });
    }
    markPreparation("校验文件夹账号绑定");
    localIndex = await bindFolderToCurrentAccount(rootHandle, localIndex);
    const folderRecord = { user: localIndex.user || {}, items: [] };
    markPreparation("创建每日轻量备份");
    const backedUp = await ensureDailyLightweightBackup(rootHandle, localIndex, downloadBatchState);
    if (backedUp) {
      logLine(`已创建 ${localDateKey()} 轻量数据库备份`, {
        type: "daily_lightweight_backup_created",
        folderName: rootHandle.label || "",
      });
    }
    if (scope === "liked") preparationLabel = "复用登录状态并初始化喜欢列表";
    if (scope === "liked") {
      await runLikedDownloadFlow(rootHandle, config, scopeDef, folderRecord, preparationStartedAt);
      return;
    }
    if (scope === "bookmarked") preparationLabel = "复用登录状态并初始化收藏列表";
    if (scope === "bookmarked") {
      await runBookmarkedDownloadFlow(rootHandle, config, scopeDef, folderRecord, preparationStartedAt);
      return;
    }

    markPreparation("读取关注作者选择");
    let selectedFollowingAuthors = scope === "following" ? await getSelectedFollowingAuthors() : [];
    if (scope === "following") {
      markPreparation("同步关注作者列表");
      const followingAuthors = await syncFollowingAuthors();
      if (!selectedFollowingAuthors.length) {
        $("followingOptionsPanel").open = true;
        await render();
        throw new Error(`已读取 ${followingAuthors.length} 位关注作者，请展开“关注作者范围”并至少勾选一位作者`);
      }
      const validUids = new Set(followingAuthors.map((author) => String(author.uid)));
      selectedFollowingAuthors = selectedFollowingAuthors.filter((uid) => validUids.has(String(uid)));
      if (!selectedFollowingAuthors.length) {
        await setSelectedFollowingAuthors([]);
        $("followingOptionsPanel").open = true;
        await render();
        throw new Error("之前选择的作者已不在关注列表，请重新选择作者");
      }
      markPreparation("同步所选作者作品");
      const syncedFollowingWorks = await syncFollowingAuthorWorks(followingAuthors, selectedFollowingAuthors);
      logLine(`所选关注作者作品同步完成：${syncedFollowingWorks} 条`, {
        type: "following_works_sync_finished",
        selectedAuthors: selectedFollowingAuthors.length,
        works: syncedFollowingWorks,
      });
    }
    let allStoredItems = await getAll("items");
    let items = allStoredItems
      .filter((item) => scopeDef.isEligible(item, { selectedFollowingAuthors }))
      .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
      .slice(0, Number(config.batchSize || DEFAULT_CONFIG.batchSize));
    logLine(`准备检查完成，耗时 ${((timingNow() - preparationStartedAt) / 1000).toFixed(1)} 秒，找到 ${items.length} 条待下载记录`, {
      type: "download_preparation_finished",
      scope,
      durationMs: timingNow() - preparationStartedAt,
      pending: items.length,
    });
    if (scope === "liked" && !items.length) {
      downloadBatchState.phase = "\u540c\u6b65\u559c\u6b22\u5217\u8868";
      setDownloadStatus("\u540c\u6b65\u4e2d");
      updateDownloadBatchProgress();
      await syncNextLikedPage(config);
      allStoredItems = await getAll("items");
      items = allStoredItems
        .filter((item) => scopeDef.isEligible(item, { selectedFollowingAuthors }))
        .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
        .slice(0, Number(config.batchSize || DEFAULT_CONFIG.batchSize));
    }

    if (!items.length) {
      downloadBatchState.phase = "空闲";
      setGlobalStatus("空闲");
      setDownloadStatus("空闲");
      updateDownloadBatchProgress();
      const likedStored = allStoredItems.filter((item) => ["liked", "favorite_api"].includes(item.source));
      const alreadyDownloaded = likedStored.filter((item) => item.downloadStatus === "downloaded").length;
      logLine(
        scopeDef.emptyText + "\uff08\u672c\u5730\u603b\u8bb0\u5f55 " + allStoredItems.length
          + "\uff0c\u559c\u6b22\u8bb0\u5f55 " + likedStored.length
          + "\uff0c\u5df2\u4e0b\u8f7d " + alreadyDownloaded + "\uff09",
        {
          type: "download_scope_empty",
          scope: scopeDef.key,
          storedTotal: allStoredItems.length,
          likedStored: likedStored.length,
          alreadyDownloaded,
        },
      );
      return;
    }
    const previouslyDownloaded = await countDownloadedInScope(scope);
    downloadBatchState.total = previouslyDownloaded + items.length;
    downloadBatchState.completed = previouslyDownloaded;
    downloadBatchState.sessionCompleted = 0;
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
    for (const [offset, item] of items.entries()) {
      downloadBatchState.currentOrder = offset + 1;
      downloadBatchState.inspected = offset + 1;
      updateDownloadBatchProgress();
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
        await markDownloadIndexCompleted(rootHandle, scope, item.awemeId);
        downloaded += 1;
        downloadBatchState.sessionCompleted = downloaded;
        downloadBatchState.completed = previouslyDownloaded + downloaded;
        await persistDownloadArtifacts(rootHandle, downloadBatchState, { itemCompleted: true });
      } catch (error) {
        if (isDownloadPausedError(error)) break;
        await saveItem(patchItem(item, { downloadStatus: "failed", lastError: `下载失败：${error.message}` }));
        logLine(`${scopeDef.label}下载失败：#${item.index} ${item.awemeId} ${error.message}`, {
          type: "download_failed",
          awemeId: item.awemeId,
          index: item.index,
          error: error.message,
          scope: scopeDef.key,
        });
        await persistDownloadArtifacts(rootHandle, downloadBatchState, { itemCompleted: true });
      }
      updateDownloadBatchProgress();
      scheduleRender();
      await waitTracked("item_delay", randomDelay(config), { scope: scopeDef.key });
    }
    if (!downloadPauseRequested) {
      downloadBatchState.phase = "已完成";
      await persistDownloadArtifacts(rootHandle, downloadBatchState, { forceFull: true });
      logLine(`${scopeDef.label}下载批次结束：完成 ${downloaded} 条`, {
        type: "download_batch_finished",
        completed: downloaded,
        scope: scopeDef.key,
      });
    }
  } catch (error) {
    const errorMessage = error?.message || String(error);
    downloadBatchState.phase = `异常 · ${errorMessage}`;
    setGlobalStatus("下载异常");
    setDownloadStatus(scope === "following" ? "关注下载异常" : "异常");
    updateDownloadBatchProgress();
    await finalizeDownloadPerformance();
    logLine(`下载流程异常：${errorMessage}`);
  } finally {
    clearInterval(preparationTimer);
    if (activeDownloadTarget?.kind === "filesystem") {
      await flushCompactWrites(activeDownloadTarget).catch((error) => {
        logLine(`保存轻量下载状态失败：${error?.message || String(error)}`);
      });
    }
    await sendRuntimeMessage({ type: "SET_DOWNLOAD_UI", enabled: true });
    if (!downloadPauseRequested && !String(downloadBatchState.phase).startsWith("异常")) {
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
    downloadBatchState.currentOrder = 0;
    downloadBatchState.inspected = 0;
    updateButtons();
    await render();
  }
}

$("profileBtn").addEventListener("click", async () => {
  try {
    setGlobalStatus("检测中");
    const result = await requestSelfProfile({ reason: "manual_profile" });
    const user = profileUser(result);
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

$("downloadTabBtn").addEventListener("click", async () => {
  setView("download");
  await render();
});
$("favoriteTabBtn").addEventListener("click", async () => {
  setView("favorite");
  await render();
});

$("followingOptionsPanel").addEventListener("toggle", () => {
  if (!$("followingOptionsPanel").open) return;
  $("followingSelectionMeta").textContent = "正在同步关注作者…";
  void syncFollowingAuthors().then(() => render()).catch((error) => {
    $("followingSelectionMeta").textContent = error?.message || String(error);
  });
});

$("refreshFollowingBtn").addEventListener("click", async () => {
  $("refreshFollowingBtn").disabled = true;
  $("followingSelectionMeta").textContent = "正在刷新关注作者…";
  try {
    await syncFollowingAuthors({ force: true });
    await render();
  } catch (error) {
    $("followingSelectionMeta").textContent = error?.message || String(error);
  } finally {
    $("refreshFollowingBtn").disabled = false;
  }
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

async function resolveContinueDownloadScope() {
  const fallbackScope = await getConfig("lastDownloadScope", "liked");
  const storedTarget = await getStoredDownloadTarget({ requestPermission: true });
  const folderProgress = storedTarget?.permission === "granted"
    ? await readDownloadProgressRecord(storedTarget)
    : null;
  const scope = folderProgress?.current?.scope || fallbackScope || "liked";
  return ["liked", "bookmarked", "following"].includes(scope) ? scope : "liked";
}


$("downloadBtn").addEventListener("click", async () => {
  await runDownloadBatch("liked");
});

$("downloadBookmarkedBtn").addEventListener("click", async () => {
  await runDownloadBatch("bookmarked");
});

$("continueDownloadBtn").addEventListener("click", async () => {
  const scope = await resolveContinueDownloadScope();
  logLine("\u7ee7\u7eed\u4e0a\u6b21\u4e0b\u8f7d\u4efb\u52a1\uff1a" + getDownloadScopeDefinition(scope).label, {
    type: "download_continue_requested",
    scope,
  });
  await runDownloadBatch(scope);
});

$("downloadFollowingBtn").addEventListener("click", async () => {
  await runDownloadBatch("following");
});

$("oneClickBackupBtn").addEventListener("click", async () => {
  await runOneClickBackup();
});

$("selectAllFollowingBtn").addEventListener("click", async () => {
  const authors = buildFollowingAuthors(await getAll("items"), await getCachedFollowingAuthors());
  const values = authors.map((author) => author.authorUid);
  await setSelectedFollowingAuthors(values);
  renderFollowingAuthors(authors, values);
});

$("clearFollowingSelectionBtn").addEventListener("click", async () => {
  const authors = buildFollowingAuthors(await getAll("items"), await getCachedFollowingAuthors());
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
  setView("download");
});

$("restartCurrentDownloadBtn").addEventListener("click", async () => {
  await runDownloadBatch(currentDownloadScope);
});

$("closeBtn").addEventListener("click", () => {
  parent.postMessage({ source: "douyin-toolkit-sidebar", type: "CLOSE_SIDEBAR" }, "*");
});

let sidebarCollapsed = false;

function renderSidebarCollapsed(collapsed) {
  sidebarCollapsed = Boolean(collapsed);
  document.body.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  const button = $("collapseBtn");
  button.setAttribute("aria-label", sidebarCollapsed ? "展开面板" : "收起面板");
  button.setAttribute("title", sidebarCollapsed ? "展开面板" : "收起面板");
}

function isDownloadedInScope(item, scope) {
  if (item.downloadStatus !== "downloaded") return false;
  if (scope === "bookmarked") return item.source === "bookmarked";
  if (scope === "following") return item.source === "following";
  return ["liked", "favorite_api"].includes(item.source);
}

async function countDownloadedInScope(scope) {
  return (await getAll("items")).filter((item) => isDownloadedInScope(item, scope)).length;
}

$("collapseBtn").addEventListener("click", () => {
  parent.postMessage({
    source: "douyin-toolkit-sidebar",
    type: "SET_SIDEBAR_COLLAPSED",
    payload: { collapsed: !sidebarCollapsed },
  }, "*");
});

window.addEventListener("message", (event) => {
  if (event.source === parent && event.data?.source === "douyin-toolkit-page" && event.data?.type === "SHARED_SCAN_PROGRESS" && oneClickRunning) {
    const progress = event.data.payload || {};
    setOneClickStatus(`私信分享：已检查 ${Number(progress.processed || 0)} · 新增喜欢 ${Number(progress.liked || 0)} · 已喜欢 ${Number(progress.alreadyLiked || 0)} · 未处理 ${Number(progress.failed || 0)}`);
    return;
  }
  if (event.data?.source !== "douyin-toolkit-content" || event.data?.type !== "SIDEBAR_COLLAPSE_STATE") return;
  renderSidebarCollapsed(event.data.payload?.collapsed);
});

$("pickFolderBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "OPEN_FOLDER_PICKER_TAB" }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      logLine(`打开文件夹选择页失败：${chrome.runtime.lastError?.message || response?.error || "unknown"}`);
      return;
    }
    logLine("已打开文件夹选择窗口，选择后会记住并复用该目录", {
      type: "download_target_picker_opened",
      windowId: response.windowId || null,
    });
  });
});
$("exportLogsBtn").addEventListener("click", async () => {
  try {
    await exportDiagnosticLogs();
  } catch (error) {
    logLine("\u5bfc\u51fa\u8bca\u65ad\u65e5\u5fd7\u5931\u8d25\uff1a" + (error?.message || String(error)), {
      type: "diagnostic_logs_export_failed",
    });
  }
});

$("exportTaskLogsBtn").addEventListener("click", exportDiagnosticLogs);


for (const id of ["batchSize", "auditRecent", "minDelayMs", "maxDelayMs", "syncLikedBeforeRun", "downloadCovers", "downloadPreferBestQuality", "downloadUseSavedFolder"]) {
  $(id).addEventListener("change", saveCurrentConfig);
}

window.addEventListener("douyin-toolkit-boot", (event) => {
  setGlobalStatus("已注入");
  $("pageMeta").textContent = event.detail?.href || "抖音页面已连接";
});

await render();
void refreshRemoteProfileSummary({ silent: false });
setInterval(() => {
  if (running) scheduleRender(0);
}, 5000);
