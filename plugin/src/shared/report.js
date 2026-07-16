const OUTCOME_LABELS = {
  best: "最高画质直接成功",
  same_resolution_fallback: "同分辨率候选替代",
  degraded: "最高画质失败后降级",
  failed: "下载失败",
  pending: "未完成",
  unknown: "缺少候选历史",
  no_video: "仅图片",
};

const STATUS_LABELS = {
  downloaded: "已下载",
  failed: "失败",
  downloading: "下载中",
  not_started: "待下载",
};

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function area(quality) {
  return number(quality?.width) * number(quality?.height);
}

function percent(value, total) {
  return total > 0 ? Number((value * 100 / total).toFixed(2)) : 0;
}

function qualityObject(value = {}) {
  return {
    width: number(value.width),
    height: number(value.height),
    codec: String(value.codec || ""),
    fps: number(value.fps),
    bitrate: number(value.bitrate),
    size: number(value.size),
    source: String(value.source || ""),
  };
}

function highestResolutionCandidate(candidates = []) {
  return candidates
    .filter((candidate) => area(candidate) > 0)
    .reduce((best, candidate) => area(candidate) > area(best) ? candidate : best, null);
}

function fallbackReason(progress, item) {
  const errors = Array.isArray(progress?.fallbackErrors) ? progress.fallbackErrors : [];
  return errors.filter(Boolean).join(" | ")
    || String(progress?.fallbackReason || item.qualityFallbackReason || "");
}

export function qualityLabel(quality) {
  if (!quality || !number(quality.width) || !number(quality.height)) return "未知";
  const details = [
    `${number(quality.width)}×${number(quality.height)}`,
    quality.codec ? String(quality.codec).toUpperCase() : "",
    number(quality.fps) ? `${number(quality.fps)}fps` : "",
    number(quality.bitrate) ? `${Math.round(number(quality.bitrate) / 1000)}kbps` : "",
  ].filter(Boolean);
  return details.join(" · ");
}

