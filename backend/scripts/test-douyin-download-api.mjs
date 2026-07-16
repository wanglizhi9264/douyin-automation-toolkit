import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  downloadMedia,
  fetchAwemeDetail,
  fetchBookmarkedPage,
  fetchLikedPage,
  fetchSelfProfile,
  requestWithRetry,
} from "./douyin-download-api.mjs";
import {
  resolveScope,
  resolveBrowserExecutable,
  updateRecordTotals,
} from "./douyin-download.mjs";

const browserFixture = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-browser-resolve-"));
try {
  const existingBrowser = path.join(browserFixture, "chrome.exe");
  fs.writeFileSync(existingBrowser, "");
  assert.equal(
    resolveBrowserExecutable([path.join(browserFixture, "missing.exe"), existingBrowser]),
    existingBrowser,
  );
} finally {
  fs.rmSync(browserFixture, { recursive: true, force: true });
}

function createPage(handler) {
  return {
    async evaluate(callback, input) {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (url, options = {}) => {
        const payload = await handler(String(url), options);
        const status = Number(payload.status ?? 200);
        return {
          ok: status >= 200 && status < 300,
          status,
          async text() {
            return typeof payload.body === "string"
              ? payload.body
              : JSON.stringify(payload.json ?? {});
          },
        };
      };
      try {
        return await callback(input);
      } finally {
        globalThis.fetch = previousFetch;
      }
    },
  };
}

const requests = [];
const page = createPage(async (url, options) => {
  requests.push({ url, options });
  if (url.includes("/user/profile/self/")) {
    return { json: { status_code: 0, user: { uid: "u1", sec_uid: "s1" } } };
  }
  if (url.includes("/aweme/favorite/")) {
    return {
      json: {
        status_code: 0,
        aweme_list: [{ aweme_id: "liked-1" }],
        has_more: 1,
        max_cursor: 123,
        min_cursor: 45,
      },
    };
  }
  if (url.includes("/aweme/listcollection/")) {
    return {
      json: {
        status_code: 0,
        aweme_list: [{ aweme_id: "saved-1" }],
        has_more: 0,
        cursor: 0,
        data: { total_count: 1 },
      },
    };
  }
  if (url.includes("/aweme/detail/")) {
    return {
      json: {
        status_code: 0,
        aweme_detail: {
          aweme_id: "liked-1",
          desc: "detail",
          author: { uid: "author-1", nickname: "author" },
          video: { cover: { url_list: ["https://cover.invalid/1.jpg"] } },
        },
      },
    };
  }
  return { status: 404, json: { status_code: 1, status_msg: "not found" } };
});

const profile = await fetchSelfProfile(page);
assert.equal(profile.ok, true);
assert.equal(profile.json.user.uid, "u1");

const likedPage = await fetchLikedPage(page, {
  secUid: "s1",
  maxCursor: 0,
  minCursor: 0,
  count: 18,
});
assert.equal(likedPage.ok, true);
assert.equal(likedPage.hasMore, true);
assert.equal(likedPage.maxCursor, 123);
const likedRequest = requests.find((entry) => entry.url.includes("/aweme/favorite/"));
assert.match(likedRequest.url, /sec_user_id=s1/);
assert.match(likedRequest.url, /count=18/);

const bookmarkedPage = await fetchBookmarkedPage(page, { cursor: 0, count: 10 });
assert.equal(bookmarkedPage.ok, true);
assert.equal(bookmarkedPage.hasMore, false);
assert.equal(bookmarkedPage.total, 1);
assert.equal(bookmarkedPage.hasTotal, true);
const bookmarkedRequest = requests.find((entry) => entry.url.includes("/aweme/listcollection/"));
assert.equal(bookmarkedRequest.options.method, "POST");
assert.equal(bookmarkedRequest.options.headers["content-type"], "application/x-www-form-urlencoded");
assert.equal(bookmarkedRequest.options.body.get("count"), "10");
assert.equal(bookmarkedRequest.options.body.get("cursor"), "0");

const detail = await fetchAwemeDetail(page, "liked-1");
assert.equal(detail.ok, true);
assert.equal(detail.desc, "detail");
assert.equal(detail.coverUrl, "https://cover.invalid/1.jpg");
assert.equal(detail.aweme.aweme_id, "liked-1");

let attempts = 0;
let retryNotices = 0;
const retried = await requestWithRetry(async () => {
  attempts += 1;
  return attempts === 1 ? { ok: false, statusMsg: "retry" } : { ok: true, value: 42 };
}, {
  retries: 3,
  delayForAttempt: () => 0,
  onRetry: () => {
    retryNotices += 1;
  },
});
assert.equal(retried.value, 42);
assert.equal(attempts, 2);
assert.equal(retryNotices, 1);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-download-api-"));
try {
  const destination = path.join(tempRoot, "video.mp4");
  const bytes = Buffer.from("verified-video");
  const context = {
    request: {
      async get(url, options) {
        assert.equal(url, "https://media.invalid/video.mp4");
        assert.equal(options.headers.referer, "https://www.douyin.com/");
        return {
          status: () => 200,
          headers: () => ({
            "content-type": "video/mp4",
            "content-length": String(bytes.length),
          }),
          body: async () => bytes,
        };
      },
    },
  };
  const result = await downloadMedia(
    context,
    "https://media.invalid/video.mp4",
    destination,
    { expected: "video", timeoutMs: 1000 },
  );
  assert.equal(result.contentLength, bytes.length);
  assert.deepEqual(fs.readFileSync(destination), bytes);
  assert.equal(fs.existsSync(destination + ".part"), false);

  const invalidContext = {
    request: {
      async get() {
        return {
          status: () => 200,
          headers: () => ({ "content-type": "text/html", "content-length": "4" }),
          body: async () => Buffer.from("oops"),
        };
      },
    },
  };
  await assert.rejects(
    downloadMedia(invalidContext, "https://media.invalid/error", path.join(tempRoot, "bad.mp4")),
    /video MIME/,
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

assert.equal(resolveScope("resume", {}, { current: { scope: "bookmarked" } }), "bookmarked");
assert.equal(resolveScope("download-liked", {}, { current: { scope: "bookmarked" } }), "liked");
const totalsRecord = {
  items: [
    { source: "liked", downloadStatus: "downloaded", listState: "present" },
    { source: "liked", downloadStatus: "downloaded", listState: "removed" },
    { source: "bookmarked", downloadStatus: "failed", listState: "present" },
  ],
};
updateRecordTotals(totalsRecord);
assert.equal(totalsRecord.likedTotal, 1);
assert.equal(totalsRecord.bookmarkedTotal, 1);
assert.equal(totalsRecord.downloadedTotal, 1);
assert.equal(totalsRecord.failedTotal, 1);

console.log("OK: backend Douyin API contract, verified media write, and resume scope tests passed");
