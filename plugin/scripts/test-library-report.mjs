import assert from "node:assert/strict";
import {
  buildReportModel,
  renderLibraryReport,
  safeMediaPath,
} from "../src/archive/report.js";
const state = {
  works: {
    1: {
      id: "1",
      complete: true,
      sources: ["liked", "bookmarked"],
      files: ["data/媒体/1/a.mp4"],
      desc: '</script><img src=x onerror="window.pwned=1">',
    },
    2: {
      id: "2",
      complete: true,
      legacy: true,
      sources: ["following"],
      files: [],
    },
  },
  files: {
    "data/媒体/1/a.mp4": {
      path: "data/媒体/1/a.mp4",
      workId: "1",
      partId: "video-1",
      kind: "video",
      complete: true,
      size: 10,
      quality: { width: 720, height: 1280 },
      highest: { width: 1080, height: 1920 },
      qualityOutcome: "degraded",
      fallbackReason: "HTTP 403",
    },
  },
  tasks: {
    task: {
      id: "task",
      scope: "liked",
      accountUid: "self",
      createdAt: "2026-10-28T01:00:00Z",
      status: "paused",
      sourceDone: false,
      sourceErrors: [],
      platformTotal: 1,
      items: {
        3: {
          id: "3",
          scope: "liked",
          state: "failed",
          error: "媒体请求失败：HTTP 429",
        },
        4: { id: "4", scope: "liked", state: "queued" },
        1: { id: "1", scope: "liked", state: "failed", error: "stale failure" },
      },
    },
  },
};
const model = buildReportModel(state, { folderLabel: "test" });
assert.equal(model.stats.unique, 2);
assert.equal(model.stats.failed, 1);
assert.equal(model.stats.pending, 1);
assert.equal(model.stats.sizeKnown, false);
assert.equal(model.rows.length, 4);
assert.equal(model.sources[0].saved, 1);
assert.deepEqual(model.rows.find((r) => r.id === "1").sources, [
  "liked",
  "bookmarked",
]);
assert.equal(model.rows.find((r) => r.id === "1").status, "downloaded");
assert.equal(model.rows.find((r) => r.id === "1").error, "");
assert.equal(model.outcomes.degraded, 1);
assert.equal(model.outcomes.unknown, 1);
assert.equal(model.causes["HTTP 429"], 1);
assert.equal(
  safeMediaPath("data/媒体/1/a.mp4"),
  "data/%E5%AA%92%E4%BD%93/1/a.mp4",
);
for (const p of [
  "data/../../bad",
  "javascript:alert(1)",
  "https://x",
  "data/a\\b",
  "/tmp/a",
])
  assert.equal(safeMediaPath(p), "");
const html = renderLibraryReport(model);
const recovered = structuredClone(model);
recovered.tasks[0].status='completed';
recovered.tasks[0].retryState={reason:'HTTP 429',until:1,exhausted:true};
assert.match(renderLibraryReport(recovered),/冷却已结束/);
assert.ok(!renderLibraryReport(recovered).includes('任务已暂停，进度已保留'));
assert.ok(!html.includes("</script><img"));
assert.ok(html.includes("\\u003c/script>"));
assert.match(html, /最高候选未记录/);
assert.match(html, /来源数量不相加/);
assert.match(html, /HTTP 429/);
console.log(
  "OK: library report dedupes sources, preserves historical inventory, separates pending/failures, suppresses stale failures, shows truthful quality and escapes scripts/paths",
);
