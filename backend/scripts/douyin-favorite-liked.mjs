#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";

const ROOT = process.cwd();
const STATE_PATH = path.join(ROOT, "data", "douyin-favorite-progress.json");
const CONFIG_PATH = path.join(ROOT, "config", "douyin-favorite.config.json");
const PROFILE_DIR = path.join(ROOT, ".douyin-playwright-profile");
const DEFAULT_START_URL = "https://www.douyin.com/";
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

const PAUSE_STATUSES = new Set([
  "paused_unclickable",
  "paused_unavailable",
  "paused_unverified",
  "blocked",
]);

const SUCCESS_STATUSES = new Set([
  "favorited",
  "already_favorited",
  "skipped_inaccessible",
]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(minMs, maxMs) {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return {
      version: 1,
      source: "douyin_liked_list",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      sourceLikedUrl: null,
      cursor: null,
      items: [],
      events: [],
    };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
}

function boolArg(value, fallback = false) {
  if (value == null) return fallback;
  if (value === true) return true;
  if (value === false) return false;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function saveState(state) {
  state.updatedAt = nowIso();
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, STATE_PATH);
}

function normalizeVideoUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl, "https://www.douyin.com");
    if (!url.hostname.endsWith("douyin.com")) return null;
    const match = url.pathname.match(/\/(video|note)\/([^/?#]+)/);
    if (!match) return null;
    return `https://www.douyin.com/${match[1]}/${match[2]}`;
  } catch {
    return null;
  }
}

function videoIdFromUrl(url) {
  return normalizeVideoUrl(url)?.match(/\/(?:video|note)\/([^/?#]+)/)?.[1] ?? null;
}

function upsertItem(state, url, indexHint = null) {
  const normalizedUrl = normalizeVideoUrl(url);
  if (!normalizedUrl) return null;
  const videoId = videoIdFromUrl(normalizedUrl);
  let item = state.items.find((candidate) => candidate.videoId === videoId);
  if (!item) {
    item = {
      videoId,
      url: normalizedUrl,
      index: state.items.length,
      status: "pending",
      attempts: 0,
      lastError: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.items.push(item);
  }
  if (indexHint != null && item.index == null) item.index = indexHint;
  return item;
}

function upsertAwemeItem(state, aweme, indexHint = null) {
  const videoId = String(aweme.aweme_id || aweme.awemeId || aweme.id || "");
  if (!videoId) return null;
  const incomingCollectStat = aweme.collect_stat ?? null;
  let item = state.items.find((candidate) => candidate.videoId === videoId);
  if (!item) {
    item = {
      videoId,
      url: `https://www.douyin.com/video/${videoId}`,
      index: indexHint ?? state.items.length,
      source: "favorite_api",
      status: "pending",
      attempts: 0,
      collectStat: incomingCollectStat,
      desc: aweme.desc ?? "",
      author: aweme.author?.nickname ?? "",
      lastError: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.items.push(item);
  }
  item.source = "favorite_api";
  item.collectStat = incomingCollectStat ?? item.collectStat ?? null;
  item.desc = aweme.desc ?? item.desc ?? "";
  item.author = aweme.author?.nickname ?? item.author ?? "";
  if (incomingCollectStat === 1) {
    if (item.status === "pending" || item.status == null) item.status = "already_favorited";
    item.lastError = null;
  } else if (incomingCollectStat === 0 && SUCCESS_STATUSES.has(item.status)) {
    item.status = "pending";
    item.lastError = "喜欢列表同步发现未收藏，已重新标回 pending";
  }
  item.updatedAt = nowIso();
  return item;
}

async function promptEnter(message) {
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question(message);
  } finally {
    rl.close();
  }
}

async function launch() {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 820 },
    locale: "zh-CN",
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

async function getPage(context) {
  const pages = context.pages();
  return pages[0] ?? context.newPage();
}

async function getSelfSecUid(page) {
  return page.evaluate(() => {
    const fromState = window.SSR_RENDER_DATA?.app?.user?.info?.secUid;
    if (fromState) return fromState;
    const scripts = Array.from(document.scripts).map((script) => script.textContent || "").join("\n");
    return scripts.match(/"secUid"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  });
}

async function fetchLikedPage(page, secUid, cursor, count = 20) {
  return page.evaluate(async ({ secUid, cursor, count }) => {
    const endpoint = `/aweme/v1/web/aweme/favorite/?device_platform=webapp&aid=6383&channel=channel_pc_web&sec_user_id=${encodeURIComponent(secUid)}&max_cursor=${encodeURIComponent(cursor)}&count=${encodeURIComponent(count)}`;
    const response = await fetch(endpoint, { credentials: "include" });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, httpStatus: response.status, text: text.slice(0, 500) };
    }
    return {
      ok: response.ok && json.status_code === 0,
      httpStatus: response.status,
      statusCode: json.status_code,
      statusMsg: json.status_msg,
      hasMore: Number(json.has_more || 0),
      maxCursor: json.max_cursor ?? 0,
      awemeList: json.aweme_list || [],
    };
  }, { secUid, cursor, count });
}

async function fetchLikedPageWithRetry(page, secUid, cursor, count = 20, retries = 3, retryBaseDelayMs = 1500) {
  let lastResult = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const result = await fetchLikedPage(page, secUid, cursor, count);
      if (result.ok) return result;
      lastResult = result;
    } catch (error) {
      lastResult = { ok: false, error: error.message };
    }
    await sleep(retryBaseDelayMs * attempt);
  }
  return lastResult ?? { ok: false, error: "unknown fetchLikedPage failure" };
}

async function collectAweme(page, awemeId) {
  return page.evaluate(async ({ awemeId }) => {
    const endpoint = `/aweme/v1/web/aweme/collect/?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=${encodeURIComponent(awemeId)}&action=1`;
    const response = await fetch(endpoint, { method: "POST", credentials: "include" });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, httpStatus: response.status, text: text.slice(0, 500) };
    }
    return {
      ok: response.ok && json.status_code === 0,
      httpStatus: response.status,
      statusCode: json.status_code,
      statusMsg: json.status_msg,
      raw: json,
    };
  }, { awemeId });
}

