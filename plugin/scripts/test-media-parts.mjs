import assert from "node:assert/strict";
import fs from "node:fs";

import {
  extractMediaParts,
  mediaTypeForParts,
  normalizeAweme,
} from "../src/shared/api.js";

const video = {
  aweme_id: "video-1",
  video: {
    bit_rate: [{
      bit_rate: 1200000,
      play_addr: {
        url_list: ["https://media/single.mp4"],
        width: 1080,
        height: 1920,
      },
    }],
  },
};
const videoParts = extractMediaParts(video);
assert.equal(videoParts.length, 1);
assert.equal(videoParts[0].kind, "video");
assert.equal(mediaTypeForParts(videoParts), "video");

const carousel = {
  aweme_id: "image-1",
  video: {
    play_addr: {
      url_list: ["https://media/generated-slideshow.mp4"],
      width: 1080,
      height: 1440,
    },
  },
  images: [
    { url_list: ["https://image/01.jpg"], width: 1080, height: 1440 },
    { download_url_list: ["https://image/02.webp"], width: 1080, height: 1440 },
  ],
};
const imageParts = extractMediaParts(carousel);
assert.equal(imageParts.length, 2);
assert.deepEqual(imageParts.map((part) => part.partId), ["image-1", "image-2"]);
assert.deepEqual(imageParts.map((part) => part.url), [
  "https://image/01.jpg",
  "https://image/02.webp",
]);
assert.equal(mediaTypeForParts(imageParts), "multi_image");
const normalizedCarousel = normalizeAweme(carousel, 3, "bookmarked");
assert.equal(normalizedCarousel.mediaType, "multi_image");
assert.equal(normalizedCarousel.mediaCount, 2);
assert.match(normalizedCarousel.url, /\/note\/image-1$/);
assert.equal(normalizedCarousel.coverUrl, "https://image/01.jpg");

const multiVideo = {
  aweme_id: "multi-video-1",
  video_list: [
    {
      play_addr: {
        url_list: ["https://media/segment-1.mp4"],
        width: 1080,
        height: 1920,
      },
    },
    {
      bit_rate: [{
        bit_rate: 2200000,
        play_addr: {
          url_list: ["https://media/segment-2.mp4"],
          width: 1440,
          height: 2560,
        },
      }],
    },
  ],
};
const multiVideoParts = extractMediaParts(multiVideo);
assert.equal(multiVideoParts.length, 2);
assert.equal(mediaTypeForParts(multiVideoParts), "multi_video");
assert.deepEqual(multiVideoParts.map((part) => part.partId), ["video-1", "video-2"]);
assert.ok(multiVideoParts.every((part) => part.candidates.length > 0));

const livePhoto = {
  aweme_id: "live-photo-1",
  images: [{
    url_list: ["https://image/live.jpg"],
    video: {
      play_addr: {
        url_list: ["https://media/live.mp4"],
        width: 1080,
        height: 1440,
      },
    },
  }],
};
const liveParts = extractMediaParts(livePhoto);
assert.equal(liveParts.length, 2);
assert.equal(mediaTypeForParts(liveParts), "mixed");
assert.deepEqual(liveParts.map((part) => part.kind), ["image", "video"]);

const sidebarSource = fs.readFileSync(new URL("../src/sidebar/app.js", import.meta.url), "utf8");
assert.match(sidebarSource, /downloadSegmentedMediaItem/);
assert.match(sidebarSource, /downloadedMediaParts/);
assert.match(sidebarSource, /download_media_part_skipped/);
assert.ok(sidebarSource.includes('${sourceFolder}/\u56fe\u7247/${base}/${order}.'));
assert.match(sidebarSource, /^async function requestBookmarkedOverview/m);
assert.match(sidebarSource, /let bookmarkedOverviewInFlight = null/);
assert.match(sidebarSource, /return bookmarkedOverviewInFlight/);
assert.match(sidebarSource, /bookmarkedOverviewInFlight[\s\S]+await requestBookmarkedOverview\(\{ reason: "bookmarked_scan" \}\)/);
assert.match(sidebarSource, /bookmarked_first_page_cache/);
assert.doesNotMatch(sidebarSource, /bookmarkedTotal \?\? folderRecord/);

console.log("OK: image carousel, live photo, explicit multi-video, and segmented resume contracts passed");
