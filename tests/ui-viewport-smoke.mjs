import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:8128';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [width,height] of [[1920,1080],[1440,900],[1366,768],[1280,720],[1024,768],[1000,650],[768,900],[390,844],[320,720]]) {
    await page.setViewportSize({width,height});
    await page.goto(`${base}/station/?session=layout-${Date.now()}`);
    await page.locator('.unified-console .map-card').waitFor();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.fit-board').count(),0,'no scaled all-boxes board');
    assert.equal(await page.getByRole('link',{name:'Simulation',exact:true}).count(),0,'no separate simulation workspace');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),'no horizontal overflow');
    const map = await page.locator('.map-card').boundingBox();
    const sidebar = await page.locator('.dashboard-cards').boundingBox();
    const canvas = await page.locator('.map-card svg').boundingBox();
    if (width > 900) {
      assert(map.width > sidebar.width * 1.7,'map dominates desktop');
      assert(canvas.y >= 0 && canvas.y + canvas.height <= height,'whole room canvas visible');
    } else assert(map.y < sidebar.y,'map appears before supporting controls on mobile');
    assert.equal(await page.locator('.map-card [data-node-id]').count(),0,'no fake seed nodes');
    for (const section of ['confidence','topology','scenario','activity','links','nodes','inspector']) {
      await page.locator(`[data-section=${section}]`).scrollIntoViewIfNeeded();
      assert(await page.locator(`[data-section=${section}]`).isVisible());
    }
    console.log(`PASS ${width}x${height}: dominant participant map, accessible controls, no horizontal overflow or synthetic nodes`);
  }
} finally {await browser.close();}
