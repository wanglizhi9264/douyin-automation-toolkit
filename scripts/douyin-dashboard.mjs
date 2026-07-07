#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const STATE_PATH = path.join(ROOT, "douyin-favorite-progress.json");
const CONFIG_PATH = path.join(ROOT, "douyin-favorite.config.json");
const AUTOMATION_SCRIPT = path.join(ROOT, "scripts", "douyin-favorite-liked.mjs");
const HOST = "127.0.0.1";
const PORT = Number(process.env.DOUYIN_DASHBOARD_PORT || 4777);

const DEFAULT_CONFIG = {
  count: 20,
  minDelayMs: 300,
  maxDelayMs: 900,
  retries: 3,
  retryBaseDelayMs: 1500,
  syncLikedBeforeRun: false,
  stopAfterNoNewPages: 5,
  cycleBatchSize: 100,
  cycleAuditRecent: 120,
  continueOnAuditFailure: true,
  maxConsecutiveAuditFailures: 6,
};

let activeProcess = null;
let activeRun = null;
let logLines = [];

function nowIso() {
  return new Date().toISOString();
}

function pushLog(line) {
  const text = String(line || "").replace(/\r/g, "");
  for (const part of text.split("\n")) {
    if (!part) continue;
    logLines.push({ at: nowIso(), text: part });
  }
  if (logLines.length > 1000) logLines = logLines.slice(-1000);
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { ...fallback, _error: error.message };
  }
}