async function collectAwemeWithRetry(page, awemeId, retries = 3, retryBaseDelayMs = 1500) {
  let lastResult = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const result = await collectAweme(page, awemeId);
      if (result.ok) return result;
      lastResult = result;
    } catch (error) {
      lastResult = { ok: false, error: error.message };
    }
    await sleep(retryBaseDelayMs * attempt);
  }
  return lastResult ?? { ok: false, error: "unknown collectAweme failure" };
}

async function fetchAwemeDetail(page, awemeId) {
  return page.evaluate(async ({ awemeId }) => {
    const endpoint = `/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=${encodeURIComponent(awemeId)}`;
    const response = await fetch(endpoint, { credentials: "include" });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, httpStatus: response.status, text: text.slice(0, 500) };
    }
    const aweme = json.aweme_detail || json.aweme || json.item || json.data || null;
    return {
      ok: response.ok && json.status_code === 0 && Boolean(aweme),
      httpStatus: response.status,
      statusCode: json.status_code,
      statusMsg: json.status_msg,
      collectStat: aweme?.collect_stat ?? null,
      desc: aweme?.desc ?? "",
      raw: json.status_code === 0 ? undefined : json,
    };
  }, { awemeId });
}

async function fetchAwemeDetailWithRetry(page, awemeId, retries = 3, retryBaseDelayMs = 1500) {
  let lastResult = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const result = await fetchAwemeDetail(page, awemeId);
      if (result.ok || result.statusCode === 2053) return result;
      lastResult = result;
    } catch (error) {
      lastResult = { ok: false, error: error.message };
    }
    await sleep(retryBaseDelayMs * attempt);
  }
  return lastResult ?? { ok: false, error: "unknown fetchAwemeDetail failure" };
}

