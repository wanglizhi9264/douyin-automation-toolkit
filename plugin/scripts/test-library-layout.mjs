import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  pathName,
  mediaRoot,
  ensureSourceLayout,
} from "../src/archive/layout.js";
import { seal } from "../src/archive/fs.js";
import { Repository } from "../src/archive/repository.js";
assert.equal(
  mediaRoot(
    { id: "123", scope: "liked" },
    { sources: ["following"], authorUid: "a", authorName: "作者" },
  ),
  "data/喜欢",
);
assert.equal(mediaRoot({ id: "123", scope: "bookmarked" }, {}), "data/收藏");
assert.equal(
  mediaRoot(
    { id: "123", scope: "following" },
    { authorUid: "a", authorName: "作者" },
  ),
  "data/我的关注/作者_a",
);
assert.notEqual(
  mediaRoot(
    { id: "123", scope: "following" },
    { authorUid: "a", authorName: "同名" },
  ),
  mediaRoot(
    { id: "123", scope: "following" },
    { authorUid: "b", authorName: "同名" },
  ),
);
assert.equal(pathName("中文/作者:??."), "中文_作者___");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-layout-"));
const base = "data/.appdata";
const files = {
  "data/点赞/视频/1.mp4": {
    path: "data/点赞/视频/1.mp4",
    workId: "1",
    partId: "video-1",
    kind: "video",
    size: 32,
    complete: true,
  },
  "data/点赞/重复/1.mp4": {
    path: "data/点赞/重复/1.mp4",
    workId: "1",
    partId: "video-1",
    kind: "video",
    size: 32,
    complete: true,
  },
  "data/收藏/视频/1.mp4": {
    path: "data/收藏/视频/1.mp4",
    workId: "1",
    partId: "video-1",
    kind: "video",
    size: 32,
    complete: true,
  },
  "data/关注/视频/2.mp4": {
    path: "data/关注/视频/2.mp4",
    workId: "2",
    partId: "video-1",
    kind: "video",
    size: 64,
    complete: true,
  },
};
files["data/媒体/3/variant/image-1.jpg"] = {
  path: "data/媒体/3/variant/image-1.jpg",
  workId: "3",
  partId: "image-1",
  kind: "image",
  size: 16,
  complete: true,
};
for (const [path, partId, kind, size] of [
  ["data/喜欢/图片/7/01.jpg", "image-1", "image", 21],
  ["data/喜欢/图片/7/03.jpg", "image-2", "image", 22],
  ["data/喜欢/图片/7/04.jpg", "image-3", "image", 23],
  ["data/喜欢/视频/7/02.mp4", "live-video-1", "video", 24],
  ["data/收藏/图片/8/02.jpg", "image-1", "image", 31],
  ["data/收藏/图片/8/01.jpg", "image-2", "image", 32],
])
  files[path] = {
    path,
    partId,
    kind,
    size,
    complete: true,
    workId: path.includes("/7/") ? "7" : "8",
  };
const state = {
  schemaVersion: 2,
  id: "layout-test",
  owner: { uid: "self" },
  works: {
    7: {
      id: "7",
      complete: true,
      sources: ["liked"],
      mediaType: "mixed",
      files: Object.keys(files).filter((p) => p.includes("/7/")),
    },
    8: {
      id: "8",
      complete: true,
      sources: ["bookmarked"],
      mediaType: "multi_image",
      desc: "韩文정신차려",
      files: Object.keys(files).filter((p) => p.includes("/8/")),
    },
    3: {
      id: "3",
      complete: false,
      mediaType: "multi_image",
      sources: ["bookmarked"],
      files: ["data/媒体/3/variant/image-1.jpg"],
    },
    1: {
      id: "1",
      complete: true,
      authorName: "作者甲",
      authorUid: "a",
      sources: ["liked", "bookmarked", "following"],
      files: Object.keys(files).filter((p) => p.endsWith("1.mp4")),
    },
    2: {
      id: "2",
      complete: true,
      authorName: "作者乙",
      sources: ["following"],
      files: ["data/关注/视频/2.mp4"],
    },
  },
  files,
  tasks: {
    old: {
      id: "old",
      scope: "following",
      authors: [{ uid: "b", nickname: "作者乙" }],
      items: {},
    },
  },
  aliases: {},
};
async function write(relative, value) {
  const p = path.join(root, relative);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(
    p,
    typeof value === "object" && !Buffer.isBuffer(value)
      ? JSON.stringify(value)
      : value,
  );
}
for (const file of Object.values(files))
  await write(file.path, Buffer.alloc(file.size, 7));
