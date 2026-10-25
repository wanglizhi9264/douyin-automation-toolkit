import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../src/sidebar/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../src/sidebar/app.js", import.meta.url), "utf8");

const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);
assert.deepEqual(duplicateIds, [], "sidebar HTML must not contain duplicate ids");

const referencedIds = [...app.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]);
const missingIds = [...new Set(referencedIds)].filter((id) => !htmlIds.includes(id));
assert.deepEqual(missingIds, [], "every sidebar element referenced by app.js must exist");

for (const requiredId of [
  "downloadView",
  "favoriteView",
  "downloadBtn",
  "downloadBookmarkedBtn",
  "downloadFollowingBtn",
  "likedLocalDownloadedCount",
  "bookmarkedLocalDownloadedCount",
  "followingLocalDownloadedCount",
]) {
  assert.ok(htmlIds.includes(requiredId), `missing required two-view UI element: ${requiredId}`);
}

assert.match(app, /summarizeLocalDownloads/);
assert.match(app, /getLocalFolderCounts/);
assert.match(app, /getScopeWorkIds/);
assert.match(app, /reconcilePageItemsWithFolderIds/);
assert.match(app, /Math\.max\([\s\S]*countDownloadedInScope\("liked"\)[\s\S]*likedFolderIds\.size/);
assert.match(app, /download-counts\.json/);
assert.match(app, /download-index\.json/);
assert.match(app, /updateLocalFolderCount/);
assert.match(app, /markDownloadIndexCompleted/);
assert.match(app, /const shouldWriteState = forceFull/);
assert.match(app, /buildDownloadRecord\(items, state, previousRecord = null\)/);
assert.match(app, /syncFollowingAuthors\(\{ force = false \} = \{\}\)/);
assert.match(app, /syncFollowingAuthorWorks\(authors, selectedAuthorUids\)/);
assert.match(app, /sendPageRequest\("FETCH_AUTHOR_AWEME_PAGE"/);
assert.match(app, /await syncFollowingAuthorWorks\(followingAuthors, selectedFollowingAuthors\)/);
assert.match(app, /if \(downloadRunning\) return;[\s\S]*scheduledRenderTimer/);
console.log("OK: two-view sidebar, three download scopes, and local-count bindings passed");
