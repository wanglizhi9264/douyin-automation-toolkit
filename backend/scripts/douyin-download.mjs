#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import {
  describeVideoCandidate,
  extractMediaParts,
  mediaTypeForParts,
  pickVideoCandidates,
  pickVideoUrl,
} from "../../plugin/src/shared/api.js";
import {
  advanceLikedScanState,
  createLikedScanState,
  LIKED_PAGE_MAX_RETRIES,
  LIKED_PAGE_MIN_INTERVAL_MS,
  LIKED_PAGE_SIZE,
  likedRetryDelayMs,
  normalizeLikedPageItems,
  parseLikedProfile,
} from "../../plugin/src/shared/liked-sync.js";
import {
  advanceBookmarkedScanState,
  BOOKMARKED_PAGE_MAX_RETRIES,
  BOOKMARKED_PAGE_MIN_INTERVAL_MS,
  BOOKMARKED_PAGE_SIZE,
  bookmarkedRetryDelayMs,
  createBookmarkedScanState,
  normalizeBookmarkedPageItems,
  parseBookmarkedProfile,
} from "../../plugin/src/shared/bookmarked-sync.js";
import {
  appendRecordEvent,
  applyListReconciliation,
  inferPreviousSnapshot,
  loadDownloadRecord,
  mediaRelativePaths,
  mediaPartCandidates,
  mediaPartRelativePath,
  segmentedManifestRelativePath,
  normalizeScope,
  reconcileListSnapshot,
  saveDownloadRecord,
  upsertDownloadItem,
  writeJsonAtomic,
} from "./douyin-download-core.mjs";
import {
  downloadMedia,
  fetchAwemeDetail,
  fetchBookmarkedPage,
  fetchLikedPage,
  fetchSelfProfile,
  requestWithRetry,
} from "./douyin-download-api.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const CONFIG_PATH = path.join(BACKEND_ROOT, "config", "douyin-favorite.config.json");
const DEFAULT_PROFILE_DIR = path.join(BACKEND_ROOT, ".douyin-playwright-profile");
const DEFAULT_START_URL = "https://www.douyin.com/";
const DEFAULT_OPTIONS = {
  downloadRoot: path.join("data", "douyin-backup"),
  downloadCovers: true,
  downloadPreferBestQuality: true,
  downloadHeadless: false,
  downloadMinDelayMs: 300,
  downloadMaxDelayMs: 900,
  mediaTimeoutMs: 120000,
};

function defaultBrowserCandidates() {
  const programFiles = process.env.ProgramFiles || process.env.PROGRAMFILES || "";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || process.env["PROGRAMFILES(X86)"] || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  return [
    chromium.executablePath(),
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
}

export function resolveBrowserExecutable(candidates = defaultBrowserCandidates()) {
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || "";
}

let stopRequested = false;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function boolArg(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_OPTIONS };
  return {
    ...DEFAULT_OPTIONS,
    ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")),
  };
}

