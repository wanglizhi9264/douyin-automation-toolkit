import assert from "node:assert/strict";
import { Repository } from "../src/archive/repository.js";
import { seal } from "../src/archive/fs.js";
import { Engine } from "../src/core/engine.js";
import { Sources } from "../src/core/sources.js";
import { counters, sleep } from "../src/core/model.js";

function memoryFS() {
  const nodes = new Map();
  function dir(path = "") {
    return {
      kind: "directory",
      name: path.split("/").at(-1) || "测试备份",
      async queryPermission() {
        return "granted";
      },
      async getDirectoryHandle(name, { create = false } = {}) {
        const p = path ? path + "/" + name : name;
        if (!nodes.has(p)) {
          if (!create) throw new DOMException("missing", "NotFoundError");
          nodes.set(p, { directory: true });
        }
        return dir(p);
      },
      async getFileHandle(name, { create = false } = {}) {
        const p = path ? path + "/" + name : name;
        if (!nodes.has(p)) {
          if (!create) throw new DOMException("missing", "NotFoundError");
          nodes.set(p, new Uint8Array());
        }
        return {
          kind: "file",
          name,
          async getFile() {
            const bytes = nodes.get(p);
            return new File([bytes], name);
          },
          async createWritable({ keepExistingData = false } = {}) {
            let bytes = keepExistingData
                ? nodes.get(p).slice()
                : new Uint8Array(),
              position = 0;
            return {
              async write(value) {
                const incoming =
                  typeof value === "string"
                    ? new TextEncoder().encode(value)
                    : value;
                const next = new Uint8Array(
                  Math.max(bytes.length, position + incoming.length),
                );
                next.set(bytes);
                next.set(incoming, position);
                bytes = next;
                position += incoming.length;
              },
              async seek(n) {
                position = n;
              },
              async truncate(n) {
                bytes = bytes.slice(0, n);
              },
              async close() {
                nodes.set(p, bytes);
              },
              async abort() {},
            };
          },
        };
      },
      async removeEntry(name) {
        nodes.delete(path ? path + "/" + name : name);
      },
      async *values() {
        for (const [p, value] of nodes) {
          const relative = path
            ? p.startsWith(path + "/")
              ? p.slice(path.length + 1)
              : null
            : p;
          if (!relative || relative.includes("/")) continue;
          yield value.directory ? dir(p) : await this.getFileHandle(relative);
        }
      },
    };
  }
  return { target: { kind: "filesystem", handle: dir() }, nodes };
}
function mutex() {
  let held = false;
  return {
    async request(name, options, callback) {
      if (held) return callback(null);
      held = true;
      try {
        return await callback({ name });
      } finally {
        held = false;
      }
    },
  };
}
const profile = {
  uid: "self",
  secUid: "sec",
  nickname: "测试账号",
  expectedTotal: 137,
  bookmarkedTotal: 137,
};
function fakeSources(total = 137, { badPage = false } = {}) {
  let pages = 0;
  return {
    get pages() {
      return pages;
    },
    profile: async () => profile,
    async page(task, p, signal) {
      check(signal);
      const start = task.cursor?.offset || 0;
      if (badPage && start >= 18) throw new Error("列表未完整读取");
      pages++;
      return {
        items: Array.from({ length: Math.min(18, total - start) }, (_, i) => ({
          aweme_id: String(start + i + 1),
          desc: "作品 " + (start + i + 1),
        })),
        cursor: { offset: Math.min(total, start + 18) },
        done: start + 18 >= total,
      };
    },
  };
}
function check(signal) {
  if (signal?.aborted) throw new DOMException("pause", "AbortError");
}
const waitFor = async (predicate) => {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("test wait timed out");
};

const fs = memoryFS(),
  repo = await Repository.open(fs.target),
  lock = mutex(),
  source = fakeSources();
let active = 0,
  maxActive = 0,
  firstAtPage = 0,
  maxQueue = 0;
