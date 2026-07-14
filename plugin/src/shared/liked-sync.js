import { normalizeAweme } from "./api.js";

export const LIKED_PAGE_SIZE = 18;
export const LIKED_PAGE_MIN_INTERVAL_MS = 5000;
export const LIKED_PAGE_MAX_RETRIES = 3;

function valueFromUser(user, keys, fallback = "") {
  for (const key of keys) {
    if (user?.[key] != null && user[key] !== "") return user[key];
  }
  return fallback;
}

export function parseLikedProfile(profile) {
  const user = profile?.json?.user || profile?.json?.user_info || profile?.json;
  return {
    secUid: String(valueFromUser(user, ["sec_uid", "secUid", "sec_user_id"])),
    uid: String(valueFromUser(user, ["uid", "id"])),
    nickname: String(valueFromUser(user, ["nickname", "name"])),
    expectedTotal: Number(valueFromUser(user, ["favoriting_count", "favoritingCount"], 0)) || 0,
  };
}

export function createLikedScanState(profile) {
  return {
    secUid: profile.secUid,
    uid: profile.uid,
    nickname: profile.nickname,
    expectedTotal: profile.expectedTotal,
    maxCursor: 0,
    minCursor: 0,
    hasMore: true,
    finished: false,
    fullScan: false,
    page: 0,
    checked: 0,
    rawChecked: 0,
    seenIds: new Set(),
  };
}

export function isVideoAweme(aweme) {
  if (Array.isArray(aweme?.images)) return false;
  return Boolean(aweme?.aweme_id || aweme?.awemeId || aweme?.id);
}

export function advanceLikedScanState(state, page, videoCount) {
  const currentMax = String(state.maxCursor ?? 0);
  const currentMin = String(state.minCursor ?? 0);
  const nextMax = page.maxCursor ?? state.maxCursor ?? 0;
  const nextMin = page.minCursor ?? state.minCursor ?? 0;
  const nextMaxText = String(nextMax ?? 0);
  const nextMinText = String(nextMin ?? 0);
  const hasMore = page.hasMore === true;
  const terminalCursor = nextMaxText === "0" || nextMaxText === "-1" || nextMaxText === "";
  const cursorAdvanced = nextMaxText !== currentMax || nextMinText !== currentMin;
  if (!terminalCursor && !cursorAdvanced) {
    throw new Error("liked cursor did not advance");
  }
  return {
    ...state,
    maxCursor: nextMax,
    minCursor: nextMin,
    hasMore,
    finished: terminalCursor,
    fullScan: !hasMore && nextMaxText === "0",
    page: state.page + 1,
    checked: state.checked + videoCount,
    rawChecked: state.rawChecked + (Array.isArray(page.awemeList) ? page.awemeList.length : 0),
  };
}

function mergeLikedItem(normalized, existing) {
  return {
    ...normalized,
    ...(existing || {}),
    index: existing?.index ?? normalized.index,
    source: ["liked", "favorite_api"].includes(existing?.source) ? existing.source : "liked",
    status: existing?.status || normalized.status,
    collectStat: normalized.collectStat ?? existing?.collectStat ?? null,
    desc: normalized.desc || existing?.desc || "",
    authorUid: normalized.authorUid || existing?.authorUid || "",
    authorName: normalized.authorName || existing?.authorName || "",
    url: normalized.url || existing?.url || "",
    coverUrl: normalized.coverUrl || existing?.coverUrl || "",
    videoUrl: normalized.videoUrl || existing?.videoUrl || "",
    downloadStatus: existing?.downloadStatus || "not_started",
    lastError: existing?.lastError || "",
    createdAt: existing?.createdAt || normalized.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeLikedPageItems(awemeList, existingItems, seenIds = new Set()) {
  const existingById = new Map(existingItems.map((item) => [String(item.awemeId), item]));
  let nextIndex = existingItems.reduce(
    (max, item) => Math.max(max, Number(item.index ?? -1)),
    -1,
  ) + 1;
  const items = [];
  let skippedImages = 0;
  let skippedDuplicates = 0;
  for (const aweme of awemeList || []) {
    if (!isVideoAweme(aweme)) {
      if (Array.isArray(aweme?.images)) skippedImages += 1;
      continue;
    }
    const awemeId = String(aweme.aweme_id || aweme.awemeId || aweme.id);
    if (seenIds.has(awemeId)) {
      skippedDuplicates += 1;
      continue;
    }
    seenIds.add(awemeId);
    const existing = existingById.get(awemeId);
    const normalized = normalizeAweme(aweme, existing?.index ?? nextIndex, "liked");
    if (!existing) nextIndex += 1;
    items.push(mergeLikedItem(normalized, existing));
  }
  return {
    items,
    skippedImages,
    skippedDuplicates,
  };
}

export function likedRetryDelayMs(attempt) {
  return 7000 * Math.max(1, Number(attempt || 1));
}
