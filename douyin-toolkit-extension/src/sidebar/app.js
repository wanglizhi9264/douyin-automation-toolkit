import { sendPageRequest } from "../shared/events.js";
import { addLog, getAll, putItems } from "../shared/db.js";
import { DEFAULT_CONFIG, importProgress, loadConfig, saveConfig, summarize } from "../shared/state.js";
import { pickVideoUrl } from "../shared/api.js";
import { chooseDownloadTarget, downloadUrl, writeFile } from "../shared/download.js";

const $ = (id) => document.getElementById(id);
let configHydrated = false;
let stopRequested = false;
let running = false;

const SUCCESS_STATUSES = new Set(["favorited", "already_favorited", "skipped_inaccessible"]);
const RUNNABLE_STATUSES = new Set([
  "pending",
  "processing",
  "paused_unverified",
  "paused_unavailable",
  "paused_unclickable",
  "paused_rate_limited",
  "blocked",
]);
const RATE_LIMIT_CODES = new Set([3009008]);

function logLine(text) {
  addLog(text).then(render).catch(console.error);
}

function configFromForm() {
  return {
    batchSize: Number($("batchSize").value || DEFAULT_CONFIG.batchSize),
    auditRecent: Number($("auditRecent").value || DEFAULT_CONFIG.auditRecent),
    minDelayMs: Number($("minDelayMs").value || DEFAULT_CONFIG.minDelayMs),
    maxDelayMs: Number($("maxDelayMs").value || DEFAULT_CONFIG.maxDelayMs),
    syncLikedBeforeRun: $("syncLikedBeforeRun").checked,
    downloadCovers: $("downloadCovers").checked,
  };
}

function fillConfig(config) {
  $("batchSize").value = config.batchSize ?? DEFAULT_CONFIG.batchSize;
  $("auditRecent").value = config.auditRecent ?? DEFAULT_CONFIG.auditRecent;
  $("minDelayMs").value = config.minDelayMs ?? DEFAULT_CONFIG.minDelayMs;
  $("maxDelayMs").value = config.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs;
  $("syncLikedBeforeRun").checked = Boolean(config.syncLikedBeforeRun);
  $("downloadCovers").checked = Boolean(config.downloadCovers);
}

