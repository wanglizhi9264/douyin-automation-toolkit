import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const root = path.resolve(import.meta.dirname, '..');
const source = await fs.readFile(new URL('../../plugin/src/injected.js', import.meta.url), 'utf8');
const functions = source.slice(0, source.indexOf('window.addEventListener("message"'));
const context = await chromium.launchPersistentContext(path.join(root, '.douyin-playwright-profile'), {
  channel:'chrome', headless:false, viewport:{width:1400,height:950}, locale:'zh-CN'
});
try {
  const page=context.pages()[0] || await context.newPage();
  await page.goto('https://www.douyin.com/jingxuan', {waitUntil:'domcontentloaded'});
  await page.locator('[data-e2e="something-button"]').filter({hasText:'消息'}).waitFor({timeout:60000});
  await page.evaluate(`${functions}\nwindow.scrollProbe={openMessageListAndFind,conversationListTargets,activateConversation,waitForConversationScrollRoot,conversationScrollRoot,sharedAwemeCards,sharedCardAwemeId}; void 0;`);
  await page.evaluate(async()=>{const p=window.scrollProbe;await p.openMessageListAndFind('王立志');p.activateConversation(p.conversationListTargets('王立志')[0]);await p.waitForConversationScrollRoot();});
  await page.waitForTimeout(2000);
  const rows=[];
  for(let i=0;i<18;i++) {
    const row=await page.evaluate(i=>{
      const p=window.scrollProbe,r=p.conversationScrollRoot();
      const info={i,top:r.scrollTop,height:r.scrollHeight,client:r.clientHeight,style:r.getAttribute('style'),direction:getComputedStyle(r).flexDirection,ids:p.sharedAwemeCards(r).map(p.sharedCardAwemeId),text:r.innerText.slice(0,120)};
      r.scrollTop=i===0?0:r.scrollTop+600;
      r.dispatchEvent(new Event('scroll',{bubbles:true}));
      info.immediate=r.scrollTop;
      return info;
    },i);
    rows.push(row);console.log(JSON.stringify(row));
    await page.waitForTimeout(1000);
  }
  await fs.writeFile(path.join(root,'data/shared-conversation-probe/scroll.json'),JSON.stringify(rows,null,2));
} finally {await context.close();}
