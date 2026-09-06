import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:3112';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [width, height] of [[1920,1080],[1440,900],[1366,768],[1280,720],[1024,768],[1000,650],[390,844]]) {
    await page.setViewportSize({width,height});
    await page.goto(`${base}/station?session=all-boxes-review`);
    await page.locator('.fit-board').waitFor({state:'visible'});
    await page.waitForTimeout(250);
    assert.equal(await page.getByRole('combobox',{name:'Console panel'}).count(),0);
    assert.equal(await page.locator('.page-controls').count(),0);
    assert.equal(await page.locator('.console').evaluate(root => {
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
      let text; let count=0;
      while(text=walker.nextNode()) if(text.textContent.trim() && !text.parentElement.closest('.panel')) count++;
      return count;
    }),0,'all console text belongs to a box');
    for (const section of ['confidence','topology','scenario','activity','links','nodes','inspector']) {
      assert(await page.locator(`[data-section=${section}]`).isVisible(),`${section} is rendered simultaneously`);
    }
    assert(await page.locator('.join-card svg').isVisible());
    assert(await page.locator('.audio-card canvas').isVisible());
    const overflow = await page.evaluate(() => {
      const outside=[...document.querySelectorAll('.fit-board .panel, .fit-board button, .fit-board canvas, .fit-board svg, .fit-board td')].filter(el=>{
        const r=el.getBoundingClientRect();
        return r.width && r.height && (r.bottom>innerHeight+1 || r.right>innerWidth+1 || r.left< -1 || r.top<47);
      }).map(el=>el.tagName+':'+(el.textContent||'').slice(0,40));
      return {width:document.documentElement.scrollWidth-innerWidth,height:document.documentElement.scrollHeight-innerHeight,outside};
    });
    assert.deepEqual(overflow,{width:0,height:0,outside:[]},`${width}x${height}: ${JSON.stringify(overflow)}`);
    console.log(`PASS ${width}x${height}: all 7 panels, map, QR and drone simultaneously visible, no pagination or clipped bounds`);
  }
} finally {await browser.close();}