function renderLogs(logs) {
  $("log").innerHTML = logs.map((entry) => {
    const time = (entry.createdAt || "").slice(11, 19);
    return `<div><span style="color:#8e8e93">${escapeHtml(time)}</span> ${escapeHtml(entry.text)}</div>`;
  }).join("");
  $("log").scrollTop = $("log").scrollHeight;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

async function render() {
  const state = await summarize();
  if (!configHydrated && !document.activeElement?.matches("input")) {
    fillConfig(state.config);
    configHydrated = true;
  }
  $("totalCount").textContent = state.total;
  $("successCount").textContent = state.success;
  $("pendingCount").textContent = state.pending;
  $("pausedCount").textContent = state.paused;
  $("cursorBox").innerHTML = state.cursor
    ? [
      `Index: ${escapeHtml(state.cursor.index)}`,
      `状态: ${escapeHtml(state.cursor.status)}`,
      `作品: ${escapeHtml(state.cursor.awemeId)}`,
      `描述: ${escapeHtml(state.cursor.desc || "")}`,
      state.cursor.lastError ? `错误: ${escapeHtml(state.cursor.lastError)}` : "",
    ].filter(Boolean).join("<br>")
    : "尚无数据";
  renderLogs(state.logs);
  updateButtons();
}

async function saveCurrentConfig() {
  await saveConfig({ ...await loadConfig(), ...configFromForm() });
}

function updateButtons() {
  $("favoriteBtn").disabled = running;
  $("auditBtn").disabled = running;
  $("downloadBtn").disabled = running;
  $("stopBtn").disabled = !running;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(config) {
  const min = Number(config.minDelayMs ?? DEFAULT_CONFIG.minDelayMs);
  const max = Number(config.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs);
  return Math.floor(min + Math.random() * Math.max(0, max - min + 1));
}

function resultError(result) {
  return result?.statusMsg || result?.text || result?.error || `HTTP ${result?.httpStatus || "unknown"}`;
}

function isRateLimited(result) {
  const text = `${result?.statusMsg || ""} ${result?.text || ""}`;
  return RATE_LIMIT_CODES.has(Number(result?.statusCode)) || /稍后再试|速度太快|频繁|rate/i.test(text);
}

function patchItem(item, changes) {
  return {
    ...item,
    ...changes,
    lastError: changes.lastError ?? item.lastError ?? "",
    updatedAt: new Date().toISOString(),
  };
}

async function saveItem(item) {
  await putItems([item]);
}

async function loadRunnableItems(limit) {
  const items = await getAll("items");
  return items
    .filter((item) => !SUCCESS_STATUSES.has(item.status) && RUNNABLE_STATUSES.has(item.status || "pending"))
    .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
    .slice(0, limit);
}

async function processFavoriteItem(item) {
  $("runtimeStatus").textContent = "运行中";
  await saveItem(patchItem(item, { status: "processing", lastError: "" }));

  const detail = await sendPageRequest("FETCH_AWEME_DETAIL", { awemeId: item.awemeId }, 30000);
  if (detail.ok && detail.collectStat === 1) {
    const updated = patchItem(item, {
      status: "already_favorited",
      collectStat: 1,
      desc: detail.desc || item.desc,
      authorName: detail.authorName || item.authorName,
      authorUid: detail.authorUid || item.authorUid,
      coverUrl: detail.coverUrl || item.coverUrl,
      lastError: "",
    });
    await saveItem(updated);
    return { ok: true, status: updated.status };
  }

  if (!detail.ok && Number(detail.statusCode) === 2053) {
    const updated = patchItem(item, { status: "skipped_inaccessible", lastError: "作品不可访问，按规则跳过" });
    await saveItem(updated);
    return { ok: true, status: updated.status };
  }

  if (!detail.ok && isRateLimited(detail)) {
    const updated = patchItem(item, { status: "paused_rate_limited", lastError: resultError(detail) });
    await saveItem(updated);
    return { ok: false, pause: true, reason: updated.lastError };
  }

  const collect = await sendPageRequest("COLLECT_AWEME", { awemeId: item.awemeId }, 30000);
  if (collect.ok) {
    const updated = patchItem(item, {
      status: "favorited",
      collectStat: 1,
      desc: detail.desc || item.desc,
      authorName: detail.authorName || item.authorName,
      authorUid: detail.authorUid || item.authorUid,
      coverUrl: detail.coverUrl || item.coverUrl,
      lastError: "",
    });
    await saveItem(updated);
    return { ok: true, status: updated.status };
  }

  const status = isRateLimited(collect) ? "paused_rate_limited" : "paused_unverified";
  const updated = patchItem(item, { status, lastError: resultError(collect) });
  await saveItem(updated);
  return { ok: false, pause: true, reason: updated.lastError };
}

async function runFavoriteBatch() {
  if (running) return;
  running = true;
  stopRequested = false;
  updateButtons();
  try {
    await saveCurrentConfig();
    const config = await loadConfig();
    const items = await loadRunnableItems(config.batchSize);
    if (!items.length) {
      $("runtimeStatus").textContent = "空闲";
      logLine("没有待收藏项目");
      return;
    }
    logLine(`开始收藏批次：${items.length} 条`);
    let completed = 0;
    for (const item of items) {
      if (stopRequested) {
        logLine("用户停止，已保存当前进度");
        break;
      }
      const result = await processFavoriteItem(item);
      completed += result.ok ? 1 : 0;
      await render();
      if (result.pause) {
        $("runtimeStatus").textContent = "已暂停";
        logLine(`暂停：#${item.index} ${item.awemeId} ${result.reason}`);
        break;
      }
      await sleep(randomDelay(config));
    }
    logLine(`收藏批次结束：成功推进 ${completed} 条`);
    if (!stopRequested && config.auditRecent > 0) await runAudit(config.auditRecent, { silentStart: true, config });
  } catch (error) {
    $("runtimeStatus").textContent = "异常";
    logLine(`收藏流程异常：${error.message}`);
  } finally {
    running = false;
    stopRequested = false;
    updateButtons();
    await render();
  }
}

async function auditOne(item) {
  const detail = await sendPageRequest("FETCH_AWEME_DETAIL", { awemeId: item.awemeId }, 30000);
  if (detail.ok && detail.collectStat === 1) {
    await saveItem(patchItem(item, {
      collectStat: 1,
      desc: detail.desc || item.desc,
      authorName: detail.authorName || item.authorName,
      authorUid: detail.authorUid || item.authorUid,
      coverUrl: detail.coverUrl || item.coverUrl,
      lastError: "",
    }));
    return { ok: true };
  }
  if (!detail.ok && Number(detail.statusCode) === 2053) {
    await saveItem(patchItem(item, { status: "skipped_inaccessible", lastError: "审计时作品不可访问，按规则跳过" }));
    return { ok: true };
  }
  if (isRateLimited(detail)) {
    await saveItem(patchItem(item, { status: "paused_rate_limited", lastError: resultError(detail) }));
    return { ok: false, pause: true, reason: resultError(detail) };
  }
  await saveItem(patchItem(item, {
    status: "pending",
    collectStat: detail.collectStat ?? item.collectStat ?? null,
    lastError: `审计发现未真正收藏：${resultError(detail)}`,
  }));
  return { ok: false };
}

async function runAudit(limit, { silentStart = false, config = DEFAULT_CONFIG } = {}) {
  const items = (await getAll("items"))
    .filter((item) => item.status === "favorited" || item.status === "already_favorited")
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, Number(limit || DEFAULT_CONFIG.auditRecent));
  if (!silentStart) logLine(`开始审计最近 ${items.length} 条`);
  let repaired = 0;
  for (const item of items) {
    if (stopRequested) break;
    const result = await auditOne(item);
    if (!result.ok) repaired += 1;
    if (result.pause) {
      $("runtimeStatus").textContent = "已暂停";
      logLine(`审计暂停：#${item.index} ${item.awemeId} ${result.reason}`);
      break;
    }
    await sleep(randomDelay(config));
  }
  logLine(`审计结束：返工 ${repaired} 条`);
  await render();
}

async function runAuditFromButton() {
  if (running) return;
  running = true;
  stopRequested = false;
  updateButtons();
  try {
    await saveCurrentConfig();
    const config = await loadConfig();
    await runAudit(config.auditRecent, { config });
  } catch (error) {
    $("runtimeStatus").textContent = "异常";
    logLine(`审计流程异常：${error.message}`);
  } finally {
    running = false;
    stopRequested = false;
    updateButtons();
    await render();
  }
}

function paddedIndex(item) {
  return String(Number(item.index ?? 0) + 1).padStart(6, "0");
}

async function downloadOne(item, rootHandle, config) {
  await saveItem(patchItem(item, { downloadStatus: "downloading", lastError: "" }));
  let videoUrl = item.videoUrl || "";
  let coverUrl = item.coverUrl || "";
  let detail = null;
  if (!videoUrl || (config.downloadCovers && !coverUrl)) {
    detail = await sendPageRequest("FETCH_AWEME_DETAIL", { awemeId: item.awemeId }, 30000);
    if (!detail.ok) throw new Error(`详情获取失败：${resultError(detail)}`);
    videoUrl = pickVideoUrl(detail.aweme)?.url || videoUrl;
    coverUrl = detail.coverUrl || coverUrl;
  }
  if (!videoUrl) throw new Error("未找到可下载视频地址");

  const base = `${paddedIndex(item)}-${item.awemeId}`;
  await downloadUrl(rootHandle, `DouyinBackup/success/videos/${base}.mp4`, videoUrl);

  if (config.downloadCovers && coverUrl) {
    await downloadUrl(rootHandle, `DouyinBackup/success/covers/${base}.jpg`, coverUrl);
  }

  const manifest = {
    awemeId: item.awemeId,
    index: item.index,
    source: item.source,
    status: item.status,
    desc: detail?.desc || item.desc || "",
    authorName: detail?.authorName || item.authorName || "",
    url: item.url,
    downloadedAt: new Date().toISOString(),
    files: {
      video: `success/videos/${base}.mp4`,
      cover: config.downloadCovers && coverUrl ? `success/covers/${base}.jpg` : null,
    },
  };
  await writeFile(rootHandle, `DouyinBackup/success/manifests/${base}.json`, `${JSON.stringify(manifest, null, 2)}\n`);

  await saveItem(patchItem(item, {
    videoUrl,
    coverUrl,
    downloadStatus: "downloaded",
    lastError: "",
  }));
}

async function runDownloadBatch() {
  if (running) return;
  running = true;
  stopRequested = false;
  updateButtons();
  $("runtimeStatus").textContent = "准备下载";
  logLine("已点击开始下载，正在检查可下载项目");
  try {
    await saveCurrentConfig();
    const config = await loadConfig();
    const items = (await getAll("items"))
      .filter((item) => ["favorited", "already_favorited"].includes(item.status) && item.downloadStatus !== "downloaded")
      .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
      .slice(0, Number(config.batchSize || DEFAULT_CONFIG.batchSize));
    if (!items.length) {
      $("runtimeStatus").textContent = "空闲";
      logLine("没有待下载的已收藏项目");
      return;
    }
    const rootHandle = await chooseDownloadTarget({ preferBrowserDownloads: true });
    $("runtimeStatus").textContent = "下载中";
    logLine(rootHandle.kind === "downloads"
      ? `开始下载批次：${items.length} 条，保存到浏览器下载目录`
      : `开始下载批次：${items.length} 条`);
    let downloaded = 0;
    for (const item of items) {
      if (stopRequested) break;
      try {
        await downloadOne(item, rootHandle, config);
        downloaded += 1;
      } catch (error) {
        await saveItem(patchItem(item, { downloadStatus: "failed", lastError: `下载失败：${error.message}` }));
        logLine(`下载失败：#${item.index} ${item.awemeId} ${error.message}`);
      }
      await render();
      await sleep(randomDelay(config));
    }
    logLine(`下载批次结束：完成 ${downloaded} 条`);
  } catch (error) {
    $("runtimeStatus").textContent = "异常";
    logLine(`下载流程异常：${error.message}`);
  } finally {
    running = false;
    stopRequested = false;
    updateButtons();
    await render();
  }
}

$("profileBtn").addEventListener("click", async () => {
  try {
    $("runtimeStatus").textContent = "检测中";
    const result = await sendPageRequest("GET_SELF_PROFILE", {}, 30000);
    const user = result?.json?.user || result?.json?.user_info || result?.json;
    $("runtimeStatus").textContent = result.ok ? "已连接" : "异常";
    $("pageMeta").textContent = result.ok
      ? `抖音页面已连接：${user?.nickname || user?.uid || "已登录"}`
      : `检测失败：${result.statusMsg || result.text || result.httpStatus}`;
    logLine(result.ok ? "登录检测成功" : "登录检测失败");
  } catch (error) {
    $("runtimeStatus").textContent = "异常";
    $("pageMeta").textContent = error.message;
    logLine(`登录检测异常：${error.message}`);
  }
});

$("importBtn").addEventListener("click", () => $("importFile").click());

$("importFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const progress = JSON.parse(await file.text());
    const count = await importProgress(progress);
    $("runtimeStatus").textContent = "已导入";
    logLine(`导入完成：${count} 条`);
    await render();
  } catch (error) {
    $("runtimeStatus").textContent = "导入失败";
    logLine(`导入失败：${error.message}`);
  } finally {
    event.target.value = "";
  }
});

$("favoriteBtn").addEventListener("click", async () => {
  await runFavoriteBatch();
});

$("stopBtn").addEventListener("click", () => {
  stopRequested = true;
  $("runtimeStatus").textContent = "停止中";
});

$("auditBtn").addEventListener("click", async () => {
  await runAuditFromButton();
});

$("downloadBtn").addEventListener("click", async () => {
  await runDownloadBatch();
});

for (const id of ["batchSize", "auditRecent", "minDelayMs", "maxDelayMs", "syncLikedBeforeRun", "downloadCovers"]) {
  $(id).addEventListener("change", saveCurrentConfig);
}

window.addEventListener("douyin-toolkit-boot", (event) => {
  $("runtimeStatus").textContent = "已注入";
  $("pageMeta").textContent = event.detail?.href || "抖音页面已连接";
});

await render();
setInterval(render, 2500);
