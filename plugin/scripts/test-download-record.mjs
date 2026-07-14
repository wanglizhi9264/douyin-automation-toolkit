import assert from "node:assert/strict";
import fs from "node:fs";

import { recoverDownloadedRecords } from "../src/shared/download-record.js";

const now = "2026-07-15T08:00:00.000Z";
const video100 = "data/\u70b9\u8d5e/\u89c6\u9891/100.mp4";
const cover100 = "data/\u70b9\u8d5e/\u5c01\u9762/100.jpg";
const video200 = "data/\u70b9\u8d5e/\u89c6\u9891/200.mp4";
const recovered = recoverDownloadedRecords([
  {
    awemeId: "100",
    index: 0,
    source: "liked",
    status: "already_favorited",
    desc: "keep-local-description",
    downloadStatus: "failed",
  },
  {
    awemeId: "300",
    index: 2,
    source: "liked",
    downloadStatus: "downloaded",
  },
], [
  {
    awemeId: "100",
    downloadStatus: "downloaded",
    resolution: "1440x2560",
    videoPath: video100,
    coverPath: cover100,
    size: 1234,
  },
  {
    awemeId: "200",
    index: 1,
    source: "liked",
    downloadStatus: "downloaded",
    desc: "reconstructed",
    authorUid: "author-1",
    videoPath: video200,
  },
  {
    awemeId: "300",
    downloadStatus: "downloaded",
  },
  {
    awemeId: "400",
    downloadStatus: "failed",
  },
], { now });

assert.equal(recovered.length, 2);
const patched = recovered.find((item) => item.awemeId === "100");
assert.equal(patched.downloadStatus, "downloaded");
assert.equal(patched.desc, "keep-local-description");
assert.equal(patched.downloadQualityLabel, "1440x2560");
assert.equal(patched.downloadVideoPath, video100);
assert.equal(patched.updatedAt, now);

const reconstructed = recovered.find((item) => item.awemeId === "200");
assert.equal(reconstructed.source, "liked");
assert.equal(reconstructed.status, "already_favorited");
assert.equal(reconstructed.downloadStatus, "downloaded");
assert.equal(reconstructed.authorUid, "author-1");

const sidebarSource = fs.readFileSync(new URL("../src/sidebar/app.js", import.meta.url), "utf8");
assert.match(sidebarSource, /folderUserId && currentUserId && folderUserId !== currentUserId/);
assert.match(sidebarSource, /record\.user = \{/);
assert.match(sidebarSource, /consecutiveFailures >= 8/);
assert.match(sidebarSource, /preferBrowserDownloads: false/);
assert.match(sidebarSource, /preferSavedFolder: true/);

console.log("OK: folder download record recovery tests passed");
