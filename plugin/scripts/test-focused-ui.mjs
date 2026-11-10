import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-ui-"));
let denyRetryMedia = false;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/host.html") {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/content.css"></head><body style="background:#f5f5f7"><p>悬浮菜单测试页面</p><script>window.chrome={runtime:{getURL:p=>location.origin+'/'+p,onMessage:{addListener(){}}}};</script><script src="/src/content.js"></script></body></html>`,
    );
    return;
  }
  if (pathname === "/media/700" && denyRetryMedia) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (pathname.startsWith("/media/")) {
    const total = 327680,
      offset = Number(
        (req.headers.range || "").match(/bytes=(\d+)-/)?.[1] || 0,
      );
    res.writeHead(offset ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": total - offset,
      "Accept-Ranges": "bytes",
      ...(offset
        ? { "Content-Range": `bytes ${offset}-${total - 1}/${total}` }
        : {}),
    });
    let sent = offset;
    const timer = setInterval(() => {
      if (sent >= total) {
        clearInterval(timer);
        res.end();
        return;
      }
      const n = Math.min(65536, total - sent),
        data = Buffer.alloc(n, Number(pathname.split("/").at(-1)) || 1);
      if (sent === 0) data.write("0000ftypisom", 0);
      res.write(data);
      sent += n;
    }, 110);
    res.on("close", () => clearInterval(timer));
    return;
  }
  if (pathname === "/src/core/retry.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(fs.readFileSync(path.join(root, "src/core/retry.js"), "utf8").replace("forbiddenBaseMs = 2500", "forbiddenBaseMs = 1"));
    return;
  }
  const file = path.join(root, decodeURIComponent(pathname));
  if (
    !file.startsWith(root + path.sep) ||
    !fs.existsSync(file) ||
    !fs.statSync(file).isFile()
  ) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader(
    "Content-Type",
    {
      ".js": "application/javascript",
      ".html": "text/html",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    }[path.extname(file)] || "text/plain",
  );
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  ...(process.env.CHROME_EXECUTABLE
    ? { executablePath: process.env.CHROME_EXECUTABLE }
    : {}),
  headless: true,
});
try {
  const context=await browser.newContext({viewport:{width:390,height:760}});
  const page = await context.newPage(),
    errors = [],
    ranges = [];
  page.on("request", (request) => {
    if (request.headers().range) ranges.push(request.headers().range);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    FileSystemHandle.prototype.queryPermission = async () => "granted";
    window.chrome = { runtime: { sendMessage: async () => ({ ok: true }) } };
    window.addEventListener("message", (event) => {
      const m = event.data;
      if (m?.source !== "douyin-toolkit-sidebar") return;
      if (m.type === "SET_SIDEBAR_COLLAPSED") {
        window.postMessage(
          {
            source: "douyin-toolkit-content",
            type: "SIDEBAR_COLLAPSE_STATE",
            payload: m.payload,
          },
          "*",
        );
        return;
      }
      if (m.type === "CLOSE_SIDEBAR") {
        window.pluginClosed = true;
        return;
      }
      if (!m.requestId) return;
      let payload;
      const aweme = (id) => ({
        aweme_id: String(id),
        desc: "测试作品 " + id,
        author: { uid: "author", nickname: "示例作者" },
        video: {
          play_addr: {
            url_list: [location.origin + "/media/" + id],
            data_size: 327680,
            width: 1080,
            height: 1920,
          },
        },
      });
      if (m.type === "GET_SELF_PROFILE")
        payload = {
          ok: true,
          json: {
            user: {
              uid: "self",
              sec_uid: "sec",
              nickname: "测试账号",
              following_count: 123,
              favoriting_count:
                24 +
                JSON.parse(localStorage.getItem("extra-liked-ids") || "[]")
                  .length,
            },
          },
        };
      if (m.type === "FETCH_LIKED_PAGE") {
        window.likedPageRequests = (window.likedPageRequests || 0) + 1;
        const ids = localStorage.getItem("ui-small-list")
          ? [700, 1]
          : [
              ...JSON.parse(localStorage.getItem("extra-liked-ids") || "[]"),
              ...Array.from({ length: 24 }, (_, i) => i + 1),
            ];
        const start = Number(m.payload.maxCursor || 0),
          n = Math.min(18, ids.length - start);
        payload = {
          ok: true,
          awemeList: ids.slice(start, start + n).map(aweme),
          hasMore: start + n < ids.length,
          maxCursor: start + n < ids.length ? start + n : 0,
          minCursor: 0,
        };
      }
      if (m.type === "FETCH_BOOKMARKED_PAGE")
        payload = {
          ok: true,
          awemeList: [aweme(1), aweme(2)],
          hasMore: false,
          cursor: 0,
        };
      if (m.type === "FETCH_AWEME_DETAIL")
        payload = { ok: true, aweme: aweme(m.payload.awemeId) };
      if (m.type === "FETCH_FOLLOWING_PAGE") {
        window.followingPageRequests = (window.followingPageRequests || 0) + 1;
        const offset = m.payload.offset || 0;
        payload = {
          ok: true,
          users: Array.from({ length: Math.min(20, 123 - offset) }, (_, i) => ({
            uid: String(offset + i),
            sec_uid: "sec-" + (offset + i),
            nickname: "作者 " + (offset + i),
            aweme_count: 3,
          })),
          hasMore: offset + 20 < 123,
          offset: Math.min(123, offset + 20),
          maxTime: 0,
          minTime: 0,
        };
      }
      if (m.type === "FETCH_AUTHOR_AWEME_PAGE")
        payload = {
          ok: true,
          awemeList: [aweme(1), aweme(30)],
          hasMore: false,
          maxCursor: 0,
        };
      window.postMessage(
        {
          source: "douyin-toolkit-page",
          requestId: m.requestId,
          type: m.type,
          payload: payload || { ok: false, error: "unknown synthetic request" },
        },
        "*",
      );
    });
  });
  await page.goto(base + "/src/sidebar/index.html");
  assert.ok(
    await page
      .locator("body")
      .evaluate((el) => el.classList.contains("collapsed")),
    "starts minimized",
  );
  await page.locator("#floating").hover();
  await page.locator("[data-quick=liked]").click();
  await page.getByText("请先选择并授权备份文件夹", { exact: true }).waitFor();
  await page.locator("[data-action=folder]").waitFor();
  assert.equal(await page.locator(".action:disabled").count(), 3);
  await page.evaluate(async () => {
    const { rememberDownloadTarget } = await import("/src/shared/download.js");
    const { Repository } = await import("/src/archive/repository.js");
    const handle = await navigator.storage.getDirectory();
    const target = { handle, kind: "filesystem" };
    const repo = await Repository.open(target);
    await repo.commit({
      owner: { uid: "self", nickname: "测试账号" },
      works: ["1", "2", "3", "900", "901"].map((id) => ({
        id,
        complete: true,
        legacy: true,
        sources: id === "1" ? ["liked", "bookmarked"] : ["liked"],
        files: [],
      })),
    });
    await rememberDownloadTarget(handle, "我的抖音备份");
  });

  await page.evaluate(async () => {
    const { Repository } = await import("/src/archive/repository.js");
    const { normalizeAweme } = await import("/src/shared/api.js");
    const handle = await navigator.storage.getDirectory();
    const r = await Repository.open({ kind: "filesystem", handle });
    const dir = await handle.getDirectoryHandle("data", { create: true });
    const old = await dir.getFileHandle("low.mp4", { create: true });
    const writer = await old.createWritable();
    const bytes = new Uint8Array(16);
    bytes.set(new TextEncoder().encode("0000ftypisom"));
    await writer.write(bytes);
    await writer.close();
    const raw = {
      aweme_id: "1",
      video: {
        play_addr: { url_list: ["https://test/low"], width: 720, height: 1280 },
      },
    };
    const partId = normalizeAweme(raw, 0, "liked").mediaParts[0].partId;
    await r.commit({
      works: [
        { ...r.state.works["1"], legacy: false, files: ["data/low.mp4"] },
      ],
      files: [
        {
          path: "data/low.mp4",
          workId: "1",
          partId,
          kind: "video",
          size: 16,
          complete: true,
          quality: { width: 720, height: 1280 },
          highest: { width: 1080, height: 1920 },
          qualityOutcome: "degraded",
        },
      ],
    });
  });
  await page.evaluate(() => localStorage.setItem("ui-small-list", "true"));
  await page.reload();
  await page.locator("#floating").click();
  await page.getByText("我的抖音备份", { exact: true }).waitFor();
  assert.equal(
    await page
      .locator(".metrics,.action-sub,.home-note,.task-strip,.eyebrow,h1")
      .count(),
    0,
    "homepage has only folder and download actions",
  );
  await page.screenshot({ path: output + "/minimal-home.png" });
  denyRetryMedia = true;
  await page.locator("[data-action=liked]").click();
  await page.getByText("候补重试 1 项", { exact: false }).waitFor({ timeout: 8000 });
  await page.waitForFunction(
    () => {
      const b = document.querySelector("[data-action=download]");
      return b && !b.disabled;
    },
    {},
    { timeout: 15000 },
  );
  const upgraded = await page.evaluate(async () => {
    const { Repository } = await import("/src/archive/repository.js");
    const handle = await navigator.storage.getDirectory();
    const r = await Repository.open({ kind: "filesystem", handle });
    const current = r.state.files[r.state.works["1"].files[0]];
    let oldExists = true;
    try {
      await (await handle.getDirectoryHandle("data")).getFileHandle("low.mp4");
    } catch (e) {
      if (e.name === "NotFoundError") oldExists = false;
      else throw e;
    }
    return {
      width: current.quality.width,
      complete: r.state.works["1"].complete,
      oldExists,
      unique: r.stats.unique,
    };
  });
  assert.equal(upgraded.width, 1080);
  assert.equal(upgraded.complete, true);
  assert.equal(upgraded.oldExists, false);
  assert.equal(upgraded.unique, 5);
  const beforeRetry = await page.evaluate(() => window.likedPageRequests);
  denyRetryMedia = false;
  await page.locator("[data-action=download]").click();
  await page.getByRole("heading", { name: "下载喜欢", exact: true }).waitFor();
  await page.getByText("本轮完成", { exact: true }).waitFor({ timeout: 10000 });
  assert.ok(
    (await page.evaluate(() => window.likedPageRequests)) > beforeRetry,
    "normal download scans from the first page again",
  );
  assert.equal(
    await page.locator(".task-controls + *").count(),
    0,
    "nothing is rendered below download controls",
  );
  assert.equal(
    await page
      .locator(
        "[data-action=retryFailures],[data-action=resume],.task-explanation,.pagination-diagnostics,.error-row",
      )
      .count(),
    0,
  );
  assert.equal(
    await page.locator('[data-metric="new-downloads"]').innerText(),
    "+1",
  );
  await page.screenshot({ path: output + "/douyin-v077-retry-complete.png" });
  console.log(
    "PASS focused UI: simple download repeats a full pass, skips best files, repairs missing media; no retry/start-over branches or diagnostics below controls",
  );
  const host = await page.context().newPage();
  await host.setViewportSize({width:390,height:760});
  await host.addInitScript(()=>{FileSystemHandle.prototype.queryPermission=async()=>"granted";});
  await host.route("**/src/injected.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "// no live network in fixture",
    }),
  );
  await host.goto(base + "/host.html");
  const frameElement = host.locator("#douyin-toolkit-sidebar");
  const floatingFrame = host.frameLocator("#douyin-toolkit-sidebar");
  await floatingFrame.locator("#floating").waitFor();
  assert.equal((await frameElement.boundingBox()).width, 60);
  const initialAnchor =
    (await frameElement.boundingBox()).x +
    (await frameElement.boundingBox()).width;
  await floatingFrame.locator("#floating").hover();
  await host.waitForFunction(
    () =>
      document.querySelector("iframe").getBoundingClientRect().width === 134,
  );
  assert.equal(
    (await frameElement.boundingBox()).x +
      (await frameElement.boundingBox()).width,
    initialAnchor,
    "main anchor stays fixed",
  );
  assert.equal(
    await floatingFrame.locator("#quickMenu button:visible").count(),
    3,
  );
  await host.waitForFunction(() =>
    [
      ...document
        .querySelector("iframe")
        .contentDocument.querySelectorAll("[data-quick]"),
    ].every((el) =>
      el.getAnimations().every((a) => a.playState === "finished"),
    ),
  );
  const bounds = await floatingFrame.locator("#quickMenu").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, width: innerWidth };
  });
  assert.ok(
    bounds.left >= 0 && bounds.right <= bounds.width,
    "all three shortcuts fit in actual iframe",
  );
  await floatingFrame.locator("#floatingProgress").evaluate((svg) => {
    svg.removeAttribute("hidden");
    svg.classList.add("indeterminate");
  });
  const centers = await floatingFrame
    .locator("#floatingProgress")
    .evaluate((svg) => {
      const animation = svg.getAnimations()[0];
      animation.pause();
      const button = document
        .querySelector("#floating")
        .getBoundingClientRect();
      return [0, 450, 900, 1350, 1799].map((time) => {
        animation.currentTime = time;
        const center = new DOMPoint(30, 30).matrixTransform(
          svg.querySelector(".ring-track").getScreenCTM(),
        );
        return {
          dx: center.x - (button.x + button.width / 2),
          dy: center.y - (button.y + button.height / 2),
        };
      });
    });
  for (const center of centers)
    assert.ok(
      Math.abs(center.dx) < 0.2 && Math.abs(center.dy) < 0.2,
      "progress ring stays concentric during the whole animation",
    );
  await floatingFrame
    .locator("#floatingProgress")
    .evaluate((svg) => svg.getAnimations()[0].play());
  await frameElement.screenshot({
    path: output + "/douyin-v077-ring-preview.png",
  });
  await host.mouse.move(20, 180);
  await host.waitForFunction(
    () => document.querySelector("iframe").getBoundingClientRect().width === 60,
  );
  await floatingFrame.locator("#floating").click();
  await floatingFrame.locator("[data-action=folder]").waitFor();
  await host.waitForFunction(
    () => document.querySelector("iframe").getBoundingClientRect().width >= 320,
  );
  assert.ok((await frameElement.boundingBox()).width >= 320);
  await host.waitForFunction(()=>{
    const r=document.querySelector('iframe').getBoundingClientRect();
    return r.y===0 && r.height===innerHeight && r.right===innerWidth;
  });
  for(const width of [320,390,1280]) {
    await host.setViewportSize({width,height:760});
    const bounds=await frameElement.boundingBox();
    assert.equal(bounds.height,760);
    assert.equal(Math.round(bounds.x+bounds.width),width);
    assert.ok(bounds.width<=width);
  }
  await host.setViewportSize({width:1280,height:800});
  await host.screenshot({path:output+'/sidebar-in-page.png'});
  await host.setViewportSize({width:390,height:760});
  await frameElement.screenshot({path:output+'/sidebar-home.png'});
  await floatingFrame.locator("#collapseBtn").click();
  await host.waitForFunction(
    () => document.querySelector("iframe").getBoundingClientRect().width === 60,
  );
  await floatingFrame.locator("#floating").hover();
  const bubble = await floatingFrame.locator("#floating").boundingBox();
  await host.mouse.move(
    bubble.x + bubble.width / 2,
    bubble.y + bubble.height / 2,
  );
  await host.mouse.down();
  await host.mouse.move(38, 700, { steps: 12 });
  await host.mouse.up();
  await host.waitForFunction(
    () => parseFloat(document.querySelector("iframe").style.top) > 600,
  );
  assert.equal(
    await frameElement.getAttribute("data-collapsed"),
    "true",
    "drag does not open the panel",
  );
  await host.mouse.move(220, 400);
  await floatingFrame.locator("#floating").hover();
  await floatingFrame.locator("[data-quick=following]").waitFor();
  const orbit = await floatingFrame.locator("#quickMenu").evaluate(() =>
    [...document.querySelectorAll("[data-quick]")].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        w: innerWidth,
        h: innerHeight,
      };
    }),
  );
  for (const box of orbit)
    assert.ok(
      box.x >= 0 && box.y >= 0 && box.right <= box.w && box.bottom <= box.h,
      "radial buttons fit after dragging to opposite corner",
    );
  await host.screenshot({ path: output + "/douyin-v076-dragged-radial.png" });
  await floatingFrame.locator("#floatingClose").click();
  await frameElement.waitFor({ state: "hidden" });
  assert.equal(
    await frameElement.count(),
    1,
    "close hides frame without losing saved state",
  );
  await host.close();
  await page.evaluate(async()=>{
    const {Repository}=await import('/src/archive/repository.js');
    const r=await Repository.open({kind:'filesystem',handle:await navigator.storage.getDirectory()});
    const task=structuredClone(r.latestTask('liked'));
    task.id='persistent-pause';task.createdAt=new Date(Date.now()+1000).toISOString();
    task.status='paused';task.sourceErrors=['文件夹授权已失效'];
    await r.commit({tasks:[task]});
  });
  await page.reload();
  await page.locator('#floating').click();
  await page.locator('.task-problem').getByText('备份文件夹暂不可用。请连接磁盘，重新选择并授权原文件夹。').waitFor();
  assert.equal(await page.locator('.task-problem [data-action="folder"]').count(),1);
  await page.screenshot({path:output+'/persistent-pause.png'});
  await page.locator('#menuBtn').click();
  await page.getByRole('heading',{name:'本地资料库',exact:true}).waitFor();
  assert.ok((await page.locator('.library-location').innerText()).includes('本地库.html'));
  assert.deepEqual(errors, []);
  console.log(
    "PASS focused UI: concentric ring at five animation phases, radial bounds, drag, close; screenshots " +
      output,
  );
} finally {
  await browser.close();
  server.close();
}
