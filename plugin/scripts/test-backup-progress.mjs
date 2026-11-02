import assert from "node:assert/strict";
import {
  sourceProgress,
  profileTotal,
  countOrUnknown,
} from "../src/core/progress.js";
import { Sources } from "../src/core/sources.js";

const stats = { sources: { liked: 8767, bookmarked: 11352, following: 601 } };
const profile = {
  uid: "self",
  totals: { liked: 8383, bookmarked: null },
  readAt: "2026-10-27T12:00:00.000Z",
};
const result = sourceProgress(stats, "liked", {
  profile,
  ownerUid: "self",
  task: { scope: "liked", accountUid: "self", platformTotal: 8380, items: {} },
});
assert.equal(result.total, 8383);
assert.equal(
  result.saved,
  8767,
  "new task must retain historical source total before reading any list page",
);
assert.equal(result.historicalExceedsTotal, true);
assert.equal(result.totalSource, "live");
assert.equal(
  sourceProgress(stats, "liked", { profile, ownerUid: "other" }).total,
  null,
  "never mix another account into a library total",
);
const recorded = sourceProgress(stats, "liked", {
  ownerUid: "self",
  task: {
    scope: "liked",
    accountUid: "self",
    platformTotal: 8383,
    createdAt: "2026-10-27T10:00:00Z",
  },
});
assert.equal(recorded.saved, 8767);
assert.equal(recorded.total, 8383);
assert.equal(recorded.totalSource, "recorded");
assert.equal(
  sourceProgress(stats, "bookmarked", { profile, ownerUid: "self" }).total,
  null,
  "missing count is unknown, not zero",
);
assert.equal(
  sourceProgress(stats, "bookmarked", {
    task: { scope: "bookmarked", platformTotal: 0 },
    ownerUid: null,
  }).total,
  null,
  "legacy zero default is ambiguous",
);
assert.equal(
  sourceProgress(stats, "bookmarked", {
    task: {
      scope: "bookmarked",
      platformTotal: 0,
      platformTotalAt: "2026-10-27T10:00:00Z",
    },
    ownerUid: null,
  }).total,
  0,
);
assert.equal(
  profileTotal({ ...profile, totals: { liked: 0 } }, "liked"),
  0,
  "an explicitly reported zero is displayed as zero",
);
assert.equal(
  profileTotal({ expectedTotal: 40 }, "liked"),
  40,
  "older injected source adapters remain compatible",
);
for (const value of [
  null,
  undefined,
  "",
  true,
  false,
  -1,
  NaN,
  Infinity,
  "bad",
])
  assert.equal(countOrUnknown(value), null);
assert.equal(countOrUnknown("8383"), 8383);

let user = { uid: "self", sec_uid: "sec", favoriting_count: "8383" };
const sources = new Sources(async () => ({ ok: true, json: { user } }));
const fetched = await sources.profile();
assert.equal(fetched.totals.liked, 8383);
assert.equal(fetched.totals.bookmarked, null);
assert.ok(fetched.readAt);
user = { ...user, collect_count: 0, favoriting_count: 0 };
const zero = await sources.profile();
assert.equal(zero.totals.bookmarked, 0);
assert.equal(zero.totals.liked, 0);
console.log(
  "OK: source totals retain historical backups, separate current platform totals, preserve unknown vs zero and prevent account mixing",
);
