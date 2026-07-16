import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

import { itemKeyFor } from "../src/shared/db.js";
import {
  advanceBookmarkedScanState,
  BOOKMARKED_PAGE_MIN_INTERVAL_MS,
  BOOKMARKED_PAGE_SIZE,
  createBookmarkedScanState,
  normalizeBookmarkedPageItems,
  parseBookmarkedProfile,
} from "../src/shared/bookmarked-sync.js";

const profile = parseBookmarkedProfile({
  json: {
    user: {
      sec_uid: "sec-bookmark",
      uid: "uid-bookmark",
      nickname: "collector",
      collect_count: 23,
    },
  },
});
assert.deepEqual(profile, {
  secUid: "sec-bookmark",
  uid: "uid-bookmark",
  nickname: "collector",
  expectedTotal: 23,
});
assert.equal(BOOKMARKED_PAGE_SIZE, 10);
assert.equal(BOOKMARKED_PAGE_MIN_INTERVAL_MS, 3000);

let state = createBookmarkedScanState(profile);
state = advanceBookmarkedScanState(state, {
  awemeList: [{ aweme_id: "1" }],
  hasMore: true,
  cursor: 10,
  total: 23,
}, 1);
assert.equal(state.finished, false);
assert.equal(state.cursor, 10);

state = advanceBookmarkedScanState(state, {
  awemeList: [{ aweme_id: "2" }],
  hasMore: false,
  cursor: 5,
}, 1);
assert.equal(state.finished, false, "has_more=false must continue until cursor reaches zero");

state = advanceBookmarkedScanState(state, {
  awemeList: [],
  hasMore: false,
  cursor: 0,
}, 0);
assert.equal(state.finished, true);
assert.equal(state.fullScan, true);

assert.throws(
  () => advanceBookmarkedScanState({ ...createBookmarkedScanState(profile), cursor: 9 }, {
    awemeList: [{ aweme_id: "3" }],
    hasMore: true,
    cursor: 9,
  }, 1),
  /cursor did not advance/,
);

const existing = [
  {
    awemeId: "same",
    index: 1,
    source: "liked",
    status: "already_favorited",
    downloadStatus: "downloaded",
    downloadVideoPath: "data/liked/same.mp4",
  },
  {
    awemeId: "saved",
    index: 2,
    source: "bookmarked",
    status: "already_favorited",
    downloadStatus: "downloaded",
    downloadVideoPath: "data/bookmarked/saved.mp4",
  },
];
const normalized = normalizeBookmarkedPageItems([
  {
    aweme_id: "same",
    desc: "also bookmarked",
    author: { uid: "author-1", nickname: "A" },
    video: { play_addr: { url_list: ["https://video/same"] } },
  },
  {
    aweme_id: "saved",
    desc: "already saved",
    author: { uid: "author-2", nickname: "B" },
    video: { play_addr: { url_list: ["https://video/saved"] } },
  },
  {
    aweme_id: "image",
    images: [{ url_list: ["https://image"] }],
  },
], existing, new Set());

assert.equal(normalized.items.length, 3);
assert.equal(normalized.skippedImages, 0);
const overlap = normalized.items.find((item) => item.awemeId === "same");
assert.equal(overlap.source, "bookmarked");
assert.equal(normalized.imageItems, 1);
const imageItem = normalized.items.find((item) => item.awemeId === "image");
assert.equal(imageItem.mediaType, "image");
assert.equal(imageItem.mediaParts.length, 1);
assert.equal(overlap.downloadStatus, "not_started");
assert.notEqual(itemKeyFor(overlap), itemKeyFor(existing[0]));
const saved = normalized.items.find((item) => item.awemeId === "saved");
assert.equal(saved.downloadStatus, "downloaded");
assert.equal(saved.downloadVideoPath, "data/bookmarked/saved.mp4");

const listeners = new Map();
const replies = [];
const requests = [];
globalThis.location = { href: "https://www.douyin.com/user/self" };
globalThis.document = { title: "Douyin" };
globalThis.window = {
  addEventListener(type, listener) {
    listeners.set(type, listener);
  },
  postMessage(message, origin) {
    replies.push({ message, origin });
  },
};
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), options });
  if (String(url).includes("/aweme/listcollection/")) {
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          status_code: 0,
          aweme_list: [{ aweme_id: "bookmarked-1", desc: "sample" }],
          has_more: 1,
          cursor: 456,
          total: 23,
        });
      },
    };
  }
  throw new Error("Unexpected URL: " + url);
};

const injectedSource = fs.readFileSync(new URL("../src/injected.js", import.meta.url), "utf8");
const sidebarSource = fs.readFileSync(new URL("../src/sidebar/app.js", import.meta.url), "utf8");
vm.runInThisContext(injectedSource, { filename: "injected.js" });
const onMessage = listeners.get("message");
await onMessage({
  source: globalThis.window,
  data: {
    source: "douyin-toolkit-content",
    requestId: "bookmarked-1",
    type: "FETCH_BOOKMARKED_PAGE",
    payload: { cursor: 123, count: 10 },
  },
});
const reply = replies.find((entry) => entry.message.requestId === "bookmarked-1");
assert.equal(reply.message.payload.ok, true);
assert.equal(reply.message.payload.cursor, 456);
assert.equal(reply.message.payload.awemeList.length, 1);
const request = requests.at(-1);
assert.match(request.url, /\/aweme\/v1\/web\/aweme\/listcollection\//);
assert.equal(request.options.method, "POST");
assert.equal(request.options.credentials, "include");
assert.match(String(request.options.body), /count=10/);
assert.match(String(request.options.body), /cursor=123/);

assert.match(
  sidebarSource,
  /if \(scope === "bookmarked"\) \{\s*await runBookmarkedDownloadFlow\(/,
);
assert.match(sidebarSource, /folderRecord\?\.current\?\.scope \|\| fallbackScope/);
assert.match(sidebarSource, /continueDownloadBtn/);

console.log("OK: bookmarked pagination, scoped resume, POST API, and overlap tests passed");
