import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:3107';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [width, height] of [[1440,900],[1366,768],[1280,720],[1024,768],[1000,650]]) {
    await page.setViewportSize({width,height});
    await page.goto(`${base}/station?session=viewport-review`);
    await page.getByRole('combobox', {name:'Console panel'}).waitFor();
    for (const panel of ['confidence','topology','scenario','activity','links','nodes']) {
      await page.getByRole('combobox', {name:'Console panel'}).selectOption(panel);
      if (panel === 'links') await page.getByRole('button',{name:'show',exact:true}).click();
      await page.waitForTimeout(100);
      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        const outside = [...document.querySelectorAll('.console button, .console select, .console canvas, .console svg, .console [data-section]')].filter(el => {
          const r=el.getBoundingClientRect();
          return r.width && r.height && (r.bottom > innerHeight + 1 || r.right > innerWidth + 1 || r.left < -1 || r.top < -1);
        }).map(el => el.tagName+':'+(el.textContent||'').slice(0,40));
        return {width:root.scrollWidth-innerWidth,height:root.scrollHeight-innerHeight,outside};
      });
      assert.deepEqual(overflow,{width:0,height:0,outside:[]},`${width}x${height} ${panel}: ${JSON.stringify(overflow)}`);
    }
    console.log(`PASS ${width}x${height}: all six panels fit with no page scrolling or clipped controls`);
  }
} finally { await browser.close(); }