async function currentSignals(page) {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText ?? "";
    return {
      url: location.href,
      title: document.title,
      loginLikelyRequired: /扫码登录|手机号登录|密码登录|验证码登录|登录后|请先登录|未登录/.test(bodyText),
      blockedLikely: /验证|验证码|访问频繁|安全|风险|稍后再试/.test(bodyText),
      inaccessibleLikely: /作品不存在|已删除|暂时无法观看|权限|私密|无法播放/.test(bodyText),
      textSample: bodyText.slice(0, 800),
    };
  });
}

async function collectVideoLinks(page, state, { maxScrolls = 80, idleRounds = 4 } = {}) {
  let stableRounds = 0;
  let lastCount = state.items.length;

  for (let round = 0; round < maxScrolls; round += 1) {
    const urls = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => anchor.href)
        .filter((href) => /douyin\.com\/(video|note)\//.test(href));
    });

    for (const url of urls) {
      upsertItem(state, url);
    }
    saveState(state);

    if (state.items.length === lastCount) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
      lastCount = state.items.length;
      console.log(`已发现 ${state.items.length} 个作品链接`);
    }

    if (stableRounds >= idleRounds) break;
    await page.mouse.wheel(0, 1800);
    await sleep(900);
  }

  return state.items.length;
}

async function findFavoriteCandidate(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };

    const textOf = (el) => [
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.getAttribute("data-e2e"),
      el.innerText,
      el.textContent,
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

    const candidates = Array.from(document.querySelectorAll("button,[role='button'],div,span"))
      .filter(visible)
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        const text = textOf(el);
        const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
        const compactText = text.replace(/\s+/g, "");
        const exact = /^(已收藏|取消收藏|收藏){1,3}$/.test(compactText) || /favorite|collect/i.test(text);
        const mixedActionGroup = /赞/.test(text) && /分享/.test(text) && /收藏/.test(text);
        const compactControl = rect.width <= 130 && rect.height <= 90 && text.length <= 12;
        const score =
          (/已收藏|取消收藏/.test(text) ? 130 : 0) +
          (/收藏/.test(text) ? 60 : 0) +
          (/favorite|collect/i.test(text) ? 25 : 0) +
          (exact ? 35 : 0) +
          (compactControl ? 30 : 0) +
          (rect.left > window.innerWidth * 0.55 ? 8 : 0) +
          (["BUTTON"].includes(el.tagName) || el.getAttribute("role") === "button" ? 10 : 0) -
          (mixedActionGroup ? 90 : 0) -
          (text.length > 40 ? 60 : 0);
        return {
          index,
          tag: el.tagName,
          role: el.getAttribute("role"),
          text,
          disabled,
          exact,
          score,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      })
      .filter((item) => item.score >= 70)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    return candidates;
  });
}

async function favoriteState(page) {
  const candidates = await findFavoriteCandidate(page);
  const best = candidates[0] ?? null;
  if (!best) return { state: "unknown", best, candidates };
  if (/已收藏|取消收藏/.test(best.text)) return { state: "favorited", best, candidates };
  if (/收藏|favorite|collect/i.test(best.text)) return { state: "not_favorited", best, candidates };
  return { state: "unknown", best, candidates };
}

async function openItemFromLikedList(page, state, item) {
  if (!state.sourceLikedUrl) return { opened: false, reason: "没有保存喜欢列表入口" };
  await page.goto(state.sourceLikedUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);

  for (let round = 0; round < 50; round += 1) {
    const selector = `a[href*="${item.videoId}"]`;
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) {
      await page.locator(selector).first().click({ timeout: 10000 }).catch(async () => {
        await page.evaluate((id) => {
          const anchor = Array.from(document.querySelectorAll("a[href]")).find((node) => node.href.includes(id));
          anchor?.click();
        }, item.videoId);
      });
      await page.waitForTimeout(1800);
      return { opened: true, via: "liked_list" };
    }
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(500);
  }

  return { opened: false, reason: "喜欢列表中未找到对应卡片" };
}

