export const PENDING = new Set([
  "queued",
  "preparing",
  "downloading",
  "retry_wait",
  "committing",
]);
export const BUSY = new Set(["starting", "running", "pausing", "finalizing"]);
export function counters(task) {
  const c = {
    read: 0,
    saved: 0,
    upgraded: 0,
    existing: 0,
    failed: 0,
    unsupported: 0,
    pending: 0,
  };
  for (const item of Object.values(task?.items || {})) {
    c.read++;
    if (item.state === "saved") {
      if (item.upgraded) c.upgraded++;
      else c.saved++;
    } else if (item.state === "existing") c.existing++;
    else if (item.state === "failed") c.failed++;
    else if (item.state === "unsupported") c.unsupported++;
    else c.pending++;
  }
  return c;
}
export function runCounters(task) {
  const all = counters(task),
    run = task?.run;
  return run
    ? {
        read: run.checked || 0,
        saved: run.saved || 0,
        upgraded: run.upgraded || 0,
        existing: run.existing || 0,
        failed: run.failed || 0,
        pending: all.pending,
        unsupported: run.unsupported || 0,
      }
    : all;
}
export function newTask(scope, accountUid, authors = []) {
  return {
    id: crypto.randomUUID(),
    scope,
    accountUid,
    authors,
    status: "starting",
    createdAt: new Date().toISOString(),
    items: {},
    cursor: null,
    sourceDone: false,
    sourceErrors: [],
    platformTotal: null,
  };
}
export function summary(state) {
  const result = {
    unique: 0,
    bytes: 0,
    sizeKnown: true,
    unknownWorks: 0,
    sources: { liked: 0, bookmarked: 0, following: 0 },
  };
  for (const work of Object.values(state.works))
    if (work.complete) {
      result.unique++;
      if (work.legacy && !work.files?.length) {
        result.sizeKnown = false;
        result.unknownWorks++;
      }
      for (const scope of new Set(work.sources || []))
        if (scope in result.sources) result.sources[scope]++;
    }
  for (const file of Object.values(state.files))
    if (file.complete) result.bytes += file.size;
  return result;
}
export function finishStatus(task) {
  const c = counters(task);
  if (!task.sourceDone || c.pending) return "paused";
  return c.failed || c.unsupported || task.sourceErrors.length
    ? "partial"
    : "completed";
}
export function abortError() {
  return new DOMException("任务已暂停", "AbortError");
}
export function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}
export function sleep(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}
