import { normalizeAweme } from "./api.js";

export const BOOKMARKED_PAGE_SIZE = 10;
export const BOOKMARKED_PAGE_MIN_INTERVAL_MS = 3000;
export const BOOKMARKED_PAGE_MAX_RETRIES = 3;

function valueFromUser(user, keys, fallback = "") {
  for (const key of keys) {
    if (user?.[key] != null && user[key] !== "") return user[key];
  }
  return fallback;
}

export function parseBookmarkedProfile(profile) {
  const user = profile?.json?.user || profile?.json?.user_info || profile?.json;
  return {
    secUid: String(valueFromUser(user, ["sec_uid", "secUid", "sec_user_id"])),
    uid: String(valueFromUser(user, ["uid", "id"])),
    nickname: String(valueFromUser(user, ["nickname", "name"])),
    expectedTotal: Number(valueFromUser(user, [
      "collect_count",
      "collection_count",
      "aweme_collect_count",
      "collectCount",
    ], 0)) || 0,
  };
}

export function createBookmarkedScanState(profile = {}) {
  return {
    secUid: profile.secUid || "",
    uid: profile.uid || "",
    nickname: profile.nickname || "",
    expectedTotal: Number(profile.expectedTotal || 0),
    cursor: 0,
    hasMore: true,
    finished: false,
    fullScan: false,
    page: 0,
    checked: 0,
    rawChecked: 0,
    seenIds: new Set(),
  };
}

export function advanceBookmarkedScanState(state, page, videoCount) {
  const currentCursor = String(state.cursor ?? 0);
  const nextCursor = page.cursor ?? state.cursor ?? 0;
  const nextCursorText = String(nextCursor ?? 0);
  const hasMore = page.hasMore === true;
  const terminalCursor = nextCursorText === "0" || nextCursorText === "-1" || nextCursorText === "";
  if (!terminalCursor && nextCursorText === currentCursor) {
    throw new Error("bookmarked cursor did not advance");
  }
  const responseTotal = Number(page.total || 0);
  return {
    ...state,
    cursor: nextCursor,
    hasMore,
    finished: terminalCursor,
    fullScan: !hasMore && nextCursorText === "0",
    page: state.page + 1,
    checked: state.checked + videoCount,
    rawChecked: state.rawChecked + (Array.isArray(page.awemeList) ? page.awemeList.length : 0),
    expectedTotal: responseTotal > 0
      ? responseTotal
      : Math.max(Number(state.expectedTotal || 0), state.checked + videoCount),
  };
}

export function isBookmarkedVideoAweme(aweme) {
  if (Array.isArray(aweme?.images)) return false;
  return Boolean(aweme?.aweme_id || aweme?.awemeId || aweme?.id);
}

function mergeBookmarkedItem(normalized, existing) {
  return {
    ...normalized,
    ...(existing || {}),
    index: existing?.index ?? normalized.index,
    source: "bookmarked",
    status: "already_favorited",
    collectStat: 1,
    desc: normalized.desc || existing?.desc || "",
    authorUid: normalized.authorUid || existing?.authorUid || "",
    authorName: normalized.authorName || existing?.authorName || "",
    url: normalized.url || existing?.url || "",
    coverUrl: normalized.coverUrl || existing?.coverUrl || "",
    videoUrl: normalized.videoUrl || existing?.videoUrl || "",
    videoCandidates: normalized.videoCandidates?.length
      ? normalized.videoCandidates
      : (existing?.videoCandidates || []),
    videoFallbackCandidate: normalized.videoFallbackCandidate?.url
      ? normalized.videoFallbackCandidate
      : (existing?.videoFallbackCandidate || null),
    videoCandidatesFetchedAt: normalized.videoCandidatesFetchedAt || existing?.videoCandidatesFetchedAt || "",
    downloadStatus: existing?.downloadStatus || "not_started",
    lastError: existing?.lastError || "",
    createdAt: existing?.createdAt || normalized.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeBookmarkedPageItems(awemeList, existingItems, seenIds = new Set()) {
  const bookmarkedItems = existingItems.filter((item) => item.source === "bookmarked");
  const existingById = new Map(bookmarkedItems.map((item) => [String(item.awemeId), item]));
  let nextIndex = existingItems.reduce(
    (max, item) => Math.max(max, Number(item.index ?? -1)),
    -1,
  ) + 1;
  const items = [];
  let skippedImages = 0;
  let skippedDuplicates = 0;
  for (const aweme of awemeList || []) {
    if (!isBookmarkedVideoAweme(aweme)) {
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
    const normalized = normalizeAweme(aweme, existing?.index ?? nextIndex, "bookmarked");
    if (!existing) nextIndex += 1;
    items.push(mergeBookmarkedItem(normalized, existing));
  }
  return {
    items,
    skippedImages,
    skippedDuplicates,
  };
}

export function bookmarkedRetryDelayMs(attempt) {
  return 7000 * Math.max(1, Number(attempt || 1));
}
