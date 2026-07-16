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

function addressUrls(value) {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string" && entry);
  for (const key of ["download_url_list", "url_list", "urls"]) {
    const urls = addressUrls(value[key]);
    if (urls.length) return urls;
  }
  return [];
}

function pickImageUrl(image) {
  for (const value of [
    image?.download_url_list,
    image?.download_url,
    image?.origin_image,
    image?.display_image,
    image?.owner_watermark_image,
    image?.image_url,
    image?.url_list,
    image?.url,
  ]) {
    const urls = addressUrls(value);
    if (urls.length) return urls.at(-1);
  }
  return "";
}

function videoObject(entry) {
  return entry?.video || entry?.video_info || entry?.videoInfo || entry || null;
}

function videoPartFrom(entry, partId, role, now) {
  const video = videoObject(entry);
  if (!video) return null;
  const aweme = { video };
  const candidates = pickVideoCandidates(aweme, { preferBestQuality: true }).slice(0, 5);
  const fallbackCandidate = pickVideoUrl(aweme, { preferBestQuality: false });
  if (!candidates.length && !fallbackCandidate?.url) return null;
  return {
    partId,
    kind: "video",
    role,
    url: (fallbackCandidate || candidates[0])?.url || "",
    candidates,
    fallbackCandidate,
    candidatesFetchedAt: now,
  };
}

function explicitVideoEntries(aweme) {
  const collections = [
    aweme?.video_list,
    aweme?.videos,
    aweme?.video_segments,
    aweme?.multi_video?.video_list,
    aweme?.multi_video?.videos,
    aweme?.multi_video?.segments,
    aweme?.video?.video_list,
    aweme?.video?.segments,
  ];
  return collections.find((entries) => Array.isArray(entries) && entries.length) || [];
}

export function extractMediaParts(aweme, { now = new Date().toISOString() } = {}) {
  const parts = [];
  const images = Array.isArray(aweme?.images) ? aweme.images : [];
  for (const [index, image] of images.entries()) {
    const url = pickImageUrl(image);
    if (url) {
      parts.push({
        partId: `image-${index + 1}`,
        kind: "image",
        role: "carousel",
        url,
        width: Number(image?.width || image?.display_image?.width || 0),
        height: Number(image?.height || image?.display_image?.height || 0),
      });
    }
    const liveVideo = videoPartFrom(
      image?.video || image?.video_info || image?.live_photo?.video,
      `live-video-${index + 1}`,
      "live_photo",
      now,
    );
    if (liveVideo) parts.push(liveVideo);
  }

  const explicitVideos = explicitVideoEntries(aweme);
  for (const [index, entry] of explicitVideos.entries()) {
    const part = videoPartFrom(entry, `video-${index + 1}`, "segment", now);
    if (part) parts.push(part);
  }

  if (!images.length && !explicitVideos.length) {
    const part = videoPartFrom(aweme?.video, "video-1", "primary", now);
    if (part) parts.push(part);
  }

  const seen = new Set();
  return parts
    .filter((part) => {
      const key = part.kind + ":" + part.url;
      if (!part.url || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((part, index) => ({ ...part, order: index + 1 }));
}

export function mediaTypeForParts(parts) {
  const images = (parts || []).filter((part) => part.kind === "image").length;
  const videos = (parts || []).filter((part) => part.kind === "video").length;
  if (images && videos) return "mixed";
  if (images > 1) return "multi_image";
  if (images === 1) return "image";
  if (videos > 1) return "multi_video";
  if (videos === 1) return "video";
  return "unsupported";
}

export function normalizeAweme(aweme, index = 0, source = "liked") {
  const awemeId = String(aweme?.aweme_id || aweme?.awemeId || aweme?.id || "");
  const now = new Date().toISOString();
  const mediaParts = extractMediaParts(aweme, { now });
  const mediaType = mediaTypeForParts(mediaParts);
  const primaryVideo = mediaParts.find((part) => part.kind === "video") || null;
  const firstImage = mediaParts.find((part) => part.kind === "image") || null;
  const videoCandidates = primaryVideo?.candidates || [];
  const videoFallbackCandidate = primaryVideo?.fallbackCandidate || null;
  const videoCandidate = videoFallbackCandidate || videoCandidates[0] || null;
  const isImagePost = mediaParts.some((part) => part.kind === "image");
  return {
    awemeId,
    index,
    source,
    status: aweme?.collect_stat === 1 ? "already_favorited" : "pending",
    collectStat: aweme?.collect_stat ?? null,
    desc: aweme?.desc || "",
    authorUid: aweme?.author?.uid || "",
    authorName: aweme?.author?.nickname || "",
    url: awemeId
      ? `https://www.douyin.com/${isImagePost ? "note" : "video"}/${awemeId}`
      : "",
    mediaType,
    mediaCount: mediaParts.length,
    mediaParts,
    imageUrls: mediaParts.filter((part) => part.kind === "image").map((part) => part.url),
    coverUrl: firstImage?.url || aweme?.video?.cover?.url_list?.[0] || "",
    videoUrl: videoCandidate?.url || "",
    videoCandidates,
    videoFallbackCandidate,
    videoCandidatesFetchedAt: primaryVideo?.candidatesFetchedAt || "",
    downloadStatus: "not_started",
    downloadedMediaParts: {},
    lastError: "",
    createdAt: now,
    updatedAt: now,
  };
}
