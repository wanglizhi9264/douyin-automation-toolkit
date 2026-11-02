import assert from "node:assert/strict";
import { Sources } from "../src/core/sources.js";
const profile = { uid: "self", secUid: "sec" };
const user = (n) => ({
  uid: String(n),
  sec_uid: "sec-" + n,
  nickname: "作者 " + n,
});
const requests = [];
const source = new Sources(
  async (type, payload) => {
    requests.push(payload);
    if (requests.length === 1)
      return {
        ok: true,
        users: Array.from({ length: 20 }, (_, n) => user(n)),
        hasMore: true,
        offset: 0,
        maxTime: 900,
        minTime: 500,
      };
    assert.equal(
      payload.maxTime,
      500,
      "older follows use the oldest timestamp of previous page",
    );
    assert.equal(
      payload.minTime,
      0,
      "must not reuse lower boundary as a filter",
    );
    return {
      ok: true,
      users: Array.from({ length: 15 }, (_, n) => user(n + 20)),
      hasMore: false,
      offset: 0,
      maxTime: 499,
      minTime: 100,
    };
  },
  { intervals: { following: 0 } },
);
const first = await source.authors(profile, null);
const second = await source.authors(profile, first.cursor);
assert.equal(first.done, false);
assert.equal(second.done, true);
assert.equal(
  new Set([...first.authors, ...second.authors].map((a) => a.uid)).size,
  35,
);
const offsetSource = new Sources(
  async () => ({
    ok: true,
    users: [user(1)],
    hasMore: true,
    offset: 20,
    maxTime: 0,
    minTime: 0,
  }),
  { intervals: { following: 0 } },
);
assert.deepEqual(
  (await offsetSource.authors(profile)).cursor,
  { offset: 20, maxTime: 0, minTime: 0 },
  "supports offset-based responses too",
);
const malformed = new Sources(
  async () => ({ ok: true, users: [], hasMore: null }),
  { intervals: { following: 0 } },
);
await assert.rejects(
  () => malformed.authors(profile),
  /格式异常/,
  "missing has_more cannot imply complete",
);
const empty = new Sources(
  async () => ({ ok: true, users: [], hasMore: true, offset: 20 }),
  { intervals: { following: 0 } },
);
assert.equal(
  (await empty.authors(profile)).done,
  false,
  "advancing empty pages are not treated as final",
);
const stalled = new Sources(
  async () => ({
    ok: true,
    users: [user(1)],
    hasMore: true,
    offset: 0,
    maxTime: 0,
    minTime: 0,
  }),
  { intervals: { following: 0 } },
);
await assert.rejects(() => stalled.authors(profile), /未读完/);
const partial = new Sources(
  async () => ({
    ok: true,
    users: [user(1), { uid: "missing-sec" }],
    hasMore: false,
  }),
  { intervals: { following: 0 } },
);
await assert.rejects(
  () => partial.authors(profile),
  /标识/,
  "do not silently discard authors with missing identifiers",
);
console.log(
  "OK: following time cursor, 35 unique authors, offset fallback, malformed/stalled pages, incomplete IDs",
);
