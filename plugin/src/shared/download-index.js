export const DOWNLOAD_SCOPES = ["liked", "bookmarked", "following"];

export function createDownloadIndex(raw = null) {
  const scopes = {};
  for (const scope of DOWNLOAD_SCOPES) {
    scopes[scope] = new Set((raw?.scopes?.[scope]?.completed || []).map(String));
  }
  return {
    schemaVersion: 1,
    generatedAt: raw?.generatedAt || "",
    user: raw?.user || { uid: "", nickname: "" },
    scopes,
  };
}

export function serializeDownloadIndex(index, generatedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    generatedAt,
    user: index?.user || { uid: "", nickname: "" },
    scopes: Object.fromEntries(DOWNLOAD_SCOPES.map((scope) => [
      scope,
      { completed: [...(index?.scopes?.[scope] || [])].map(String).sort() },
    ])),
  };
}

export function isDownloadCompleted(index, scope, awemeId) {
  return Boolean(index?.scopes?.[scope]?.has(String(awemeId || "")));
}

export function markIndexCompleted(index, scope, awemeId) {
  if (!DOWNLOAD_SCOPES.includes(scope) || !awemeId) return false;
  index.scopes[scope] ||= new Set();
  const before = index.scopes[scope].size;
  index.scopes[scope].add(String(awemeId));
  return index.scopes[scope].size !== before;
}