const downloader = async (item, raw, signal, progress) => {
  active++;
  maxActive = Math.max(active, maxActive);
  if (!firstAtPage) firstAtPage = source.pages;
  try {
    await sleep(3, signal);
    progress({ loaded: 10, total: 10 });
    await repo.commit({
      works: [
        {
          id: item.id,
          complete: true,
          sources: [item.scope],
          files: [],
          lastTask: item.taskId,
        },
      ],
    });
  } finally {
    active--;
  }
};
const engine = new Engine(repo, source, downloader, { lock });
engine.subscribe(() => {
  maxQueue = Math.max(maxQueue, engine.queue.length + engine.active.size);
});
await engine.start("liked");
assert.equal(engine.error, "");
assert.equal(engine.task.status, "completed");
assert.equal(counters(engine.task).saved, 137);
assert.equal(repo.stats.unique, 137);
assert.equal(maxActive, 2);
assert.ok(firstAtPage < 8, "downloads start before the entire list is read");
assert.ok(maxQueue <= 64, "bounded producer queue");
const downloaded = repo.stats.unique;
await engine.start("bookmarked");
assert.equal(counters(engine.task).existing, 137);
assert.equal(counters(engine.task).saved, 0);
assert.equal(repo.stats.unique, downloaded);
assert.equal(repo.stats.sources.bookmarked, 137);
assert.equal(
  Object.values(repo.state.works)[0].sources.length,
  2,
  "source relations survive cross-scope skipping",
);
const reopened = await Repository.open(fs.target);
assert.equal(reopened.stats.unique, 137);
assert.equal(reopened.latestTask("bookmarked").status, "completed");
await assert.rejects(
  () => reopened.bind({ ...profile, uid: "other" }),
  /其他账号/,
);

const pausedFS = memoryFS(),
  pausedRepo = await Repository.open(pausedFS.target);
let begun = 0;
const slow = async (item, raw, signal) => {
  begun++;
  await sleep(70, signal);
  await pausedRepo.commit({
    works: [
      {
        id: item.id,
        complete: true,
        sources: [item.scope],
        files: [],
        lastTask: item.taskId,
      },
    ],
  });
};
const paused = new Engine(pausedRepo, fakeSources(41), slow, { lock: mutex() });
const run = paused.start("liked");
await waitFor(() => begun === 2);
await paused.pause();
await run;
assert.equal(paused.task.status, "paused");
assert.equal(counters(paused.task).failed, 0);
assert.ok(counters(paused.task).pending > 0);
const interrupted = await Repository.open(pausedFS.target);
const resumed = new Engine(
  interrupted,
  fakeSources(41),
  async (item) => {
    await interrupted.commit({
      works: [
        {
          id: item.id,
          complete: true,
          sources: [item.scope],
          files: [],
          lastTask: item.taskId,
        },
      ],
    });
  },
  { lock: mutex() },
);
await resumed.start("liked", [], interrupted.latestTask("liked"));
assert.equal(resumed.task.status, "completed");
assert.equal(counters(resumed.task).saved, 41);

const badFS = memoryFS(),
  badRepo = await Repository.open(badFS.target);
const bad = new Engine(
  badRepo,
  fakeSources(40, { badPage: true }),
  async (item) => {
    await badRepo.commit({
      works: [
        {
          id: item.id,
          complete: true,
          sources: [item.scope],
          files: [],
          lastTask: item.taskId,
        },
      ],
    });
  },
  { lock: mutex() },
);
await bad.start("liked");
assert.equal(bad.task.status, "paused");
assert.equal(bad.task.sourceDone, false);
assert.equal(counters(bad.task).saved, 18);
assert.equal(bad.task.sourceErrors.length, 1);
const lockedFS = memoryFS(),
  lockedRepo = await Repository.open(lockedFS.target);
await lockedRepo.initialize();
const unavailable = new Engine(lockedRepo, fakeSources(), async () => {}, {
  lock: { request: async (name, opts, fn) => fn(null) },
});
await unavailable.start("liked");
assert.match(unavailable.error, /其他标签页/);
assert.equal(
  Object.keys(lockedRepo.state.tasks).length,
  0,
  "failed lock acquisition cannot write task records",
);

// An uncommitted or corrupt latest head must recover the previous durable generation.
const recoveredFS = memoryFS(),
  recovered = await Repository.open(recoveredFS.target);
await recovered.initialize();
await recovered.commit({ owner: { uid: "old" } });
await recovered.commit({ owner: { uid: "new" } });
const head = recovered.head;
const broken = await seal({ ...head, tail: "missing-event" });
await recovered.io.write(
  `data/.appdata/v2/heads/${head.revision % 2 ? "b" : "a"}.json`,
  broken,
);
const fallback = await Repository.open(recoveredFS.target);
assert.equal(fallback.state.owner.uid, "old");

