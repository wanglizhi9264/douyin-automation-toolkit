export function pickVideoUrl(aweme, { preferBestQuality = false } = {}) {
  const candidates = [];
  const video = aweme?.video || {};
  for (const item of video.bit_rate || []) {
    if (item?.play_addr?.url_list?.length) {
      candidates.push({
        url: item.play_addr.url_list.at(-1),
        width: item.play_addr.width || 0,
        size: item.play_addr.data_size || 0,
        bitrate: item.bit_rate || 0,
        codec: item.is_h265 ? "h265" : "h264",
      });
    }
  }
  for (const [key, codec] of [["play_addr_h264", "h264"], ["play_addr_h265", "h265"], ["play_addr", "unknown"]]) {
    const address = video[key];
    if (address?.url_list?.length) {
      candidates.push({
        url: address.url_list.at(-1),
        width: address.width || 0,
        size: address.data_size || 0,
        bitrate: 0,
        codec,
      });
    }
  }
  const valid = candidates.filter((candidate) => candidate.url);
  if (!valid.length) return null;
  if (!preferBestQuality) {
    return valid.find((candidate) => candidate.codec === "h264") || valid[0];
  }
  return valid.sort((a, b) => (b.width - a.width) || (b.bitrate - a.bitrate) || (b.size - a.size))[0];
}

export function normalizeAweme(aweme, index = 0, source = "liked") {
  const awemeId = String(aweme?.aweme_id || aweme?.awemeId || aweme?.id || "");
  const videoCandidate = pickVideoUrl(aweme);
  return {
    awemeId,
    index,
    source,
    status: aweme?.collect_stat === 1 ? "already_favorited" : "pending",
    collectStat: aweme?.collect_stat ?? null,
    desc: aweme?.desc || "",
    authorUid: aweme?.author?.uid || "",
    authorName: aweme?.author?.nickname || "",
    url: awemeId ? `https://www.douyin.com/video/${awemeId}` : "",
    coverUrl: aweme?.video?.cover?.url_list?.[0] || "",
    videoUrl: videoCandidate?.url || "",
    downloadStatus: "not_started",
    lastError: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
