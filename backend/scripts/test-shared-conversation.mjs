import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";

// Execute the actual extension functions, not a second backend implementation.
const injected = await fs.readFile(new URL("../../plugin/src/injected.js", import.meta.url), "utf8");
const functions = injected.slice(0, injected.indexOf('window.addEventListener("message"'));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.route('https://www.douyin.com/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
  await page.goto('https://www.douyin.com/');
  await page.setContent(`<style>div { min-height:20px; } .conversationConversationItemwrapper { width:324px; height:67px; }
    .messageMessageListlist { width:500px; height:400px; overflow-y:auto; }</style>
    <div id="slidelist">Permanent home feed</div>
    <div id="imSaasContainerId"><div class="conversationConversationListwrapper">
    <div class="conversationConversationItemwrapper"><div class="conversationConversationItemtitle">王立志</div></div></div></div>`);
  await page.evaluate(() => {
    window.fixtureClicks = 0;
    document.querySelector('.conversationConversationItemwrapper').addEventListener('mousedown', () => {
      window.fixtureClicks++;
      setTimeout(() => {
        const list = document.createElement('div');
        list.className = 'messageMessageListlist';
        document.querySelector('#imSaasContainerId').append(list);
      }, 1000);
    }, { once: true });
  });
  await page.addScriptTag({ content: `${functions}\nwindow.fixtureApi = { scanSharedAwemeCards, openSharedCardAndProcess, sharedAwemeCards, sharedAwemeModal, conversationListTargets, activateConversation, waitForConversationScrollRoot, scanSharedConversation };` });
  assert.equal(await page.evaluate(() => window.fixtureApi.sharedAwemeModal() === null), true,
    'permanent home feed must not be treated as a modal');
  const result = await page.evaluate(async () => {
    const api = window.fixtureApi;
    const targets = api.conversationListTargets('王立志');
    api.activateConversation(targets[0]);
    const root = await api.waitForConversationScrollRoot(2500);
    return { matches: targets.length, activated: window.fixtureClicks, rootClass: root?.className };
  });
  assert.deepEqual(result, { matches: 1, activated: 1, rootClass: 'messageMessageListlist' });
  const cardResult = await page.evaluate(() => {
    const list = document.querySelector('.messageMessageListlist');
    list.innerHTML = '<div data-e2e="msg-item-content"><div class="MessageItemShareAwemecontainer">shared video</div></div>';
    let opened = false;
    list.querySelector('.MessageItemShareAwemecontainer').addEventListener('click', () => { opened = true; });
    const cards = window.fixtureApi.sharedAwemeCards(list);
    cards[0].click();
    return { count: cards.length, opened };
  });
  assert.deepEqual(cardResult, { count: 1, opened: true }, 'click must reach the inner share card handler');
  const processed = await page.evaluate(async () => {
    const card = document.querySelector('.MessageItemShareAwemecontainer');
    card.innerHTML = '<div class="MessageItemShareAwemeplayIcon">Play</div>';
    card.__reactProps$fixture = { children: { props: { message: { parsedContent: { itemId: '7686022498153052409' } } } } };
    let clicks = 0;
    card.querySelector('.MessageItemShareAwemeplayIcon').onclick = () => {
      const modal = document.createElement('div');
      modal.dataset.e2e = 'modal-video-container';
      document.body.append(modal);
      setTimeout(() => {
        modal.innerHTML = '<div class="o7hAjQkB"><div class="gesnxrtb">Close</div></div><div data-e2e="feed-active-video" data-e2e-vid="7686022498153052409"><div data-e2e="video-player-digg" data-e2e-state="video-player-no-digged">Like</div></div>';
        modal.querySelector('.gesnxrtb').onclick = () => modal.remove();
        modal.querySelector('[data-e2e="video-player-digg"]').onclick = event => {
          clicks++;
          event.currentTarget.dataset.e2eState = 'video-player-is-digged';
        };
      }, 600);
    };
    const result = await window.fixtureApi.openSharedCardAndProcess(card, { likeMissing: true });
    return { result, clicks, closed: !window.fixtureApi.sharedAwemeModal() };
  });
  assert.deepEqual(processed, { result: { awemeId: '7686022498153052409', liked: 1, alreadyLiked: 0, likeState: 'video-player-is-digged' }, clicks: 1, closed: true });
  const replacedList = await page.evaluate(async () => {
    const list = document.querySelector('.messageMessageListlist');
    const ids = ['7686022498153052409', '7686022498153052410', '7686022498153052411'];
    const liked = new Set([ids[0], ids[1]]);
    let likeClicks = 0;
    const openingPositions = [];
    function rebuild() {
      list.replaceChildren();
      for (const id of ids) {
        const card = document.createElement('div');
        card.className = 'MessageItemShareAwemecontainer';
        card.__reactProps$fixture = { children: { props: { message: { parsedContent: { itemId: id } } } } };
        card.innerHTML = '<div class="MessageItemShareAwemeplayIcon">Play</div>';
        card.firstElementChild.onclick = () => {
          openingPositions.push(list.scrollTop);
          const modal = document.createElement('div');
          modal.dataset.e2e = 'modal-video-container';
          modal.innerHTML = `<div class="o7hAjQkB"><div class="gesnxrtb">Close</div></div><div data-e2e="feed-active-video" data-e2e-vid="${id}"><div data-e2e="video-player-digg" data-e2e-state="${liked.has(id) ? 'video-player-is-digged' : 'video-player-no-digged'}">Like</div></div>`;
          modal.querySelector('.gesnxrtb').onclick = () => { modal.remove(); rebuild(); list.scrollTop = 0; };
          modal.querySelector('[data-e2e="video-player-digg"]').onclick = event => {
            likeClicks++;
            liked.add(id);
            event.currentTarget.dataset.e2eState = 'video-player-is-digged';
          };
          document.body.append(modal);
        };
        list.append(card);
      }
      const spacer = document.createElement('div');
      spacer.style.height = '1000px';
      list.append(spacer);
    }
    rebuild();
    list.scrollTop = 300;
    const result = await window.fixtureApi.scanSharedAwemeCards(1, { likeMissing: true });
    return { ids: result.ids, liked: result.liked, alreadyLiked: result.alreadyLiked,
      failures: result.cardFailures, unknown: result.unknownLikeState, likeClicks, openingPositions };
  });
  assert.deepEqual(replacedList, { ids: ['7686022498153052409', '7686022498153052410', '7686022498153052411'],
    liked: 1, alreadyLiked: 2, failures: 0, unknown: 0, likeClicks: 1, openingPositions: [300, 300, 300] });
  console.log('PASS: actual plugin source selects class-only conversation, triggers mousedown, waits for async history, excludes home feed');
} finally { await browser.close(); }