const calls = [];
const realSources = new Sources(
  async (type, payload) => {
    calls.push(type);
    if (type === "GET_SELF_PROFILE")
      return { ok: true, json: { user: { uid: "self", sec_uid: "sec" } } };
    return {
      ok: true,
      awemeList: [],
      hasMore: true,
      maxCursor: 0,
      minCursor: 0,
    };
  },
  {
    intervals: { liked: 0, bookmarked: 0, following: 0, detail: 0 },
    paginationDelays: [],
  },
);
await assert.rejects(
  () => realSources.page({ scope: "liked", cursor: null }, profile),
  (error) => error.name === "PaginationError" && error.page.items.length === 0,
);
const authorSource = new Sources(
  async () => ({ ok: true, users: [], hasMore: true, offset: 0 }),
  { intervals: { following: 0 } },
);
await assert.rejects(() => authorSource.authors(profile), /未读完/);
// Pause during preparation must still leave a usable continue action.
const earlyFS = memoryFS(),
  earlyRepo = await Repository.open(earlyFS.target),
  earlySource = fakeSources(2);
const originalProfile = earlySource.profile;
earlySource.profile = async (signal) => {
  await sleep(20, signal);
  return originalProfile();
};
const early = new Engine(
  earlyRepo,
  earlySource,
  async (item) => {
    await earlyRepo.commit({
      works: [
        {
          id: item.id,
          complete: true,
          sources: [item.scope],
          files: [],
          lastTask: item.taskId,
        },
      ],
    });
  },
  { lock: mutex() },
);
const earlyRun = early.start("liked");
await early.pause();
await earlyRun;
assert.equal(early.error, "");
assert.equal(early.task.status, "paused");
await early.start("liked", [], early.task);
assert.equal(early.task.status, "completed");
assert.equal(early.counts.saved, 2);

// Storage errors stop both consumers and preserve retryable items rather than marking each work failed.
const quotaFS = memoryFS(),
  quotaRepo = await Repository.open(quotaFS.target);
let diskFull = true;
const quota = new Engine(
  quotaRepo,
  fakeSources(5),
  async (item) => {
    if (diskFull) throw new DOMException("测试磁盘已满", "QuotaExceededError");
    await quotaRepo.commit({
      works: [
        {
          id: item.id,
          complete: true,
          sources: [item.scope],
          files: [],
          lastTask: item.taskId,
        },
      ],
    });
  },
  { lock: mutex() },
);
await quota.start("liked");
assert.match(quota.error, /磁盘已满/);
assert.equal(quota.task.status, "paused");
assert.equal(quota.counts.failed, 0);
diskFull = false;
await quota.start("liked", [], quotaRepo.latestTask("liked"));
assert.equal(quota.counts.saved, 5);
assert.equal(quota.task.status, "completed");

const { filesystem } = await import("../src/archive/fs.js");
const legacyFS = memoryFS(),
  legacyIO = filesystem(legacyFS.target);
await legacyIO.write("data/.appdata/download-index.json", {
  schemaVersion: 1,
  user: {},
  scopes: { liked: { completed: ["x"] }, bookmarked: { completed: ["x"] } },
});
await legacyIO.write("data/.appdata/download-state.json", {
  user: { uid: "other", nickname: "历史账号" },
  items: [],
});
const legacy = await Repository.open(legacyFS.target);
assert.equal(legacy.stats.unique, 1);
assert.equal(legacy.stats.sizeKnown, false);
assert.equal(legacy.stats.sources.bookmarked, 1);
await assert.rejects(() => legacy.bind(profile), /其他账号/);
const unknownFS = memoryFS();
await unknownFS.target.handle.getFileHandle("个人文件.txt", { create: true });
const nodeCount = unknownFS.nodes.size;
await assert.rejects(
  () => Repository.open(unknownFS.target),
  /没有可识别的备份记录/,
);
assert.equal(
  unknownFS.nodes.size,
  nodeCount,
  "opening unknown folders must not create a library",
);

const retryFS = memoryFS(),
  retryRepo = await Repository.open(retryFS.target);
await retryRepo.initialize();
const originalWrite = retryRepo.io.write.bind(retryRepo.io);
retryRepo.io.write = async (path, value) => {
  if (path.includes("/journal/"))
    throw new DOMException("磁盘写入失败", "QuotaExceededError");
  return originalWrite(path, value);
};
await assert.rejects(
  () => retryRepo.commit({ owner: { uid: "self" } }),
  /无法保存备份/,
);
assert.equal(retryRepo.poisoned, true);
retryRepo.io.write = originalWrite;
await retryRepo.load();
assert.equal(retryRepo.poisoned, false);
await retryRepo.commit({ owner: { uid: "self" } });
assert.equal(retryRepo.state.owner.uid, "self");

// Rate-limited work stays retryable when a shared cooldown budget is exhausted.
const { httpError } = await import("../src/shared/http.js");
const rateFS = memoryFS(),
  rateRepo = await Repository.open(rateFS.target),
  rateSources = fakeSources(5);
