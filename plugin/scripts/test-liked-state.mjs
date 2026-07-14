import assert from "node:assert/strict";
import {
  advanceLikedScanState,
  createLikedScanState,
  normalizeLikedPageItems,
  parseLikedProfile,
} from "../src/shared/liked-sync.js";

const profile = parseLikedProfile({
  json: {
    user: {
      sec_uid: "sec-1",
      uid: "uid-1",
      nickname: "tester",
      favoriting_count: 42,
    },
  },
});
assert.deepEqual(profile, {
  secUid: "sec-1",
  uid: "uid-1",
  nickname: "tester",
  expectedTotal: 42,
});

let state = createLikedScanState(profile);
state = advanceLikedScanState(state, {
  awemeList: [{ aweme_id: "1" }, { aweme_id: "2" }],
  hasMore: true,
  maxCursor: 100,
  minCursor: 0,
}, 2);
assert.equal(state.finished, false);
assert.equal(state.checked, 2);

state = advanceLikedScanState(state, {
  awemeList: [{ aweme_id: "3" }],
  hasMore: false,
  maxCursor: 50,
  minCursor: 0,
}, 1);
assert.equal(state.finished, false, "has_more=false must continue until max_cursor reaches zero");

state = advanceLikedScanState(state, {
  awemeList: [],
  hasMore: false,
  maxCursor: 0,
  minCursor: 0,
}, 0);
assert.equal(state.finished, true);
assert.equal(state.fullScan, true);

assert.throws(
  () => advanceLikedScanState({ ...createLikedScanState(profile), maxCursor: 99 }, {
    awemeList: [{ aweme_id: "4" }],
    hasMore: true,
    maxCursor: 99,
    minCursor: 0,
  }, 1),
  /cursor did not advance/,
);

const existing = [{
  awemeId: "1",
  index: 7,
  source: "liked",
  status: "already_favorited",
  downloadStatus: "downloaded",
  downloadVideoPath: "data/liked/1.mp4",
  desc: "old",
}];
const seen = new Set();
const normalized = normalizeLikedPageItems([
  {
    aweme_id: "1",
    desc: "refreshed",
    author: { uid: "author-1", nickname: "A" },
    video: { play_addr: { url_list: ["https://video/1"] } },
  },
  {
    aweme_id: "2",
    desc: "new",
    author: { uid: "author-2", nickname: "B" },
    video: { play_addr: { url_list: ["https://video/2"] } },
  },
  {
    aweme_id: "2",
    desc: "duplicate",
    video: { play_addr: { url_list: ["https://video/2"] } },
  },
  {
    aweme_id: "3",
    images: [],
  },
], existing, seen);

assert.equal(normalized.items.length, 2);
assert.equal(normalized.skippedDuplicates, 1);
assert.equal(normalized.skippedImages, 1);
assert.equal(normalized.items[0].downloadStatus, "downloaded");
assert.equal(normalized.items[0].downloadVideoPath, "data/liked/1.mp4");
assert.equal(normalized.items[0].desc, "refreshed");
assert.equal(normalized.items[1].downloadStatus, "not_started");

console.log("OK: liked scan state and merge tests passed");

