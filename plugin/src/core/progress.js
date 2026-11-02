// Platform list totals and historical backups are separate sets. A historical
// backup remains after an unlike, so it must never be subtracted from a total
// to invent a remaining-download count or a coverage percentage.
export function countOrUnknown(value) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  )
    return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function profileTotal(profile, scope) {
  if (profile?.totals && Object.hasOwn(profile.totals, scope))
    return countOrUnknown(profile.totals[scope]);
  return countOrUnknown(
    scope === "liked"
      ? profile?.expectedTotal
      : scope === "bookmarked"
        ? profile?.bookmarkedTotal
        : null,
  );
}

export function sourceProgress(stats, scope, { profile, task, ownerUid } = {}) {
  const sameAccount =
    profile?.uid && (!ownerUid || String(ownerUid) === String(profile.uid));
  const liveTotal = sameAccount ? profileTotal(profile, scope) : null;
  const taskMatches =
    task?.scope === scope &&
    (!ownerUid || String(task.accountUid) === String(ownerUid));
  // 0.7.0 used zero when the server omitted the field. Only a timestamped
  // observation can distinguish that legacy default from a confirmed zero.
  const recordedTotal =
    taskMatches && !(task.platformTotal === 0 && !task.platformTotalAt)
      ? countOrUnknown(task.platformTotal)
      : null;
  const displayTotal =
    sameAccount &&
    scope === "bookmarked" &&
    /^约[\d.]+[万亿w]$/i.test(profile.bookmarkedDisplay || "")
      ? profile.bookmarkedDisplay
      : null;
  const listTotal =
    taskMatches && task.sourceDone
      ? countOrUnknown(
          task.listTotal ??
            task.run?.checked ??
            Object.keys(task.items || {}).length,
        )
      : null;
  const total =
    liveTotal ?? (displayTotal ? null : (recordedTotal ?? listTotal));
  const saved = stats?.sources?.[scope] ?? null;
  return {
    total,
    displayTotal: liveTotal === null ? displayTotal : null,
    saved,
    totalSource:
      liveTotal !== null
        ? "live"
        : displayTotal
          ? "display"
          : recordedTotal !== null
            ? "recorded"
            : listTotal !== null
              ? "list"
              : "unknown",
    readAt:
      liveTotal !== null
        ? profile.readAt
        : taskMatches
          ? task.platformTotalAt || task.createdAt
          : null,
    includesHistory: scope === "liked" || scope === "bookmarked",
    historicalExceedsTotal: total !== null && saved !== null && saved > total,
  };
}

// Ring describes this run/current transfers, never saved-history / platform total.
export function floatingProgress(task, active = new Map(), selectedId = null) {
  if (
    !task ||
    !["starting", "running", "pausing", "finalizing", "paused"].includes(
      task.status,
    )
  )
    return { visible: false, value: 0, label: "暂无下载任务", key: null };
  const entries = [...(active?.entries() || [])];
  const current = entries.find(([id]) => id === selectedId) || entries[0];
  if (current) {
    const [key, item] = current;
    if (item.total > 0) {
      const parts = Math.max(1, item.parts || 1),
        part = Math.max(1, item.part || 1);
      const value = Math.min(
        100,
        Math.max(
          0,
          Math.round(
            ((part - 1 + Math.min(1, (item.loaded || 0) / item.total)) /
              parts) *
              100,
          ),
        ),
      );
      return { visible: true, value, key, label: `当前作品 ${value}%` };
    }
    return { visible: true, value: null, key, label: "正在准备媒体" };
  }
  return {
    visible: true,
    value: task.status === "paused" ? 0 : null,
    key: null,
    label:
      task.status === "paused"
        ? "下载已暂停"
        : task.retryOnly
          ? "正在准备重试"
          : "正在检查列表",
  };
}
