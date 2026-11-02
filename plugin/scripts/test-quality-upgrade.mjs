import assert from "node:assert/strict";
import { normalizeAweme } from "../src/shared/api.js";
import {
  createMediaDownloader,
  qualityUpgradeParts,
  isBetterQuality,
} from "../src/core/media.js";
import { RetryCoordinator } from "../src/core/retry.js";
import { httpError } from "../src/shared/http.js";
const raw = {
  aweme_id: "123",
  video: {
    play_addr: {
      url_list: ["https://media.test/high"],
      width: 1080,
      height: 1920,
      data_size: 20,
    },
  },
};
const partId = normalizeAweme(raw, 0, "liked").mediaParts[0].partId;
function fixture() {
  const old = {
    path: "data/old.mp4",
    workId: "123",
    partId,
    kind: "video",
    complete: true,
    size: 10,
    quality: { width: 720, height: 1280 },
    highest: { width: 1080, height: 1920 },
    qualityOutcome: "degraded",
  };
  const state = {
    works: {
      123: { id: "123", complete: true, sources: ["liked"], files: [old.path] },
    },
    files: { [old.path]: old },
  };
  const removed = [];
  const events = [];
  return {
    state,
    removed,
    events,
    target: {},
    io: {
      file: async () => ({ size: 10 }),
      read: async () => null,
      remove: async (path) => {
        assert.ok(
          !state.works["123"].files.includes(path),
          "switch durable reference before deleting old media",
        );
        removed.push(path);
      },
    },
    commit: async (patch) => {
      events.push(structuredClone(patch));
      for (const w of patch.works || []) state.works[w.id] = structuredClone(w);
      for (const f of patch.files || []) {
        if (f.removed) delete state.files[f.path];
        else state.files[f.path] = structuredClone(f);
      }
    },
  };
}
function retry() {
  let now = 0;
  return new RetryCoordinator({
    now: () => now,
    random: () => 0,
    wait: async (ms) => {
      now += ms;
    },
  });
}
const signal = new AbortController().signal,
  item = { id: "123", scope: "liked", taskId: "task", upgrade: true };
const repo = fixture();
assert.deepEqual(
  qualityUpgradeParts(repo.state.works["123"], raw, repo.state.files),
  [partId],
);
const calls = [];
const result = await createMediaDownloader(
  repo,
  { retry: retry() },
  {
    transfer: async (t, p, u) => {
      calls.push(u);
      assert.equal(repo.state.works["123"].complete, true);
      assert.deepEqual(repo.state.works["123"].files, ["data/old.mp4"]);
      return { size: 20, contentType: "video/mp4" };
    },
  },
)(item, raw, signal, () => {});
assert.equal(result.upgraded, true);
assert.equal(calls.length, 1);
assert.equal(repo.state.works["123"].complete, true);
assert.equal(repo.removed.length, 1);
assert.equal(
  repo.state.files[repo.state.works["123"].files[0]].quality.width,
  1080,
);
assert.deepEqual(
  qualityUpgradeParts(repo.state.works["123"], raw, repo.state.files),
  [],
  "equal quality never downloads twice",
);
const failed = fixture();
await assert.rejects(
  () =>
    createMediaDownloader(
      failed,
      { retry: retry(), detail: async () => ({ aweme: raw }) },
      {
        transfer: async () => {
          throw httpError(403);
        },
      },
    )(item, raw, signal, () => {}),
  (e) => e.httpStatus === 403,
);
assert.equal(failed.state.works["123"].complete, true);
assert.deepEqual(failed.state.works["123"].files, ["data/old.mp4"]);
assert.equal(failed.removed.length, 0);
const changed = fixture();
const low = {
  ...raw,
  video: { play_addr: { ...raw.video.play_addr, width: 480, height: 854 } },
};
const unchanged = await createMediaDownloader(
  changed,
  { retry: retry() },
  {
    transfer: async () => {
      throw new Error("must not downgrade");
    },
  },
)(item, low, signal, () => {});
assert.equal(unchanged.unchanged, true);
assert.equal(changed.removed.length, 0);
assert.equal(
  isBetterQuality(
    { width: 1080, height: 1920, codec: "h264", bitrate: 8000 },
    { width: 1080, height: 1920, codec: "h265", bitrate: 4000 },
  ),
  false,
  "cross codec bitrate alone cannot imply higher quality",
);
assert.equal(
  isBetterQuality({ width: 1080, height: 1920 }, { width: 0, height: 0 }),
  false,
  "unknown legacy quality is not mass-downloaded",
);
console.log(
  "OK: safe 720→1080 upgrade, durable switch before cleanup, failed upgrade preserves original, no downgrade or repeat",
);

const shared=fixture();shared.state.works.other={id:'other',complete:true,sources:['liked'],files:['data/old.mp4']};
await createMediaDownloader(shared,{retry:retry()},{transfer:async()=>({size:20})})(item,raw,signal,()=>{});
assert.equal(shared.removed.length,0,'shared original media is retained');
assert.deepEqual(shared.state.works.other.files,['data/old.mp4']);

for(const status of ["best","unknown",undefined]) {
  const protectedRepo=fixture();protectedRepo.state.files['data/old.mp4'].qualityOutcome=status;
  assert.deepEqual(qualityUpgradeParts(protectedRepo.state.works['123'],raw,protectedRepo.state.files),[],`status ${status} never triggers upgrade`);
  const result=await createMediaDownloader(protectedRepo,{retry:retry(),detail:async()=>{throw new Error('must not fetch detail')}} ,{transfer:async()=>{throw new Error('must not transfer')}})(item,null,signal,()=>{});
  assert.equal(result.unchanged,true);
}
const newer={...raw,video:{play_addr:{...raw.video.play_addr,width:2160,height:3840}}};
assert.deepEqual(qualityUpgradeParts(repo.state.works['123'],newer,repo.state.files),[],'after best is confirmed even future larger candidates are skipped');
const mirror=fixture();mirror.state.files['data/old.mp4'].qualityOutcome='fallback';mirror.state.files['data/old.mp4'].quality={width:1080,height:1920};
assert.deepEqual(qualityUpgradeParts(mirror.state.works['123'],raw,mirror.state.files),[],'same quality mirror fallback is not downloaded twice');
console.log('OK: only saved non-best outcomes trigger; best/unknown never fetch details or transfer');
