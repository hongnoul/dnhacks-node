// UI_BASE_URL=http://localhost:3107 node tests/join-ui.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.UI_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  for (const width of [1440, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base);
    const title = page.getByRole('heading', { name: 'Welcome to SkyMesh' });
    await title.waitFor();
    assert.equal(await title.evaluate(e => getComputedStyle(e).fontStyle), 'italic');
    assert.equal(await title.evaluate(e => getComputedStyle(e).color), 'rgb(0, 0, 207)');
    assert.equal(await page.locator('section').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(222, 222, 222)');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const logo = page.getByRole('img', { name: 'SkyMesh robot logo in ASCII art' });
    assert(await logo.isVisible());
    const centered = await logo.evaluate(e => {
      const a=e.getBoundingClientRect(), b=e.parentElement.getBoundingClientRect();
      return {dx:Math.abs(a.x+a.width/2-b.x-b.width/2),dy:Math.abs(a.y+a.height/2-b.y-b.height/2),children:e.parentElement.children.length};
    });
    assert(centered.dx<1 && centered.dy<1, 'ASCII art must center within its own media container');
    assert.equal(centered.children,1, 'Media container contains only ASCII art');
    assert.match(await logo.textContent(), /^[ #+.\n-]+$/);
    assert((await logo.textContent()).split('\n').length >= 20);
    const button = page.getByRole('button', { name: 'Enable microphone & join' });
    assert((await button.boundingBox()).height >= 48);
    assert.equal(await button.evaluate(e => getComputedStyle(e).borderRadius), '0px');
    assert.equal(await button.evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(192, 192, 192)');
    await page.keyboard.press('Tab');
    assert(await button.evaluate(e => e === document.activeElement));
    assert.equal(await button.evaluate(e => getComputedStyle(e).outlineStyle), 'dotted');
    await button.hover();
    assert.equal(await button.evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(192, 192, 192)');
    assert.equal(await button.evaluate(e => getComputedStyle(e).borderTopColor), 'rgb(255, 255, 255)');
    assert.equal(await button.evaluate(e => getComputedStyle(e).borderBottomColor), 'rgb(52, 52, 52)');
    assert.equal(await button.evaluate(e => getComputedStyle(e).transitionDuration), '0s');
    await page.mouse.down();
    assert.equal(await button.evaluate(e => getComputedStyle(e).borderTopColor), 'rgb(52, 52, 52)');
    await page.mouse.move(0, 0);
    await page.mouse.up();
    if (process.env.JCODE_SCRATCH_DIR) await page.screenshot({ path: `${process.env.JCODE_SCRATCH_DIR}/join-${width}.png`, fullPage: true });
  }
  // Hold model loading to verify a single disabled action, then simulate failure.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/drone_crnn.onnx', async route => { await held; await route.abort(); });
  await page.getByRole('button', { name: 'Enable microphone & join' }).click();
  const preparing = page.getByRole('button', { name: 'Preparing your sensor…' });
  await preparing.waitFor();
  assert(await preparing.isDisabled());
  assert.equal(await page.locator('section').getAttribute('aria-busy'), 'true');
  release();
  await page.getByText(/Detector unavailable:/).waitFor({ timeout: 30000 });
  assert(await page.getByRole('heading', { name: /^Node / }).isVisible());
  assert.equal(await page.getByRole('img', { name: 'SkyMesh robot logo in ASCII art' }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: four responsive sizes, ASCII logo, classic hover and pressed bevel, retro colors, keyboard focus, loading state, and failed-detector join fallback.');
} finally { await browser.close(); }
