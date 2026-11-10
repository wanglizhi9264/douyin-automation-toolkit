import assert from "node:assert/strict";
import { RetryCoordinator } from "../src/core/retry.js";
import { httpError, retryAfterMs } from "../src/shared/http.js";
import { createMediaDownloader } from "../src/core/media.js";
import { Sources } from "../src/core/sources.js";

assert.equal(retryAfterMs("45", 0), 45000);
assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:01:00 GMT", 0), 60000);
assert.equal(retryAfterMs("bad"), 0);
function clock(options = {}) {
  let time = 0;
  const waits = [];
  const retry = new RetryCoordinator({
    now: () => time,
    wait: async (ms, signal) => {
      if (signal?.aborted) throw new DOMException("paused", "AbortError");
      waits.push(ms);
      time += ms;
    },
    random: () => 0,
    ...options,
  });
  return {
    retry,
    waits,
    get time() {
      return time;
    },
  };
}
const c = clock({ maxRateRetries: 2 });
let attempts = 0;
const starts = [];
assert.equal(
  await c.retry.run(async () => {
    starts.push(c.time);
    if (attempts++ < 2) throw httpError(429, attempts === 1 ? "45" : null);
    return "saved";
  }),
  "saved",
);
assert.deepEqual(starts, [0, 45000, 75000]);
assert.deepEqual(c.waits, [45000, 30000]);
const restore = clock();
restore.retry.restore({
  until: 120000,
  status: 429,
  reason: "HTTP 429",
  attempt: 1,
});
let ranAt = 0;
await restore.retry.run(async () => {
  ranAt = restore.time;
});
assert.equal(ranAt, 120000);
const exhausted = clock({ maxRateRetries: 1 });
let n = 0;
await assert.rejects(
  () =>
    exhausted.retry.run(async () => {
      n++;
      throw httpError(429);
    }),
  (e) => e.httpStatus === 429 && e.retryExhausted,
);
assert.equal(n, 2);
assert.ok(exhausted.retry.info.exhausted);
const controller = new AbortController();
controller.abort();
await assert.rejects(
  () =>
    c.retry.run(
      async () => {
        throw new Error("must not run");
      },
      { signal: controller.signal },
    ),
  (e) => e.name === "AbortError",
);
const sources = new Sources(async () =>
  ++n === 101
    ? { ok: false, httpStatus: 429, retryAfter: "50" }
    : { ok: true, json: { user: { uid: "self", sec_uid: "sec" } } },
);
n = 100;
const sourceClock = clock();
sources.retry = sourceClock.retry;
await sources.profile();
assert.equal(sourceClock.time, 50000);
function repo() {
  return {
    state: { works: {}, files: {} },
    target: { kind: "filesystem" },
    io: { file: async () => ({ size: 10 }), read: async () => null },
    async commit(patch) {
      for (const w of patch.works || [])
        this.state.works[w.id] = structuredClone(w);
      for (const f of patch.files || [])
        this.state.files[f.path] = structuredClone(f);
    },
  };
}
const raw = {
  aweme_id: "123",
  desc: "test",
  video: {
    bit_rate: [
      {
        bit_rate: 8000000,
        is_h265: 1,
        play_addr: {
          url_list: ["https://media.test/best"],
          width: 2160,
          height: 3840,
          data_size: 10,
        },
      },
      {
        bit_rate: 1000000,
        play_addr: {
          url_list: ["https://media.test/low"],
          width: 720,
          height: 1280,
          data_size: 10,
        },
      },
    ],
  },
};
const item = { id: "123", scope: "liked", taskId: "task" },
  signal = new AbortController().signal;
const bestRepo = repo(),
  bestClock = clock({rateBaseMs: 100}),
  requests = [];
let rateOnce = true;
await createMediaDownloader(
  bestRepo,
  { retry: bestClock.retry },
  {
    transfer: async (target, path, url) => {
      requests.push(url);
      if (rateOnce) {
        rateOnce = false;
        throw httpError(429, "0.1");
      }
      return { size: 10, contentType: "video/mp4" };
    },
  },
)(item, raw, signal, async () => {});
assert.deepEqual(
  requests,
  ["https://media.test/best", "https://media.test/best"],
  "429 retries the same highest candidate",
);
assert.equal(bestClock.time, 100);
const best = Object.values(bestRepo.state.files)[0];
assert.equal(best.qualityOutcome, "best");
assert.equal(best.quality.width, 2160);
assert.equal(best.attempts[0].status, 429);
const fallbackRepo = repo();
await createMediaDownloader(
  fallbackRepo,
  { retry: clock().retry },
  {
    transfer: async (t, p, url) => {
      if (url.endsWith("best")) throw httpError(404);
      return { size: 10, contentType: "video/mp4" };
    },
  },
)(item, raw, signal, async () => {});
const fallback = Object.values(fallbackRepo.state.files)[0];
assert.equal(fallback.qualityOutcome, "degraded");
assert.equal(fallback.highest.width, 2160);
assert.equal(fallback.quality.width, 720);
assert.match(fallback.fallbackReason, /404/);
const limitedRepo = repo(),
  limitedClock = clock({ maxRateRetries: 1 }),
  limitedUrls = [];
