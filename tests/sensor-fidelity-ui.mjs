import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.chartMarks = [];
    for (const name of ['arc', 'fillRect', 'stroke', 'fillText']) {
      const original = CanvasRenderingContext2D.prototype[name];
      CanvasRenderingContext2D.prototype[name] = function (...args) {
        if (this.canvas.getAttribute('aria-label') === 'Drone confidence over the last 60 seconds') {
          window.chartMarks.push({ name, args, cap: this.lineCap, join: this.lineJoin, width: this.lineWidth });
          if (window.chartMarks.length > 500) window.chartMarks.shift();
        }
        return original.apply(this, args);
      };
    }
  });
  await page.goto(process.env.UI_BASE_URL ?? 'http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => Object.keys(b).some(k => k.startsWith('__reactProps$'))));
  await page.getByRole('button', { name: 'Enable microphone & join' }).click();
  const sensor = page.getByRole('region', { name: 'SkyMesh sensor window' });
  await sensor.waitFor({ timeout: 60000 });
  await page.waitForFunction(() => window.chartMarks.some(m => m.name === 'fillRect'), null, { timeout: 60000 });
  const marks = await page.evaluate(() => window.chartMarks);
  assert(!marks.some(m => m.name === 'arc'), 'Terminal chart must not draw circular endpoints');
  assert(marks.some(m => m.name === 'fillRect' && m.args[2] === 2 && m.args[3] === 2), 'History uses terminal-sized dots');
  assert(marks.some(m => m.name === 'stroke' && m.cap === 'butt' && m.join === 'miter' && m.width === 1));
  for (const label of ['100%', '0%', '60s', '0s']) assert(marks.some(m => m.name === 'fillText' && m.args[0] === label));
  assert(!marks.some(m => m.name === 'fillRect' && m.args[2] === 6), 'No oversized endpoint');
  assert.equal(await page.locator('fieldset').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(16, 18, 22)');
  if (process.env.JCODE_SCRATCH_DIR) await page.screenshot({ path: `${process.env.JCODE_SCRATCH_DIR}/bottom-sensor.png`, fullPage: true });
  await sensor.focus();
  assert.equal(await sensor.evaluate(e => getComputedStyle(e).outlineStyle), 'none');
  for (const width of [1440, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ['Monitor', 'Mesh', 'Diagnostics']) {
      await page.getByRole('tab', { name, exact: true }).click();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  await page.getByRole('tab', { name: 'Monitor', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  const mesh = page.getByRole('tab', { name: 'Mesh', exact: true });
  assert.equal(await mesh.getAttribute('aria-selected'), 'true');
  assert.equal(await mesh.evaluate(e => getComputedStyle(e).outlineStyle), 'dotted');
  await page.getByRole('button', { name: 'Minimize sensor window' }).click();
  await sensor.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Open sensor dashboard' }).click();
  await sensor.waitFor();
  await page.getByRole('button', { name: 'Close sensor window', exact: true }).click();
  await sensor.waitFor({ state: 'hidden' });
  console.log('PASS: bottom dotted trace, terminal axes and palette, window/control focus, four viewport widths, tabs, minimize/restore and close');
} finally { await browser.close(); }
