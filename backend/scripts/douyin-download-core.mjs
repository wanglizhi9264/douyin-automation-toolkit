import fs from "node:fs";
import path from "node:path";

export const DOWNLOAD_RECORD_SCHEMA_VERSION = 2;

export function normalizeScope(source) {
  if (source === "favorite_api") return "liked";
  if (source === "collection") return "bookmarked";
  return source || "liked";
}

export function downloadItemKey(source, awemeId) {
  return normalizeScope(source) + ":" + String(awemeId || "");
}

function uniqueIds(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const id = String(value || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function normalizeDownloadRecord(raw = {}) {
  const itemsByKey = new Map();
  for (const rawItem of raw.items || []) {
    const awemeId = String(rawItem?.awemeId || rawItem?.videoId || "");
    if (!awemeId) continue;
    const source = normalizeScope(rawItem.source);
    const item = {
      ...rawItem,
      awemeId,
      source,
      itemKey: downloadItemKey(source, awemeId),
      downloadStatus: rawItem.downloadStatus || "not_started",
    };
    const existing = itemsByKey.get(item.itemKey);
    itemsByKey.set(item.itemKey, existing ? { ...existing, ...item } : item);
  }
  return {
    ...raw,
    schemaVersion: DOWNLOAD_RECORD_SCHEMA_VERSION,
    generatedAt: raw.generatedAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.generatedAt || "",
    user: raw.user || { uid: "", nickname: "" },
    current: raw.current || {
      scope: "liked",
      phase: "idle",
      completed: 0,
      total: 0,
    },
    listSnapshots: raw.listSnapshots || {},
    items: [...itemsByKey.values()],
    events: Array.isArray(raw.events) ? raw.events : [],
  };
}

export function recordPaths(rootDir) {
  const appDataDir = path.join(rootDir, "data", ".appdata");
  return {
    appDataDir,
    record: path.join(appDataDir, "download-state.json"),
    log: path.join(appDataDir, "download-log.json"),
    manifestDir: path.join(appDataDir, "manifests"),
  };
}

export function loadDownloadRecord(rootDir) {
  const paths = recordPaths(rootDir);
  const record = fs.existsSync(paths.record)
    ? normalizeDownloadRecord(JSON.parse(fs.readFileSync(paths.record, "utf8")))
    : normalizeDownloadRecord();
  if (!record.events.length && fs.existsSync(paths.log)) {
    try {
      const persistedLog = JSON.parse(fs.readFileSync(paths.log, "utf8"));
      const events = Array.isArray(persistedLog.events)
        ? persistedLog.events
        : persistedLog.logs;
      if (Array.isArray(events)) record.events = events.slice(-2000);
    } catch {
      // A damaged diagnostic log must not block recovery from valid state.
    }
  }
  return record;
}

function atomicWriteText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = filePath + ".tmp";
  fs.writeFileSync(temporaryPath, text);
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    // Windows may reject rename-over-existing even though POSIX replaces it.
    // Keep the normal atomic path, then use a narrowly scoped compatibility
    // fallback so the second and later checkpoint writes remain reliable.
    try {
      if (!fs.existsSync(filePath)) throw error;
      fs.rmSync(filePath, { force: true });
      fs.renameSync(temporaryPath, filePath);
    } catch (fallbackError) {
      fs.rmSync(temporaryPath, { force: true });
      throw fallbackError;
    }
  }
}

export function saveDownloadRecord(rootDir, record) {
  const paths = recordPaths(rootDir);
  record.schemaVersion = DOWNLOAD_RECORD_SCHEMA_VERSION;
  record.updatedAt = new Date().toISOString();
  atomicWriteText(paths.record, JSON.stringify(record, null, 2) + "\n");
  atomicWriteText(paths.log, JSON.stringify({
    generatedAt: record.updatedAt,
    events: record.events || [],
    logs: record.events || [],
  }, null, 2) + "\n");
}

export function appendRecordEvent(record, text, meta = {}) {
  const event = {
    at: new Date().toISOString(),
    text,
    ...meta,
  };
  record.events = [...(record.events || []), event].slice(-2000);
  return event;
}

