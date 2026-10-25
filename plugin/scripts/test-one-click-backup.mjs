import assert from "node:assert/strict";
import fs from "node:fs";

const injected = fs.readFileSync(new URL("../src/injected.js", import.meta.url), "utf8");
const sidebar = fs.readFileSync(new URL("../src/sidebar/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../src/sidebar/index.html", import.meta.url), "utf8");

function sourceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}

assert.match(injected, /SCAN_SHARED_CONVERSATION/);
assert.match(injected, /FETCH_AWEME_DETAIL/);
assert.match(injected, /DIGG_AWEME/);
assert.match(injected, /params\.set\("type", "1"\)/);
assert.match(injected, /\/aweme\/v1\/web\/commit\/item\/digg\//);
assert.doesNotMatch(injected, /\/aweme\/v1\/web\/aweme\/digg\//);
assert.match(injected, /conversationKey/);
assert.match(injected, /conversationTargetScore/);
assert.match(injected, /addVideoIdsFromReactData/);
assert.match(injected, /messageEntryCandidates/);
assert.match(injected, /openMessageListAndFind/);
assert.match(injected, /searchMessageConversation/);
assert.match(injected, /\.messageMessageListlist/);
assert.match(injected, /waitForConversationScrollRoot\(15000\)/);
assert.match(injected, /#imSaasContainerId/);
assert.match(injected, /conversationRootDiagnostics/);
assert.match(injected, /\.MessageItemShareAwemecontainer/);
assert.match(injected, /searchParams\.get\("modal_id"\)/);
assert.match(injected, /feed-active-video/);
assert.match(injected, /video-player-no-digged/);
assert.match(injected, /video-player-is-digged/);
assert.match(injected, /\.o7hAjQkB \.gesnxrtb/);
assert.doesNotMatch(injected, /history\.back\(\)/);
assert.doesNotMatch(sourceFunction(injected, "sharedAwemeModal"), /querySelector\([^)]*#slidelist/);
assert.match(injected, /likeState: "not-opened"/);
assert.match(injected, /scanSharedAwemeCards/);
assert.match(sidebar, /likeMissing: true/);
assert.match(sidebar, /1_800_000/);
assert.doesNotMatch(sourceFunction(sidebar, "likeSharedConversationWorks"), /DIGG_AWEME/);
assert.doesNotMatch(injected, /找到多个昵称为.*无法安全判断/);
assert.match(sidebar, /const SHARED_CONVERSATION_NAME = "王立志"/);
assert.match(sidebar, /await runDownloadBatch\("liked"\)[\s\S]+await runDownloadBatch\("bookmarked"\)[\s\S]+await runDownloadBatch\("following"\)/);
assert.match(sidebar, /sharedConversationBinding/);
assert.match(sidebar, /但没有识别到分享作品/);
assert.match(sidebar, /分享扫描完成：发现/);
assert.match(html, /id="oneClickBackupBtn"/);

const parseIds = new Function(`${sourceFunction(injected, "addVideoIdsFromText")}; return addVideoIdsFromText;`)();
const parsedIds = new Set();
parseIds(parsedIds, "https://www.douyin.com/video/7686022498153052409");
parseIds(parsedIds, "itemId:85423833389");
parseIds(parsedIds, "https%3A%2F%2Fwww.douyin.com%2Fvideo%2F7686022498153052410");
assert.deepEqual([...parsedIds], ["7686022498153052409", "7686022498153052410"]);
assert.equal(parsedIds.has("85423833389"), false, "short user/message ids must not be treated as aweme ids");

console.log("OK: private-message share liking and sequential one-click backup contracts passed");
