import assert from "node:assert/strict";
import { floatingProgress, sourceProgress } from "../src/core/progress.js";
import { summary } from "../src/core/model.js";
import { Sources } from "../src/core/sources.js";
import { measureSizes } from "../src/maintenance/measure.js";
const stats = { sources: { bookmarked: 15000 } };
const profile = {
  uid: "self",
  totals: { bookmarked: null },
  bookmarkedDisplay: "约1.3万",
};
const approximate = sourceProgress(stats, "bookmarked", {
  profile,
  ownerUid: "self",
});
assert.equal(approximate.total, null);
assert.equal(approximate.displayTotal, "约1.3万");
assert.equal(approximate.totalSource, "display");
assert.equal(
  sourceProgress(stats, "bookmarked", { profile, ownerUid: "other" })
    .displayTotal,
  null,
);
const complete = sourceProgress(stats, "bookmarked", {
  task: {
    scope: "bookmarked",
    accountUid: "self",
    sourceDone: true,
    listTotal: 123,
  },
  ownerUid: "self",
});
assert.equal(complete.total, 123);
assert.equal(complete.totalSource, "list");
assert.equal(
  sourceProgress(stats, "bookmarked", {
    task: {
      scope: "bookmarked",
      accountUid: "self",
      sourceDone: false,
      items: { 1: {} },
    },
    ownerUid: "self",
  }).total,
  null,
);
assert.equal(
  floatingProgress(
    { status: "running" },
    new Map([
      ["a", { total: 100, loaded: 50 }],
      ["b", { total: 100, loaded: 0 }],
    ]),
  ).value,
  50,
);
assert.equal(
  floatingProgress(
    { status: "running" },
    new Map([["a", { total: 0, loaded: 50 }]]),
  ).value,
  null,
);
assert.equal(floatingProgress({ status: "paused" }).value, 0);
assert.equal(floatingProgress({ status: "completed" }).visible, false);
assert.equal(
  floatingProgress({
    status: "running",
    sourceDone: true,
    items: { a: { state: "saved" }, b: { state: "queued" } },
  }).value,
  null,
);
let calls = 0;
const sources = new Sources(
  async () => {
    calls++;
    return {
      ok: true,
      awemeList: [{ aweme_id: "1" }],
      hasMore: false,
      cursor: 0,
      hasTotal: true,
      total: 42,
    };
  },
  { intervals: { bookmarked: 0 }, paginationDelays: [] },
);
const p = { uid: "self", totals: { bookmarked: null } };
await sources.probeBookmarkedTotal(p);
assert.equal(p.totals.bookmarked, 42);
await sources.page({ scope: "bookmarked", cursor: null }, p);
assert.equal(calls, 1, "count probe first page is reused for download");
const state = {
  works: {
    a: { id: "a", legacy: true, complete: true, sources: ["liked"], files: [] },
    b: { id: "b", legacy: true, complete: true, sources: ["liked"], files: [] },
  },
  files: { known: { path: "known", size: 100, complete: true } },
};
let reads = 0,
  commits = 0;
const repo = {
  state,
  load: async () => {},
  io: {
    json: async (path) =>
      path.endsWith("a.json")
        ? { parts: [{ path: "data/a.mp4", partId: "video-1", kind: "video" }] }
        : null,
    file: async () => {
      reads++;
      return { size: 50 };
    },
    read: async () => null,
  },
  commit: async (patch) => {
    commits++;
    for (const w of patch.works) state.works[w.id] = w;
    for (const f of patch.files) state.files[f.path] = f;
  },
};
const lock = { request: async (name, options, fn) => fn({}) };
const before = summary(state);
assert.equal(before.bytes, 100);
assert.equal(before.sizeKnown, false);
assert.equal(before.unknownWorks, 2);
const result = await measureSizes(repo, { lock });
assert.equal(result.unresolved, 1);
assert.equal(reads, 1);
assert.equal(commits, 1);
const after = summary(state);
assert.equal(after.bytes, 150);
assert.equal(after.unknownWorks, 1);
assert.equal(
  state.works.b.complete,
  true,
  "measurement never invalidates legacy backup or removes media",
);
const abort = new AbortController();
abort.abort();
await assert.rejects(() => measureSizes(repo, { lock, signal: abort.signal }), {
  name: "AbortError",
});
console.log(
  "OK: truthful approximate/complete counts, probe reuse, weighted transfer ring, idle size backfill, unresolved records and cancellation",
);

const activeRing = new Map([
  ["first", { total: 100, loaded: 25, parts: 2, part: 2 }],
  ["second", { total: 100, loaded: 90 }],
]);
assert.equal(
  floatingProgress({ status: "running" }, activeRing, "first").value,
  63,
);
assert.equal(
  floatingProgress(
    { status: "running" },
    new Map([...activeRing, ["third", { total: 100, loaded: 0 }]]),
    "first",
  ).value,
  63,
  "new transfer does not reset selected work ring",
);
