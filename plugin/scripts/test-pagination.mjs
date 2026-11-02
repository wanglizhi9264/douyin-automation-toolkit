import assert from "node:assert/strict";
import fs from "node:fs";
import { Sources } from "../src/core/sources.js";
import { cursorKey } from "../src/core/pagination.js";
const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/liked-nonzero-end.json", import.meta.url),
    "utf8",
  ),
);
const profile = { uid: "self", secUid: "self-sec" };
const packet = (cursor, hasMore, ids = []) => ({
  ok: true,
  httpStatus: 200,
  statusCode: 0,
  maxCursor: cursor,
  minCursor: 0,
  hasMore,
  awemeList: ids.map((id) => ({ aweme_id: String(id) })),
  json: {
    status_code: 0,
    has_more: hasMore ? 1 : 0,
    max_cursor: cursor,
    aweme_list: ids.map((id) => ({ aweme_id: String(id) })),
  },
});
function source(pages, options = {}) {
  const calls = [];
  let index = 0;
  const result = new Sources(
    async (type, payload) => {
      calls.push({ type, payload });
      return structuredClone(pages[Math.min(index++, pages.length - 1)]);
    },
    {
      intervals: { liked: 0, bookmarked: 0, following: 0, detail: 0 },
      paginationDelays: [0, 0],
      paginationWait: async () => {},
      ...options,
    },
  );
  return { source: result, calls };
}
const terminal = source([fixture.response]);
const end = await terminal.source.page(
  { scope: "liked", cursor: fixture.input, items: {} },
  profile,
);
assert.equal(end.done, true);
assert.equal(end.items.length, 13);
assert.equal(end.cursor.maxCursor, 1783511616000);
assert.equal(end.end.confirmations, 2);
assert.equal(terminal.calls.length, 2);
assert.ok(
  terminal.calls.every((c) => c.payload.maxCursor === fixture.input.maxCursor),
  "confirm at saved checkpoint, never restart at zero",
);
const gap = source([packet(90, true, []), packet(80, true, [1])]);
let task = {
  scope: "liked",
  cursor: { maxCursor: 100, minCursor: 0 },
  sourceEmptyPages: 0,
};
const empty = await gap.source.page(task, profile);
assert.equal(empty.done, false);
assert.equal(empty.emptyPages, 1);
assert.equal(empty.cursor.maxCursor, 90);
const resumed = await gap.source.page(
  { ...task, cursor: empty.cursor, sourceEmptyPages: empty.emptyPages },
  profile,
);
assert.equal(resumed.items.length, 1);
assert.equal(resumed.emptyPages, 0);
const recovery = source([packet(100, true, [1]), packet(90, true, [2])]);
const recovered = await recovery.source.page(task, profile);
assert.equal(recovered.cursor.maxCursor, 90);
assert.deepEqual(
  recovered.items.map((i) => i.aweme_id),
  ["1", "2"],
  "retain useful data from an anomalous response",
);
assert.equal(recovered.trace[0].decision, "retry");
const stall = source([packet(100, true, [1])]);
await assert.rejects(
  () => stall.source.page(task, profile),
  (error) =>
    error.name === "PaginationError" &&
    error.page.items.length === 1 &&
    error.page.cursor.maxCursor === 100 &&
    error.page.trace.length === 3,
);
assert.equal(stall.calls.length, 3);
const missing = source([
  {
    ok: true,
    awemeList: [],
    hasMore: false,
    maxCursor: 0,
    json: { status_code: 0, aweme_list: [] },
  },
]);
await assert.rejects(
  () => missing.source.page(task, profile),
  (error) => error.name === "PaginationError",
);
const canonical = source([packet(0, false, [1])]);
assert.equal((await canonical.source.page(task, profile)).done, true);
assert.equal(canonical.calls.length, 1);
const changed = source([packet(80, false, [1, 2]), packet(90, true, [2, 3])]);
const continuing = await changed.source.page(task, profile);
assert.equal(continuing.done, false);
assert.deepEqual(
  continuing.items.map((i) => i.aweme_id),
  ["1", "2", "3"],
);
const loop = source([packet(90, true, [1])]);
await assert.rejects(
  () =>
    loop.source.page(task, profile, undefined, {
      seenCursors: new Set([
        cursorKey({ maxCursor: "90", minCursor: "0" }, "liked"),
      ]),
    }),
  (error) => error.name === "PaginationError",
);
assert.equal(
  cursorKey({ minCursor: 0, maxCursor: "100" }, "liked"),
  cursorKey({ maxCursor: 100, minCursor: "0" }, "liked"),
);
const manyEmpty = source([packet(90, true, [])]);
await assert.rejects(
  () => manyEmpty.source.page({ ...task, sourceEmptyPages: 12 }, profile),
  (error) => error.name === "PaginationError",
);
const cancelled = source([fixture.response]);
const controller = new AbortController();
cancelled.source.onPaginationRetry = async () => controller.abort();
await assert.rejects(
  () =>
    cancelled.source.page(
      { ...task, cursor: fixture.input },
      profile,
      controller.signal,
    ),
  (error) => error.name === "AbortError",
);
assert.equal(cancelled.calls.length, 1);
const bookmark = source([
  { ok: true, awemeList: [{ aweme_id: "7" }], cursor: 23, hasMore: false },
]);
const b = await bookmark.source.page(
  { scope: "bookmarked", cursor: { cursor: 30 } },
  profile,
);
assert.equal(b.done, true);
assert.equal(b.items.length, 1);
assert.equal(b.end.confirmations, 2);
const author = source([packet(50, false, [8])]);
const a = await author.source.page(
  {
    scope: "following",
    cursor: { authorIndex: 0, maxCursor: 60 },
    authors: [{ secUid: "a" }, { secUid: "b" }],
  },
  profile,
);
assert.equal(a.done, false);
assert.equal(a.cursor.authorIndex, 1);
assert.equal(a.cursor.maxCursor, 0);
console.log(
  "OK: real nonzero 13-work end page, explicit terminal confirmation, empty-gap continuation, stalled-page retry/recovery, data retention, loop/schema/empty-budget protection, cancellation and all three scopes",
);
