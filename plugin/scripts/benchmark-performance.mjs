import { performance } from "node:perf_hooks";

const ITEM_COUNT = Number(process.argv[2] || 11319);
const ITERATIONS = Number(process.argv[3] || 20);

const items = Array.from({ length: ITEM_COUNT }, (_, index) => ({
  awemeId: String(7600000000000000000n + BigInt(index)),
  index,
  source: index % 2 ? "liked" : "bookmarked",
  status: "already_favorited",
  downloadStatus: index % 20 ? "downloaded" : "not_started",
  mediaType: "video",
  mediaCount: 1,
  desc: "性能基准作品描述".repeat(6),
  authorUid: `author-${index % 800}`,
  authorName: `作者 ${index % 800}`,
  videoPath: `data/点赞/视频/${7600000000000000000n + BigInt(index)}.mp4`,
  coverPath: `data/点赞/封面/${7600000000000000000n + BigInt(index)}.jpg`,
  resolution: "h264 1080x1920 30fps 1800kbps",
  size: 4_000_000 + index,
  updatedAt: "2026-10-06T00:00:00.000Z",
}));

const record = {
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  current: { scope: "liked", completed: 5000, total: 5573 },
  items,
};
const progress = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  current: { scope: "liked", completed: 5000, total: 5573, inspected: 5100 },
};

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function benchmark(name, task) {
  const times = [];
  let bytes = 0;
  for (let index = 0; index < ITERATIONS; index += 1) {
    const startedAt = performance.now();
    const value = task();
    times.push(performance.now() - startedAt);
    bytes = Buffer.byteLength(value);
  }
  return {
    name,
    iterations: ITERATIONS,
    bytes,
    p50Ms: Number(percentile(times, 0.5).toFixed(2)),
    p95Ms: Number(percentile(times, 0.95).toFixed(2)),
    p99Ms: Number(percentile(times, 0.99).toFixed(2)),
    maxMs: Number(Math.max(...times).toFixed(2)),
  };
}

const results = [
  benchmark("legacy_pretty_full_state", () => JSON.stringify(record, null, 2)),
  benchmark("compact_full_state", () => JSON.stringify(record)),
  benchmark("progress_checkpoint", () => JSON.stringify(progress)),
];

console.log(JSON.stringify({ itemCount: ITEM_COUNT, results }, null, 2));
