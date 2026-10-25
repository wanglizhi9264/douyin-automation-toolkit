import assert from "node:assert/strict";

import {
  createDownloadIndex,
  isDownloadCompleted,
  markIndexCompleted,
  serializeDownloadIndex,
} from "../src/shared/download-index.js";

const index = createDownloadIndex({
  schemaVersion: 1,
  user: { uid: "user-1", nickname: "tester" },
  scopes: {
    liked: { completed: ["3", "1"] },
    bookmarked: { completed: ["1"] },
  },
});
assert.equal(isDownloadCompleted(index, "liked", "1"), true);
assert.equal(isDownloadCompleted(index, "following", "1"), false);
assert.equal(markIndexCompleted(index, "liked", "2"), true);
assert.equal(markIndexCompleted(index, "liked", "2"), false);
assert.equal(markIndexCompleted(index, "invalid", "4"), false);

const serialized = serializeDownloadIndex(index, "2026-10-06T00:00:00.000Z");
assert.deepEqual(serialized.scopes.liked.completed, ["1", "2", "3"]);
assert.deepEqual(serialized.scopes.bookmarked.completed, ["1"]);
assert.deepEqual(serialized.scopes.following.completed, []);
assert.equal(serialized.user.uid, "user-1");

console.log("OK: compact scoped download index contracts passed");
