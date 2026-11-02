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
assert.match(pickerSource, /startIn:\s*stored\?\.handle\s*\|\|\s*["']videos["']/);
assert.match(pickerSource, /await inspectFolder\(handle\)/);
assert.match(pickerSource, /await repo\.initialize\(\)/);
assert.doesNotMatch(pickerSource, /window\.confirm/);
assert.match(pickerSource, /navigator\.locks\.request/);
assert.match(pickerSource, /await rememberDownloadTarget\(handle/);
assert.match(backgroundSource, /pickerUrl\.searchParams\.set\("returnTabId"/);
assert.match(backgroundSource, /chrome\.windows\.create/);
assert.doesNotMatch(backgroundSource, /chrome\.tabs\.create\(\{ url: pickerUrl\.toString\(\) \}/);

const sidebarSource = fs.readFileSync(new URL("../src/sidebar/app.js", import.meta.url), "utf8");
assert.doesNotMatch(sidebarSource, /sendPageRequest\("DOWNLOAD_TO_FOLDER"/);
assert.match(sidebarSource, /downloadVerifiedMedia\(\s*rootHandle,/);

const writtenFiles = new Map();
function createDirectory(parts = []) {
  return {
    async getDirectoryHandle(name) {
      return createDirectory([...parts, name]);
    },
    async removeEntry(name) {
      writtenFiles.delete([...parts, name].join("/"));
    },
    async getFileHandle(name) {
      const path = [...parts, name].join("/");
      return {
        async getFile() {
          const entry = writtenFiles.get(path);
          return {
            size: entry?.bytes?.byteLength || 0,
            async text() { return new TextDecoder().decode(entry?.bytes || new Uint8Array()); },
          };
        },
        async createWritable({ keepExistingData = false } = {}) {
          let bytes = keepExistingData
            ? new Uint8Array(writtenFiles.get(path)?.bytes || [])
            : new Uint8Array();
          let position = 0;
          return {
            async seek(offset) { position = offset; },
            async write(data) {
              const chunk = data instanceof Uint8Array
                ? data
                : (typeof data === "string"
                    ? new TextEncoder().encode(data)
                    : new Uint8Array(await data.arrayBuffer()));
              const next = new Uint8Array(Math.max(bytes.byteLength, position + chunk.byteLength));
              next.set(bytes);
              next.set(chunk, position);
              bytes = next;
              position += chunk.byteLength;
              writtenFiles.set(path, {
                size: bytes.byteLength,
                type: data.type || "",
                bytes,
              });
            },
            async truncate(size) { bytes = bytes.slice(0, size); },
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
  assert.ok(result.timings.requestMs >= 0);
  assert.ok(result.timings.transferMs >= 0);
  assert.ok(result.timings.writeMs >= 0);
  assert.ok(result.timings.totalMs >= 0);
  assert.equal(mediaFetchCount, 1, "verified media must be fetched exactly once");
  assert.equal(writtenFiles.get("data/\u70b9\u8d5e/\u89c6\u9891/123.mp4").size, 8);

  writtenFiles.set("data/\u70b9\u8d5e/\u89c6\u9891/resume.mp4", {
    size: 4,
    bytes: new Uint8Array([0, 0, 0, 24]),
  });
  writtenFiles.set("data/\u70b9\u8d5e/\u89c6\u9891/resume.mp4.resume.json", {
    bytes: new TextEncoder().encode(JSON.stringify({ key: "https://video.example/resume.mp4" })),
  });
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers.Range, "bytes=4-");
    const remainder = new Uint8Array([102, 116, 121, 112]);
    return new Response(remainder, {
      status: 206,
      headers: {
        "content-type": "video/mp4",
        "content-length": "4",
        "content-range": "bytes 4-7/8",
        "accept-ranges": "bytes",
      },
    });
  };
  const resumed = await downloadVerifiedMedia(
    { kind: "filesystem", handle: createDirectory(), label: "backup" },
    "data/\u70b9\u8d5e/\u89c6\u9891/resume.mp4",
    "https://video.example/resume.mp4",
    { expected: "video", headerTimeoutMs: 1000, totalTimeoutMs: 2000 },
  );
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.resumedBytes, 4);
  assert.equal(resumed.size, 8);
  assert.deepEqual(
    [...writtenFiles.get("data/\u70b9\u8d5e/\u89c6\u9891/resume.mp4").bytes],
    [0, 0, 0, 24, 102, 116, 121, 112],
  );
  globalThis.fetch=async()=>new Response('rate limited',{status:429,headers:{'retry-after':'90'}});
  await assert.rejects(()=>downloadVerifiedMedia({kind:'filesystem',handle:createDirectory()},'data/rate-limited.mp4','https://video.example/rate.mp4'),error=>error.httpStatus===429&&error.retryAfter==='90');
  globalThis.fetch=async()=>new Response(new Uint8Array([1,2,3]),{headers:{"content-type":"video/mp4","content-length":"8"}});
  await assert.rejects(()=>downloadVerifiedMedia({kind:'filesystem',handle:createDirectory()},'data/short.mp4','https://video.example/short.mp4'),error=>error.retryable===true);
  globalThis.fetch=async(_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('timed out','AbortError')),{once:true}));
  await assert.rejects(()=>downloadVerifiedMedia({kind:'filesystem',handle:createDirectory()},'data/timeout.mp4','https://video.example/timeout.mp4',{headerTimeoutMs:5}),error=>error.retryable===true);
  // Headers alone must not disable the shared first-byte deadline.
  globalThis.fetch = async (_url, init) => {
    const body = new ReadableStream({start(controller) {
      init.signal.addEventListener('abort', () => controller.error(new DOMException('timeout', 'AbortError')), {once:true});
    }});
    return new Response(body, {headers:{'content-type':'video/mp4','content-length':'8'}});
  };
  const before = performance.now();
  await assert.rejects(() => downloadVerifiedMedia({kind:'filesystem',handle:createDirectory()},
    'data/no-body.mp4','https://video.example/no-body.mp4',
    {headerTimeoutMs:1000,firstByteTimeoutMs:15,totalTimeoutMs:1000}), e=>e.retryable);
  assert.ok(performance.now()-before<500, 'headers without body cannot hold the slot');
  // Continuous progress may finish after the first-byte budget, including large files.
  globalThis.fetch = async () => {
    const body = new ReadableStream({start(controller) {
      controller.enqueue(new Uint8Array([0,0,0,24]));
      setTimeout(() => {controller.enqueue(new Uint8Array([102,116,121,112]));controller.close();}, 35);
    }});
    return new Response(body, {headers:{'content-type':'video/mp4','content-length':'8'}});
  };
  const healthy = await downloadVerifiedMedia({kind:'filesystem',handle:createDirectory()},
    'data/healthy.mp4','https://video.example/healthy.mp4',
    {headerTimeoutMs:1000,firstByteTimeoutMs:15,totalTimeoutMs:1000});
  assert.equal(healthy.size,8, 'healthy long transfers are not cut off by the initial-response deadline');
} finally {
  globalThis.fetch = originalFetch;
}

console.log("OK: folder permission reuse, direct media fetch, and archive write tests passed");
