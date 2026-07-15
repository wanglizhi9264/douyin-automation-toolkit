import assert from "node:assert/strict";
import fs from "node:fs";

import {
  createPerformanceTracker,
  formatPerformanceSummary,
  measurePerformance,
  recordPerformanceSample,
  summarizePerformance,
} from "../src/shared/performance.js";

const tracker = createPerformanceTracker("liked", {
  now: Date.parse("2026-07-15T00:00:00.000Z"),
  monotonic: 100,
});
recordPerformanceSample(tracker, "list_api", 100, { ok: true });
recordPerformanceSample(tracker, "list_api", 300, { ok: true });
recordPerformanceSample(tracker, "media_transfer", 1000, {
  ok: true,
  bytes: 2 * 1024 * 1024,
});
recordPerformanceSample(tracker, "checkpoint", 50, { ok: false, error: "test" });

const summary = summarizePerformance(tracker, {
  monotonic: 2100,
  endedAt: Date.parse("2026-07-15T00:00:02.000Z"),
});
assert.equal(summary.scope, "liked");
assert.equal(summary.wallMs, 2000);
assert.equal(summary.stages.list_api.count, 2);
assert.equal(summary.stages.list_api.totalMs, 400);
assert.equal(summary.stages.list_api.p50Ms, 100);
assert.equal(summary.stages.list_api.p95Ms, 300);
assert.equal(summary.stages.media_transfer.bytes, 2 * 1024 * 1024);
assert.equal(summary.stages.media_transfer.megabytesPerSecond, 2);
assert.equal(summary.stages.checkpoint.failures, 1);
assert.equal(summary.bottlenecks[0].stage, "media_transfer");
assert.match(formatPerformanceSummary(summary), /media_transfer=1\.0s/);

const measuredTracker = createPerformanceTracker("bookmarked");
const value = await measurePerformance(measuredTracker, "profile_api", async () => 42);
assert.equal(value, 42);
assert.equal(measuredTracker.samples[0].stage, "profile_api");
assert.equal(measuredTracker.samples[0].ok, true);

console.log("OK: performance stage aggregation and formatting tests passed");
const sidebarSource = fs.readFileSync(new URL("../src/sidebar/app.js", import.meta.url), "utf8");
assert.match(sidebarSource, /requestSelfProfile\(\{ reason: "sidebar_summary" \}\)/);
assert.match(sidebarSource, /download_candidates_reused/);
assert.match(sidebarSource, /CANDIDATE_CACHE_MAX_AGE_MS/);
assert.match(sidebarSource, /FULL_ARTIFACT_EVERY_ITEMS/);
assert.match(sidebarSource, /\{ itemCompleted: true \}/);
assert.match(sidebarSource, /\{ forceFull: true \}/);
assert.match(sidebarSource, /performance-summary\.json/);
assert.match(sidebarSource, /await finalizeDownloadPerformance\(\)/);
