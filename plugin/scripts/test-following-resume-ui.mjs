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
  const page = await browser.newPage({ viewport: { width: 390, height: 760 } }),
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
              following_count: 2,
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
          users: Array.from({ length: Math.min(20, 2 - offset) }, (_, i) => ({
            uid: String(offset + i),
            sec_uid: "sec-" + (offset + i),
            nickname: "作者 " + (offset + i),
            aweme_count: 3,
          })),
          hasMore: offset + 20 < 2,
          offset: Math.min(2, offset + 20),
          maxTime: 0,
          minTime: 0,
        };
      }
      if (m.type === "FETCH_AUTHOR_AWEME_PAGE")
        payload = {
          ok: true,
          awemeList: (m.payload.secUid === "sec-0" ? [10, 11] : [20, 21]).map(
            aweme,
          ),
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

  await page.reload();
  await page.locator("#floating").click();
  await page.getByText("我的抖音备份", { exact: true }).waitFor();
  await page.locator("[data-action=following]").click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".author").length === 2 &&
      !document.querySelector("#selectAll").disabled,
    {},
    { timeout: 8000 },
  );
  await page.locator("#authorSearch").fill("secA");
  assert.equal(await page.locator(".author").count(),0);
  await page.locator("#authorSearch").fill("0");
  assert.equal(await page.locator(".author").count(),1);
  assert.ok((await page.locator(".author").innerText()).includes("UID 0"));
  await page.locator("#authorSearch").fill("");
  await page.locator("#selectAll").check();
  await page.locator("[data-action=startFollowing]").click();
  await page.locator(".transfer").first().waitFor({ timeout: 8000 });
  await page.locator('.title-row .status').getByText('下载中',{exact:true}).waitFor({timeout:8000});
  await page.locator('[data-action="home"]').click();
  const currentEntry = page.locator('[data-scope="following"]');
  assert.match(await currentEntry.innerText(), /关注 · /);
  assert.equal(await currentEntry.getAttribute('data-action'),'task');
  await currentEntry.click();
  await page.locator("[data-action=pause]").click();
  await page.getByText("已暂停", { exact: true }).waitFor();
  await page.reload();
  await page.locator("#floating").click();
  await page.getByText("我的抖音备份", { exact: true }).waitFor();
  await page.locator("[data-action=following]").click();
  await page.locator("[data-action=startFollowing]").waitFor({ timeout: 8000 });
  await page.waitForFunction(
    () => document.querySelectorAll(".author input:checked").length === 2,
    {},
    { timeout: 8000 },
  );
  await page.locator("#authorSearch").fill("作者 0");
  assert.equal(await page.locator(".author").count(),1);
  assert.ok((await page.locator(".select-all").innerText()).includes("全选搜索结果"));
  await page.locator("#authorSearch").fill("");
  await page.locator(".selection-state").getByText("已记住作者选择", {exact:false}).waitFor();
  await page.screenshot({ path: output + "/following-remembered.png" });
  await page.locator("[data-action=startFollowing]").click();
  await page.getByText("本轮完成", { exact: true }).waitFor({ timeout: 10000 });
  await page.locator(".following-current").waitFor();
  const snapshot = await page.evaluate(async () => {
    const { Repository } = await import("/src/archive/repository.js");
    const r = await Repository.open({
      kind: "filesystem",
      handle: await navigator.storage.getDirectory(),
    });
    const task = Object.values(r.state.tasks)
      .filter((t) => t.scope === "following")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return {
      chosen: r.state.followingSelection.authors.length,
      progress: task.authorProgress,
      continuing: task.run.continuingFollowing,
    };
  });
  assert.equal(snapshot.chosen, 2);
  assert.equal(snapshot.continuing, false);
  assert.equal(
    Object.values(snapshot.progress).filter((a) => a.status === "completed")
      .length,
    2,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS following UI: remembered selection after reload, same full-pass action, both authors complete; screenshots " +
      output,
  );
} finally {
  await browser.close();
  server.close();
}