await write("data/data/点错的.txt", "preserve me");
await write("本地库.html.crswap", "old swap");
await write(`${base}/archive.json`, { schemaVersion: 2, id: state.id });
await write(`${base}/v2/snapshots/initial.json`, await seal({ seq: 0, state }));
await write(
  `${base}/v2/heads/a.json`,
  await seal({
    seq: 0,
    revision: 0,
    snapshot: `${base}/v2/snapshots/initial.json`,
    tail: null,
  }),
);
const plan = path.join(root, "..", path.basename(root) + "-plan.json");
const run = (...args) =>
  execFileSync(
    process.execPath,
    [
      "scripts/maintain-local-library.mjs",
      root,
      "--plan",
      plan,
      "--seconds",
      "20",
      ...args,
    ],
    { encoding: "utf8", timeout: 25000 },
  );
try {
  run();
  const audit = JSON.parse(await fs.readFile(plan, "utf8"));
  assert.equal(
    audit.duplicates.length,
    1,
    "identical likes and collections remain in their own folders",
  );
  run("--apply");
  const io = {
    async read(p) {
      try {
        return await fs.readFile(path.join(root, p), "utf8");
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },
    async json(p) {
      const t = await this.read(p);
      return t === null ? null : JSON.parse(t);
    },
  };
  const repo = new Repository(io);
  await repo.load();
  assert.equal(repo.stats.unique, 4);
  assert.ok(repo.state.works["1"].files.includes("data/喜欢/视频/1.mp4"));
  assert.ok(repo.state.works["3"].files.includes("data/收藏/图片/3/01.jpg"));
  assert.ok(
    repo.state.works["3"].files.every((p) => p.startsWith("data/收藏/")),
    "completed parts of unfinished works are classified too",
  );
  assert.ok(
    repo.state.works["1"].files.some((p) => p.startsWith("data/喜欢/")),
  );
  assert.ok(
    repo.state.works["1"].files.some((p) => p.startsWith("data/收藏/")),
  );
  assert.ok(
    repo.state.works["1"].files.some((p) =>
      p.startsWith("data/我的关注/作者甲_a/"),
    ),
  );
  assert.ok(
    repo.state.works["2"].files.every((p) =>
      p.startsWith("data/我的关注/作者乙_b/"),
    ),
  );
  for (const work of Object.values(repo.state.works))
    for (const file of work.files) await fs.access(path.join(root, file));
  for (const [relative, size] of [
    ["data/喜欢/图片/7/01.jpg", 21],
    ["data/喜欢/图片/7/02.jpg", 22],
    ["data/喜欢/图片/7/03.jpg", 23],
    ["data/喜欢/视频/7.mp4", 24],
    ["data/收藏/图片/8/01.jpg", 31],
    ["data/收藏/图片/8/02.jpg", 32],
  ])
    assert.equal(
      (await fs.stat(path.join(root, relative))).size,
      size,
      "renumbering preserves each original part, including cycles",
    );
  const result = JSON.parse(await fs.readFile(plan, "utf8"));
  assert.equal(result.phase, "complete");
  assert.equal(result.removed, 1);
  assert.equal(
    await fs.readFile(
      path.join(root, result.backup, "隔离/data/data/点错的.txt"),
      "utf8",
    ),
    "preserve me",
  );
  assert.equal(
    await fs.readFile(
      path.join(root, result.backup, "隔离/本地库.html.crswap"),
      "utf8",
    ),
    "old swap",
  );
  assert.equal(await io.read("data/.appdata/maintenance.json"), null);
  // Replay a crash halfway through a batch: one rename happened, one did not.
  const oldPaths = [
    repo.state.works["1"].files.find((p) => p.startsWith("data/喜欢/")),
    repo.state.works["2"].files[0],
  ];
  const mapping = new Map(
    oldPaths.map((p) => [
      p,
      path.posix.join(
        path.posix.dirname(p),
        "recovered-" + path.posix.basename(p),
      ),
    ]),
  );
  const moves = oldPaths.map((from) => ({
    from,
    to: mapping.get(from),
    size: repo.state.files[from].size,
  }));
  const patch = {
    files: oldPaths.flatMap((from) => [
      { ...repo.state.files[from], path: mapping.get(from) },
      { path: from, removed: true },
    ]),
    works: Object.values(repo.state.works)
      .filter((work) => work.files.some((p) => mapping.has(p)))
      .map((work) => ({
        ...work,
        files: work.files.map((p) => mapping.get(p) || p),
      })),
    aliases: oldPaths.map((from) => ({ from, to: mapping.get(from) })),
  };
  await write(`${base}/maintenance-move.json`, { moves, patch });
  await fs.rename(path.join(root, moves[0].from), path.join(root, moves[0].to));
  await write(`${base}/maintenance.json`, {
    pid: 2147483647,
    planPath: plan,
    archiveId: repo.state.id,
  });
  const interruptedPlan = JSON.parse(await fs.readFile(plan, "utf8"));
  interruptedPlan.revision--;
  interruptedPlan.phase = "authors";
  await fs.writeFile(plan, JSON.stringify(interruptedPlan));
  await assert.rejects(() => new Repository(io).load(), /正在本地整理/);
  run("--apply");
  await repo.load();
  for (const [from] of Object.entries(repo.state.aliases)) {
    let p = from;
    const seen = new Set();
    while (repo.state.aliases[p]) {
      assert.ok(
        !seen.has(p),
        "canonical path reuse cannot create alias cycles",
      );
      seen.add(p);
      p = repo.state.aliases[p];
    }
  }
  for (const work of Object.values(repo.state.works))
    for (const file of work.files) await fs.access(path.join(root, file));
  assert.equal(await io.read(`${base}/maintenance-move.json`), null);
  const cycleFrom = ["data/收藏/图片/8/01.jpg", "data/收藏/图片/8/02.jpg"];
  const cycleMoves = cycleFrom.map((from, i) => ({
    from,
    to: cycleFrom[1 - i],
    stage: `${base}/layout-staging/test/${i}`,
    size: repo.state.files[from].size,
  }));
  const cyclePatch = {
    files: [
      ...cycleMoves.map((m) => ({ path: m.from, removed: true })),
      ...cycleMoves.map((m) => ({ ...repo.state.files[m.from], path: m.to })),
    ],
    works: [
      {
        ...repo.state.works["8"],
        files: [...repo.state.works["8"].files].reverse(),
      },
    ],
    aliases: cycleMoves.map((m) => ({ from: m.from, to: m.to })),
  };
  for (const move of cycleMoves) {
    await fs.mkdir(path.dirname(path.join(root, move.stage)), {
      recursive: true,
    });
    await fs.rename(path.join(root, move.from), path.join(root, move.stage));
  }
  await fs.rename(
    path.join(root, cycleMoves[0].stage),
    path.join(root, cycleMoves[0].to),
  );
  await write(`${base}/maintenance-move.json`, {
    phase: "promote",
    moves: cycleMoves,
    patch: cyclePatch,
  });
  await write(`${base}/maintenance.json`, {
    pid: 2147483647,
    planPath: plan,
    archiveId: repo.state.id,
  });
  const interruptedCycle = JSON.parse(await fs.readFile(plan, "utf8"));
  interruptedCycle.phase = "authors";
  await fs.writeFile(plan, JSON.stringify(interruptedCycle));
  run("--apply");
  await repo.load();
  assert.equal(
    (await fs.stat(path.join(root, "data/收藏/图片/8/01.jpg"))).size,
    31,
  );
  assert.equal(
    (await fs.stat(path.join(root, "data/收藏/图片/8/02.jpg"))).size,
    32,
  );
  // An interrupted classification copy preserves every completed reference.
  const original = structuredClone(repo.state.works["1"]);
  original.files = original.files.filter((p) => p.startsWith("data/喜欢/"));
  repo.state.works["1"] = original;
  repo.io.copy = async () => {
    throw new DOMException("paused", "AbortError");
  };
  await assert.rejects(
    () => ensureSourceLayout(repo, "1", "following"),
    (e) => e.name === "AbortError",
  );
  assert.deepEqual(repo.state.works["1"], original);
  const namedPlan = JSON.parse(await fs.readFile(plan, "utf8"));
  namedPlan.phase = "authors";
  namedPlan.readableNames = true;
  await fs.writeFile(plan, JSON.stringify(namedPlan));
  run("--apply");
  await repo.load();
  assert.ok(
    repo.state.works["1"].files.includes(
      "data/喜欢/视频/作者甲 - 未命名作品 [1].mp4",
    ),
  );
  assert.ok(
    repo.state.works["1"].files.includes(
      "data/我的关注/作者甲_a/视频/未命名作品 [1].mp4",
    ),
  );
  assert.equal(repo.stats.unique, 4);
  for (const work of Object.values(repo.state.works))
    for (const relative of work.files) {
      assert.equal(
        (await fs.stat(path.join(root, relative))).size,
        repo.state.files[relative].size,
      );
    }
  assert.equal(
    (
      await fs.stat(
        path.join(root, "data/收藏/图片/未知作者 - 韩文정신차려 [8]/01.jpg"),
      )
    ).size,
    31,
  );
  assert.equal(
    (
      await fs.stat(
        path.join(root, "data/收藏/图片/未知作者 - 韩文정신차려 [8]/02.jpg"),
      )
    ).size,
    32,
  );
  const korean = repo.state.works["8"].files.find((p) => p.endsWith("01.jpg"));
  const restorePlan = JSON.parse(await fs.readFile(plan, "utf8"));
  const isolated = path.join(
    root,
    restorePlan.backup,
    "隔离",
    korean.normalize("NFD"),
  );
  await fs.mkdir(path.dirname(isolated), { recursive: true });
  await fs.rename(path.join(root, korean), isolated);
  restorePlan.phase = "quarantine";
  restorePlan.quarantined++;
  await fs.writeFile(plan, JSON.stringify(restorePlan));
  run("--apply");
  await repo.load();
  assert.equal(
    (await fs.stat(path.join(root, korean))).size,
    31,
    "NFD quarantine entries restore to their NFC metadata references",
  );
  assert.ok(JSON.parse(await fs.readFile(plan, "utf8")).restored >= 1);
  for (const work of Object.values(repo.state.works))
    for (const relative of work.files)
      await fs.access(path.join(root, relative));
  const decoratedPlan = JSON.parse(await fs.readFile(plan, "utf8"));
  const decorated = path.join(
    root,
    decoratedPlan.backup,
    "隔离",
    korean.replace("韩文", "韩文\u034f").normalize("NFD"),
  );
  await fs.mkdir(path.dirname(decorated), { recursive: true });
  await fs.rename(path.join(root, korean), decorated);
  decoratedPlan.phase = "quarantine";
  decoratedPlan.quarantined++;
  await fs.writeFile(plan, JSON.stringify(decoratedPlan));
  run("--apply");
  await repo.load();
  assert.equal(
    (await fs.stat(path.join(root, korean))).size,
    31,
    "stable ID/type/index/size recovers decorated filesystem spellings without relying on title equivalence",
  );
  console.log(
    "OK: separate likes/collections/following folders, authors only under following, same-name UID separation, cross-source copies retained, exact duplicates removed, unknown leftovers recoverable, references valid after replay and cancellation",
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(plan, { force: true });
}