await assert.rejects(
  () =>
    createMediaDownloader(
      limitedRepo,
      { retry: limitedClock.retry },
      {
        transfer: async (t, p, url) => {
          limitedUrls.push(url);
          throw httpError(429);
        },
      },
    )(item, raw, signal, async () => {}),
  (e) => e.httpStatus === 429,
);
assert.ok(limitedUrls.every((url) => url.endsWith("best")));
assert.equal(limitedRepo.state.works["123"].complete, false);
const refreshRepo = repo();
let refreshes = 0;
const one = {
  aweme_id: "123",
  video: {
    play_addr: {
      url_list: ["https://media.test/expired"],
      width: 1080,
      height: 1920,
      data_size: 10,
    },
  },
};
const refreshDownload = createMediaDownloader(
  refreshRepo,
  {
    retry: clock().retry,
    detail: async () => {
      refreshes++;
      return {
        aweme: {
          ...one,
          video: {
            play_addr: {
              ...one.video.play_addr,
              url_list: ["https://media.test/fresh"],
            },
          },
        },
      };
    },
  },
  {
    transfer: async (t, p, url) => {
      if (url.endsWith("expired")) throw httpError(403);
      return { size: 10, contentType: "video/mp4" };
    },
  },
);
await assert.rejects(() => refreshDownload(item, one, signal, async () => {}), e => e.mediaFailure);
assert.equal(refreshes, 0, "no inline detail refresh blocks the main pass");
await refreshDownload(item, null, signal, async () => {});
assert.equal(refreshes, 1);
assert.equal(Object.values(refreshRepo.state.files)[0].refreshedAddress, true);
console.log(
  "OK: Retry-After dates/seconds, exponential cooldown, cancellation, bounded 429, source retry, highest-quality retry without downgrade, recorded fallback and one-time expired-address refresh",
);

const forbiddenClock = clock();
let forbiddenCalls = 0;
const deniedDownload = createMediaDownloader(repo(), { retry: forbiddenClock.retry }, {
  transfer: async () => {
    forbiddenCalls++;
    throw httpError(403);
  },
});
await assert.rejects(() => deniedDownload(item, raw, signal, () => {}), e => e.httpStatus === 403);
assert.equal(forbiddenCalls, 1, "403 does not retry the same address or try another representation");
assert.deepEqual(forbiddenClock.waits, []);
const refreshedBest = repo(),
  refreshClock = clock(),
  freshUrls = [];
let freshCount = 0;
const freshDownload = createMediaDownloader(
  refreshedBest,
  {
    retry: refreshClock.retry,
    detail: async () => {
      freshCount++;
      return {
        aweme: {
          ...raw,
          video: {
            bit_rate: [
              {
                ...raw.video.bit_rate[0],
                play_addr: {
                  ...raw.video.bit_rate[0].play_addr,
                  url_list: ["https://media.test/new-best"],
                },
              },
              raw.video.bit_rate[1],
            ],
          },
        },
      };
    },
  },
  {
    transfer: async (t, p, url) => {
      freshUrls.push(url);
      if (url.endsWith("/best")) throw httpError(403);
      return { size: 10 };
    },
  },
);
await assert.rejects(() => freshDownload(item, raw, signal, () => {}), e => e.mediaFailure);
assert.equal(freshCount, 0);
await freshDownload(item, null, signal, () => {});
assert.equal(freshCount, 1);
assert.deepEqual(
  freshUrls,
  ["https://media.test/best", "https://media.test/new-best"],
  "refresh highest address before lower-quality fallback",
);
assert.equal(Object.values(refreshedBest.state.files)[0].quality.width, 2160);
const source403 = clock();
let sourceDenials = 0;
await assert.rejects(
  () =>
    source403.retry.run(async () => {
      sourceDenials++;
      throw httpError(403);
    }),
  (e) => e.httpStatus === 403,
);
assert.equal(
  sourceDenials,
  1,
  "403 retry is explicitly scoped to media, not all APIs",
);
console.log(
  "OK: single-attempt 403, one fresh highest address before fallback, bounded media-only policy",
);

