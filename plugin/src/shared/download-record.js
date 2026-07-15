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
    if (!recordItem?.awemeId || recordItem.downloadStatus !== "downloaded") continue;
    const awemeId = String(recordItem.awemeId);
    const source = recordItem.source || defaultSource;
    const existing = existingById.get(recordKey(source, awemeId));
    if (existing?.downloadStatus === "downloaded") continue;
    if (existing) {
      recovered.push({
        ...existing,
        downloadStatus: "downloaded",
        lastError: "",
        downloadQualityLabel: recordItem.resolution || existing.downloadQualityLabel || "",
        downloadWidth: recordItem.width || existing.downloadWidth || 0,
        downloadHeight: recordItem.height || existing.downloadHeight || 0,
        downloadBitrate: recordItem.bitrate || existing.downloadBitrate || 0,
        downloadCodec: recordItem.codec || existing.downloadCodec || "",
        downloadFps: recordItem.fps || existing.downloadFps || 0,
        downloadSize: recordItem.size || existing.downloadSize || 0,
        downloadVideoPath: recordItem.videoPath || existing.downloadVideoPath || "",
        downloadCoverPath: recordItem.coverPath || existing.downloadCoverPath || "",
        updatedAt: now,
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
      url: recordItem.url || ("https://www.douyin.com/video/" + awemeId),
      coverUrl: "",
      videoUrl: "",
      downloadStatus: "downloaded",
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
      createdAt: recordItem.updatedAt || now,
      updatedAt: now,
    });
  }
  return recovered;
}
