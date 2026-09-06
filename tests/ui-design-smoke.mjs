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
    assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily.includes('monospace')), false);
    assert.equal(await page.locator('.metric strong').first().evaluate(el => getComputedStyle(el).fontFamily.includes('monospace')), true);
    assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(8, 15, 23)');
    assert(await page.locator('.console-sidebar svg').first().isVisible());
    assert(await page.locator('.console-sidebar canvas').isVisible());
    const map = await page.locator('.map-card svg').boundingBox();
    assert(map.width > 0 && map.height > 0, 'responsive map has visible area');
    const targets = await page.locator('button').evaluateAll(els => els.filter(el => el.getBoundingClientRect().height < 44).length);
    assert.equal(targets, 0, 'all operator button targets are at least 44px');
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
    const join = page.getByRole('button', { name: 'Enable microphone & join' });
    await join.focus();
    assert.equal(await join.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    assert.equal(await page.locator('.join-screen').innerText().then(t => t.includes('never your audio')), true);
    console.log(`PASS ${width}px: dark palette, font hierarchy, 44px targets, QR/drone visible, responsive map/cards, session URL, labels, onboarding and keyboard focus`);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
