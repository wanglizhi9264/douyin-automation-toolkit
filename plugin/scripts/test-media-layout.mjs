import assert from "node:assert/strict";
import { createMediaDownloader } from "../src/core/media.js";
import { RetryCoordinator } from "../src/core/retry.js";
import {
  ensureSourceLayout,
  layoutMetadata,
  sourceTargetPath,
} from "../src/archive/layout.js";
function fixture() {
  const bytes = new Map(),
    history = [];
  const repo = {
    state: { works: {}, files: {}, aliases: {} },
    target: {},
    io: {
      async file(path) {
        if (!bytes.has(path))
          throw new DOMException("missing", "NotFoundError");
        return new File([bytes.get(path)], path);
      },
      async read() {
        return null;
      },
      async mkdir() {},
      async copy(from, to) {
        assert.ok(bytes.has(from));
        bytes.set(to, bytes.get(from).slice());
      },
      async remove(path) {
        assert.ok(
          !Object.values(repo.state.works).some((work) =>
            work.files?.includes(path),
          ),
          "never delete referenced media",
        );
        bytes.delete(path);
      },
    },
    async commit(patch) {
      history.push(structuredClone(patch));
      for (const work of patch.works || [])
        repo.state.works[work.id] = structuredClone(work);
      for (const file of patch.files || []) {
        if (file.removed) delete repo.state.files[file.path];
        else {
          repo.state.files[file.path] = structuredClone(file);
          if (file.complete && !file.pendingDelete)
            delete repo.state.aliases[file.path];
        }
      }
      for (const alias of patch.aliases || [])
        repo.state.aliases[alias.from] = alias.to;
    },
  };
  let now = 0;
  const retry = new RetryCoordinator({
    now: () => now,
    random: () => 0,
    wait: async (ms) => {
      now += ms;
    },
    maxForbiddenRetries: 0,
  });
  const calls = [];
  const transfer = async (_target, path, url) => {
    calls.push({ path, url });
    bytes.set(path, new Uint8Array(20).fill(3));
    return {
      size: 20,
      contentType: url.includes("cover")
        ? "image/jpeg"
        : url.endsWith("webp")
          ? "image/webp"
          : url.endsWith("jpg")
            ? "image/jpeg"
            : "video/mp4",
    };
  };
  return { repo, bytes, history, retry, calls, transfer };
}
const video = (url, w = 1080, h = 1920) => ({
  play_addr: { url_list: [url], width: w, height: h, data_size: 20 },
});
const signal = new AbortController().signal;
const one = fixture();
await createMediaDownloader(
  one.repo,
  { retry: one.retry },
  { transfer: one.transfer },
)(
  { id: "100", scope: "liked", taskId: "t" },
  {
    aweme_id: "100",
    video: {
      ...video("https://test/single"),
      cover: { url_list: ["https://test/cover.jpg"] },
    },
  },
  signal,
  () => {},
);
assert.deepEqual(one.repo.state.works["100"].files.sort(), [
  "data/喜欢/封面/未知作者 - 未命名作品 [100].jpg",
  "data/喜欢/视频/未知作者 - 未命名作品 [100].mp4",
]);
assert.ok([...one.bytes.keys()].every((path) => !path.includes("1080-1920")));
const multiple = fixture();
let deny = true;
const raw = {
  aweme_id: "200",
  author: { uid: "u", nickname: "作者" },
  video_list: [
    video("https://test/first"),
    video("https://test/second", 1440, 2560),
  ],
};
const download = createMediaDownloader(
  multiple.repo,
  { retry: multiple.retry },
  {
    transfer: async (...args) => {
      if (args[2].endsWith("second") && deny)
        throw new Error("test permanent failure");
      return multiple.transfer(...args);
    },
  },
);
await assert.rejects(() =>
  download(
    { id: "200", scope: "following", taskId: "t" },
    raw,
    signal,
    () => {},
  ),
);
assert.equal(multiple.repo.state.works["200"].complete, false);
assert.deepEqual(multiple.repo.state.works["200"].files, [
  "data/我的关注/作者_u/视频/未命名作品 [200]/01.mp4",
]);
deny = false;
await download(
  { id: "200", scope: "following", taskId: "t" },
  raw,
  signal,
  () => {},
);
assert.equal(
  multiple.calls.filter((call) => call.url.endsWith("first")).length,
  1,
  "finished segment is not transferred again",
);
assert.deepEqual(multiple.repo.state.works["200"].files.sort(), [
  "data/我的关注/作者_u/视频/未命名作品 [200]/01.mp4",
  "data/我的关注/作者_u/视频/未命名作品 [200]/02.mp4",
]);
const gallery = fixture();
await createMediaDownloader(
  gallery.repo,
  { retry: gallery.retry },
  { transfer: gallery.transfer },
)(
  { id: "300", scope: "bookmarked", taskId: "t" },
  {
    aweme_id: "300",
    images: [
      { url_list: ["https://test/01.webp"] },
      { url_list: ["https://test/02.jpg"] },
    ],
  },
  signal,
  () => {},
);
assert.deepEqual(
  gallery.repo.state.works["300"].files.sort(),
  [
    "data/收藏/封面/未知作者 - 未命名作品 [300].webp",
    "data/收藏/图片/未知作者 - 未命名作品 [300]/01.webp",
    "data/收藏/图片/未知作者 - 未命名作品 [300]/02.jpg",
  ].sort(),
);
assert.equal(gallery.calls.length, 2, "gallery cover uses local first image");
const mixedParts = [
  { partId: "live-video-1", kind: "video", order: 2 },
  { partId: "video-1", kind: "video", order: 5 },
];
const mixed = { id: "400", ...layoutMetadata(mixedParts) };
assert.notEqual(
  sourceTargetPath(mixed, mixedParts[0], "liked"),
  sourceTargetPath(mixed, mixedParts[1], "liked"),
  "live and explicit videos cannot overwrite each other",
);
const upgrade = fixture();
const old = "data/喜欢/视频/500.mp4";
upgrade.bytes.set(old, new Uint8Array(10).fill(1));
const prior = {
  path: old,
  workId: "500",
  partId: "video-1",
  kind: "video",
  complete: true,
  size: 10,
  quality: { width: 720, height: 1280 },
  qualityOutcome: "degraded",
  highest: { width: 1080, height: 1920 },
};
upgrade.repo.state.files[old] = prior;
upgrade.repo.state.works["500"] = {
  id: "500",
  complete: true,
  sources: ["liked", "bookmarked"],
  files: [old],
};
await createMediaDownloader(
  upgrade.repo,
  { retry: upgrade.retry },
  {
    transfer: async (...args) => {
      assert.equal(
        upgrade.bytes.get(old).length,
        10,
        "original remains intact while upgrade transfers",
      );
      return upgrade.transfer(...args);
    },
  },
)(
  { id: "500", scope: "liked", taskId: "t", upgrade: true },
  { aweme_id: "500", video: video("https://test/high") },
  signal,
  () => {},
);
const upgradedPath = "data/喜欢/视频/未知作者 - 未命名作品 [500].mp4";
assert.equal(upgrade.bytes.get(upgradedPath).length, 20);
assert.ok(
  upgrade.repo.state.works["500"].files.includes(
    "data/收藏/视频/未知作者 - 未命名作品 [500].mp4",
  ),
);
assert.ok(
  [...upgrade.bytes.keys()].every((path) => !path.includes("/staging/")),
  "verified staging files leave no public quality directories",
);
assert.equal(upgrade.repo.state.files[upgradedPath].qualityOutcome, "best");
const unchanged = upgrade.calls.length;
await createMediaDownloader(
  upgrade.repo,
  { retry: upgrade.retry },
  { transfer: upgrade.transfer },
)({ id: "500", scope: "liked", upgrade: true }, null, signal, () => {});
assert.equal(
  upgrade.calls.length,
  unchanged,
  "best quality marker still prevents retransfers",
);
const conflict = fixture();
conflict.repo.state.works["600"] = {
  id: "600",
  complete: true,
  sources: ["liked"],
  files: ["data/媒体/600/v/video-1.mp4"],
};
conflict.repo.state.files["data/媒体/600/v/video-1.mp4"] = {
  path: "data/媒体/600/v/video-1.mp4",
  workId: "600",
  partId: "video-1",
  kind: "video",
  size: 20,
  complete: true,
};
conflict.bytes.set("data/媒体/600/v/video-1.mp4", new Uint8Array(20));
conflict.bytes.set("data/喜欢/视频/600.mp4", new Uint8Array(17).fill(9));
await ensureSourceLayout(conflict.repo, "600", "liked");
assert.ok(
  [...conflict.bytes].some(
    ([path, bytes]) =>
      path.includes("/layout-conflicts/") && bytes.length === 17,
  ),
  "unknown destination is backed up before replacement",
);
console.log(
  "OK: flat single files, ordered multi-video/gallery folders, cover/image distinction, local cover reuse, per-part continuation, safe staged quality upgrade and conflict preservation",
);
const cycle = fixture();
const first = "data/喜欢/图片/700/02.jpg",
  second = "data/喜欢/图片/700/01.jpg";
