// UI_BASE_URL=http://localhost:3107 node tests/join-ui.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
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
    assert.equal(await page.locator('section').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(192, 192, 192)');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const logo = page.getByAltText('SkyMesh robot logo');
    assert(await logo.evaluate(e => e.complete && e.naturalWidth > 0));
    const button = page.getByRole('button', { name: 'Enable microphone & join' });
    assert((await button.boundingBox()).height >= 48);
    assert.equal(await button.evaluate(e => getComputedStyle(e).borderRadius), '0px');
    assert.equal(await button.evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(192, 192, 192)');
    await page.keyboard.press('Tab');
    assert(await button.evaluate(e => e === document.activeElement));
    assert.equal(await button.evaluate(e => getComputedStyle(e).outlineStyle), 'dotted');
    if (process.env.JCODE_SCRATCH_DIR) await page.screenshot({ path: `${process.env.JCODE_SCRATCH_DIR}/join-${width}.png`, fullPage: true });
  }
  const logoResponse = await page.request.get(`${base}/skymesh-logo.svg`);
  assert.equal(await logoResponse.text(), await readFile(new URL('../public/skymesh-logo.svg', import.meta.url), 'utf8'));
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
  assert.equal(await page.getByAltText('SkyMesh robot logo').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: four responsive sizes, exact SVG asset, retro colors, keyboard focus, loading state, and failed-detector join fallback.');
} finally { await browser.close(); }