const rateInfo = {
  until: Date.now() + 60000,
  status: 429,
  attempt: 5,
  maxRetries: 4,
  reason: "HTTP 429 限流",
  exhausted: true,
};
rateSources.retry = { last: rateInfo, subscribe() {}, restore() {} };
const rateEngine = new Engine(
  rateRepo,
  rateSources,
  async (item, raw, signal, progress) => {
    await progress({ retry: rateInfo });
    const error = httpError(429);
    error.retryExhausted = true;
    throw error;
  },
  { lock: mutex() },
);
await rateEngine.start("liked");
assert.equal(rateEngine.task.status, "paused");
assert.equal(rateEngine.counts.failed, 0);
assert.equal(rateEngine.counts.pending, 5);
assert.equal(rateRepo.latestTask("liked").retryState.until, rateInfo.until);
assert.match(rateEngine.error, /429/);

// Reproduce the user's paused 8,035-work run at a nonzero terminal cursor.
const paginationFixture = JSON.parse(
  await (
    await import("node:fs/promises")
  ).readFile(
    new URL("./fixtures/liked-nonzero-end.json", import.meta.url),
    "utf8",
  ),
);
const tailFS = memoryFS(),
  tailRepo = await Repository.open(tailFS.target),
  tailTaskId = "real-shape-tail-task";
const prefix = Array.from({ length: 8035 }, (_, i) => String(10000000 + i)),
  tailIds = paginationFixture.response.awemeList.map((i) => i.aweme_id),
  historyIds = Array.from({ length: 964 }, (_, i) => String(20000000 + i));
const tailTask = {
  id: tailTaskId,
  scope: "liked",
  accountUid: "self",
  authors: [],
  createdAt: "2026-10-27T10:29:51Z",
  status: "paused",
  items: Object.fromEntries(
    prefix.map((id, i) => [
      id,
      {
        id,
        scope: "liked",
        taskId: tailTaskId,
        state: i < 271 ? "saved" : "existing",
      },
    ]),
  ),
  cursor: paginationFixture.input,
  sourceDone: false,
  sourceErrors: ["old pagination failure"],
  platformTotal: 8479,
};
await tailRepo.commit({
  owner: { uid: "self", nickname: "test" },
  works: [...prefix, ...tailIds, ...historyIds].map((id) => ({
    id,
    complete: true,
    legacy: true,
    sources: ["liked"],
    files: [],
  })),
  tasks: [tailTask],
});
const tailCalls = [];
const tailSource = new Sources(
  async (type, payload) => {
    if (type === "GET_SELF_PROFILE")
      return {
        ok: true,
        json: {
          user: {
            uid: "self",
            sec_uid: "sec",
            nickname: "test",
            favoriting_count: 8479,
          },
        },
      };
    tailCalls.push(payload);
    const start = Number(payload.maxCursor || 0);
    if (start >= prefix.length)
      return structuredClone(paginationFixture.response);
    const next = Math.min(prefix.length, start + 18);
    return {
      ok: true,
      hasMore: true,
      maxCursor: next,
      minCursor: 0,
      awemeList: prefix.slice(start, next).map((id) => ({ aweme_id: id })),
    };
  },
  {
    intervals: { liked: 0, bookmarked: 0, following: 0, detail: 0 },
    paginationDelays: [0],
    paginationWait: async () => {},
  },
);
let tailTransfers = 0;
const tailEngine = new Engine(
  tailRepo,
  tailSource,
  async () => {
    tailTransfers++;
  },
  { lock: mutex() },
);
await tailEngine.start("liked", [], tailRepo.latestTask("liked"));
assert.equal(tailEngine.error, "");
assert.equal(tailEngine.task.status, "completed");
assert.equal(tailEngine.counts.read, 8048);
assert.equal(tailEngine.counts.saved, 0);
assert.equal(counters(tailRepo.state.tasks[tailTaskId]).saved, 271);
assert.equal(tailEngine.counts.existing, 8048);
assert.equal(tailRepo.stats.sources.liked, 9012);
assert.equal(
  tailTransfers,
  0,
  "13 existing tail works require zero media transfers",
);
assert.equal(tailCalls[0].maxCursor, 0);
assert.ok(tailCalls.slice(-2).every((p) => p.maxCursor === prefix.length));
assert.equal(tailEngine.task.previousTaskId, tailTaskId);
assert.equal(tailEngine.task.sourceEnd.confirmations, 2);
assert.ok(tailEngine.task.sourcePageHistory.length);

