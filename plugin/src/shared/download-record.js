function recordKey(source, awemeId) {
  const scope = source === "favorite_api" ? "liked" : (source || "liked");
  return scope + ":" + String(awemeId || "");
}

export function recoverDownloadedRecords(existingItems, recordItems, {
  defaultSource = "liked",
  now = new Date().toISOString(),
} = {}) {
  const existingById = new Map(existingItems.map((item) => [
    recordKey(item.source, item.awemeId), item,
  ]));
  let nextIndex = existingItems.reduce(
    (max, item) => Math.max(max, Number(item.index ?? -1)),
    -1,
  ) + 1;
  const recovered = [];
  for (const recordItem of recordItems || []) {
    const downloadedMediaParts = recordItem?.downloadedMediaParts || {};
    const downloadedPartCount = Object.values(downloadedMediaParts)
      .filter((part) => part?.status === "downloaded").length;
    const fullyDownloaded = recordItem?.downloadStatus === "downloaded";
    if (!recordItem?.awemeId || (!fullyDownloaded && !downloadedPartCount)) continue;
    const awemeId = String(recordItem.awemeId);
    const source = recordItem.source || defaultSource;
    const existing = existingById.get(recordKey(source, awemeId));
    if (existing?.downloadStatus === "downloaded") continue;
    const restoredStatus = fullyDownloaded ? "downloaded" : "not_started";
    if (existing) {
      recovered.push({
        ...existing,
        downloadStatus: restoredStatus,
        lastError: "",
        downloadQualityLabel: recordItem.resolution || existing.downloadQualityLabel || "",
        downloadWidth: recordItem.width || existing.downloadWidth || 0,
        downloadHeight: recordItem.height || existing.downloadHeight || 0,
        downloadBitrate: recordItem.bitrate || existing.downloadBitrate || 0,
        downloadCodec: recordItem.codec || existing.downloadCodec || "",
        downloadFps: recordItem.fps || existing.downloadFps || 0,
        downloadSize: recordItem.size || existing.downloadSize || 0,
        downloadCandidateRank: recordItem.candidateRank || recordItem.downloadCandidateRank || existing.downloadCandidateRank || 0,
        downloadQualityFallbackReason: recordItem.qualityFallbackReason || recordItem.downloadQualityFallbackReason || existing.downloadQualityFallbackReason || "",
        downloadVideoPath: recordItem.videoPath || existing.downloadVideoPath || "",
        downloadCoverPath: recordItem.coverPath || existing.downloadCoverPath || "",
        updatedAt: now,
        mediaType: recordItem.mediaType || existing.mediaType || "video",
        mediaCount: recordItem.mediaCount || existing.mediaCount || 0,
        mediaParts: recordItem.mediaParts?.length ? recordItem.mediaParts : (existing.mediaParts || []),
        downloadedMediaParts: {
          ...(existing.downloadedMediaParts || {}),
          ...downloadedMediaParts,
        },
        downloadedPartCount: Math.max(downloadedPartCount, existing.downloadedPartCount || 0),
        downloadMediaPaths: recordItem.mediaPaths || existing.downloadMediaPaths || [],
        downloadImagePaths: recordItem.imagePaths || existing.downloadImagePaths || [],
      });
      continue;
    }
    const recordIndex = Number(recordItem.index);
    const index = Number.isFinite(recordIndex) ? recordIndex : nextIndex;
    nextIndex = Math.max(nextIndex, index + 1);
    recovered.push({
      awemeId,
      index,
      source,
      status: recordItem.status || "already_favorited",
      collectStat: 1,
      desc: recordItem.desc || "",
      authorUid: recordItem.authorUid || "",
      authorName: recordItem.authorName || "",
      createTime: recordItem.createTime || 0,
      url: recordItem.url || ("https://www.douyin.com/"
        + (["image", "multi_image", "mixed"].includes(recordItem.mediaType) ? "note/" : "video/")
        + awemeId),
      coverUrl: "",
      videoUrl: "",
      downloadStatus: restoredStatus,
      downloadQualityLabel: recordItem.resolution || "",
      downloadWidth: recordItem.width || 0,
      downloadHeight: recordItem.height || 0,
      downloadBitrate: recordItem.bitrate || 0,
      downloadCodec: recordItem.codec || "",
      downloadFps: recordItem.fps || 0,
      downloadSize: recordItem.size || 0,
      downloadVideoPath: recordItem.videoPath || "",
      downloadCoverPath: recordItem.coverPath || "",
      lastError: "",
      downloadCandidateRank: recordItem.candidateRank || recordItem.downloadCandidateRank || 0,
      downloadQualityFallbackReason: recordItem.qualityFallbackReason || recordItem.downloadQualityFallbackReason || "",
      createdAt: recordItem.updatedAt || now,
      mediaType: recordItem.mediaType || "video",
      mediaCount: recordItem.mediaCount || 0,
      mediaParts: recordItem.mediaParts || [],
      downloadedMediaParts,
      downloadedPartCount,
      downloadMediaPaths: recordItem.mediaPaths || [],
      downloadImagePaths: recordItem.imagePaths || [],
      updatedAt: now,
    });
  }
  return recovered;
}