export function classifyFailureReason(error) {
  const text = String(error || "");
  if (!text) return "未记录原因";
  if (/HTTP 504/i.test(text)) return "HTTP 504";
  if (/HTTP 502/i.test(text)) return "HTTP 502";
  if (/HTTP 429/i.test(text)) return "HTTP 429 / 限流";
  if (/HTTP 403/i.test(text)) return "HTTP 403";
  if (/HTTP 404/i.test(text)) return "HTTP 404";
  if (/Failed to fetch|扩展抓取失败/i.test(text)) return "Failed to fetch";
  if (/120\s*秒|120s|媒体下载超过/i.test(text)) return "媒体传输超时";
  if (/30\s*秒|30s|等待媒体响应超过/i.test(text)) return "媒体首包超时";
  if (/未返回视频大小|content-length/i.test(text)) return "缺少媒体长度";
  if (/MIME|video\/mp4|image\//i.test(text)) return "媒体类型不符";
  if (/详情|detail/i.test(text)) return "作品详情失败";
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

function qualityOutcome(highest, actual, candidateRank, itemStatus) {
  if (!actual && itemStatus === "failed") return "failed";
  if (!actual) return "pending";
  if (!highest) return "unknown";
  if (area(actual) < area(highest)) return "degraded";
  if (number(candidateRank) > 1) return "same_resolution_fallback";
  return "best";
}

function eventPartId(meta) {
  return String(meta?.partId || "video-1");
}

export function buildQualityHistory(logs = []) {
  const history = new Map();
  const failureTypes = new Set([
    "download_stream_candidate_failed",
    "download_candidate_failed",
    "download_precheck_candidate_failed",
    "download_media_part_candidate_failed",
  ]);
  const successTypes = new Set([
    "download_stream_validated",
    "download_success",
    "download_precheck_success",
    "download_precheck_candidate_success",
    "download_media_part_success",
  ]);
  for (const event of logs || []) {
    const meta = event?.meta || {};
    const type = String(meta.type || "");
    const awemeId = String(meta.awemeId || "");
    if (!awemeId || (!failureTypes.has(type) && !successTypes.has(type))) continue;
    if (type === "download_media_part_success" && meta.kind !== "video") continue;
    const partId = eventPartId(meta);
    const key = `${awemeId}:${partId}`;
    if (!history.has(key)) history.set(key, { awemeId, partId, failures: [], success: null, highest: null });
    const entry = history.get(key);
    const quality = meta.quality && area(meta.quality) > 0 ? qualityObject(meta.quality) : null;
    if (failureTypes.has(type)) {
      entry.failures.push({
        candidateRank: number(meta.candidateRank),
        quality,
        error: String(meta.error || event.text || ""),
        createdAt: String(event.createdAt || event.at || ""),
      });
      if (quality && area(quality) > area(entry.highest)) entry.highest = quality;
    } else if (quality) {
      entry.success = {
        quality,
        candidateRank: number(meta.candidateRank),
        path: String(meta.path || ""),
        createdAt: String(event.createdAt || event.at || ""),
      };
      if (area(quality) > area(entry.highest)) entry.highest = quality;
    }
  }
  return history;
}

function mergeDiagnosticsWithHistory(item, diagnostics, itemHistory) {
  if (!itemHistory?.length) return diagnostics;
  const byPart = new Map(diagnostics.map((entry) => [entry.partId, entry]));
  for (const history of itemHistory) {
    const existing = byPart.get(history.partId);
    const highest = existing?.highest || history.highest;
    const actual = existing?.actual || history.success?.quality || null;
    const candidateRank = existing?.candidateRank || history.success?.candidateRank || 0;
    const errors = history.failures.map((failure) => {
      const prefix = failure.candidateRank ? `#${failure.candidateRank} ` : "";
      return `${prefix}${failure.error}`;
    });
    const fallback = existing?.fallbackReason || errors.join(" | ");
    const merged = {
      partId: history.partId,
      order: existing?.order || byPart.size + 1,
      role: existing?.role || "history",
      highest,
      actual,
      candidateRank,
      candidateCount: Math.max(existing?.candidateCount || 0, ...history.failures.map((failure) => failure.candidateRank), candidateRank),
      outcome: qualityOutcome(highest, actual, candidateRank, item.downloadStatus),
      fallbackReason: fallback,
      path: existing?.path || history.success?.path || item.videoPath || "",
      size: existing?.size || number(actual?.size),
    };
    merged.outcomeLabel = OUTCOME_LABELS[merged.outcome];
    byPart.set(history.partId, merged);
  }
  return [...byPart.values()].sort((a, b) => a.order - b.order);
}

export function videoDiagnosticsForItem(item = {}) {
  const parts = Array.isArray(item.mediaParts) ? item.mediaParts : [];
  const videoParts = parts.filter((part) => part?.kind === "video");
  const progressMap = item.downloadedMediaParts || {};
  const diagnostics = videoParts.map((part, index) => {
    const progress = progressMap[part.partId] || {};
    const candidates = Array.isArray(part.candidates) ? part.candidates : [];
    const highest = highestResolutionCandidate(candidates);
    const actual = progress.quality
      ? qualityObject(progress.quality)
      : (videoParts.length === 1 && number(item.width) && number(item.height)
        ? qualityObject(item)
        : null);
    const candidateRank = number(progress.candidateRank)
      || (videoParts.length === 1 ? number(item.candidateRank) : 0);
    let outcome = "unknown";
    if (!actual && item.downloadStatus === "failed") outcome = "failed";
    else if (!actual) outcome = "pending";
    else if (!highest) outcome = "unknown";
    else if (area(actual) < area(highest)) outcome = "degraded";
    else if (candidateRank > 1) outcome = "same_resolution_fallback";
    else outcome = "best";
    return {
      partId: String(part.partId || `video-${index + 1}`),
      order: number(part.order) || index + 1,
      role: String(part.role || "video"),
      highest: highest ? qualityObject(highest) : null,
      actual,
      candidateRank,
      candidateCount: candidates.length,
      outcome,
      outcomeLabel: OUTCOME_LABELS[outcome],
      fallbackReason: fallbackReason(progress, item),
      path: String(progress.path || (videoParts.length === 1 ? item.videoPath || "" : "")),
      size: number(progress.size) || number(actual?.size),
    };
  });

  if (!videoParts.length && (number(item.width) || item.videoPath)) {
    const actual = number(item.width) && number(item.height) ? qualityObject(item) : null;
    diagnostics.push({
      partId: "video-1",
      order: 1,
      role: "legacy",
      highest: null,
      actual,
      candidateRank: number(item.candidateRank),
      candidateCount: 0,
      outcome: actual ? "unknown" : (item.downloadStatus === "failed" ? "failed" : "pending"),
      outcomeLabel: actual ? OUTCOME_LABELS.unknown : OUTCOME_LABELS[item.downloadStatus === "failed" ? "failed" : "pending"],
      fallbackReason: String(item.qualityFallbackReason || ""),
      path: String(item.videoPath || ""),
      size: number(item.size),
    });
  }
  return diagnostics;
}

function itemOutcome(item, diagnostics) {
  if (!diagnostics.length) return item.downloadStatus === "failed" ? "failed" : "no_video";
  for (const outcome of ["degraded", "failed", "same_resolution_fallback", "pending", "unknown", "best"]) {
    if (diagnostics.some((entry) => entry.outcome === outcome)) return outcome;
  }
  return "unknown";
}

function summaryQuality(diagnostics, field) {
  const labels = [...new Set(diagnostics.map((entry) => qualityLabel(entry[field])).filter((label) => label !== "未知"))];
  if (!labels.length) return "未知";
  if (labels.length === 1) return labels[0];
  return `${labels[0]} 等 ${labels.length} 种 / ${diagnostics.length} 段`;
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

export function analyzeDownloadRecord(record = {}, logs = []) {
  const qualityHistory = buildQualityHistory(logs);
  const historyByAweme = new Map();
  for (const history of qualityHistory.values()) {
    if (!historyByAweme.has(history.awemeId)) historyByAweme.set(history.awemeId, []);
    historyByAweme.get(history.awemeId).push(history);
  }
  const items = (Array.isArray(record.items) ? record.items : []).map((item) => {
    const diagnostics = mergeDiagnosticsWithHistory(
      item,
      videoDiagnosticsForItem(item),
      historyByAweme.get(String(item.awemeId || "")) || [],
    );
    const outcome = itemOutcome(item, diagnostics);
    return {
      ...item,
      scope: item.source === "bookmarked" ? "bookmarked" : "liked",
      diagnostics,
      qualityOutcome: outcome,
      qualityOutcomeLabel: OUTCOME_LABELS[outcome],
      highestQualityLabel: summaryQuality(diagnostics, "highest"),
      actualQualityLabel: summaryQuality(diagnostics, "actual"),
      failureCategory: classifyFailureReason(item.lastError),
    };
  });

  const statusCounts = {};
  const scopeCounts = {};
  const mediaTypeCounts = {};
  const qualityOutcomeCounts = {};
  const resolutionCounts = {};
  const failureReasonCounts = {};
  const videoUnits = [];
  for (const item of items) {
    increment(statusCounts, item.downloadStatus || "not_started");
    increment(scopeCounts, item.scope);
    increment(mediaTypeCounts, item.mediaType || "video");
    increment(qualityOutcomeCounts, item.qualityOutcome);
    if (item.downloadStatus === "failed") increment(failureReasonCounts, item.failureCategory);
    for (const diagnostic of item.diagnostics) {
      videoUnits.push(diagnostic);
      if (diagnostic.actual) increment(resolutionCounts, `${diagnostic.actual.width}×${diagnostic.actual.height}`);
    }
  }
  const downloaded = statusCounts.downloaded || 0;
  const failed = statusCounts.failed || 0;
  const pending = items.length - downloaded - failed;
  const comparable = videoUnits.filter((entry) => ["best", "same_resolution_fallback", "degraded"].includes(entry.outcome));
  const degraded = videoUnits.filter((entry) => entry.outcome === "degraded").length;
  const sameResolutionFallback = videoUnits.filter((entry) => entry.outcome === "same_resolution_fallback").length;
  const best = videoUnits.filter((entry) => entry.outcome === "best").length;
  return {
    items,
    totals: {
      items: items.length,
      downloaded,
      failed,
      pending,
      successRate: percent(downloaded, items.length),
      failureRate: percent(failed, items.length),
      videoUnits: videoUnits.length,
      comparableVideoUnits: comparable.length,
      best,
      sameResolutionFallback,
      degraded,
      highestResolutionRate: percent(best + sameResolutionFallback, comparable.length),
      degradedRate: percent(degraded, comparable.length),
      unknownQuality: videoUnits.filter((entry) => entry.outcome === "unknown").length,
    },
    statusCounts,
    scopeCounts,
    mediaTypeCounts,
    qualityOutcomeCounts,
    resolutionCounts,
    failureReasonCounts,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sortedEntries(map, limit = 12) {
  return Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function barRows(entries, total, color = "blue") {
  if (!entries.length) return '<p class="empty">暂无数据</p>';
  return entries.map(([label, value]) => {
    const width = total > 0 ? Math.max(1, value * 100 / total) : 0;
    return `<div class="bar-row"><div class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div><div class="bar-track"><i class="${color}" style="width:${width.toFixed(2)}%"></i></div><strong>${value}</strong></div>`;
  }).join("");
}

function pathLinks(item) {
  const paths = [...new Set([
    ...(Array.isArray(item.mediaPaths) ? item.mediaPaths : []),
    ...(Array.isArray(item.imagePaths) ? item.imagePaths : []),
    item.videoPath,
    item.coverPath,
  ].filter(Boolean))];
  if (!paths.length) return "-";
  return paths.slice(0, 12).map((path, index) => `<a href="${escapeHtml(path)}">文件 ${index + 1}</a>`).join(" · ")
    + (paths.length > 12 ? ` · 另 ${paths.length - 12} 个` : "");
}

function diagnosticsHtml(item) {
  if (!item.diagnostics.length) return '<p class="muted">该作品没有视频分段。</p>';
  return `<div class="parts">${item.diagnostics.map((entry) => `
    <div class="part ${entry.outcome}">
      <strong>第 ${entry.order} 段 · ${escapeHtml(entry.role)}</strong>
      <span>最高：${escapeHtml(qualityLabel(entry.highest))}</span>
      <span>实际：${escapeHtml(qualityLabel(entry.actual))}</span>
      <span>结果：${escapeHtml(entry.outcomeLabel)}${entry.candidateRank ? ` · 候选 #${entry.candidateRank}/${Math.max(entry.candidateCount, entry.candidateRank)}` : ""}</span>
      ${entry.fallbackReason ? `<span class="error">回退原因：${escapeHtml(entry.fallbackReason)}</span>` : ""}
      ${entry.path ? `<span>路径：${escapeHtml(entry.path)}</span>` : ""}
    </div>`).join("")}</div>`;
}

export function buildEnhancedDownloadReportHtml(record, folderLabel = "", logs = []) {
  const analysis = analyzeDownloadRecord(record, logs);
  const t = analysis.totals;
  const reportItems = [...analysis.items].sort((a, b) => number(b.index) - number(a.index));
  const rows = reportItems.map((item) => {
    const search = [item.awemeId, item.authorName, item.desc, item.lastError, item.highestQualityLabel, item.actualQualityLabel].join(" ").toLowerCase();
    const link = /^https:\/\/www\.douyin\.com\//.test(item.url || "")
      ? `<a class="work-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.awemeId)}</a>`
      : escapeHtml(item.awemeId);
    return `<tr hidden data-search="${escapeHtml(search)}" data-scope="${escapeHtml(item.scope)}" data-status="${escapeHtml(item.downloadStatus)}" data-quality="${escapeHtml(item.qualityOutcome)}" data-media="${escapeHtml(item.mediaType || "video")}" data-index="${number(item.index)}" data-updated="${escapeHtml(item.updatedAt || "")}">
      <td>${number(item.index)}</td>
      <td>${link}<small>${escapeHtml(item.authorName || "未知作者")}</small></td>
      <td><span class="badge ${escapeHtml(item.downloadStatus)}">${escapeHtml(STATUS_LABELS[item.downloadStatus] || item.downloadStatus || "待下载")}</span><small>${escapeHtml(item.scope === "bookmarked" ? "收藏" : "喜欢")} · ${escapeHtml(item.mediaType || "video")}</small></td>
      <td><strong>${escapeHtml(item.highestQualityLabel)}</strong></td>
      <td><strong>${escapeHtml(item.actualQualityLabel)}</strong><small>${item.diagnostics.length ? `${item.diagnostics.length} 个视频段` : "无视频段"}</small></td>
      <td><span class="badge quality ${escapeHtml(item.qualityOutcome)}">${escapeHtml(item.qualityOutcomeLabel)}</span>${item.lastError ? `<small class="error">${escapeHtml(item.failureCategory)}</small>` : ""}</td>
      <td><div class="description">${escapeHtml(item.desc || "-")}</div><details><summary>诊断明细</summary>${diagnosticsHtml(item)}<div class="file-links">${pathLinks(item)}</div>${item.lastError ? `<p class="error">最后错误：${escapeHtml(item.lastError)}</p>` : ""}</details></td>
    </tr>`;
  }).join("");

  const statusChart = barRows(sortedEntries(analysis.statusCounts).map(([key, value]) => [STATUS_LABELS[key] || key, value]), t.items, "blue");
  const qualityChart = barRows(sortedEntries(analysis.qualityOutcomeCounts).map(([key, value]) => [OUTCOME_LABELS[key] || key, value]), t.items, "purple");
  const resolutionChart = barRows(sortedEntries(analysis.resolutionCounts, 15), Math.max(1, t.videoUnits), "green");
  const failureChart = barRows(sortedEntries(analysis.failureReasonCounts, 12), Math.max(1, t.failed), "red");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>抖音本地库与画质分析</title>
  <style>
  :root{color-scheme:light;--bg:#f3f5f9;--panel:#fff;--text:#182033;--muted:#667085;--line:#e4e7ec;--blue:#3478f6;--green:#16a36a;--red:#e5484d;--purple:#7c5ce7}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1680px;margin:auto;padding:24px}.hero,.panel,.toolbar,.table-wrap{background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:0 4px 18px #1018280a}.hero{padding:22px}.hero h1{margin:0;font-size:26px}.muted,small{display:block;color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(8,minmax(130px,1fr));gap:10px;margin-top:18px}.stat{padding:14px;border-radius:12px;background:#f8fafc;border:1px solid var(--line)}.stat b{display:block;font-size:25px;margin-top:4px}.charts{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0}.panel{padding:16px}.panel h2{font-size:15px;margin:0 0 12px}.bar-row{display:grid;grid-template-columns:110px 1fr 44px;gap:8px;align-items:center;margin:8px 0}.bar-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bar-track{height:8px;border-radius:99px;background:#edf0f5;overflow:hidden}.bar-track i{display:block;height:100%;border-radius:99px}.blue{background:var(--blue)}.green{background:var(--green)}.red{background:var(--red)}.purple{background:var(--purple)}.toolbar{display:grid;grid-template-columns:minmax(260px,2fr) repeat(5,minmax(130px,1fr)) auto;gap:10px;padding:14px;margin-bottom:12px;position:sticky;top:0;z-index:5}.toolbar input,.toolbar select,.toolbar button{width:100%;border:1px solid var(--line);border-radius:9px;padding:9px 10px;background:#fff;color:var(--text)}.toolbar button{cursor:pointer;background:#182033;color:white}.result-count{align-self:center;color:var(--muted);white-space:nowrap}.table-wrap{overflow:auto;max-height:72vh}table{border-collapse:separate;border-spacing:0;width:100%;min-width:1350px}th,td{padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}th{position:sticky;top:0;background:#f8fafc;color:var(--muted);font-size:12px;z-index:2}tbody tr:hover{background:#fbfcfe}td:nth-child(1){width:72px}.work-link{font-weight:700;color:var(--blue);text-decoration:none}.badge{display:inline-block;border-radius:99px;padding:3px 8px;font-size:12px;background:#eef2f7}.badge.downloaded,.badge.best{color:#087a50;background:#e8f7f0}.badge.failed,.badge.degraded{color:#b42318;background:#feeceb}.badge.downloading,.badge.same_resolution_fallback{color:#6941c6;background:#f0ebff}.badge.not_started,.badge.unknown,.badge.pending{color:#475467;background:#f2f4f7}.description{max-width:360px;max-height:44px;overflow:hidden}.error{color:#b42318}details{margin-top:6px}summary{cursor:pointer;color:var(--blue)}.parts{display:grid;gap:7px;margin-top:8px}.part{display:grid;gap:2px;padding:8px;border:1px solid var(--line);border-radius:8px;background:#fafbfc}.part.degraded,.part.failed{border-color:#f4b4b2}.file-links{margin-top:8px}.file-links a{color:var(--blue)}.empty{color:var(--muted)}@media(max-width:1100px){.stats{grid-template-columns:repeat(4,1fr)}.charts{grid-template-columns:repeat(2,1fr)}.toolbar{grid-template-columns:1fr 1fr}}@media(max-width:680px){.wrap{padding:10px}.stats{grid-template-columns:repeat(2,1fr)}.charts{grid-template-columns:1fr}.toolbar{position:static;grid-template-columns:1fr}}
  </style></head><body><main class="wrap"><section class="hero"><h1>抖音本地库与画质分析</h1><p class="muted">目录：${escapeHtml(folderLabel || "已授权目录")} · 生成：${escapeHtml(record.generatedAt || "-")} · 画质降级只在“已记录最高候选且实际像素更低”时计算，旧记录缺少候选历史会标为未知。</p><div class="stats">
  <div class="stat"><span>作品总数</span><b>${t.items}</b></div><div class="stat"><span>成功率</span><b>${t.successRate}%</b><small>${t.downloaded} 已下载</small></div><div class="stat"><span>失败率</span><b>${t.failureRate}%</b><small>${t.failed} 失败</small></div><div class="stat"><span>待处理</span><b>${t.pending}</b></div><div class="stat"><span>视频分段</span><b>${t.videoUnits}</b></div><div class="stat"><span>最高分辨率达成率</span><b>${t.highestResolutionRate}%</b><small>仅统计可比较记录</small></div><div class="stat"><span>降级率</span><b>${t.degradedRate}%</b><small>${t.degraded} 个视频段</small></div><div class="stat"><span>候选历史未知</span><b>${t.unknownQuality}</b></div></div></section>
  <section class="charts"><div class="panel"><h2>下载状态</h2>${statusChart}</div><div class="panel"><h2>画质结果</h2>${qualityChart}</div><div class="panel"><h2>实际分辨率 Top 15</h2>${resolutionChart}</div><div class="panel"><h2>失败原因 Top 12</h2>${failureChart}</div></section>
  <section class="toolbar"><input id="search" placeholder="搜索作品 ID、作者、描述、错误或画质"><select id="scope"><option value="">全部来源</option><option value="liked">喜欢</option><option value="bookmarked">收藏</option></select><select id="status"><option value="">全部状态</option><option value="downloaded">已下载</option><option value="failed">失败</option><option value="downloading">下载中</option><option value="not_started">待下载</option></select><select id="quality"><option value="">全部画质结果</option>${Object.entries(OUTCOME_LABELS).map(([value,label])=>`<option value="${value}">${label}</option>`).join("")}</select><select id="media"><option value="">全部媒体</option><option value="video">单视频</option><option value="multi_video">多段视频</option><option value="image">单图</option><option value="multi_image">多图</option><option value="mixed">图文/实况混合</option></select><select id="sort"><option value="index-desc">序号从新到旧</option><option value="index-asc">序号从旧到新</option><option value="updated-desc">最近更新</option></select><button id="reset">重置</button><button id="prev" type="button">上一页</button><button id="next" type="button">下一页</button><span class="result-count" id="count"></span></section>
  <section class="table-wrap"><table><thead><tr><th>#</th><th>作品 / 作者</th><th>状态 / 类型</th><th>最高可用画质</th><th>实际下载画质</th><th>画质结论</th><th>描述 / 诊断</th></tr></thead><tbody id="rows">${rows}</tbody></table></section></main>
  <script>
  (() => {
    const body = document.getElementById('rows');
    const rows = [...body.rows];
    const search = document.getElementById('search');
    const filters = ['scope', 'status', 'quality', 'media'].map((id) => document.getElementById(id));
    const sort = document.getElementById('sort');
    const count = document.getElementById('count');
    const previous = document.getElementById('prev');
    const next = document.getElementById('next');
    const pageSize = 200;
    let currentPage = 1;
    let matchedRows = [];
    let timer;
    function apply() {
      const query = search.value.trim().toLowerCase();
      const values = Object.fromEntries(filters.map((element) => [element.id, element.value]));
      matchedRows = [];
      for (const row of rows) {
        const visible = (!query || row.dataset.search.includes(query))
          && (!values.scope || row.dataset.scope === values.scope)
          && (!values.status || row.dataset.status === values.status)
          && (!values.quality || row.dataset.quality === values.quality)
          && (!values.media || row.dataset.media === values.media);
        row.hidden = true;
        if (visible) matchedRows.push(row);
      }
      const totalPages = Math.max(1, Math.ceil(matchedRows.length / pageSize));
      currentPage = Math.min(Math.max(1, currentPage), totalPages);
      const start = (currentPage - 1) * pageSize;
      const pageRows = matchedRows.slice(start, start + pageSize);
      for (const row of pageRows) row.hidden = false;
      previous.disabled = currentPage <= 1;
      next.disabled = currentPage >= totalPages;
      count.textContent = '匹配 ' + matchedRows.length + ' / ' + rows.length
        + ' · 第 ' + currentPage + ' / ' + totalPages + ' 页'
        + ' · 当前 ' + pageRows.length + ' 条';
    }
    function sortRows() {
      currentPage = 1;
      const mode = sort.value;
      rows.sort((a, b) => mode === 'updated-desc'
        ? b.dataset.updated.localeCompare(a.dataset.updated)
        : (mode === 'index-asc'
          ? Number(a.dataset.index) - Number(b.dataset.index)
          : Number(b.dataset.index) - Number(a.dataset.index)));
      body.append(...rows);
      apply();
    }
    search.addEventListener('input', () => { currentPage = 1; clearTimeout(timer); timer = setTimeout(apply, 120); });
    filters.forEach((element) => element.addEventListener('change', () => { currentPage = 1; apply(); }));
    sort.addEventListener('change', sortRows);
    previous.addEventListener('click', () => { currentPage -= 1; apply(); });
    next.addEventListener('click', () => { currentPage += 1; apply(); });
    document.getElementById('reset').addEventListener('click', () => {
      search.value = '';
      filters.forEach((element) => { element.value = ''; });
      sort.value = 'index-desc';
      currentPage = 1;
      sortRows();
    });
    apply();
  })();
  </script></body></html>`;
}