function randomBetween(minimum, maximum) {
  return Math.floor(minimum + Math.random() * (maximum - minimum + 1));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const beijingFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function printEvent(record, text, meta = {}) {
  const event = appendRecordEvent(record, text, meta);
  console.log(beijingFormatter.format(new Date(event.at)) + " " + text);
  return event;
}

function absoluteMediaPath(rootDir, relativePath) {
  return path.join(rootDir, ...String(relativePath).split("/").filter(Boolean));
}

export function updateRecordTotals(record) {
  const activeLiked = record.items.filter((item) => (
    normalizeScope(item.source) === "liked" && item.listState !== "removed"
  ));
  const activeBookmarked = record.items.filter((item) => (
    normalizeScope(item.source) === "bookmarked" && item.listState !== "removed"
  ));
  const active = [...activeLiked, ...activeBookmarked];
  record.likedTotal = activeLiked.length;
  record.bookmarkedTotal = activeBookmarked.length;
  record.eligibleTotal = active.length;
  record.downloadedTotal = active.filter((item) => item.downloadStatus === "downloaded").length;
  record.pendingTotal = active.filter((item) => item.downloadStatus !== "downloaded").length;
  record.failedTotal = active.filter((item) => item.downloadStatus === "failed").length;
}

function persist(rootDir, record) {
  updateRecordTotals(record);
  saveDownloadRecord(rootDir, record);
}

export function resolveScope(command, args, record) {
  if (command === "liked" || command === "download-liked") return "liked";
  if (command === "bookmarked" || command === "download-bookmarked") return "bookmarked";
  if (command === "resume" || command === "download-resume") {
    return normalizeScope(record.current?.scope || args.scope || "liked");
  }
  if (command === "download") return normalizeScope(args.scope || record.current?.scope || "liked");
  throw new Error("unknown command: " + command);
}

export function resolveOptions(args, config) {
  const outputValue = args.output || config.downloadRoot || DEFAULT_OPTIONS.downloadRoot;
  return {
    rootDir: path.resolve(BACKEND_ROOT, outputValue),
    profileDir: path.resolve(BACKEND_ROOT, args["profile-dir"] || DEFAULT_PROFILE_DIR),
    covers: boolArg(args.covers, Boolean(config.downloadCovers)),
    preferBestQuality: boolArg(args.best, Boolean(config.downloadPreferBestQuality)),
    headless: boolArg(args.headless, Boolean(config.downloadHeadless)),
    minDelayMs: Number(args["min-delay-ms"] ?? config.downloadMinDelayMs),
    maxDelayMs: Number(args["max-delay-ms"] ?? config.downloadMaxDelayMs),
    mediaTimeoutMs: Number(args["media-timeout-ms"] ?? config.mediaTimeoutMs),
    maxItems: args["max-items"] ? Number(args["max-items"]) : Infinity,
    maxPages: args["max-pages"] ? Number(args["max-pages"]) : Infinity,
  };
}

async function launchBrowser(options) {
  const executablePath = resolveBrowserExecutable();
  if (!executablePath) {
    throw new Error(
      "no Chromium browser found; run 'npx playwright install chromium' or install Edge/Chrome",
    );
  }
  return chromium.launchPersistentContext(options.profileDir, {
    headless: options.headless,
    executablePath,
    viewport: { width: 1280, height: 820 },
    locale: "zh-CN",
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

async function getPage(context) {
  return context.pages()[0] || context.newPage();
}

async function loadProfile(page, scope, record) {
  const profileResult = await requestWithRetry(
    () => fetchSelfProfile(page),
    {
      retries: 3,
      delayForAttempt: (attempt) => 3000 * attempt,
      onRetry: ({ attempt, delayMs, error }) => {
        printEvent(record, "Profile request retry " + attempt, {
          type: "profile_retry",
          delayMs,
          error: error.message,
        });
      },
    },
  );
  const profile = scope === "bookmarked"
    ? parseBookmarkedProfile(profileResult)
    : parseLikedProfile(profileResult);
  if (!profile.uid && !profile.secUid) {
    throw new Error("current Douyin account id is missing; log in and retry");
  }
  if (scope === "liked" && !profile.secUid) {
    throw new Error("current Douyin sec_uid is missing; log in and retry");
  }
  return profile;
}

async function waitForPageSlot(lastRequestAt, minimumIntervalMs) {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < minimumIntervalMs) await wait(minimumIntervalMs - elapsed);
}

async function requestScanPage(page, scope, scanState, record, rootDir, requestClock) {
  const isBookmarked = scope === "bookmarked";
  const minimumIntervalMs = isBookmarked
    ? BOOKMARKED_PAGE_MIN_INTERVAL_MS
    : LIKED_PAGE_MIN_INTERVAL_MS;
  const retries = isBookmarked
    ? BOOKMARKED_PAGE_MAX_RETRIES
    : LIKED_PAGE_MAX_RETRIES;
  const retryDelay = isBookmarked ? bookmarkedRetryDelayMs : likedRetryDelayMs;
  if (isBookmarked && String(scanState.cursor ?? 0) === "0" && requestClock.firstBookmarkedPage) {
    const cached = requestClock.firstBookmarkedPage;
    requestClock.firstBookmarkedPage = null;
    return cached;
  }

  await waitForPageSlot(requestClock.lastAt, minimumIntervalMs);
  requestClock.lastAt = Date.now();

  return requestWithRetry(
    () => isBookmarked
      ? fetchBookmarkedPage(page, {
        cursor: scanState.cursor,
        count: BOOKMARKED_PAGE_SIZE,
      })
      : fetchLikedPage(page, {
        secUid: scanState.secUid,
        maxCursor: scanState.maxCursor,
        minCursor: scanState.minCursor,
        count: LIKED_PAGE_SIZE,
      }),
    {
      retries,
      delayForAttempt: retryDelay,
      onRetry: ({ attempt, delayMs, error }) => {
        printEvent(record, "List page retry " + attempt + "/" + retries, {
          type: scope + "_page_retry",
          page: scanState.page + 1,
          cursor: isBookmarked ? scanState.cursor : scanState.maxCursor,
          delayMs,
          error: error.message,
        });
        persist(rootDir, record);
      },
    },
  );
}

function shouldDownloadAsSegments(mediaParts) {
  const parts = Array.isArray(mediaParts) ? mediaParts : [];
  return parts.some((part) => part.kind === "image")
    || parts.filter((part) => part.kind === "video").length > 1;
}

async function downloadSegmentedOne(page, rootDir, record, item, options, detail, mediaParts) {
  const progress = { ...(item.downloadedMediaParts || {}) };
  const mediaType = mediaTypeForParts(mediaParts);
  Object.assign(item, {
    mediaType,
    mediaCount: mediaParts.length,
    mediaParts,
    downloadedMediaParts: progress,
    downloadedPartCount: mediaParts.filter((part) => progress[part.partId]?.status === "downloaded").length,
    downloadStatus: "downloading",
    lastError: "",
    updatedAt: new Date().toISOString(),
  });
  persist(rootDir, record);

  for (const part of mediaParts) {
    const completed = progress[part.partId];
    if (completed?.status === "downloaded") {
      printEvent(record, "Skip completed media part " + item.awemeId + " " + part.partId, {
        type: "download_media_part_skipped",
        scope: item.source,
        awemeId: item.awemeId,
        partId: part.partId,
        path: completed.path || "",
      });
      persist(rootDir, record);
      continue;
    }

    const relativePath = mediaPartRelativePath(item.source, item.awemeId, part, mediaParts.length);
    const destination = absoluteMediaPath(rootDir, relativePath);
    let mediaResult = null;
    let selectedCandidate = null;
    let selectedRank = 0;
    const fallbackErrors = [];

    if (part.kind === "image") {
      mediaResult = await downloadMedia(page.context(), part.url, destination, {
        expected: "image",
        timeoutMs: options.mediaTimeoutMs,
      });
    } else {
      const candidates = mediaPartCandidates(part, options.preferBestQuality);
      if (!candidates.length) throw new Error("media part " + part.partId + " has no video candidate");
      const candidateErrors = fallbackErrors;
      for (const [index, candidate] of candidates.entries()) {
        printEvent(record, "Try media part candidate " + (index + 1) + " " + describeVideoCandidate(candidate), {
          type: "download_media_part_candidate_started",
          scope: item.source,
          awemeId: item.awemeId,
          partId: part.partId,
          candidateRank: index + 1,
          quality: candidate,
        });
        try {
          mediaResult = await downloadMedia(page.context(), candidate.url, destination, {
            expected: "video",
            timeoutMs: options.mediaTimeoutMs,
          });
          selectedCandidate = candidate;
          selectedRank = index + 1;
          break;
        } catch (error) {
          candidateErrors.push("#" + (index + 1) + " " + error.message);
          printEvent(record, "Media part candidate failed " + (index + 1) + " " + error.message, {
            type: "download_media_part_candidate_failed",
            scope: item.source,
            awemeId: item.awemeId,
            partId: part.partId,
            candidateRank: index + 1,
            error: error.message,
          });
          persist(rootDir, record);
        }
      }
      if (!selectedCandidate) {
        throw new Error("all candidates failed for " + part.partId + ": " + candidateErrors.join(" | "));
      }
    }

    progress[part.partId] = {
      partId: part.partId,
      kind: part.kind,
      role: part.role || "",
      order: part.order,
      status: "downloaded",
      path: relativePath,
      size: Number(mediaResult?.contentLength || selectedCandidate?.size || 0),
      contentType: mediaResult?.contentType || (part.kind === "image" ? "image/*" : "video/mp4"),
      candidateRank: selectedRank,
      quality: selectedCandidate,
      fallbackErrors,
      width: Number(part.width || selectedCandidate?.width || 0),
      height: Number(part.height || selectedCandidate?.height || 0),
      updatedAt: new Date().toISOString(),
    };
    Object.assign(item, {
      downloadedMediaParts: progress,
      downloadedPartCount: mediaParts.filter((entry) => progress[entry.partId]?.status === "downloaded").length,
      downloadStatus: "downloading",
      updatedAt: new Date().toISOString(),
    });
    printEvent(record, "Media part downloaded " + item.awemeId + " " + part.partId, {
      type: "download_media_part_success",
      scope: item.source,
      awemeId: item.awemeId,
      partId: part.partId,
      kind: part.kind,
      order: part.order,
      path: relativePath,
      size: progress[part.partId].size,
    });
    persist(rootDir, record);
  }

  const completedParts = mediaParts.map((part) => progress[part.partId]).filter(Boolean);
  if (completedParts.length !== mediaParts.length) {
    throw new Error("media parts incomplete: " + completedParts.length + "/" + mediaParts.length);
  }
  const videoRecords = completedParts.filter((part) => part.kind === "video");
  const imageRecords = completedParts.filter((part) => part.kind === "image");
  const mediaPaths = completedParts.map((part) => part.path);
  let coverPath = item.downloadCoverPath || item.coverPath || "";
  if (options.covers && detail.coverUrl && !imageRecords.length && !coverPath) {
    const relativePaths = mediaRelativePaths(item.source, item.awemeId);
    await downloadMedia(page.context(), detail.coverUrl, absoluteMediaPath(rootDir, relativePaths.cover), {
      expected: "image",
      timeoutMs: options.mediaTimeoutMs,
    });
    coverPath = relativePaths.cover;
  }

  const firstVideo = videoRecords[0] || null;
  const firstQuality = firstVideo?.quality || null;
  const qualityLabel = [
    videoRecords.length ? videoRecords.length + " video parts" : "",
    imageRecords.length ? imageRecords.length + " images" : "",
  ].filter(Boolean).join(" + ");
  const manifest = {
    awemeId: item.awemeId,
    index: item.index,
    source: normalizeScope(item.source),
    status: item.status || "",
    mediaType,
    mediaCount: mediaParts.length,
    desc: detail.desc || item.desc || "",
    authorUid: detail.authorUid || item.authorUid || "",
    authorName: detail.authorName || item.authorName || "",
    createTime: detail.createTime || item.createTime || 0,
    url: item.url || ("https://www.douyin.com/" + (imageRecords.length ? "note/" : "video/") + item.awemeId),
    downloadedAt: new Date().toISOString(),
    parts: completedParts,
    files: {
      media: mediaPaths,
      videos: videoRecords.map((part) => part.path),
      images: imageRecords.map((part) => part.path),
      cover: coverPath || null,
    },
  };
  writeJsonAtomic(absoluteMediaPath(rootDir, segmentedManifestRelativePath(item.awemeId)), manifest);

  Object.assign(item, {
    status: item.status || "already_favorited",
    mediaType,
    mediaCount: mediaParts.length,
    mediaParts,
    downloadedMediaParts: progress,
    downloadedPartCount: mediaParts.length,
    downloadStatus: "downloaded",
    resolution: qualityLabel,
    downloadQualityLabel: qualityLabel,
    width: firstQuality?.width || 0,
    height: firstQuality?.height || 0,
    bitrate: firstQuality?.bitrate || 0,
    codec: firstQuality?.codec || "",
    fps: firstQuality?.fps || 0,
    size: completedParts.reduce((sum, part) => sum + Number(part.size || 0), 0),
    mediaPaths,
    imagePaths: imageRecords.map((part) => part.path),
    downloadMediaPaths: mediaPaths,
    downloadImagePaths: imageRecords.map((part) => part.path),
    videoPath: firstVideo?.path || "",
    coverPath,
    downloadVideoPath: firstVideo?.path || "",
    downloadCoverPath: coverPath,
    downloadCandidateRank: firstVideo?.candidateRank || 0,
    authorUid: detail.authorUid || item.authorUid || "",
    authorName: detail.authorName || item.authorName || "",
    createTime: detail.createTime || item.createTime || 0,
    desc: detail.desc || item.desc || "",
    lastError: "",
    updatedAt: new Date().toISOString(),
  });
  printEvent(record, "Segmented download success " + item.awemeId + " " + qualityLabel, {
    type: "download_segmented_success",
    scope: item.source,
    awemeId: item.awemeId,
    mediaType,
    mediaCount: mediaParts.length,
    videoCount: videoRecords.length,
    imageCount: imageRecords.length,
    paths: mediaPaths,
  });
  persist(rootDir, record);
}

async function downloadOne(page, rootDir, record, item, options) {
  item.downloadStatus = "downloading";
  item.lastError = "";
  item.updatedAt = new Date().toISOString();
  persist(rootDir, record);
  printEvent(record, "Download start #" + item.index + " " + item.awemeId, {
    type: "download_item_started",
    scope: item.source,
    awemeId: item.awemeId,
    index: item.index,
  });

  const detail = await requestWithRetry(
    () => fetchAwemeDetail(page, item.awemeId),
    {
      retries: 3,
      delayForAttempt: (attempt) => 7000 * attempt,
      onRetry: ({ attempt, delayMs, error }) => {
        printEvent(record, "Detail retry " + attempt + " " + item.awemeId, {
          type: "download_detail_retry",
          awemeId: item.awemeId,
          delayMs,
          error: error.message,
        });
      },
    },
  );

  const mediaParts = extractMediaParts(detail.aweme);
  if (!mediaParts.length) throw new Error("detail has no downloadable media");
  if (shouldDownloadAsSegments(mediaParts)) {
    await downloadSegmentedOne(page, rootDir, record, item, options, detail, mediaParts);
    return;
  }

  const rankedCandidates = pickVideoCandidates(detail.aweme, {
    preferBestQuality: options.preferBestQuality,
  });
  const fallbackCandidate = pickVideoUrl(detail.aweme, { preferBestQuality: false });
  const candidates = [...rankedCandidates, fallbackCandidate]
    .filter((candidate) => candidate?.url)
    .filter((candidate, index, list) => (
      list.findIndex((other) => other.url === candidate.url) === index
    ));
  const limit = options.preferBestQuality ? Math.min(candidates.length, 4) : Math.min(candidates.length, 1);
  if (!limit) throw new Error("no downloadable video candidate");

  const relativePaths = mediaRelativePaths(item.source, item.awemeId);
  const videoDestination = absoluteMediaPath(rootDir, relativePaths.video);
  let selectedCandidate = null;
  let selectedRank = 0;
  let mediaResult = null;
  const candidateErrors = [];

  for (let index = 0; index < limit; index += 1) {
    const candidate = candidates[index];
    printEvent(record, "Try candidate " + (index + 1) + " " + describeVideoCandidate(candidate), {
      type: "download_candidate_started",
      awemeId: item.awemeId,
      candidateRank: index + 1,
      quality: candidate,
    });
    try {
      mediaResult = await downloadMedia(page.context(), candidate.url, videoDestination, {
        expected: "video",
        timeoutMs: options.mediaTimeoutMs,
      });
      selectedCandidate = candidate;
      selectedRank = index + 1;
      break;
    } catch (error) {
      candidateErrors.push("#" + (index + 1) + " " + error.message);
      printEvent(record, "Candidate failed " + (index + 1) + " " + error.message, {
        type: "download_candidate_failed",
        awemeId: item.awemeId,
        candidateRank: index + 1,
        quality: candidate,
        error: error.message,
      });
    }
  }
  if (!selectedCandidate) {
    throw new Error("all video candidates failed: " + candidateErrors.join(" | "));
  }

  let coverPath = "";
  if (options.covers && detail.coverUrl) {
    const coverDestination = absoluteMediaPath(rootDir, relativePaths.cover);
    await downloadMedia(page.context(), detail.coverUrl, coverDestination, {
      expected: "image",
      timeoutMs: options.mediaTimeoutMs,
    });
    coverPath = relativePaths.cover;
  }

  const manifest = {
    awemeId: item.awemeId,
    index: item.index,
    source: normalizeScope(item.source),
    status: item.status || "",
    desc: detail.desc || item.desc || "",
    authorUid: detail.authorUid || item.authorUid || "",
    authorName: detail.authorName || item.authorName || "",
    createTime: detail.createTime || item.createTime || 0,
    url: item.url || ("https://www.douyin.com/video/" + item.awemeId),
    downloadedAt: new Date().toISOString(),
    selectedCandidateRank: selectedRank,
    selectedQuality: selectedCandidate,
    candidates: rankedCandidates.slice(0, 5),
    precheck: mediaResult,
    files: {
      video: relativePaths.video,
      cover: coverPath || null,
    },
  };
  writeJsonAtomic(absoluteMediaPath(rootDir, relativePaths.manifest), manifest);

  Object.assign(item, {
    status: item.status || "already_favorited",
    downloadStatus: "downloaded",
    resolution: describeVideoCandidate(selectedCandidate),
    downloadQualityLabel: describeVideoCandidate(selectedCandidate),
    width: selectedCandidate.width || 0,
    height: selectedCandidate.height || 0,
    bitrate: selectedCandidate.bitrate || 0,
    codec: selectedCandidate.codec || "",
    fps: selectedCandidate.fps || 0,
    size: mediaResult.contentLength || selectedCandidate.size || 0,
    videoPath: relativePaths.video,
    coverPath,
    downloadVideoPath: relativePaths.video,
    downloadCoverPath: coverPath,
    downloadCandidateRank: selectedRank,
    downloadQualityFallbackReason: candidateErrors.join(" | "),
    authorUid: detail.authorUid || item.authorUid || "",
    authorName: detail.authorName || item.authorName || "",
    createTime: detail.createTime || item.createTime || 0,
    desc: detail.desc || item.desc || "",
    lastError: "",
    updatedAt: new Date().toISOString(),
  });
  persist(rootDir, record);
  printEvent(record, "Download success " + item.awemeId + " " + item.resolution, {
    type: "download_success",
    scope: item.source,
    awemeId: item.awemeId,
    candidateRank: selectedRank,
    quality: selectedCandidate,
    size: item.size,
  });
}

function normalizePageItems(scope, pageResult, record, scanState) {
  return scope === "bookmarked"
    ? normalizeBookmarkedPageItems(pageResult.awemeList, record.items, scanState.seenIds)
    : normalizeLikedPageItems(pageResult.awemeList, record.items, scanState.seenIds);
}

function advanceScanState(scope, scanState, pageResult, videoCount) {
  return scope === "bookmarked"
    ? advanceBookmarkedScanState(scanState, pageResult, videoCount)
    : advanceLikedScanState(scanState, pageResult, videoCount);
}

function createScanState(scope, profile) {
  return scope === "bookmarked"
    ? createBookmarkedScanState(profile)
    : createLikedScanState(profile);
}

function scanCursor(scope, scanState) {
  return scope === "bookmarked" ? scanState.cursor : scanState.maxCursor;
}

export async function runDownload(page, rootDir, record, scope, options) {
  const profile = await loadProfile(page, scope, record);
  const currentUserId = String(profile.uid || profile.secUid || "");
  const folderUserId = String(record.user?.uid || "");
  if (folderUserId && currentUserId && folderUserId !== currentUserId) {
    throw new Error("backup folder belongs to another Douyin account: " + (record.user?.nickname || folderUserId));
  }

  record.user = {
    uid: currentUserId,
    nickname: profile.nickname || "",
  };
  const previousSnapshot = inferPreviousSnapshot(record, scope);
  let scanState = createScanState(scope, profile);
  record.current = {
    scope,
    phase: "scanning",
    completed: 0,
    total: Number(profile.expectedTotal || 0),
    inspected: 0,
    page: 0,
    cursor: scanCursor(scope, scanState),
    awemeId: "",
    resolution: "",
  };
  printEvent(record, "Start " + scope + " scan from page 1", {
    type: scope + "_scan_started",
    expectedTotal: profile.expectedTotal,
    output: rootDir,
  });
  persist(rootDir, record);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let attempted = 0;
  let consecutiveFailures = 0;
  const requestClock = { lastAt: 0 };
  if (scope === "bookmarked") {
    const overview = await requestWithRetry(
      () => fetchBookmarkedPage(page, { cursor: 0, count: BOOKMARKED_PAGE_SIZE }),
      {
        retries: BOOKMARKED_PAGE_MAX_RETRIES,
        delayForAttempt: bookmarkedRetryDelayMs,
        onRetry: ({ attempt, delayMs, error }) => {
          printEvent(record, "Bookmarked overview retry " + attempt, {
            type: "bookmarked_overview_retry",
            delayMs,
            error: error.message,
          });
          persist(rootDir, record);
        },
      },
    );
    requestClock.lastAt = Date.now();
    requestClock.firstBookmarkedPage = overview;
    const overviewTotal = Number(overview.total || 0);
    if (overviewTotal > 0) {
      profile.expectedTotal = Math.max(Number(profile.expectedTotal || 0), overviewTotal);
      scanState = { ...scanState, expectedTotal: profile.expectedTotal };
      record.current.total = profile.expectedTotal;
    }
    printEvent(record, "Bookmarked overview loaded: total=" + profile.expectedTotal, {
      type: "bookmarked_overview_loaded",
      expectedTotal: profile.expectedTotal,
      responseTotal: overviewTotal,
      firstPageItems: overview.awemeList.length,
    });
    persist(rootDir, record);

  }
  while (!scanState.finished && !stopRequested) {
    if (scanState.page >= options.maxPages) {
      stopRequested = true;
      break;
    }
    const pageResult = await requestScanPage(page, scope, scanState, record, rootDir, requestClock);
    const normalized = normalizePageItems(scope, pageResult, record, scanState);
    const pageItems = normalized.items.map((item) => upsertDownloadItem(record, {
      ...item,
      source: scope,
      listState: "present",
      lastSeenInListAt: new Date().toISOString(),
      removedFromListAt: "",
    }));
    scanState = advanceScanState(scope, scanState, pageResult, pageItems.length);
    record.current = {
      ...record.current,
      phase: "scanning",
      page: scanState.page,
      inspected: scanState.checked,
      total: Math.max(Number(scanState.expectedTotal || 0), scanState.checked),
      cursor: scanCursor(scope, scanState),
    };
    printEvent(record, "Checked " + scope + " page " + scanState.page
      + ": raw=" + pageResult.awemeList.length
      + " works=" + pageItems.length
      + " total=" + scanState.checked, {
      type: scope + "_page_checked",
      page: scanState.page,
      rawItems: pageResult.awemeList.length,
      videoItems: pageItems.length,
      mediaItems: pageItems.length,
      checked: scanState.checked,
      cursor: scanCursor(scope, scanState),
      hasMore: scanState.hasMore,
      fullScan: scanState.fullScan,
      imageItems: normalized.imageItems,
      multiVideoItems: normalized.multiVideoItems,
      skippedUnsupported: normalized.skippedUnsupported,
      skippedImages: 0,
      skippedDuplicates: normalized.skippedDuplicates,
    });
    persist(rootDir, record);

    if (scanState.finished && !scanState.fullScan) {
      throw new Error(scope + " list ended with an untrusted cursor: " + scanCursor(scope, scanState));
    }
    if (scanState.finished && scanState.expectedTotal > 0 && scanState.rawChecked === 0) {
      throw new Error(scope + " list expected " + scanState.expectedTotal + " items but returned 0");
    }

    for (const item of pageItems) {
      if (stopRequested) break;
      if (item.downloadStatus === "downloaded") {
        skipped += 1;
        continue;
      }
      if (attempted >= options.maxItems) {
        stopRequested = true;
        break;
      }
      attempted += 1;
      record.current = {
        ...record.current,
        phase: "downloading",
        awemeId: item.awemeId,
        index: item.index,
        completed: downloaded,
      };
      try {
        await downloadOne(page, rootDir, record, item, options);
        downloaded += 1;
        consecutiveFailures = 0;
      } catch (error) {
        failed += 1;
        consecutiveFailures += 1;
        item.downloadStatus = "failed";
        item.lastError = error.message;
        item.updatedAt = new Date().toISOString();
        printEvent(record, "Download failed " + item.awemeId + ": " + error.message, {
          type: "download_failed",
          scope,
          awemeId: item.awemeId,
          error: error.message,
        });
        persist(rootDir, record);
        if (consecutiveFailures >= 8) {
          throw new Error("8 consecutive media downloads failed; stopped for safety");
        }
      }
      record.current.completed = downloaded;
      persist(rootDir, record);
      await wait(randomBetween(options.minDelayMs, options.maxDelayMs));
    }
  }

  if (stopRequested) {
    record.current = {
      ...record.current,
      phase: "paused",
      completed: downloaded,
      inspected: scanState.checked,
      cursor: scanCursor(scope, scanState),
    };
    printEvent(record, "Paused without list reconciliation", {
      type: scope + "_download_paused",
      checked: scanState.checked,
      downloaded,
      skipped,
      failed,
    });
    persist(rootDir, record);
    return;
  }

  if (!scanState.fullScan) {
    throw new Error(scope + " list did not reach a trusted full-scan terminal state");
  }

  const reconciliation = reconcileListSnapshot(
    previousSnapshot,
    [...scanState.seenIds],
    new Date().toISOString(),
  );
  applyListReconciliation(record, scope, reconciliation);
  const activeScopeItems = record.items.filter((item) => (
    normalizeScope(item.source) === scope && item.listState !== "removed"
  ));
  const alreadyDownloaded = activeScopeItems
    .filter((item) => item.downloadStatus === "downloaded")
    .length;
  record.current = {
    ...record.current,
    phase: "completed",
    completed: downloaded,
    inspected: scanState.checked,
    total: reconciliation.snapshot.total,
    cursor: scanCursor(scope, scanState),
  };

  const changeText = reconciliation.hasBaseline
    ? "added=" + reconciliation.addedIds.length
      + " removed=" + reconciliation.removedIds.length
      + " reappeared=" + reconciliation.reappearedIds.length
    : "baseline created";
  printEvent(record, "Completed " + scope + " reconciliation: " + changeText, {
    type: scope + "_list_reconciled",
    currentTotal: reconciliation.snapshot.total,
    addedIds: reconciliation.addedIds,
    removedIds: reconciliation.removedIds,
    reappearedIds: reconciliation.reappearedIds,
    downloaded,
    skipped,
    failed,
    alreadyDownloaded,
  });
  persist(rootDir, record);
  console.log(JSON.stringify({
    scope,
    output: rootDir,
    checked: scanState.checked,
    downloaded,
    skipped,
    failed,
    alreadyDownloaded,
    changes: reconciliation.snapshot.lastChanges,
  }, null, 2));
}

export async function main() {
  const command = process.argv[2] || "resume";
  const args = parseArgs(process.argv.slice(3));
  const config = loadConfig();
  const options = resolveOptions(args, config);
  const record = loadDownloadRecord(options.rootDir);
  const scope = resolveScope(command, args, record);
  if (!["liked", "bookmarked"].includes(scope)) {
    throw new Error("scope must be liked or bookmarked");
  }

  process.once("SIGINT", () => {
    stopRequested = true;
    console.log("\nPause requested; waiting for the current safe point...");
  });

  let context = null;
  try {
    context = await launchBrowser(options);
    const page = await getPage(context);
    page.setDefaultTimeout(30000);
    await page.goto(DEFAULT_START_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    }).catch(() => {});
    await page.waitForTimeout(2000);
    await runDownload(page, options.rootDir, record, scope, options);
  } catch (error) {
    record.current = {
      ...(record.current || {}),
      scope,
      phase: "failed",
      lastError: error.message,
    };
    printEvent(record, "Task failed: " + error.message, {
      type: "download_task_failed",
      scope,
      error: error.message,
    });
    persist(options.rootDir, record);
    throw error;
  } finally {
    await context?.close().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