cycle.repo.state.works["700"] = {
  id: "700",
  complete: true,
  sources: ["liked"],
  files: [first, second],
};
for (const [path, partId, size] of [
  [first, "image-1", 11],
  [second, "image-2", 12],
]) {
  cycle.repo.state.files[path] = {
    path,
    partId,
    workId: "700",
    kind: "image",
    complete: true,
    size,
  };
  cycle.bytes.set(path, new Uint8Array(size));
}
await ensureSourceLayout(cycle.repo, "700", "liked");
assert.equal(
  cycle.bytes.get("data/喜欢/图片/700/01.jpg").length,
  11,
  "browser organizer preserves original first image when names cycle",
);
assert.equal(
  cycle.bytes.get("data/喜欢/图片/700/02.jpg").length,
  12,
  "browser organizer preserves original second image when names cycle",
);
assert.ok(
  [...cycle.bytes.keys()].every((path) => !path.includes("/layout-staging/")),
);
console.log(
  "OK: browser-side numbered-file cycles stage all originals before replacing names",
);
// Old manifests must not reinterpret numbered files after a modern migration.
const { organize } = await import("../src/maintenance/organize.js");
const worker = globalThis.Worker;
globalThis.Worker = class {
  terminate() {}
  async postMessage({ id, file }) {
    const hash = Buffer.from(
      await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
    ).toString("hex");
    this.onmessage({ data: { id, hash } });
  }
};
cycle.repo.state.id = "modern-test";
cycle.repo.state.works["700"].legacy = false;
cycle.repo.load = async () => {};
cycle.repo.compact = async () => {};
cycle.repo.io.list = async (path) =>
  path.endsWith("/manifests")
    ? [
        {
          kind: "file",
          name: "700.json",
          getFile: async () =>
            new File(
              [
                JSON.stringify({
                  awemeId: "700",
                  parts: [
                    {
                      path: second,
                      partId: "image-2",
                      kind: "image",
                      size: 11,
                    },
                    { path: first, partId: "image-1", kind: "image", size: 12 },
                  ],
                }),
              ],
              "700.json",
            ),
        },
      ]
    : [];
try {
  await organize(cycle.repo, {
    lock: { request: async (_name, _options, callback) => callback({}) },
  });
  assert.equal(
    cycle.repo.state.files["data/喜欢/图片/未知作者 - 未命名作品 [700]/01.jpg"]
      .partId,
    "image-1",
  );
  assert.equal(
    cycle.bytes.get("data/喜欢/图片/未知作者 - 未命名作品 [700]/01.jpg").length,
    11,
  );
} finally {
  globalThis.Worker = worker;
}
console.log(
  "OK: migrated modern works ignore obsolete legacy manifest numbering",
);
const loneMotion = {
  id: "800",
  ...layoutMetadata([{ partId: "live-video-12", kind: "video", order: 13 }]),
};
assert.equal(
  sourceTargetPath(
    loneMotion,
    { partId: "live-video-12", kind: "video" },
    "liked",
  ),
  "data/喜欢/视频/800.mp4",
  "one motion clip stays flat even when it came from the twelfth photo",
);
console.log(
  "OK: multi-file choice uses actual media counts, not original image position",
);