async function waitForVideoReady(page) {
  for (let round = 0; round < 15; round += 1) {
    const ready = await page.evaluate(() => {
      const text = document.body?.innerText ?? "";
      const hasActions = /赞[\s\S]{0,40}收藏[\s\S]{0,40}分享/.test(text) || /收藏/.test(text);
      const loading = /视频数据加载中/.test(text);
      return {
        ready: hasActions || text.length > 1200,
        bodyLength: text.length,
        loading,
      };
    }).catch(() => ({ ready: false, bodyLength: 0, loading: true }));
    if (ready.ready || ready.bodyLength > 1200) return ready;
    await page.waitForTimeout(1000);
  }
  return { ready: false, bodyLength: 0, loading: true };
}

async function clickFavoriteCandidate(page, candidate) {
  if (!candidate || candidate.disabled) return false;
  const x = candidate.rect.x + candidate.rect.width / 2;
  const y = candidate.rect.y + candidate.rect.height / 2;
  await page.mouse.click(x, y);
  return true;
}

async function processItem(page, state, item, options) {
  item.attempts += 1;
  item.updatedAt = nowIso();
  item.lastError = null;
  state.cursor = {
    lastVideoId: item.videoId,
    lastVideoUrl: item.url,
    listIndex: item.index,
    status: "processing",
  };
  saveState(state);

  console.log(`处理 #${item.index}: ${item.url}`);
  const opened = await openItemFromLikedList(page, state, item);
  if (!opened.opened) {
    await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  }
  const ready = await waitForVideoReady(page);
  if (!ready.ready) {
    item.status = "paused_unavailable";
    item.lastError = `作品页未完成加载或未出现操作区: ${JSON.stringify(ready)}`;
    item.updatedAt = nowIso();
    state.cursor.status = item.status;
    saveState(state);
    return { pause: true, reason: item.lastError };
  }

  const signals = await currentSignals(page);
  if (signals.blockedLikely || signals.loginLikelyRequired) {
    item.status = "blocked";
    item.lastError = signals.loginLikelyRequired ? "需要登录或登录态失效" : "页面出现验证/风控提示";
    item.updatedAt = nowIso();
    state.cursor.status = item.status;
    saveState(state);
    return { pause: true, reason: item.lastError };
  }

  if (signals.inaccessibleLikely) {
    item.status = "skipped_inaccessible";
    item.lastError = "作品不可访问，按确认规则跳过";
    item.updatedAt = nowIso();
    state.cursor.status = item.status;
    saveState(state);
    return { pause: false };
  }

  const before = await favoriteState(page);
  if (before.state === "favorited") {
    item.status = "already_favorited";
    item.updatedAt = nowIso();
    state.cursor.status = item.status;
    saveState(state);
    return { pause: false };
  }

  if (before.state !== "not_favorited") {
    item.status = "paused_unavailable";
    item.lastError = `无法可靠定位收藏按钮: ${JSON.stringify(before.candidates)}`;
    item.updatedAt = nowIso();
    state.cursor.status = item.status;
    saveState(state);
    return { pause: true, reason: item.lastError };
  }

  if (before.best?.disabled) {
    item.status = "paused_unclickable";
    item.lastError = "收藏按钮存在但不可点击";
    item.updatedAt = nowIso();
    state.cursor.status = item.status;
    saveState(state);
    return { pause: true, reason: item.lastError };
  }

  await clickFavoriteCandidate(page, before.best);
  await page.waitForTimeout(1400);

  const after = await favoriteState(page);
  if (after.state === "favorited") {
    item.status = "favorited";
    item.updatedAt = nowIso();
    state.cursor.status = item.status;
    saveState(state);
    await sleep(randomBetween(options.minDelayMs, options.maxDelayMs));
    return { pause: false };
  }

  item.status = "paused_unverified";
  item.lastError = `点击后无法确认已收藏: ${JSON.stringify(after.candidates)}`;
  item.updatedAt = nowIso();
  state.cursor.status = item.status;
  saveState(state);
  return { pause: true, reason: item.lastError };
}