// Even a page with an unrecoverable cursor must not discard its valid works.
const rescueFS = memoryFS(),
  rescueRepo = await Repository.open(rescueFS.target);
const rescueSource = new Sources(
  async (type) =>
    type === "GET_SELF_PROFILE"
      ? { ok: true, json: { user: { uid: "self", sec_uid: "sec" } } }
      : {
          ok: true,
          awemeList: [{ aweme_id: "8801" }],
          hasMore: true,
          maxCursor: 0,
          minCursor: 0,
        },
  {
    intervals: { liked: 0, bookmarked: 0, following: 0, detail: 0 },
    paginationDelays: [],
  },
);
const rescue = new Engine(
  rescueRepo,
  rescueSource,
  async (item) => {
    await rescueRepo.commit({
      works: [
        {
          id: item.id,
          complete: true,
          sources: ["liked"],
          files: [],
          lastTask: item.taskId,
        },
      ],
    });
  },
  { lock: mutex() },
);
await rescue.start("liked");
assert.equal(rescue.task.status, "paused");
assert.equal(rescue.counts.saved, 1);
assert.equal(rescue.task.cursor, null);
assert.equal(rescue.task.sourceDone, false);
assert.ok(rescue.task.sourcePageHistory.length);
assert.equal(rescue.counts.failed, 0);

// Every activation starts at the newest list, including paused/partial jobs.
const syncFS = memoryFS(),
  syncRepo = await Repository.open(syncFS.target);
let likedIds = Array.from({ length: 12 }, (_, i) => String(i + 1)),
  downloadedIds = [],
  fail17 = false;
const syncSource = {
  profile: async () => ({ ...profile, expectedTotal: likedIds.length }),
  calls: [],
  async page(task, p, signal) {
    await sleep(5, signal);
    const offset = task.cursor?.offset || 0;
    this.calls.push(offset);
    const next = Math.min(likedIds.length, offset + 4);
    return {
      items: likedIds.slice(offset, next).map((id) => ({ aweme_id: id })),
      cursor: { offset: next },
      done: next >= likedIds.length,
    };
  },
};
const syncEngine = new Engine(
  syncRepo,
  syncSource,
  async (item, raw, signal) => {
    downloadedIds.push(item.id);
    await sleep(25, signal);
    if (item.id === "17" && fail17) throw new Error("media unavailable");
    await syncRepo.commit({
      works: [
        {
          id: item.id,
          complete: true,
          sources: ["liked"],
          files: [],
          lastTask: item.taskId,
        },
      ],
    });
  },
  { lock: mutex() },
);
const firstSync = syncEngine.start("liked");
await waitFor(() => syncEngine.counts.saved >= 2);
await syncEngine.pause();
await firstSync;
const oldSync = structuredClone(syncEngine.task),
  previouslyComplete = new Set(Object.keys(syncRepo.state.works));
assert.equal(oldSync.status, "paused");
likedIds = ["13", "14", ...Array.from({ length: 11 }, (_, i) => String(i + 1))];
downloadedIds = [];
syncSource.calls = [];
await syncEngine.start("liked", [], oldSync);
assert.equal(syncSource.calls[0], 0);
assert.notEqual(syncEngine.task.id, oldSync.id);
assert.equal(syncEngine.task.previousTaskId, oldSync.id);
assert.equal(syncEngine.task.status, "completed");
assert.equal(syncEngine.counts.read, 13);
assert.ok(downloadedIds.includes("13") && downloadedIds.includes("14"));
assert.ok(
  !downloadedIds.includes("12"),
  "unlisted previous queue entries are not blindly downloaded",
);
assert.ok(
  downloadedIds.every((id) => !previouslyComplete.has(id)),
  "existing completed media never transfers again",
);
assert.ok(
  syncRepo.state.tasks[oldSync.id],
  "previous run history remains intact",
);
likedIds = ["15", ...likedIds];
downloadedIds = [];
syncSource.calls = [];
await syncEngine.start("liked");
assert.deepEqual(downloadedIds, ["15"]);
assert.equal(syncEngine.counts.saved, 1);
assert.equal(syncEngine.counts.existing, 13);
assert.equal(syncSource.calls[0], 0);
const sameTotal = likedIds.length;
likedIds = ["16", ...likedIds.filter((id) => id !== "5")];
downloadedIds = [];
syncSource.calls = [];
await syncEngine.start("liked");
assert.equal(likedIds.length, sameTotal);
assert.deepEqual(
  downloadedIds,
  ["16"],
  "unchanged total still discovers changed contents",
);
assert.ok(
  syncRepo.state.works["5"].complete,
  "unlikes preserve historical files",
);
likedIds = ["1", ...likedIds.filter((id) => id !== "1")];
downloadedIds = [];
await syncEngine.start("liked");
assert.deepEqual(
  downloadedIds,
  [],
  "re-liking an existing work does not create another download",
);
likedIds = ["17", ...likedIds];
fail17 = true;
await syncEngine.start("liked");
assert.equal(syncEngine.task.status, "partial");
assert.equal(syncEngine.task.sourceDone, true);
const partialSync = structuredClone(syncEngine.task);
likedIds = ["18", ...likedIds];
fail17 = false;
downloadedIds = [];
syncSource.calls = [];
await syncEngine.start("liked", [], partialSync);
assert.equal(syncEngine.task.status, "completed");
assert.equal(syncSource.calls[0], 0);
assert.deepEqual(
  new Set(downloadedIds),
  new Set(["17", "18"]),
  "retrying a fully scanned partial run also checks new likes",
);
console.log(
  "OK: fresh-list business scenarios — pause/new likes/unlikes, completed run with new likes, unchanged totals, re-likes, failed-media retry plus new likes, old history and no completed-media retransfers",
);
console.log(
  "OK: backup engine runtime — 137 works, 2 transfers, bounded queue, source dedupe, pause/reopen/resume, incomplete pagination, lock exclusion and journal recovery",
);