export function upsertDownloadItem(record, incoming) {
  const awemeId = String(incoming?.awemeId || incoming?.videoId || "");
  if (!awemeId) throw new Error("download item is missing awemeId");
  const source = normalizeScope(incoming.source);
  const itemKey = downloadItemKey(source, awemeId);
  const index = record.items.findIndex((item) => downloadItemKey(item.source, item.awemeId) === itemKey);
  const existing = index >= 0 ? record.items[index] : null;
  const item = {
    ...(existing || {}),
    ...incoming,
    awemeId,
    source,
    itemKey,
    downloadStatus: incoming.downloadStatus || existing?.downloadStatus || "not_started",
    updatedAt: new Date().toISOString(),
  };
  if (index >= 0) record.items[index] = item;
  else record.items.push(item);
  return item;
}

export function inferPreviousSnapshot(record, scope) {
  const normalizedScope = normalizeScope(scope);
  const stored = record.listSnapshots?.[normalizedScope];
  if (stored && Array.isArray(stored.ids)) return stored;
  const ids = uniqueIds(record.items
    .filter((item) => normalizeScope(item.source) === normalizedScope && item.listState !== "removed")
    .map((item) => item.awemeId));
  return ids.length ? {
    schemaVersion: 1,
    completedAt: record.generatedAt || record.updatedAt || "",
    ids,
    missingIds: [],
    migratedFromItems: true,
  } : null;
}

export function reconcileListSnapshot(previousSnapshot, currentIds, completedAt = new Date().toISOString()) {
  const ids = uniqueIds(currentIds);
  const hasBaseline = Boolean(previousSnapshot && Array.isArray(previousSnapshot.ids));
  const previousIds = uniqueIds(previousSnapshot?.ids || []);
  const previousMissingIds = uniqueIds(previousSnapshot?.missingIds || []);
  const currentSet = new Set(ids);
  const previousSet = new Set(previousIds);
  const previousMissingSet = new Set(previousMissingIds);

  const addedIds = hasBaseline
    ? ids.filter((id) => !previousSet.has(id) && !previousMissingSet.has(id))
    : [];
  const removedIds = hasBaseline
    ? previousIds.filter((id) => !currentSet.has(id))
    : [];
  const reappearedIds = hasBaseline
    ? ids.filter((id) => previousMissingSet.has(id))
    : [];
  const missingIds = uniqueIds([...previousMissingIds, ...removedIds])
    .filter((id) => !currentSet.has(id));

  return {
    hasBaseline,
    addedIds,
    removedIds,
    reappearedIds,
    snapshot: {
      schemaVersion: 1,
      completedAt,
      total: ids.length,
      ids,
      missingIds,
      lastChanges: {
        addedIds,
        removedIds,
        reappearedIds,
      },
    },
  };
}

export function applyListReconciliation(record, scope, reconciliation) {
  const normalizedScope = normalizeScope(scope);
  const present = new Set(reconciliation.snapshot.ids);
  const removed = new Set(reconciliation.snapshot.missingIds);
  for (const item of record.items) {
    if (normalizeScope(item.source) !== normalizedScope) continue;
    const awemeId = String(item.awemeId || "");
    if (present.has(awemeId)) {
      item.listState = "present";
      item.lastSeenInListAt = reconciliation.snapshot.completedAt;
      item.removedFromListAt = "";
    } else if (removed.has(awemeId)) {
      item.listState = "removed";
      item.removedFromListAt = item.removedFromListAt || reconciliation.snapshot.completedAt;
    }
    item.updatedAt = reconciliation.snapshot.completedAt;
  }
  record.listSnapshots = {
    ...(record.listSnapshots || {}),
    [normalizedScope]: reconciliation.snapshot,
  };
  return record;
}

export function mediaRelativePaths(scope, awemeId) {
  const normalizedScope = normalizeScope(scope);
  const sourceFolder = normalizedScope === "bookmarked" ? "\u6536\u85cf" : "\u70b9\u8d5e";
  const base = String(awemeId);
  return {
    video: path.posix.join("data", sourceFolder, "\u89c6\u9891", base + ".mp4"),
    cover: path.posix.join("data", sourceFolder, "\u5c01\u9762", base + ".jpg"),
    manifest: path.posix.join("data", ".appdata", "manifests", base + ".json"),
  };
}

export function writeJsonAtomic(filePath, value) {
  atomicWriteText(filePath, JSON.stringify(value, null, 2) + "\n");
}