function nextWorkItem(state) {
  return (
    state.items.find((item) => PAUSE_STATUSES.has(item.status)) ??
    state.items.find((item) => !SUCCESS_STATUSES.has(item.status))
  );
}

function summarize(state) {
  const counts = state.items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
  return { total: state.items.length, counts, cursor: state.cursor };
}

async function loginCommand() {
  const context = await launch();
  const page = await getPage(context);
  await page.goto(DEFAULT_START_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  console.log("请在打开的浏览器里登录抖音，并导航到你的“喜欢”列表页面。");
  console.log("到达喜欢列表后，回到这个终端按 Enter。");
  await promptEnter("");
  const state = loadState();
  state.sourceLikedUrl = page.url();
  state.events.push({ type: "login_or_source_set", url: page.url(), at: nowIso() });
  saveState(state);
  console.log(`已保存喜欢列表入口: ${page.url()}`);
  await context.close();
}

async function probeCommand(args) {
  const state = loadState();
  const context = await launch();
  const page = await getPage(context);
  const startUrl = args["liked-url"] || state.sourceLikedUrl || DEFAULT_START_URL;
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  if (!args["liked-url"] && !state.sourceLikedUrl) {
    console.log("请在浏览器里导航到你的“喜欢”列表页面，然后回到终端按 Enter。");
    await promptEnter("");
    state.sourceLikedUrl = page.url();
    saveState(state);
  }
  const signals = await currentSignals(page);
  const beforeCount = state.items.length;
  await collectVideoLinks(page, state, { maxScrolls: Number(args.scrolls ?? 8), idleRounds: 2 });
  const sample = state.items.slice(beforeCount, beforeCount + 5);
  console.log(JSON.stringify({ signals, discoveredTotal: state.items.length, sample }, null, 2));
  await context.close();
}

async function runCommand(args) {
  const state = loadState();
  const context = await launch();
  const page = await getPage(context);
  const startUrl = args["liked-url"] || state.sourceLikedUrl || DEFAULT_START_URL;
  const maxItems = args.max ? Number(args.max) : Infinity;
  const options = {
    minDelayMs: Number(args["min-delay-ms"] ?? 300),
    maxDelayMs: Number(args["max-delay-ms"] ?? 900),
  };

  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  if (!args["liked-url"] && !state.sourceLikedUrl) {
    console.log("请在浏览器里导航到你的“喜欢”列表页面，然后回到终端按 Enter。");
    await promptEnter("");
    state.sourceLikedUrl = page.url();
    saveState(state);
  }

  await collectVideoLinks(page, state, {
    maxScrolls: Number(args.scrolls ?? 80),
    idleRounds: Number(args["idle-rounds"] ?? 4),
  });

  let processed = 0;
  while (processed < maxItems) {
    const item = nextWorkItem(state);
    if (!item) break;
    const result = await processItem(page, state, item, options);
    processed += 1;
    if (result.pause) {
      console.log(`已暂停: ${result.reason}`);
      console.log(JSON.stringify(summarize(state), null, 2));
      await context.close();
      process.exitCode = 2;
      return;
    }
  }

  console.log(JSON.stringify(summarize(state), null, 2));
  await context.close();
}

async function runApiCommand(args) {
  const state = loadState();
  const config = loadConfig();
  const context = await launch();
  const page = await getPage(context);
  const startUrl = args["liked-url"] || state.sourceLikedUrl || DEFAULT_START_URL;
  const maxItems = args.max ? Number(args.max) : Infinity;
  const maxPages = args["max-pages"] ? Number(args["max-pages"]) : Infinity;
  const pageSize = args.count ? Number(args.count) : Number(config.count);
  const options = {
    minDelayMs: Number(args["min-delay-ms"] ?? config.minDelayMs),
    maxDelayMs: Number(args["max-delay-ms"] ?? config.maxDelayMs),
    retries: Number(args.retries ?? config.retries),
    retryBaseDelayMs: Number(args["retry-base-delay-ms"] ?? config.retryBaseDelayMs),
    syncLikedBeforeRun: boolArg(args["sync-liked"], Boolean(config.syncLikedBeforeRun)),
    stopAfterNoNewPages: Number(args["stop-after-no-new-pages"] ?? config.stopAfterNoNewPages),
  };

  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  state.sourceLikedUrl = startUrl;

  for (const item of state.items) {
    if (item.source !== "favorite_api" && !SUCCESS_STATUSES.has(item.status)) {
      item.status = "skipped_non_like_probe_artifact";
      item.lastError = "旧版 DOM 探测误采集项，已忽略";
      item.updatedAt = nowIso();
    }
  }

  if (options.syncLikedBeforeRun) {
    const secUid = await getSelfSecUid(page);
    if (!secUid) {
      console.log("已暂停: 无法读取当前登录用户 secUid，请确认已登录并在个人喜欢页。");
      await context.close();
      process.exitCode = 2;
      return;
    }
    state.secUid = secUid;
    let cursor = 0;
    let pageNo = 0;
    let noNewPages = 0;
    while (pageNo < maxPages) {
      const result = await fetchLikedPageWithRetry(page, secUid, cursor, pageSize, options.retries, options.retryBaseDelayMs);
      if (!result.ok) {
        state.cursor = { status: "blocked", lastError: `喜欢列表接口失败: ${JSON.stringify(result).slice(0, 500)}` };
        saveState(state);
        console.log(`已暂停: ${state.cursor.lastError}`);
        await context.close();
        process.exitCode = 2;
        return;
      }
      const beforeApiCount = state.items.filter((item) => item.source === "favorite_api").length;
      const startIndex = beforeApiCount;
      result.awemeList.forEach((aweme, offset) => upsertAwemeItem(state, aweme, startIndex + offset));
      const afterApiCount = state.items.filter((item) => item.source === "favorite_api").length;
      noNewPages = afterApiCount === beforeApiCount ? noNewPages + 1 : 0;
      state.apiCursor = result.maxCursor;
      saveState(state);
      console.log(`已同步喜欢列表第 ${pageNo + 1} 页，累计 ${afterApiCount} 个真实喜欢作品`);
      pageNo += 1;
      if (noNewPages >= options.stopAfterNoNewPages) {
        console.log(`连续 ${noNewPages} 页无新增，停止同步并进入收藏阶段`);
        break;
      }
      if (!result.hasMore || !result.maxCursor || result.maxCursor === cursor) break;
      cursor = result.maxCursor;
      await sleep(500);
    }
  } else {
    const apiCount = state.items.filter((item) => item.source === "favorite_api").length;
    console.log(`跳过喜欢列表同步，直接处理已有 ${apiCount} 个真实喜欢作品。需要刷新时传 --sync-liked`);
  }

  let processed = 0;
  const apiItems = state.items.filter((item) => item.source === "favorite_api");
  for (const item of apiItems) {
    if (processed >= maxItems) break;
    if (SUCCESS_STATUSES.has(item.status)) continue;

    state.cursor = {
      lastVideoId: item.videoId,
      lastVideoUrl: item.url,
      listIndex: item.index,
      status: "processing",
    };
    item.attempts += 1;
    item.updatedAt = nowIso();
    saveState(state);

    if (item.collectStat === 1) {
      item.status = "already_favorited";
      item.lastError = null;
      item.updatedAt = nowIso();
      state.cursor.status = item.status;
      saveState(state);
      processed += 1;
      continue;
    }

    console.log(`收藏 #${item.index}: ${item.videoId} ${item.desc || ""}`.trim());
    const result = await collectAwemeWithRetry(page, item.videoId, options.retries, options.retryBaseDelayMs);
    if (!result.ok) {
      if (result.statusCode === 2053) {
        item.status = "skipped_inaccessible";
        item.lastError = result.statusMsg || "视频不存在，按规则跳过";
        item.updatedAt = nowIso();
        state.cursor.status = item.status;
        saveState(state);
        processed += 1;
        continue;
      }
      item.status = "paused_unverified";
      item.lastError = `收藏接口失败: ${JSON.stringify(result).slice(0, 500)}`;
      item.updatedAt = nowIso();
      state.cursor.status = item.status;
      saveState(state);
      console.log(`已暂停: ${item.lastError}`);
      console.log(JSON.stringify(summarize(state), null, 2));
      await context.close();
      process.exitCode = 2;
      return;
    }

    item.status = "favorited";
    item.collectStat = 1;
    item.lastError = null;
    item.updatedAt = nowIso();
    state.cursor.status = item.status;
    saveState(state);
    processed += 1;
    await sleep(randomBetween(options.minDelayMs, options.maxDelayMs));
  }

  console.log(JSON.stringify(summarize(state), null, 2));
  await context.close();
}

async function auditCommand(args) {
  const state = loadState();
  const config = loadConfig();
  const context = await launch();
  const page = await getPage(context);
  const startUrl = args["liked-url"] || state.sourceLikedUrl || DEFAULT_START_URL;
  const options = {
    limit: args.all ? Infinity : Number(args.recent ?? args.limit ?? 100),
    maxIndex: args["max-index"] == null ? Infinity : Number(args["max-index"]),
    minIndex: args["min-index"] == null ? -Infinity : Number(args["min-index"]),
    minDelayMs: Number(args["min-delay-ms"] ?? config.minDelayMs),
    maxDelayMs: Number(args["max-delay-ms"] ?? config.maxDelayMs),
    retries: Number(args.retries ?? config.retries),
    retryBaseDelayMs: Number(args["retry-base-delay-ms"] ?? config.retryBaseDelayMs),
    continueOnFailure: boolArg(args["continue-on-audit-failure"], config.continueOnAuditFailure),
    maxConsecutiveFailures: Number(args["max-consecutive-audit-failures"] ?? config.maxConsecutiveAuditFailures),
  };

  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const candidates = state.items
    .filter((item) => {
      const index = item.index ?? -1;
      return (
        item.source === "favorite_api" &&
        (item.status === "favorited" || item.status === "already_favorited") &&
        index <= options.maxIndex &&
        index >= options.minIndex
      );
    })
    .sort((a, b) => (b.index ?? -1) - (a.index ?? -1))
    .slice(0, options.limit);

  let checked = 0;
  let confirmed = 0;
  let resetToPending = 0;
  let skipped = 0;
  let failed = 0;
  let consecutiveFailures = 0;

  for (const item of candidates) {
    const result = await fetchAwemeDetailWithRetry(page, item.videoId, options.retries, options.retryBaseDelayMs);
    checked += 1;
    if (checked % 100 === 0) {
      console.log(`审计进度: ${checked}/${candidates.length}`);
    }

    if (result.statusCode === 2053) {
      item.status = "skipped_inaccessible";
      item.lastError = result.statusMsg || "审计发现视频不存在，按规则跳过";
      item.updatedAt = nowIso();
      skipped += 1;
      consecutiveFailures = 0;
      saveState(state);
      continue;
    }

    if (!result.ok) {
      const previousStatus = item.status;
      item.lastError = `审计接口失败: ${JSON.stringify(result).slice(0, 500)}`;
      item.updatedAt = nowIso();
      failed += 1;
      saveState(state);
      if (options.continueOnFailure) {
        console.log(`审计跳过 #${item.index}: ${item.videoId} ${item.lastError}；保留原状态 ${previousStatus}`);
        consecutiveFailures += 1;
        if (consecutiveFailures >= options.maxConsecutiveFailures) {
          state.cursor = {
            status: "audit_degraded",
            listIndex: item.index,
            consecutiveFailures,
            lastError: item.lastError,
          };
          saveState(state);
          console.log(`连续 ${consecutiveFailures} 条审计失败，结束当前审计段，后续收藏继续。`);
          break;
        }
        await sleep(randomBetween(options.minDelayMs, options.maxDelayMs));
        continue;
      }
      state.cursor = {
        lastVideoId: item.videoId,
        lastVideoUrl: item.url,
        listIndex: item.index,
        status: "audit_paused_unverified",
      };
      console.log(`审计暂停: ${item.lastError}；保留原状态 ${previousStatus}`);
      console.log(JSON.stringify({ checked, confirmed, resetToPending, skipped, failed, item }, null, 2));
      await context.close();
      process.exitCode = 2;
      return;
    }

    item.collectStat = result.collectStat;
    consecutiveFailures = 0;
    if (result.collectStat === 1) {
      confirmed += 1;
      item.lastError = null;
      item.updatedAt = nowIso();
    } else {
      item.status = "pending";
      item.lastError = `审计发现未真正收藏: collect_stat=${result.collectStat}`;
      item.updatedAt = nowIso();
      resetToPending += 1;
      console.log(`审计返工 #${item.index}: ${item.videoId} ${item.lastError}`);
    }

    saveState(state);
    await sleep(randomBetween(options.minDelayMs, options.maxDelayMs));
  }

  if (args.all) {
    state.cursor = {
      status: "audit_completed",
      listIndex: candidates.at(-1)?.index ?? null,
      checked,
      confirmed,
      resetToPending,
      skipped,
      failed,
    };
    saveState(state);
  }

  console.log(JSON.stringify({ checked, confirmed, resetToPending, skipped, failed }, null, 2));
  await context.close();
}

async function cycleCommand(args) {
  const config = loadConfig();
  const batchSize = Number(args["batch-size"] ?? args.max ?? config.cycleBatchSize);
  const auditRecent = Number(args["audit-recent"] ?? config.cycleAuditRecent);
  const cycles = args.cycles ? Number(args.cycles) : Infinity;
  const skipHistoryAudit = boolArg(args["skip-history-audit"], false);

  if (!skipHistoryAudit) {
    const state = loadState();
    const historyAuditArgs = { ...args, all: true };
    if (historyAuditArgs["max-index"] == null && state.cursor?.status === "audit_paused_unverified" && state.cursor.listIndex != null) {
      historyAuditArgs["max-index"] = String(state.cursor.listIndex);
      console.log(`从上次历史审计暂停位置继续：index <= ${state.cursor.listIndex}`);
    }
    console.log("先审计历史已成功项，发现漏收藏会标回 pending。");
    process.exitCode = 0;
    await auditCommand(historyAuditArgs);
    if (process.exitCode) return;
  }

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    console.log(`开始第 ${cycle} 轮：收藏最多 ${batchSize} 条`);
    process.exitCode = 0;
    await runApiCommand({ ...args, max: String(batchSize) });
    if (process.exitCode) return;

    console.log(`第 ${cycle} 轮收藏完成，审计最近 ${auditRecent} 条已成功项`);
    process.exitCode = 0;
    await auditCommand({ ...args, recent: String(auditRecent), all: false });
    if (process.exitCode) return;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(3));
  const command = process.argv[2] ?? "run";
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  if (command === "login") return loginCommand(args);
  if (command === "probe") return probeCommand(args);
  if (command === "run" || command === "resume" || command === "run-api") return runApiCommand(args);
  if (command === "run-ui") return runCommand(args);
  if (command === "audit") return auditCommand(args);
  if (command === "cycle") return cycleCommand(args);

  console.error(`未知命令: ${command}`);
  console.error("用法: npm run douyin:run -- [--liked-url URL] [--max N]");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