{
  const retryFS = memoryFS(),
    retryRepo = await Repository.open(retryFS.target),
    retrySource = fakeSources(3);
  let shouldFail = true;
  const retryDownloads = [];
  const retryEngine = new Engine(
    retryRepo,
    retrySource,
    async (item) => {
      retryDownloads.push(item.id);
      if (shouldFail && item.id !== "1") {
        const e = new Error(item.id === "2" ? "HTTP 403" : "作品暂不可用");
        if (item.id === "3") e.unsupported = true;
        throw e;
      }
      await retryRepo.commit({
        works: [
          {
            id: item.id,
            complete: true,
            sources: [item.scope],
            files: [],
            lastTask: item.taskId,
          },
        ],
      });
    },
    { lock: mutex() },
  );
  await retryEngine.start("liked");
  assert.equal(retryEngine.task.status, "partial");
  const failedTask = structuredClone(retryEngine.task),
    pagesBeforeRetry = retrySource.pages;
  shouldFail = false;
  retryDownloads.length = 0;
  await retryEngine.retryFailures(failedTask);
  assert.deepEqual(new Set(retryDownloads), new Set(["2", "3"]));
  assert.equal(
    retrySource.pages,
    pagesBeforeRetry,
    "failed-only retry never paginates source lists",
  );
  assert.equal(retryEngine.task.run.fromLatest, false);
  assert.equal(retryEngine.task.run.checked, 2);
  assert.equal(retryEngine.task.run.saved, 2);
  assert.equal(retryEngine.task.status, "completed");
  assert.equal(
    retryEngine.task.listTotal,
    3,
    "failed-only run retains complete list count instead of replacing it with failure count",
  );
  assert.equal(retryRepo.stats.unique, 3);
  assert.throws(() => retryEngine.retryFailures(failedTask), /没有需要重试/);
  console.log(
    "OK: failed-only retry refreshes just failed/unsupported works, skips completed works and list pages, preserves source totals",
  );
}