function saveJson(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function loadConfig() {
  return { ...DEFAULT_CONFIG, ...loadJson(CONFIG_PATH, {}) };
}

function loadState() {
  return loadJson(STATE_PATH, { items: [], cursor: null, updatedAt: null });
}

function summarizeState() {
  const state = loadState();
  const items = Array.isArray(state.items) ? state.items : [];
  const counts = {};
  for (const item of items) counts[item.status || "unknown"] = (counts[item.status || "unknown"] || 0) + 1;

  const realItems = items.filter((item) => item.source === "favorite_api");
  const successStatuses = new Set(["favorited", "already_favorited", "skipped_inaccessible"]);
  const successCount = realItems.filter((item) => successStatuses.has(item.status)).length;
  const pendingCount = realItems.filter((item) => item.status === "pending").length;
  const pausedItems = realItems.filter((item) => String(item.status || "").startsWith("paused") || item.status === "blocked");
  const auditPending = realItems.filter((item) => item.status === "pending" && String(item.lastError || "").includes("审计发现未真正收藏"));
  const auditFailures = realItems.filter((item) => String(item.lastError || "").startsWith("审计接口失败"));
  const latestIndex = realItems.reduce((max, item) => Math.max(max, Number(item.index ?? -1)), -1);
  const cursorIndex = Number(state.cursor?.listIndex ?? -1);
  const completedThroughIndex = realItems
    .filter((item) => successStatuses.has(item.status))
    .reduce((max, item) => Math.max(max, Number(item.index ?? -1)), -1);

  return {
    state,
    summary: {
      total: items.length,
      realTotal: realItems.length,
      counts,
      successCount,
      pendingCount,
      pausedCount: pausedItems.length,
      auditPendingCount: auditPending.length,
      auditFailureCount: auditFailures.length,
      skippedCount: counts.skipped_inaccessible || 0,
      progressRatio: realItems.length ? successCount / realItems.length : 0,
      latestIndex,
      cursorIndex,
      completedThroughIndex,
      updatedAt: state.updatedAt || null,
      sourceLikedUrl: state.sourceLikedUrl || null,
      cursor: state.cursor || null,
      pausedItems: pausedItems.slice(0, 12),
      auditPending: auditPending.slice(0, 20).map(compactItem),
      recentItems: realItems
        .slice()
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
        .slice(0, 24)
        .map(compactItem),
    },
  };
}

function compactItem(item) {
  return {
    index: item.index,
    videoId: item.videoId,
    status: item.status,
    collectStat: item.collectStat,
    desc: item.desc || "",
    author: item.author || "",
    lastError: item.lastError || null,
    updatedAt: item.updatedAt || null,
    url: item.url || null,
  };
}

function publicStatus() {
  const { summary } = summarizeState();
  return {
    config: loadConfig(),
    summary,
    running: Boolean(activeProcess),
    activeRun,
    logs: logLines.slice(-300),
  };
}

function bool(value, fallback = false) {
  if (value == null) return fallback;
  if (value === true || value === false) return value;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function buildArgs(body) {
  const mode = body.mode || "cycle";
  if (mode === "login") return ["login"];
  if (mode === "audit") {
    const args = ["audit"];
    if (body.auditAll) args.push("--all");
    else if (body.auditRecent) args.push("--recent", String(body.auditRecent));
    return args;
  }

  const args = [mode === "run" ? "run" : "cycle"];
  if (mode === "cycle" && bool(body.skipHistoryAudit, true)) args.push("--skip-history-audit");
  if (bool(body.syncLiked, false)) args.push("--sync-liked");
  if (body.batchSize) args.push("--batch-size", String(body.batchSize));
  if (body.auditRecent) args.push("--audit-recent", String(body.auditRecent));
  if (body.minDelayMs) args.push("--min-delay-ms", String(body.minDelayMs));
  if (body.maxDelayMs) args.push("--max-delay-ms", String(body.maxDelayMs));
  return args;
}

function startRun(body) {
  if (activeProcess) {
    const error = new Error("已有任务正在运行");
    error.statusCode = 409;
    throw error;
  }

  const args = buildArgs(body);
  const label = body.label || args.join(" ");
  activeRun = {
    label,
    args,
    startedAt: nowIso(),
    stoppedAt: null,
    exitCode: null,
  };
  pushLog(`启动: node ${path.relative(ROOT, AUTOMATION_SCRIPT)} ${args.join(" ")}`);

  activeProcess = spawn(process.execPath, [AUTOMATION_SCRIPT, ...args], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  activeProcess.stdout.on("data", (chunk) => pushLog(chunk));
  activeProcess.stderr.on("data", (chunk) => pushLog(chunk));
  activeProcess.on("exit", (code, signal) => {
    pushLog(`任务结束: code=${code} signal=${signal || "none"}`);
    activeRun = {
      ...activeRun,
      stoppedAt: nowIso(),
      exitCode: code,
      signal,
    };
    activeProcess = null;
  });
  activeProcess.on("error", (error) => {
    pushLog(`任务启动失败: ${error.message}`);
    activeRun = {
      ...activeRun,
      stoppedAt: nowIso(),
      exitCode: 1,
      error: error.message,
    };
    activeProcess = null;
  });
}

function stopRun() {
  if (!activeProcess) return false;
  pushLog("请求停止当前任务");
  activeProcess.kill("SIGINT");
  return true;
}

function finishLogin() {
  if (!activeProcess) return false;
  activeProcess.stdin.write("\n");
  pushLog("已发送登录完成确认");
  return true;
}

function cleanupBrowser() {
  return new Promise((resolve) => {
    execFile("pgrep", ["-f", "douyin-playwright-profile"], (pgrepError, stdout) => {
      if (pgrepError || !stdout.trim()) return resolve({ killed: [] });
      const pids = stdout
        .trim()
        .split(/\s+/)
        .map((value) => Number(value))
        .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Ignore already closed processes.
        }
      }
      pushLog(`释放浏览器占用: ${pids.join(", ") || "none"}`);
      resolve({ killed: pids });
    });
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("请求体过大"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(HTML);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
    if (request.method === "GET" && url.pathname === "/") return sendHtml(response);
    if (request.method === "GET" && url.pathname === "/api/status") return sendJson(response, 200, publicStatus());

    if (request.method === "POST" && url.pathname === "/api/run") {
      const body = await readBody(request);
      startRun(body);
      return sendJson(response, 200, publicStatus());
    }
    if (request.method === "POST" && url.pathname === "/api/stop") {
      const stopped = stopRun();
      return sendJson(response, 200, { stopped, ...publicStatus() });
    }
    if (request.method === "POST" && url.pathname === "/api/login-done") {
      const sent = finishLogin();
      return sendJson(response, 200, { sent, ...publicStatus() });
    }
    if (request.method === "POST" && url.pathname === "/api/config") {
      const body = await readBody(request);
      const current = loadConfig();
      const next = { ...current };
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (body[key] == null) continue;
        if (typeof DEFAULT_CONFIG[key] === "boolean") next[key] = Boolean(body[key]);
        else next[key] = Number(body[key]);
      }
      saveJson(CONFIG_PATH, next);
      pushLog("已保存配置");
      return sendJson(response, 200, publicStatus());
    }
    if (request.method === "POST" && url.pathname === "/api/clear-log") {
      logLines = [];
      return sendJson(response, 200, publicStatus());
    }
    if (request.method === "POST" && url.pathname === "/api/cleanup-browser") {
      const result = await cleanupBrowser();
      return sendJson(response, 200, { ...result, ...publicStatus() });
    }

    sendJson(response, 404, { error: "not found" });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message, ...publicStatus() });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Douyin dashboard running: ${url}`);
  console.log(`Workspace: ${ROOT}`);
});

const HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>抖音收藏控制台</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f5f7;
      --panel: #ffffff;
      --panel-2: #fbfbfd;
      --text: #1d1d1f;
      --muted: #6e6e73;
      --line: #d8d8de;
      --blue: #0071e3;
      --blue-dark: #005bb8;
      --red: #d92d20;
      --amber: #b7791f;
      --shadow: 0 10px 30px rgba(0, 0, 0, .07);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      color: var(--text);
      background: var(--bg);
      letter-spacing: 0;
    }
    button, input, select { font: inherit; }
    .shell { max-width: 1320px; margin: 0 auto; padding: 28px; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.16; font-weight: 720; }
    .sub { margin-top: 6px; color: var(--muted); font-size: 14px; }
    .status-pill {
      display: inline-flex; align-items: center; gap: 8px; min-height: 34px;
      padding: 0 12px; border: 1px solid var(--line); border-radius: 999px;
      background: var(--panel); color: var(--muted); white-space: nowrap;
    }
    .dot { width: 8px; height: 8px; border-radius: 99px; background: #8e8e93; }
    .dot.running { background: var(--blue); box-shadow: 0 0 0 4px rgba(0, 113, 227, .14); }
    .layout { display: grid; grid-template-columns: minmax(0, 1.15fr) 380px; gap: 18px; }
    .layout > * { min-width: 0; }
    .panel {
      background: var(--panel); border: 1px solid rgba(0,0,0,.08);
      border-radius: 8px; box-shadow: var(--shadow);
    }
    .panel.pad { padding: 18px; }
    .grid { display: grid; gap: 14px; }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .stat {
      background: var(--panel-2); border: 1px solid var(--line);
      border-radius: 8px; padding: 14px; min-height: 92px;
    }
    .stat .label { color: var(--muted); font-size: 13px; }
    .stat .value { margin-top: 10px; font-size: 28px; line-height: 1; font-weight: 720; }
    .progress {
      height: 12px; background: #e8e8ed; border-radius: 999px; overflow: hidden;
      border: 1px solid rgba(0,0,0,.04);
    }
    .progress > div { height: 100%; width: 0%; background: var(--blue); transition: width .25s ease; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .button {
      border: 1px solid var(--line); background: var(--panel); color: var(--text);
      min-height: 38px; padding: 0 14px; border-radius: 8px; cursor: pointer;
      display: inline-flex; align-items: center; gap: 7px;
    }
    .button:hover { border-color: #b8b8bf; }
    .button.primary { background: var(--blue); border-color: var(--blue); color: white; }
    .button.primary:hover { background: var(--blue-dark); }
    .button.danger { color: var(--red); }
    .button:disabled { opacity: .52; cursor: not-allowed; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    label.field { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
    input[type="number"] {
      width: 100%; min-height: 38px; border: 1px solid var(--line); border-radius: 8px;
      padding: 0 10px; background: white; color: var(--text);
    }
    .checkline { display: flex; align-items: center; gap: 9px; color: var(--text); font-size: 14px; min-height: 30px; }
    .checkline input { width: 17px; height: 17px; }
    .section-title { margin: 0 0 12px; font-size: 16px; font-weight: 680; }
    .meta { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
    .cursor {
      display: grid; gap: 8px; background: #f7f7fa; border: 1px solid var(--line);
      border-radius: 8px; padding: 12px; font-size: 13px;
    }
    .table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
    .table th, .table td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #ececf0; vertical-align: top; }
    .table th { color: var(--muted); font-weight: 560; }
    .desc { max-width: 520px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .badge {
      display: inline-flex; align-items: center; min-height: 24px; padding: 0 8px;
      border-radius: 999px; background: #eef4ff; color: #064f9e; font-size: 12px;
      white-space: nowrap;
    }
    .badge.warn { background: #fff7e6; color: var(--amber); }
    .badge.err { background: #fff1f0; color: var(--red); }
    .log {
      height: 360px; overflow: auto; background: #111217; color: #f2f2f7;
      border-radius: 8px; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px; line-height: 1.5;
    }
    .log-row { white-space: pre-wrap; overflow-wrap: anywhere; }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    @media (max-width: 980px) {
      .shell { padding: 18px; }
      .layout, .split { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .form-grid { grid-template-columns: 1fr; }
      .topbar { flex-direction: column; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">
      <div>
        <h1>抖音收藏控制台</h1>
        <div class="sub">本地运行，复用现有登录态和进度文件。</div>
      </div>
      <div class="status-pill"><span id="runDot" class="dot"></span><span id="runText">读取中</span></div>
    </div>

    <div class="layout">
      <section class="grid">
        <div class="panel pad">
          <div class="toolbar">
            <button id="runBtn" class="button primary">继续运行</button>
            <button id="stopBtn" class="button danger">停止</button>
            <button id="loginBtn" class="button">打开登录</button>
            <button id="loginDoneBtn" class="button">登录完成</button>
            <button id="auditBtn" class="button">审计最近</button>
            <button id="cleanupBtn" class="button">释放浏览器占用</button>
          </div>
          <div style="height: 16px"></div>
          <div class="progress"><div id="progressBar"></div></div>
          <div class="meta" style="margin-top: 8px" id="progressText">-</div>
        </div>

        <div class="grid stats">
          <div class="stat"><div class="label">已收藏/成功</div><div class="value" id="successCount">-</div></div>
          <div class="stat"><div class="label">待处理</div><div class="value" id="pendingCount">-</div></div>
          <div class="stat"><div class="label">审计返工</div><div class="value" id="auditPendingCount">-</div></div>
          <div class="stat"><div class="label">当前位置</div><div class="value" id="cursorIndex">-</div></div>
        </div>

        <div class="split">
          <div class="panel pad">
            <h2 class="section-title">当前位置</h2>
            <div class="cursor" id="cursorBox"></div>
          </div>
          <div class="panel pad">
            <h2 class="section-title">状态分布</h2>
            <div id="countsBox" class="meta"></div>
          </div>
        </div>

        <div class="panel pad">
          <h2 class="section-title">最近更新</h2>
          <table class="table">
            <thead><tr><th>Index</th><th>状态</th><th>描述</th><th>错误</th></tr></thead>
            <tbody id="recentRows"></tbody>
          </table>
        </div>
      </section>

      <aside class="grid">
        <div class="panel pad">
          <h2 class="section-title">运行选项</h2>
          <label class="checkline"><input id="skipHistoryAudit" type="checkbox" checked />跳过历史审计</label>
          <label class="checkline"><input id="syncLiked" type="checkbox" />重新刷新喜欢列表</label>
          <div class="form-grid" style="margin-top: 10px">
            <label class="field">每批数量<input id="batchSize" type="number" min="1" max="500" /></label>
            <label class="field">每批后审计<input id="auditRecent" type="number" min="0" max="1000" /></label>
            <label class="field">最小间隔 ms<input id="minDelayMs" type="number" min="0" /></label>
            <label class="field">最大间隔 ms<input id="maxDelayMs" type="number" min="0" /></label>
            <label class="field">审计连续失败阈值<input id="maxConsecutiveAuditFailures" type="number" min="1" /></label>
            <label class="field">重试次数<input id="retries" type="number" min="1" /></label>
          </div>
          <div class="toolbar" style="margin-top: 14px">
            <button id="saveConfigBtn" class="button">保存配置</button>
            <button id="clearLogBtn" class="button">清空日志</button>
          </div>
        </div>

        <div class="panel pad">
          <h2 class="section-title">日志</h2>
          <div id="log" class="log"></div>
        </div>
      </aside>
    </div>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    let lastConfigLoaded = false;

    async function api(path, body) {
      const res = await fetch(path, {
        method: body == null ? "GET" : "POST",
        headers: body == null ? undefined : { "content-type": "application/json" },
        body: body == null ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }

    function formValues() {
      return {
        skipHistoryAudit: $("skipHistoryAudit").checked,
        syncLiked: $("syncLiked").checked,
        batchSize: Number($("batchSize").value || 100),
        auditRecent: Number($("auditRecent").value || 120),
        minDelayMs: Number($("minDelayMs").value || 300),
        maxDelayMs: Number($("maxDelayMs").value || 900),
        maxConsecutiveAuditFailures: Number($("maxConsecutiveAuditFailures").value || 6),
        retries: Number($("retries").value || 3),
      };
    }

    function fillConfig(config) {
      if (lastConfigLoaded) return;
      $("batchSize").value = config.cycleBatchSize ?? 100;
      $("auditRecent").value = config.cycleAuditRecent ?? 120;
      $("minDelayMs").value = config.minDelayMs ?? 300;
      $("maxDelayMs").value = config.maxDelayMs ?? 900;
      $("maxConsecutiveAuditFailures").value = config.maxConsecutiveAuditFailures ?? 6;
      $("retries").value = config.retries ?? 3;
      $("syncLiked").checked = Boolean(config.syncLikedBeforeRun);
      lastConfigLoaded = true;
    }

    function badge(status) {
      const cls = String(status).includes("paused") || status === "blocked" ? "err" : status === "pending" ? "warn" : "";
      return '<span class="badge ' + cls + '">' + escapeHtml(status || "-") + '</span>';
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[char]));
    }

    function render(data) {
      fillConfig(data.config || {});
      const s = data.summary || {};
      $("runDot").className = "dot" + (data.running ? " running" : "");
      $("runText").textContent = data.running ? "运行中" : "空闲";
      $("runBtn").disabled = data.running;
      $("loginBtn").disabled = data.running;
      $("auditBtn").disabled = data.running;
      $("cleanupBtn").disabled = data.running;
      $("stopBtn").disabled = !data.running;
      $("loginDoneBtn").disabled = !data.running;

      $("successCount").textContent = s.successCount ?? "-";
      $("pendingCount").textContent = s.pendingCount ?? "-";
      $("auditPendingCount").textContent = s.auditPendingCount ?? "-";
      $("cursorIndex").textContent = s.cursorIndex >= 0 ? s.cursorIndex : "-";
      const percent = Math.round((s.progressRatio || 0) * 1000) / 10;
      $("progressBar").style.width = Math.max(0, Math.min(100, percent)) + "%";
      $("progressText").textContent = percent + "% · 真实喜欢 " + (s.realTotal || 0) + " · 成功 " + (s.successCount || 0) + " · 待处理 " + (s.pendingCount || 0) + " · 更新时间 " + (s.updatedAt || "-");

      const c = s.cursor || {};
      $("cursorBox").innerHTML =
        '<div>状态：' + badge(c.status || "-") + '</div>' +
        '<div>Index：' + escapeHtml(c.listIndex ?? "-") + '</div>' +
        '<div>Video：' + escapeHtml(c.lastVideoId || "-") + '</div>' +
        '<div class="meta">' + escapeHtml(c.lastVideoUrl || "") + '</div>';

      const counts = s.counts || {};
      $("countsBox").innerHTML = Object.keys(counts).sort().map((key) => (
        '<div style="display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid #ececf0"><span>' + escapeHtml(key) + '</span><strong>' + counts[key] + '</strong></div>'
      )).join("");

      $("recentRows").innerHTML = (s.recentItems || []).map((item) =>
        '<tr>' +
          '<td>' + escapeHtml(item.index) + '</td>' +
          '<td>' + badge(item.status) + '</td>' +
          '<td class="desc" title="' + escapeHtml(item.desc) + '">' + escapeHtml(item.desc || item.videoId) + '</td>' +
          '<td class="desc" title="' + escapeHtml(item.lastError || "") + '">' + escapeHtml(item.lastError || "") + '</td>' +
        '</tr>'
      ).join("");

      const rows = (data.logs || []).map((row) => '<div class="log-row"><span style="color:#8e8e93">' + escapeHtml(row.at?.slice(11, 19) || "") + '</span> ' + escapeHtml(row.text) + '</div>');
      const log = $("log");
      const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
      log.innerHTML = rows.join("");
      if (atBottom) log.scrollTop = log.scrollHeight;
    }

    async function refresh() {
      try {
        render(await api("/api/status"));
      } catch (error) {
        $("runText").textContent = error.message;
      }
    }

    $("runBtn").onclick = async () => {
      const values = formValues();
      await api("/api/run", { mode: "cycle", label: "循环运行", ...values });
      refresh();
    };
    $("stopBtn").onclick = async () => { await api("/api/stop", {}); refresh(); };
    $("loginBtn").onclick = async () => { await api("/api/run", { mode: "login", label: "登录" }); refresh(); };
    $("loginDoneBtn").onclick = async () => { await api("/api/login-done", {}); refresh(); };
    $("auditBtn").onclick = async () => {
      const values = formValues();
      await api("/api/run", { mode: "audit", label: "审计最近", auditRecent: values.auditRecent });
      refresh();
    };
    $("cleanupBtn").onclick = async () => { await api("/api/cleanup-browser", {}); refresh(); };
    $("clearLogBtn").onclick = async () => { await api("/api/clear-log", {}); refresh(); };
    $("saveConfigBtn").onclick = async () => {
      const values = formValues();
      await api("/api/config", {
        cycleBatchSize: values.batchSize,
        cycleAuditRecent: values.auditRecent,
        minDelayMs: values.minDelayMs,
        maxDelayMs: values.maxDelayMs,
        maxConsecutiveAuditFailures: values.maxConsecutiveAuditFailures,
        retries: values.retries,
        syncLikedBeforeRun: values.syncLiked,
      });
      refresh();
    };

    refresh();
    setInterval(refresh, 1500);
  </script>
</body>
</html>`;
