function candidateKey(candidate) {
  return [
    candidate.url || "",
    candidate.codec || "",
    candidate.width || 0,
    candidate.height || 0,
    candidate.bitrate || 0,
    candidate.size || 0,
    candidate.source || "",
  ].join("|");
}

function normalizeCandidate(candidate) {
  return {
    url: candidate.url || "",
    width: Number(candidate.width || 0),
    height: Number(candidate.height || 0),
    size: Number(candidate.size || 0),
    bitrate: Number(candidate.bitrate || 0),
    codec: candidate.codec || "unknown",
    source: candidate.source || "unknown",
    fps: Number(candidate.fps || 0),
    qualityType: Number(candidate.qualityType || 0),
  };
}

function scoreCandidate(candidate, { preferBestQuality = false } = {}) {
  const area = candidate.width * Math.max(candidate.height, 1);
  if (preferBestQuality) {
    return (
      area * 1e9
      + candidate.bitrate * 1e3
      + candidate.size
      + candidate.fps * 1e5
      + (candidate.codec === "h265" ? 5e4 : 0)
      + candidate.qualityType
    );
  }
  return (
    (candidate.codec === "h264" ? 1e15 : 0)
    + area * 1e9
    + candidate.bitrate * 1e3
    + candidate.size
    + candidate.fps * 1e5
    + candidate.qualityType
  );
}

export function pickVideoCandidates(aweme, { preferBestQuality = false } = {}) {
  const candidates = [];
  const video = aweme?.video || {};
  for (const item of video.bit_rate || []) {
    if (item?.play_addr?.url_list?.length) {
      candidates.push({
        url: item.play_addr.url_list.at(-1),
        width: item.play_addr.width || 0,
        height: item.play_addr.height || item.gear_name?.match(/_(\d+)p_/)?.[1] || 0,
        size: item.play_addr.data_size || 0,
        bitrate: item.bit_rate || 0,
        codec: item.is_h265 ? "h265" : "h264",
        source: "bit_rate",
        fps: item.FPS || item.fps || 0,
        qualityType: item.quality_type || 0,
      });
    }
  }
  for (const [key, codec] of [["play_addr_h264", "h264"], ["play_addr_h265", "h265"], ["play_addr", "unknown"]]) {
    const address = video[key];
    if (address?.url_list?.length) {
      candidates.push({
        url: address.url_list.at(-1),
        width: address.width || 0,
        height: address.height || 0,
        size: address.data_size || 0,
        bitrate: 0,
        codec,
        source: key,
        fps: 0,
        qualityType: 0,
      });
    }
  }
  const deduped = new Map();
  for (const raw of candidates) {
    const candidate = normalizeCandidate(raw);
    if (!candidate.url) continue;
    const key = candidateKey(candidate);
    const existing = deduped.get(key);
    if (!existing || scoreCandidate(candidate, { preferBestQuality: true }) > scoreCandidate(existing, { preferBestQuality: true })) {
      deduped.set(key, candidate);
    }
  }
  return [...deduped.values()].sort((a, b) => (
    scoreCandidate(b, { preferBestQuality }) - scoreCandidate(a, { preferBestQuality })
  ));
}

export function pickVideoUrl(aweme, { preferBestQuality = false } = {}) {
  return pickVideoCandidates(aweme, { preferBestQuality })[0] || null;
}

export function describeVideoCandidate(candidate) {
  if (!candidate) return "未知";
  const codec = candidate.codec || "unknown";
  const resolution = candidate.width && candidate.height
    ? `${candidate.width}x${candidate.height}`
    : (candidate.width ? `${candidate.width}w` : "0w");
  const bitrate = candidate.bitrate ? `${Math.round(candidate.bitrate / 1000)}kbps` : "bitrate?";
  const fps = candidate.fps ? ` ${candidate.fps}fps` : "";
  const size = candidate.size ? `${(candidate.size / 1024 / 1024).toFixed(1)}MB` : "size?";
  return `${codec} ${resolution}${fps} ${bitrate} ${size}`;
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
