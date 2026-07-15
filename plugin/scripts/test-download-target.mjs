import assert from "node:assert/strict";
import fs from "node:fs";

import { downloadVerifiedMedia, resolveDownloadTargetRecord } from "../src/shared/download.js";

let requests = 0;
const handle = {
  async queryPermission() {
    return "prompt";
  },
  async requestPermission() {
    requests += 1;
    return "granted";
  },
};

const passive = await resolveDownloadTargetRecord({ handle, label: "backup" });
assert.equal(passive.permission, "prompt");
assert.equal(requests, 0);

const granted = await resolveDownloadTargetRecord(
  { handle, label: "backup" },
  { requestPermission: true },
);
assert.equal(granted.permission, "granted");
assert.equal(granted.label, "backup");
assert.equal(requests, 1);
assert.equal(await resolveDownloadTargetRecord(null), null);

const pickerSource = fs.readFileSync(new URL("../src/folder-picker/app.js", import.meta.url), "utf8");
const backgroundSource = fs.readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
assert.match(pickerSource, /startIn: stored\?\.handle \|\| "videos"/);
assert.match(pickerSource, /getDirectoryHandle\("data", \{ create: true \}\)/);
assert.match(pickerSource, /getDirectoryHandle\("\.appdata", \{ create: true \}\)/);
assert.match(backgroundSource, /pickerUrl\.searchParams\.set\("returnTabId"/);

const sidebarSource = fs.readFileSync(new URL("../src/sidebar/app.js", import.meta.url), "utf8");
assert.doesNotMatch(sidebarSource, /sendPageRequest\("DOWNLOAD_TO_FOLDER"/);
assert.match(sidebarSource, /downloadVerifiedMedia\(\s*rootHandle,/);

const writtenFiles = new Map();
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

let mediaFetchCount = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  mediaFetchCount += 1;
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
  return new Response(new Blob([bytes], { type: "video/mp4" }), {
    status: 200,
    headers: {
      "content-type": "video/mp4",
      "content-length": String(bytes.byteLength),
      "accept-ranges": "bytes",
    },
  });
};
try {
  const result = await downloadVerifiedMedia(
    { kind: "filesystem", handle: createDirectory(), label: "backup" },
    "data/\u70b9\u8d5e/\u89c6\u9891/123.mp4",
    "https://video.example/123.mp4",
    { expected: "video", headerTimeoutMs: 1000, totalTimeoutMs: 2000 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.precheck.contentLength, 8);
  assert.equal(mediaFetchCount, 1, "verified media must be fetched exactly once");
  assert.equal(writtenFiles.get("data/\u70b9\u8d5e/\u89c6\u9891/123.mp4").size, 8);
  assert.equal(writtenFiles.get("data/\u70b9\u8d5e/\u89c6\u9891/123.mp4").type, "video/mp4");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("OK: folder permission reuse, direct media fetch, and archive write tests passed");
