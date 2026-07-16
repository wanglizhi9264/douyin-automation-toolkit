import assert from "node:assert/strict";

import {
  analyzeDownloadRecord,
  buildEnhancedDownloadReportHtml,
  classifyFailureReason,
  videoDiagnosticsForItem,
} from "../src/shared/report.js";

function candidate(width, height, codec = "h265") {
  return {
    url: `https://media/${width}x${height}-${codec}.mp4`,
    width,
    height,
    codec,
    fps: 60,
    bitrate: width * 1000,
  };
}

function videoItem({
  id,
  actual,
  candidates,
  rank = 1,
  status = "downloaded",
  fallbackReason = "",
  desc = "",
}) {
  return {
    awemeId: id,
    index: Number(id),
    source: "bookmarked",
    downloadStatus: status,
    mediaType: "video",
    mediaCount: 1,
    mediaParts: [{
      partId: "video-1",
      kind: "video",
      order: 1,
      candidates,
    }],
    width: actual?.width || 0,
    height: actual?.height || 0,
    codec: actual?.codec || "",
    fps: actual?.fps || 0,
    bitrate: actual?.bitrate || 0,
    candidateRank: rank,
    qualityFallbackReason: fallbackReason,
    videoPath: status === "downloaded" ? `data/收藏/视频/${id}.mp4` : "",
    desc,
    lastError: status === "failed" ? fallbackReason : "",
  };
}

const fourK = candidate(2160, 3840);
const fourKAlt = candidate(2160, 3840, "h264");
const fullHd = candidate(1080, 1920, "h264");
const items = [
  videoItem({ id: "1", actual: fourK, candidates: [fourK, fullHd] }),
  videoItem({
    id: "2",
    actual: fullHd,
    candidates: [fourK, fullHd],
    rank: 2,
    fallbackReason: "#1 Failed to fetch",
    desc: "<script>alert('xss')</script>",
  }),
  videoItem({
    id: "3",
    actual: fourKAlt,
    candidates: [fourK, fourKAlt],
    rank: 2,
    fallbackReason: "#1 HTTP 404",
  }),
  videoItem({
    id: "4",
    actual: null,
    candidates: [fourK, fullHd],
    status: "failed",
    fallbackReason: "没有可用的视频候选：HTTP 504",
  }),
  {
    awemeId: "5",
    index: 5,
    source: "liked",
    downloadStatus: "downloaded",
    mediaType: "multi_image",
    mediaCount: 2,
    mediaParts: [
      { partId: "image-1", kind: "image", order: 1 },
      { partId: "image-2", kind: "image", order: 2 },
    ],
    imagePaths: ["data/点赞/图片/5/01.jpg", "data/点赞/图片/5/02.jpg"],
  },
  {
    awemeId: "6",
    index: 6,
    source: "bookmarked",
    downloadStatus: "downloaded",
    mediaType: "mixed",
    mediaCount: 2,
    mediaParts: [
      { partId: "image-1", kind: "image", order: 1 },
      { partId: "live-video-1", kind: "video", role: "live_photo", order: 2, candidates: [fullHd] },
    ],
    downloadedMediaParts: {
      "live-video-1": {
        status: "downloaded",
        path: "data/收藏/视频/6/02.mp4",
        candidateRank: 1,
        quality: fullHd,
      },
    },
  },
];

const degraded = videoDiagnosticsForItem(items[1]);
assert.equal(degraded.length, 1);
assert.equal(degraded[0].outcome, "degraded");
assert.equal(degraded[0].candidateRank, 2);
assert.match(degraded[0].fallbackReason, /Failed to fetch/);

const analysis = analyzeDownloadRecord({ items });
assert.equal(analysis.totals.items, 6);
assert.equal(analysis.totals.downloaded, 5);
assert.equal(analysis.totals.failed, 1);
assert.equal(analysis.totals.successRate, 83.33);
assert.equal(analysis.totals.videoUnits, 5);
assert.equal(analysis.totals.comparableVideoUnits, 4);
assert.equal(analysis.totals.best, 2);
assert.equal(analysis.totals.sameResolutionFallback, 1);
assert.equal(analysis.totals.degraded, 1);
assert.equal(analysis.totals.highestResolutionRate, 75);
assert.equal(analysis.totals.degradedRate, 25);
assert.equal(analysis.qualityOutcomeCounts.no_video, 1);
assert.equal(analysis.failureReasonCounts["HTTP 504"], 1);
assert.equal(classifyFailureReason("媒体下载超过 120 秒"), "媒体传输超时");

const legacyRecord = {
  items: [{
    awemeId: "legacy",
    index: 7,
    source: "bookmarked",
    downloadStatus: "downloaded",
    mediaType: "video",
    width: 1080,
    height: 1920,
    codec: "h264",
    videoPath: "data/??/??/legacy.mp4",
  }],
};
const historyLogs = [
  {
    createdAt: "2026-07-16T09:00:00.000Z",
    meta: { type: "download_stream_candidate_failed", awemeId: "legacy", candidateRank: 1, quality: fourK, error: "Failed to fetch" },
  },
  {
    createdAt: "2026-07-16T09:00:02.000Z",
    meta: { type: "download_success", awemeId: "legacy", candidateRank: 2, quality: fullHd },
  },
];
const historyAnalysis = analyzeDownloadRecord(legacyRecord, historyLogs);
assert.equal(historyAnalysis.totals.degraded, 1);
assert.equal(historyAnalysis.items[0].highestQualityLabel.startsWith("2160\u00d73840"), true);
assert.equal(historyAnalysis.items[0].actualQualityLabel.startsWith("1080\u00d71920"), true);
assert.match(historyAnalysis.items[0].diagnostics[0].fallbackReason, /Failed to fetch/);

const html = buildEnhancedDownloadReportHtml({
  generatedAt: "2026-07-16T10:00:00.000Z",
  items,
}, "test-folder");
assert.match(html, /抖音本地库与画质分析/);
assert.match(html, /最高可用画质/);
assert.match(html, /实际下载画质/);
assert.match(html, /最高分辨率达成率/);
assert.match(html, /失败原因 Top 12/);
assert.match(html, /id="quality"/);
assert.match(html, /data-quality="degraded"/);
assert.match(html, /2160×3840/);
assert.match(html, /1080×1920/);
assert.match(html, /&lt;script&gt;alert/);
assert.doesNotMatch(html, /<script>alert\('xss'\)<\/script>/);

console.log("OK: enhanced local library analytics, quality diagnostics, filters, and XSS escaping passed");
