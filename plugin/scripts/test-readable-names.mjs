import assert from "node:assert/strict";
import {
  readableTitle,
  readableBase,
  reserveWorkName,
} from "../src/archive/naming.js";
import { sourceTargetPath, layoutMetadata } from "../src/archive/layout.js";
import { prepareReadableNames } from "../src/maintenance/names.js";
assert.equal(
  readableTitle("雨后的西湖！第二句 #杭州 #旅行 @小陈 https://example.test/a"),
  "雨后的西湖",
);
assert.equal(readableTitle("#杭州 #旅行"), "杭州 旅行");
assert.equal(readableTitle("@小陈\n第二行正文 #记录"), "第二行正文");
assert.equal(readableTitle("..."), "未命名作品");
assert.equal(readableTitle({ text: "unexpected" }), "未命名作品");
const repo = { state: { works: {} } };
const first = {
  id: "1000000012345678",
  desc: "雨后的西湖 #杭州",
  authorName: "小陈",
  authorUid: "u",
};
first.naming = reserveWorkName(repo, first);
repo.state.works[first.id] = first;
assert.equal(readableBase(first, "liked"), "小陈 - 雨后的西湖 [12345678]");
assert.equal(readableBase(first, "following"), "雨后的西湖 [12345678]");
const second = { ...first, id: "2000000012345678", naming: undefined };
second.naming = reserveWorkName(repo, second);
repo.state.works[second.id] = second;
assert.equal(
  second.naming.token.length,
  12,
  "same title and suffix extends ID rather than overwriting",
);
const third = { ...first, id: "3000000012345678", naming: undefined };
third.naming = reserveWorkName(repo, third);
assert.equal(third.naming.token.length, 16);
assert.deepEqual(
  reserveWorkName(repo, {
    ...first,
    desc: "已修改的标题",
    authorName: "新昵称",
  }),
  first.naming,
  "stored naming remains frozen",
);
assert.deepEqual(
  reserveWorkName(repo, { ...second, naming: undefined, desc: "again" }),
  second.naming,
  "an in-flight reservation is stable",
);
const reopened = { state: structuredClone(repo.state) };
assert.deepEqual(
  reserveWorkName(reopened, { ...first, naming: undefined }),
  first.naming,
  "reopen preserves frozen names",
);
const capsRepo = { state: { works: {} } };
const a = {
  id: "1000000087654321",
  desc: "ABC",
  authorName: "Test",
  authorUid: "x",
};
a.naming = reserveWorkName(capsRepo, a);
capsRepo.state.works[a.id] = a;
const b = {
  id: "2000000087654321",
  desc: "abc",
  authorName: "test",
  authorUid: "x",
};
b.naming = reserveWorkName(capsRepo, b);
assert.equal(
  b.naming.token.length,
  12,
  "case-insensitive filesystems cannot collide",
);
const long = {
  id: "1234567890123456789",
  desc: "👩‍👩‍👧‍👧".repeat(100),
  authorName: "小陈/危险:*?".repeat(20),
};
long.naming = reserveWorkName({ state: { works: {} } }, long);
const base = readableBase(long, "liked");
assert.ok(new TextEncoder().encode(base + ".mp4").length <= 225);
assert.ok(!/[<>:"/\\|?*\u0000-\u001f]/.test(base));
assert.ok(!long.naming.title.endsWith("\u200d"), "emoji clusters remain whole");
const model = {
  ...first,
  ...layoutMetadata([
    { partId: "video-1", kind: "video" },
    { partId: "video-2", kind: "video" },
  ]),
};
assert.equal(
  sourceTargetPath(model, { partId: "video-1", kind: "video" }, "liked"),
  "data/喜欢/视频/小陈 - 雨后的西湖 [12345678]/01.mp4",
);
assert.equal(
  sourceTargetPath(
    { ...first, ...layoutMetadata([{ partId: "cover", kind: "image" }]) },
    { partId: "cover", kind: "image" },
    "liked",
  ),
  "data/喜欢/封面/小陈 - 雨后的西湖 [12345678].jpg",
);
const historical = {
  state: {
    works: {
      9000000012345678: {
        id: "9000000012345678",
        complete: true,
        files: [],
        sources: ["bookmarked"],
      },
    },
  },
  io: {
    json: async (p) =>
      p.endsWith("db_texts.json")
        ? { 9000000012345678: "历史作品的标题 #话题" }
        : p.endsWith("db_videos.json")
          ? { 9000000012345678: { authorUid: "old" } }
          : p.endsWith("db_authors.json")
            ? { old: { nickname: "历史作者" } }
            : {},
  },
  async commit(patch) {
    for (const work of patch.works || [])
      this.state.works[work.id] = structuredClone(work);
    if (patch.namingVersion) this.state.namingVersion = patch.namingVersion;
  },
};
await prepareReadableNames(historical);
assert.equal(
  readableBase(historical.state.works["9000000012345678"], "liked"),
  "历史作者 - 历史作品的标题 [12345678]",
);
const name = structuredClone(historical.state.works["9000000012345678"].naming);
await prepareReadableNames(historical);
assert.deepEqual(historical.state.works["9000000012345678"].naming, name);
console.log(
  "OK: title cleanup, topic-only fallback, 8→12→full collision handling, stable persisted names, UTF-8/emoji limits, source-specific labels and local historical enrichment",
);
const clipped = {
  id: "1000000000000099",
  desc: "a".repeat(29) + ".后续内容",
  authorName: "b".repeat(13) + ".更多",
};
clipped.naming = reserveWorkName({ state: { works: {} } }, clipped);
assert.equal(clipped.naming.title, "a".repeat(29));
assert.equal(clipped.naming.author, "b".repeat(13));
assert.ok(readableBase(clipped, "liked").includes(" ["));
assert.equal(readableTitle("...隐藏标题"), "隐藏标题");

// Chromium's local File System Access handles reject format characters,
// including the invisible joiner in a combined emoji.
const withJoiner = {
  id: "1234567890123456",
  authorName: "作者🏊🏻‍♀️",
  authorUid: "12345",
  desc: "训练👩‍👩‍👧‍👧",
  authorFolder: "data/我的关注/作者🏊🏻‍♀️_12345",
  naming: { version: 1, title: "训练👩‍👩‍👧‍👧", author: "作者🏊🏻‍♀️", token: "90123456" },
};
const part = { partId: "video-1", kind: "video" };
for (const scope of ["liked", "bookmarked", "following"]) {
  const output = sourceTargetPath(withJoiner, part, scope);
  assert.doesNotMatch(output, /\p{Cf}/u);
  assert.ok(output.endsWith("[1234567890123456].mp4"), "legacy repair uses the full unique ID");
}
const newName = reserveWorkName({ state: { works: {} } }, { ...withJoiner, naming: undefined });
assert.doesNotMatch(newName.author + newName.title, /\p{Cf}/u);
assert.equal(newName.token, "90123456", "new names retain the normal short ID");
assert.match(withJoiner.desc, /\u200d/, "original display description remains intact");
