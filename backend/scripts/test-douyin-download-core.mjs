import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyListReconciliation,
  downloadItemKey,
  inferPreviousSnapshot,
  loadDownloadRecord,
  mediaRelativePaths,
  normalizeDownloadRecord,
  recordPaths,
  reconcileListSnapshot,
  saveDownloadRecord,
  upsertDownloadItem,
} from "./douyin-download-core.mjs";

const pluginRecord = normalizeDownloadRecord({
  generatedAt: "2026-07-15T00:00:00.000Z",
  user: { uid: "user-1", nickname: "tester" },
  current: { scope: "liked", phase: "paused" },
  items: [
    {
      awemeId: "same",
      source: "liked",
      downloadStatus: "downloaded",
      videoPath: "data/liked/same.mp4",
    },
    {
      awemeId: "same",
      source: "bookmarked",
      downloadStatus: "not_started",
    },
  ],
});

assert.equal(pluginRecord.items.length, 2);
assert.equal(downloadItemKey("favorite_api", "same"), "liked:same");
assert.equal(downloadItemKey("bookmarked", "same"), "bookmarked:same");

const inferred = inferPreviousSnapshot(pluginRecord, "liked");
assert.deepEqual(inferred.ids, ["same"]);
assert.equal(inferred.migratedFromItems, true);

upsertDownloadItem(pluginRecord, {
  awemeId: "2",
  source: "liked",
  downloadStatus: "downloaded",
});
upsertDownloadItem(pluginRecord, {
  awemeId: "3",
  source: "liked",
  downloadStatus: "not_started",
});
upsertDownloadItem(pluginRecord, {
  awemeId: "4",
  source: "liked",
  downloadStatus: "downloaded",
});

const reconciliation = reconcileListSnapshot({
  ids: ["same", "2"],
  missingIds: ["4"],
}, ["2", "3", "4"], "2026-07-15T01:00:00.000Z");

assert.equal(reconciliation.hasBaseline, true);
assert.deepEqual(reconciliation.addedIds, ["3"]);
assert.deepEqual(reconciliation.removedIds, ["same"]);
assert.deepEqual(reconciliation.reappearedIds, ["4"]);
assert.deepEqual(reconciliation.snapshot.missingIds, ["same"]);

applyListReconciliation(pluginRecord, "liked", reconciliation);
const byKey = new Map(pluginRecord.items.map((item) => [item.itemKey, item]));
assert.equal(byKey.get("liked:same").listState, "removed");
assert.equal(byKey.get("liked:2").listState, "present");
assert.equal(byKey.get("liked:3").listState, "present");
assert.equal(byKey.get("liked:4").listState, "present");
assert.equal(byKey.get("bookmarked:same").listState, undefined);
assert.deepEqual(pluginRecord.listSnapshots.liked.lastChanges, {
  addedIds: ["3"],
  removedIds: ["same"],
  reappearedIds: ["4"],
});

const firstBaseline = reconcileListSnapshot(null, ["10", "11"], "2026-07-15T02:00:00.000Z");
assert.equal(firstBaseline.hasBaseline, false);
assert.deepEqual(firstBaseline.addedIds, []);
assert.equal(firstBaseline.snapshot.total, 2);

const likedPaths = mediaRelativePaths("liked", "100");
const bookmarkedPaths = mediaRelativePaths("bookmarked", "200");
assert.equal(likedPaths.video, "data/\u70b9\u8d5e/\u89c6\u9891/100.mp4");
assert.equal(bookmarkedPaths.video, "data/\u6536\u85cf/\u89c6\u9891/200.mp4");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-download-record-"));
try {
  saveDownloadRecord(tempRoot, pluginRecord);
  pluginRecord.current.phase = "completed";
  pluginRecord.events.push({ at: "2026-07-15T03:00:00.000Z", text: "second checkpoint" });
  saveDownloadRecord(tempRoot, pluginRecord);

  const loaded = loadDownloadRecord(tempRoot);
  assert.equal(loaded.user.uid, "user-1");
  assert.equal(loaded.current.phase, "completed");
  assert.equal(loaded.current.scope, "liked");
  assert.equal(loaded.items.length, pluginRecord.items.length);
  assert.equal(loaded.listSnapshots.liked.total, 3);
  assert.equal(fs.existsSync(path.join(tempRoot, "data", ".appdata", "download-log.json")), true);

  const paths = recordPaths(tempRoot);
  const pluginState = JSON.parse(fs.readFileSync(paths.record, "utf8"));
  delete pluginState.events;
  fs.writeFileSync(paths.record, JSON.stringify(pluginState));
  fs.writeFileSync(paths.log, JSON.stringify({
    logs: [{ at: "2026-07-15T04:00:00.000Z", text: "plugin log preserved" }],
  }));
  const pluginLoaded = loadDownloadRecord(tempRoot);
  assert.equal(pluginLoaded.events.length, 1);
  assert.equal(pluginLoaded.events[0].text, "plugin log preserved");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("OK: backend download record, repeat checkpoints, scoped resume, and reconciliation tests passed");
