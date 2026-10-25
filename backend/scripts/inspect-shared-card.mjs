import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'data/shared-conversation-probe');
const source = await fs.readFile(new URL('../../plugin/src/injected.js', import.meta.url), 'utf8');
const functions = source.slice(0, source.indexOf('window.addEventListener("message"'));
const context = await chromium.launchPersistentContext(path.join(root, '.douyin-playwright-profile'), {
  channel:'chrome', headless:false, viewport:{width:1400,height:950}, locale:'zh-CN'
});
const page=context.pages()[0] || await context.newPage();
const responses=[];
page.on('response',async response=>{if(response.url().includes('/aweme/detail')) {const json=await response.json().catch(()=> null); responses.push({path:new URL(response.url()).pathname,status:response.status(),statusCode:json?.status_code,count:json?.aweme_details?.length || 0});}});
try {
  await page.goto('https://www.douyin.com/jingxuan', {waitUntil:'domcontentloaded'});
  await page.locator('[data-e2e="something-button"]').filter({hasText:'消息'}).waitFor({state:'visible',timeout:60000});
  await page.evaluate(`${functions}\nwindow.cardProbe={openMessageListAndFind,conversationListTargets,activateConversation,waitForConversationScrollRoot}; void 0;`);
  await page.evaluate(async()=>{await window.cardProbe.openMessageListAndFind('王立志'); const targets=window.cardProbe.conversationListTargets('王立志'); if(!targets.length) throw new Error('No conversation list targets'); window.cardProbe.activateConversation(targets[0]); await window.cardProbe.waitForConversationScrollRoot();});
  await page.waitForTimeout(5000);
  const card=page.locator('.MessageItemShareAwemecontainer').filter({hasText:'Li十七呀'}).first();
  const before=await card.evaluate(el=>({html:el.outerHTML,parent:el.parentElement.outerHTML.slice(0,4000)}));
  await card.locator('.MessageItemShareAwemeplayIcon').click({force:true});
  await page.locator('[data-e2e="feed-active-video"]').waitFor({timeout:30000}).catch(()=>{});
  console.log('Open pages:', JSON.stringify(context.pages().map(p=>p.url())));
  const react = await card.evaluate(el=>{
    const rows=[];
    for(let node=el,depth=0;node && depth<6;node=node.parentElement,depth++) {
      for(const key of Object.keys(node).filter(k=>k.startsWith('__reactProps'))) {
        const seen=new WeakSet();
        rows.push({depth,props:JSON.stringify(node[key],(k,v)=>{
          if(typeof v==='function') return String(v).slice(0,500);
          if(v && typeof v==='object'){if(seen.has(v))return '[circular]';seen.add(v);}
          return v;
        }).slice(0,15000)});
      }
    }
    return rows;
  });
  const after=await page.evaluate(()=>({url:location.href,active:[...document.querySelectorAll('[data-e2e="feed-active-video"]')].map(e=>({id:e.getAttribute('data-e2e-vid'),html:e.outerHTML.slice(-6000)})),modal:[...document.querySelectorAll('[data-e2e="modal-video-container"]')].map(e=>e.outerHTML.slice(0,2500)),close:[...document.querySelectorAll('[aria-label],[title],[data-e2e]')].filter(e=>/close|关闭/i.test(`${e.getAttribute('aria-label')} ${e.getAttribute('title')} ${e.getAttribute('data-e2e')}`)).map(e=>e.outerHTML.slice(0,1000))}));
  after.closeGeometry=await page.locator('svg').evaluateAll(els=>els.filter(e=>{const r=e.getBoundingClientRect();return r.x>25 && r.x<90 && r.y>25 && r.y<90 && r.width>0;}).map(e=>e.parentElement.outerHTML.slice(0,2000)));
  await fs.writeFile(path.join(output,'card-inspection.json'),JSON.stringify({before,after,react,responses,pages:context.pages().map(p=>p.url())},null,2));
  await page.screenshot({path:path.join(output,'card.png')});
  console.log(JSON.stringify({url:after.url,active:after.active.map(e=>e.id),modal:after.modal.length,close:after.close}));
} catch(error) {
  await fs.writeFile(path.join(output,'card-failure.json'),JSON.stringify({error:String(error),url:page.url(),html:await page.locator('body').innerHTML()},null,2));
  await page.screenshot({path:path.join(output,'card-failure.png')});
  throw error;
} finally {await context.close();}
