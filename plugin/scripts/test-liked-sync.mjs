import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const listeners = new Map();
const replies = [];
const requests = [];
const writtenFiles = new Map();
const videoUrl = "https://video.example/test.mp4";

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
globalThis.fetch = async (url) => {
  requests.push(String(url));
  if (String(url).includes("/user/profile/self/")) {
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ status_code: 0, user: { sec_uid: "sec-test", nickname: "tester" } });
      },
    };
  }
  if (String(url).includes("/aweme/favorite/")) {
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          status_code: 0,
          aweme_list: [{ aweme_id: "123", desc: "sample" }],
          has_more: 1,
          max_cursor: 456,
        });
      },
    };
  }
  if (String(url) === videoUrl) {
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    return new Response(new Blob([bytes], { type: "video/mp4" }), {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": String(bytes.byteLength),
        "accept-ranges": "bytes",
      },
    });
  }
  throw new Error("Unexpected URL: " + url);
};

const source = fs.readFileSync(new URL("../src/injected.js", import.meta.url), "utf8");
const sidebarSource = fs.readFileSync(new URL("../src/sidebar/app.js", import.meta.url), "utf8");
assert.doesNotMatch(
  sidebarSource,
  /async function downloadOne[^\{]*\{\s*async function syncNextLikedPage/,
  "syncNextLikedPage must not be nested inside downloadOne",
);
vm.runInThisContext(source, { filename: "injected.js" });
assert.match(
  sidebarSource,
  /async function runLikedDownloadFlow[\s\S]*while \(!scanState\.finished && !downloadPauseRequested\)/,
  "liked downloads must keep scanning until the terminal cursor",
);
assert.match(
  sidebarSource,
  /if \(scope === "liked"\) \{\s*await runLikedDownloadFlow\(/,
  "liked download button must route to the streaming flow",
);
assert.match(
  source,
  /type === "DOWNLOAD_TO_FOLDER"[\s\S]*downloadToFolderOnce\(/,
  "folder downloads must use the single-request implementation",
);
assert.match(
  sidebarSource,
  /rootHandle\.kind === "filesystem"[\s\S]*options: \{ expected: "video" \}[\s\S]*if \(!downloadedDirect\) try/,
  "filesystem video downloads must not precheck before the write request",
);
const onMessage = listeners.get("message");
assert.equal(typeof onMessage, "function");

await onMessage({
  source: globalThis.window,
  data: {
    source: "douyin-toolkit-content",
    requestId: "profile-1",
    type: "GET_SELF_PROFILE",
    payload: {},
  },
});
const profileReply = replies.find((entry) => entry.message.requestId === "profile-1");
assert.equal(profileReply.message.payload.ok, true);
assert.equal(profileReply.message.payload.json.user.sec_uid, "sec-test");

await onMessage({
  source: globalThis.window,
  data: {
    source: "douyin-toolkit-content",
    requestId: "liked-1",
    type: "FETCH_LIKED_PAGE",
    payload: { secUid: "sec-test", maxCursor: 123, minCursor: 7, count: 18 },
  },
});
const likedReply = replies.find((entry) => entry.message.requestId === "liked-1");
assert.equal(likedReply.message.payload.ok, true);
assert.equal(likedReply.message.payload.awemeList.length, 1);
assert.equal(likedReply.message.payload.maxCursor, 456);
assert.match(requests.at(-1), /sec_user_id=sec-test/);
assert.match(requests.at(-1), /max_cursor=123/);
assert.match(requests.at(-1), /min_cursor=7/);

function createDirectory(parts = []) {
  return {
    async getDirectoryHandle(name) {
      return createDirectory([...parts, name]);
    },
    async getFileHandle(name) {
      const path = [...parts, name].join("/");
      return {
        async createWritable() {
          return {
            async write(data) {
              writtenFiles.set(path, {
                size: data.size ?? data.byteLength ?? 0,
                type: data.type || "",
              });
            },
            async close() {},
          };
        },
      };
    },
  };
}

const requestCountBeforeDownload = requests.length;
await onMessage({
  source: globalThis.window,
  data: {
    source: "douyin-toolkit-content",
    requestId: "download-1",
    type: "DOWNLOAD_TO_FOLDER",
    payload: {
      rootHandle: createDirectory(),
      relativePath: "data/\u70b9\u8d5e/\u89c6\u9891/123.mp4",
      url: videoUrl,
      options: { expected: "video" },
    },
  },
});
const downloadReply = replies.find((entry) => entry.message.requestId === "download-1");
assert.equal(downloadReply.message.payload.ok, true);
assert.equal(requests.length - requestCountBeforeDownload, 1, "video write must fetch exactly once");
assert.equal(writtenFiles.get("data/\u70b9\u8d5e/\u89c6\u9891/123.mp4").size, 8);
assert.equal(writtenFiles.get("data/\u70b9\u8d5e/\u89c6\u9891/123.mp4").type, "video/mp4");

console.log("OK: liked-list page and single-request folder write runtime tests passed");