{
  const batchFS = memoryFS(),
    batchRepo = await Repository.open(batchFS.target),
    calls = [],
    downloads = [];
  const authors = [
    { uid: "A", secUid: "secA", nickname: "作者A" },
    { uid: "B", secUid: "secB", nickname: "作者B" },
  ];
  let pauseOn = "A2",
    started = false;
  const source = new Sources(
    async (type, payload) => {
      if (type === "GET_SELF_PROFILE")
        return {
          ok: true,
          json: { user: { uid: "self", sec_uid: "sec", nickname: "测试账号" } },
        };
      if (type === "FETCH_AUTHOR_AWEME_PAGE") {
        const a = payload.secUid === "secA" ? "A" : "B";
        calls.push(a);
        if (a === "B")
          assert.ok(
            batchRepo.state.works.A1?.complete &&
              batchRepo.state.works.A2?.complete,
            "next author listing waits until previous media completes",
          );
        return {
          ok: true,
          awemeList: [1, 2].map((n) => ({ aweme_id: a + n, desc: a + n })),
          hasMore: false,
          maxCursor: 0,
        };
      }
      throw new Error("unexpected " + type);
    },
    { intervals: { following: 0, detail: 0 } },
  );
  const download = async (item, raw, signal) => {
    downloads.push(item.id);
    if (item.id === pauseOn) {
      started = true;
      await sleep(1000, signal);
    }
    await batchRepo.commit({
      works: [
        {
          id: item.id,
          complete: true,
          sources: ["following"],
          files: [],
          lastTask: item.taskId,
        },
      ],
    });
  };
  const first = new Engine(batchRepo, source, download, { lock: mutex() });
  void first.start("following", authors);
  for (let n = 0; n < 1000 && !started; n++) await sleep(2);
  assert.ok(started);
  await first.pause();
  const checkpoint = structuredClone(first.task);
  assert.equal(checkpoint.cursor.authorIndex, 1);
  assert.equal(checkpoint.status, "paused");
  assert.equal(calls.includes("B"), false);
  pauseOn = null;
  const resumed = new Engine(batchRepo, source, download, { lock: mutex() });
  await resumed.continueFollowing(checkpoint);
  assert.deepEqual(
    calls,
    ["A", "B"],
    "continue does not re-read completed author pages",
  );
  assert.equal(resumed.task.run.continuingFollowing, true);
  assert.equal(resumed.task.status, "completed");
  assert.equal(batchRepo.stats.unique, 4);
  assert.equal(resumed.task.authorProgress.A.status, "completed");
  assert.equal(resumed.task.authorProgress.B.status, "completed");
  await batchRepo.commit({
    followingSelection: { authors, updatedAt: "test" },
  });
  const reopened = await Repository.open(batchFS.target);
  assert.deepEqual(
    reopened.state.followingSelection.authors,
    authors,
    "selection survives reopening",
  );
  // Last author's list can be complete while media is still pending.
  const last = structuredClone(resumed.task);
  last.status = "paused";
  last.items.B2 = { ...last.items.B2, state: "queued" };
  await batchRepo.commit({
    tasks: [last],
    works: [{ ...batchRepo.state.works.B2, complete: false }],
  });
  const before = calls.length;
  const tail = new Engine(batchRepo, source, download, { lock: mutex() });
  await tail.continueFollowing(last);
  assert.equal(tail.task.status, "completed");
  assert.equal(
    calls.length,
    before,
    "last-author pending media resumes without listing",
  );
  const stale=structuredClone(tail.task);stale.status='paused';stale.items.B2.state='queued';
  await batchRepo.commit({tasks:[stale]});
  const priorTransfers=downloads.length;
  const recovered=new Engine(batchRepo,source,download,{lock:mutex()});
  await recovered.continueFollowing(stale);
  assert.equal(recovered.task.status,'completed');assert.equal(downloads.length,priorTransfers,'completed media with stale queued record is reconciled without transfer');
  console.log(
    "OK: strictly sequential authors, persisted selection, pause/reopen/checkpoint continuation, last-author pending media",
  );
}
{
  const fs = memoryFS(),
    repo = await Repository.open(fs.target);
  const old = {
    path: "data/old.mp4",
    workId: "quality",
    qualityOutcome: "degraded",
    highest:{width:1080,height:1920},
    partId: "video-1",
    kind: "video",
    complete: true,
    size: 10,
    quality: { width: 720, height: 1280 },
  };
  await repo.commit({
    works: [
      { id: "quality", complete: true, files: [old.path], sources: ["liked"] },
    ],
    files: [old],
  });
  await repo.io.write(old.path, "0123456789");
  const source = {
    profile: async () => profile,
    page: async () => ({
      items: [
        {
          aweme_id: "quality",
          video: {
            play_addr: {
              url_list: ["https://media.test/high"],
              width: 1080,
              height: 1920,
            },
          },
        },
      ],
      cursor: { offset: 1 },
      done: true,
    }),
  };
  let downloads = 0;
  const engine = new Engine(
    repo,
    source,
    async (item) => {
      downloads++;
      assert.equal(item.upgrade, true);
      await repo.commit({
        files: [{ ...old, quality: { width: 1080, height: 1920 } }],
      });
      return { upgraded: true };
    },
    { lock: mutex() },
  );
  await engine.start("liked");
  assert.equal(downloads, 1);
  assert.equal(engine.task.run.saved, 0);
  assert.equal(engine.task.run.upgraded, 1);
  assert.equal(repo.stats.unique, 1);
  await engine.start("liked");
  assert.equal(downloads, 1, "already upgraded work is skipped on future runs");
  await repo.commit({files:[{...old,qualityOutcome:'best'}]});
  await engine.start('liked');
  assert.equal(downloads,1,'best flag skips even a later higher-resolution list candidate');
  console.log(
    "OK: completed works upgrade via bounded queue, counted separately from new backups, equal quality skipped",
  );
}

