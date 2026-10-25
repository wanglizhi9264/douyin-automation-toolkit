import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'data', 'shared-conversation-probe');
await fs.mkdir(output, { recursive: true });
const source = await fs.readFile(new URL('../../plugin/src/injected.js', import.meta.url), 'utf8');
const functions = source.slice(0, source.indexOf('window.addEventListener("message"'));
const likeMissing = process.argv.includes('--like');
const maxPages = process.argv.includes('--full') ? 200 : 2;
const context = await chromium.launchPersistentContext(path.join(root, '.douyin-playwright-profile'), {
  channel: 'chrome', headless: false, viewport: { width: 1400, height: 950 }, locale: 'zh-CN',
});
const page = context.pages()[0] || await context.newPage();
try {
  await page.goto('https://www.douyin.com/jingxuan', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('Probe browser opened. Waiting for login if necessary (up to 10 minutes).');
  await page.waitForFunction(() => {
    const login = [...document.querySelectorAll('button')].some(e => e.textContent.trim() === '登录');
    return !login && [...document.querySelectorAll("[data-e2e='something-button']")].some(e => e.textContent.trim() === '消息');
  }, null, { timeout: 600000 });
  await page.evaluate(`${functions}\nwindow.sharedProbe = { scanSharedConversation, conversationRootDiagnostics }; void 0;`);
  await page.exposeFunction('reportShareProgress', async value => {
    console.log(JSON.stringify(value));
    await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify({
      mode: likeMissing ? 'like-missing' : 'read-only', updatedAt: new Date().toISOString(), ...value,
    }, null, 2));
  });
  await page.evaluate(() => window.addEventListener('message', event => {
    if (event.data?.source === 'douyin-toolkit-page' && event.data?.type === 'SHARED_SCAN_PROGRESS') {
      window.reportShareProgress(event.data.payload);
    }
  }));
  const result = await page.evaluate(({ maxPages, likeMissing }) => window.sharedProbe.scanSharedConversation('王立志', maxPages, likeMissing), { maxPages, likeMissing });
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ mode: likeMissing ? 'like-missing' : 'read-only', ...result }, null, 2));
  console.log(JSON.stringify({ ok: result.ok, found: result.awemeIds.length, pages: result.scannedPages,
    cardFailures: result.cardFailures, unknownLikeState: result.unknownLikeState, reachedHistoryStart: result.reachedHistoryStart }));
  if (result.cardFailures || result.unknownLikeState || (maxPages === 200 && !result.reachedHistoryStart)) process.exitCode = 1;
  await page.screenshot({ path: path.join(output, 'page.png') });
} catch (error) {
  const diagnostic = await page.evaluate(() => ({
    url: location.href,
    im: document.querySelector('#imSaasContainerId')?.outerHTML || null,
  })).catch(() => null);
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), diagnostic }, null, 2));
  await page.screenshot({ path: path.join(output, 'page.png') }).catch(() => {});
  console.error(String(error));
  process.exitCode = 1;
} finally { await context.close(); }
