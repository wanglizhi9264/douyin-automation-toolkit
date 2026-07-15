const MAX_SAMPLES = 2000;

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

function rounded(value, digits = 1) {
  const multiplier = 10 ** digits;
  return Math.round(Number(value || 0) * multiplier) / multiplier;
}

export function createPerformanceTracker(scope, {
  now = Date.now(),
  monotonic = monotonicNow(),
} = {}) {
  return {
    schemaVersion: 1,
    scope: scope || "unknown",
    startedAt: new Date(now).toISOString(),
    startedAtMonotonic: monotonic,
    samples: [],
  };
}

export function recordPerformanceSample(tracker, stage, durationMs, meta = {}) {
  if (!tracker || !stage) return null;
  const sample = {
    stage: String(stage),
    durationMs: Math.max(0, Number(durationMs || 0)),
    bytes: Math.max(0, Number(meta.bytes || 0)),
    ...meta,
    at: meta.at || new Date().toISOString(),
  };
  tracker.samples.push(sample);
  if (tracker.samples.length > MAX_SAMPLES) {
    tracker.samples.splice(0, tracker.samples.length - MAX_SAMPLES);
  }
  return sample;
}

export async function measurePerformance(tracker, stage, task, meta = {}) {
  const startedAt = monotonicNow();
  try {
    const result = await task();
    recordPerformanceSample(tracker, stage, monotonicNow() - startedAt, {
      ...meta,
      ok: true,
    });
    return result;
  } catch (error) {
    recordPerformanceSample(tracker, stage, monotonicNow() - startedAt, {
      ...meta,
      ok: false,
      error: error?.message || String(error),
    });
    throw error;
  }
}

export function summarizePerformance(tracker, {
  monotonic = monotonicNow(),
  endedAt = Date.now(),
} = {}) {
  if (!tracker) return null;
  const grouped = new Map();
  for (const sample of tracker.samples || []) {
    const list = grouped.get(sample.stage) || [];
    list.push(sample);
    grouped.set(sample.stage, list);
  }
  const stages = {};
  for (const [stage, samples] of grouped) {
    const durations = samples.map((sample) => Number(sample.durationMs || 0)).sort((a, b) => a - b);
    const totalMs = durations.reduce((sum, value) => sum + value, 0);
    const bytes = samples.reduce((sum, sample) => sum + Number(sample.bytes || 0), 0);
    stages[stage] = {
      count: samples.length,
      totalMs: rounded(totalMs),
      averageMs: rounded(totalMs / Math.max(samples.length, 1)),
      p50Ms: rounded(percentile(durations, 0.5)),
      p95Ms: rounded(percentile(durations, 0.95)),
      maxMs: rounded(durations.at(-1) || 0),
      bytes,
      megabytesPerSecond: totalMs > 0 && bytes > 0
        ? rounded((bytes / 1024 / 1024) / (totalMs / 1000), 2)
        : 0,
      failures: samples.filter((sample) => sample.ok === false).length,
    };
  }
  const bottlenecks = Object.entries(stages)
    .sort(([, left], [, right]) => right.totalMs - left.totalMs)
    .slice(0, 5)
    .map(([stage, value]) => ({
      stage,
      totalMs: value.totalMs,
      count: value.count,
    }));
  return {
    schemaVersion: 1,
    scope: tracker.scope,
    startedAt: tracker.startedAt,
    endedAt: new Date(endedAt).toISOString(),
    wallMs: rounded(Math.max(0, monotonic - Number(tracker.startedAtMonotonic || 0))),
    sampleCount: tracker.samples.length,
    stages,
    bottlenecks,
  };
}

export function formatPerformanceSummary(summary) {
  if (!summary) return "";
  const top = (summary.bottlenecks || [])
    .slice(0, 4)
    .map((entry) => entry.stage + "=" + (entry.totalMs / 1000).toFixed(1) + "s")
    .join(" | ");
  return "total=" + (Number(summary.wallMs || 0) / 1000).toFixed(1) + "s"
    + (top ? " | " + top : "");
}