// Failed media must release slots, then be recovered exactly once after discovery.
for (const permanentlyUnavailable of [false, true]) {
  const recoveryRepo = await Repository.open(memoryFS().target);
  const source = fakeSources(6), calls = [];
  const engine = new Engine(recoveryRepo, source, async (item, raw) => {
    calls.push({ id: item.id, recovery: item.recoveryRound || 0, raw });
    if (["1", "3"].includes(item.id) && (!item.recoveryRound || permanentlyUnavailable))
      throw Object.assign(new Error("HTTP 403"), { deferToSweep: true });
    await recoveryRepo.commit({ works: [{ id: item.id, complete: true,
      files: [], sources: [item.scope], lastTask: item.taskId }] });
  }, { lock: mutex(), capacity: 4 });
  await engine.start("liked");
  const main = calls.filter(c => !c.recovery), tail = calls.filter(c => c.recovery);
  assert.equal(main.length, 6);
  assert.deepEqual(tail.map(c => c.id).sort(), ["1", "3"]);
  assert.equal(calls.findIndex(c => c.recovery), 6, "all main items precede recovery");
  assert.ok(tail.every(c => !c.raw), "recovery refreshes addresses rather than reusing stale list data");
  assert.equal(source.pages, 1, "automatic sweep never re-reads the list");
  assert.equal(engine.task.run.checked, 6, "recovery doesn't inflate checked totals");
  assert.equal(engine.task.run.saved, permanentlyUnavailable ? 4 : 6);
  assert.equal(engine.task.run.failed, permanentlyUnavailable ? 2 : 0);
  assert.equal(engine.task.recovery.recovered, permanentlyUnavailable ? 0 : 2);
  assert.equal(engine.task.status, permanentlyUnavailable ? "partial" : "completed");
}
{
  const recoveryRepo = await Repository.open(memoryFS().target);
  const engine = new Engine(recoveryRepo, fakeSources(3), async (item, raw, signal) => {
    if (!item.recoveryRound) throw Object.assign(new Error("temporarily unavailable"), {deferToSweep:true});
    await sleep(10000, signal);
  }, {lock:mutex()});
  const done = engine.start("liked");
  await waitFor(() => engine.task.recovery?.status === "running" && engine.active.size > 0);
  await engine.pause();
  await done;
  assert.equal(engine.task.status, "paused");
  assert.equal(engine.task.recovery.status, "paused");
  assert.equal(engine.task.run.checked, 3);
  assert.ok(engine.counts.pending > 0);
}
console.log("OK: one automatic tail sweep, fresh addresses, unchanged checked counts, no infinite failures, pause cancels recovery");
{
  const recoveryRepo = await Repository.open(memoryFS().target), calls = [];
  const authors = [{uid:'A',secUid:'secA',nickname:'A'},{uid:'B',secUid:'secB',nickname:'B'}];
  let activeAuthor = null, activeCount = 0;
  const sources = new Sources(async(type,payload)=>{
    if(type==='GET_SELF_PROFILE') return {ok:true,json:{user:{uid:'self',sec_uid:'sec'}}};
    const author=payload.secUid==='secA'?'A':'B';
    return {ok:true,awemeList:[1,2].map(n=>({aweme_id:author+n,desc:author+n})),hasMore:false,maxCursor:0};
  },{intervals:{following:0,detail:0}});
  const engine=new Engine(recoveryRepo,sources,async(item,raw,signal)=>{
    assert.ok(!activeCount||activeAuthor===item.authorUid,'authors never overlap, including automatic sweep');
    activeAuthor=item.authorUid;activeCount++;
    calls.push([item.id,item.recoveryRound||0]);
    try {
      await sleep(3,signal);
      if(!item.recoveryRound) throw Object.assign(new Error('HTTP 403'),{deferToSweep:true});
      await recoveryRepo.commit({works:[{id:item.id,complete:true,files:[],sources:['following'],lastTask:item.taskId}]});
    } finally {activeCount--;}
  },{lock:mutex()});
  await engine.start('following',authors);
  assert.deepEqual(calls.map(c=>c[1]),[0,0,0,0,1,1,1,1]);
  assert.equal(engine.task.authorProgress.A.status,'completed');
  assert.equal(engine.task.authorProgress.B.status,'completed');
  assert.equal(engine.task.run.checked,4);
}
console.log('OK: automatic following recovery preserves sequential authors and refreshes author completion state');
