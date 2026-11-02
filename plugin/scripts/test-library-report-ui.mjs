import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildReportModel,
  renderLibraryReport,
} from "../src/archive/report.js";
const require = createRequire(import.meta.url),
  { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-report-ui-"));
const state = {
  works: {},
  files: {},
  tasks: {
    task: {
      id: "task",
      scope: "liked",
      accountUid: "self",
      createdAt: "2026-10-28T01:00:00Z",
      status: "paused",
      sourceDone: false,
      sourceErrors: [],
      platformTotal: 190,
      items: {
        9001: {
          id: "9001",
          scope: "liked",
          state: "failed",
          error: "媒体请求失败：HTTP 429",
        },
        9002: {
          id: "9002",
          scope: "liked",
          state: "failed",
          error: "媒体请求失败：HTTP 403",
        },
        9003: {
          id: "9003",
          scope: "liked",
          state: "retry_wait",
          retryAt: Date.now() + 60000,
        },
      },
    },
  },
};
for (let i = 1; i <= 201; i++) {
  const id = String(i),
    file = `data/媒体/${id}/video.mp4`;
  state.works[id] = {
    id,
    complete: true,
    desc:
      i === 1
        ? 'XSS test </script><img src=x onerror="window.pwned=1">'
        : `珍藏作品 ${i}`,
    authorName: `作者 ${i % 10}`,
    sources: i % 2 === 0 ? ["liked", "bookmarked"] : ["following"],
    files: [file],
  };
  state.files[file] = {
    path: file,
    workId: id,
    partId: "video-1",
    kind: "video",
    complete: true,
    size: 1024,
    quality: { width: 1080, height: 1920, codec: "h265" },
    highest: {
      width: i % 3 === 0 ? 2160 : 1080,
      height: i % 3 === 0 ? 3840 : 1920,
    },
    qualityOutcome: i % 3 === 0 ? "degraded" : "best",
    fallbackReason: i % 3 === 0 ? "HTTP 403" : "",
  };
}
const model = buildReportModel(state, { folderLabel: "我的抖音备份" }),
  file = path.join(output, "本地库.html");
await fs.writeFile(file, renderLibraryReport(model));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_EXECUTABLE
    ? { executablePath: process.env.CHROME_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(pathToFileURL(file).href);
  await page.locator(".work-row").first().waitFor();
  assert.equal(await page.locator(".work-row").count(), 50);
  assert.match(await page.locator("#count").innerText(), /204/);
  await page.screenshot({ path: path.join(output, "overview.png") });
  await page.locator('[data-scope="bookmarked"]').click();
  assert.match(await page.locator("#count").innerText(), /100/);
  await page.locator("#next").click();
  assert.equal(await page.locator(".work-row").count(), 50);
  await page.locator("#reset").click();
  await page.locator("#search").fill("XSS test");
  assert.equal(await page.locator(".work-row").count(), 1);
  assert.equal(await page.locator(".work-title img").count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await page.locator(".details-toggle").click();
  assert.ok(await page.locator(".file-path a").first().getAttribute("href"));
  await page.locator("#reset").click();
  await page.locator("#quality").selectOption("degraded");
  assert.match(await page.locator("#count").innerText(), /67/);
  assert.ok(
    (await page.locator(".quality").allTextContents()).every((t) =>
      t.includes("已降级"),
    ),
  );
  await page.locator("[data-issue]").first().click();
  assert.equal(await page.locator(".work-row").count(), 2);
  assert.match(await page.locator("#rows").innerText(), /HTTP 429/);
  assert.match(await page.locator("#rows").innerText(), /HTTP 403/);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#csv").click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /\.csv$/);
  await download.saveAs(path.join(output, "filtered.csv"));
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "report has no overflow at " + width,
    );
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, "mobile.png") });
  assert.deepEqual(errors, []);
  if (process.env.REAL_REPORT) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(pathToFileURL(process.env.REAL_REPORT).href);
    await page.locator(".work-row").first().waitFor();
    assert.equal(await page.locator(".work-row").count(), 50);
    await page.screenshot({ path: path.join(output, "real-overview.png") });
    assert.deepEqual(errors, []);
  }
  console.log(
    "OK: offline report — 204 rows with 50-row pagination, multi-source filtering, status/quality/search, details, local links, CSV, XSS and responsive layout. Screenshots: " +
      output,
  );
} finally {
  await browser.close();
}