for (const status of [403, 429, 503, 0]) {
  const c = clock();
  let calls = 0;
  assert.equal(
    await c.retry.run(
      async () => {
        if (calls++ < 1)
          throw status ? httpError(status) : new TypeError("Failed to fetch");
        return "recovered";
      },
      { retryForbidden: true },
    ),
    "recovered",
  );
  assert.equal(calls, 2, "initial request plus one retry");
  const e = clock();
  let denials = 0;
  await assert.rejects(
    () =>
      e.retry.run(
        async () => {
          denials++;
          throw status ? httpError(status) : new TypeError("Failed to fetch");
        },
        { retryForbidden: true },
      ),
    (error) => error.retryExhausted === true,
  );
  assert.equal(denials, 2, "bounded automatic recovery");
  if (status === 403)
    assert.equal(
      e.retry.info,
      null,
      "exhausted 403 does not add an unused cooldown",
    );
}
const pauseClock = clock({
  wait: async () => {
    throw new DOMException("paused", "AbortError");
  },
});
let pauseCalls = 0;
await assert.rejects(
  () =>
    pauseClock.retry.run(
      async () => {
        pauseCalls++;
        throw httpError(403);
      },
      { retryForbidden: true },
    ),
  (e) => e.name === "AbortError",
);
assert.equal(pauseCalls, 1, "pause interrupts backoff before next request");
console.log(
  "OK: media 403, 429, 503 and network failures retry once, stop after two attempts, pause interrupts waiting",
);

for (const error of [Object.assign(new Error("媒体响应停滞"),{retryable:true}),new TypeError("network error"),new Error("connection reset")]) {
  const retryClock=clock();let tries=0;
  assert.equal(await retryClock.retry.run(async()=>{if(tries++<1)throw error;return true}),true);
  assert.equal(tries,2);
}
console.log("OK: explicit transfer timeout/truncation flags and network connection errors retry without treating validation or permission failures as transient");

const gated = clock();
let gatedCalls = 0;
await assert.rejects(() => gated.retry.run(async () => {
  gatedCalls++;
  throw httpError(429, "60");
}, {deadline:2000,rateKey:'https://cdn-a.test'}), e => e.retryExhausted && e.retryUntil === 60000);
assert.equal(gatedCalls, 1);
assert.deepEqual(gated.waits, [], 'long Retry-After does not occupy a download slot');
assert.equal(gated.retry.info, null, 'media cooldown does not globally pause other work');
assert.equal(await gated.retry.run(async()=> 'other host', {deadline:2000,rateKey:'https://cdn-b.test'}), 'other host');
await assert.rejects(() => gated.retry.run(async()=>assert.fail('cooling host must not request'),
  {deadline:2000,rateKey:'https://cdn-a.test'}), e => e.retryExhausted && e.httpStatus === 429);
const budget = clock();
let budgetCalls=0;
await assert.rejects(() => budget.retry.run(async()=> {
  budgetCalls++; await budget.retry.wait(1950);throw httpError(403);
}, {deadline:2000,retryForbidden:true}), e=>e.retryExhausted);
assert.equal(budgetCalls, 1, 'retry cannot exceed shared 2 second budget');
assert.equal(budget.time, 1950);
console.log('OK: shared failure budget, one backoff, per-host 429 gates, unrelated hosts keep downloading');

// A stuck list request cannot hold up details. Cancelling queued details
// rejects immediately and prevents the cancelled request from being sent.
let releaseList, releaseDetail;
const listGate = new Promise(resolve => { releaseList = resolve; });
const detailGate = new Promise(resolve => { releaseDetail = resolve; });
const requested = [];
const lanes = new Sources(async (type, payload) => {
  requested.push(payload.id);
  if (payload.id === "list") await listGate;
  if (payload.id === "detail") await detailGate;
  return { ok: true };
});
const listing = lanes.call("FETCH_LIKED_PAGE", { id: "list" });
const detail = lanes.call("FETCH_AWEME_DETAIL", { id: "detail" });
await new Promise(resolve => setTimeout(resolve, 10));
assert.deepEqual(requested, ["list", "detail"]);
const cancelled = new AbortController();
const waiting = lanes.call("FETCH_AWEME_DETAIL", { id: "cancelled" }, cancelled.signal);
cancelled.abort();
await assert.rejects(waiting, { name: "AbortError" });
releaseDetail();
releaseList();
await Promise.all([listing, detail]);
await lanes.call("FETCH_AWEME_DETAIL", { id: "next" });
assert.deepEqual(requested, ["list", "detail", "next"]);
console.log("OK: independent paced list/detail lanes and immediate queued-request cancellation");
