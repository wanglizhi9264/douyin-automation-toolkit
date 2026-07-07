import { sendPageRequest } from "../shared/events.js";
import { addLog } from "../shared/db.js";
import { DEFAULT_CONFIG, importProgress, loadConfig, saveConfig, summarize } from "../shared/state.js";

const $ = (id) => document.getElementById(id);
let configHydrated = false;

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
}

async function saveCurrentConfig() {
  await saveConfig({ ...await loadConfig(), ...configFromForm() });
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
  await saveCurrentConfig();
  logLine("收藏流程将在下一阶段接入；当前版本已完成插件壳、导入和页面 API 通信");
});

$("auditBtn").addEventListener("click", async () => {
  await saveCurrentConfig();
  logLine("审计流程将在下一阶段接入");
});

$("downloadBtn").addEventListener("click", async () => {
  await saveCurrentConfig();
  logLine("下载流程将在下载模块阶段接入");
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
