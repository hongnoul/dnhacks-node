import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:3107';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(`${base}/station?session=ui-review`);
    await page.getByRole('heading', { name: 'Shared airspace awareness' }).waitFor();
    await page.getByText(`${new URL(base).origin}/?session=ui-review`, { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Drone audio demo' }).count(), 1);
    assert.equal(await page.getByText('Simulation', { exact: true }).count(), 1);
    assert.equal(await page.locator('.metric').count(), 4);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `station overflow at ${width}`);
    const columns = await page.locator('.dashboard-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    assert.equal(columns, width > 1200 ? 2 : 1);
    await page.getByRole('button', { name: 'show', exact: true }).click();
    await page.getByRole('button', { name: 'hide', exact: true }).waitFor();
    await page.goto(`${base}/?session=ui-review`);
    await page.getByRole('heading', { name: 'Join SkyMesh' }).waitFor();
    assert.equal(await page.locator('.join-steps li').count(), 3);
    assert(await page.getByRole('button', { name: 'Enable microphone & join' }).isEnabled());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `phone overflow at ${width}`);
    console.log(`PASS desktop/phone layout and controls at ${width}px`);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
