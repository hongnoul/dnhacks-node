// Run against a production server: THEME_TEST_URL=http://localhost:3198 node tests/retro-theme.browser.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.THEME_TEST_URL ?? 'http://localhost:3198';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/station?session=theme-review`);
  await page.locator('.leaflet-container').waitFor();
  const color = (selector, property) => page.locator(selector).first().evaluate((el, key) => getComputedStyle(el)[key], property);
  assert.equal(await color('main', 'backgroundColor'), 'rgb(170, 170, 170)');
  assert.equal(await color('.panel', 'backgroundColor'), 'rgb(222, 222, 222)');
  assert.equal(await color('.retro-console-header', 'backgroundColor'), 'rgb(0, 0, 128)');
  assert.equal(await color('.map-viewport', 'color'), 'rgb(244, 244, 244)');
  assert.equal(await color('.panel', 'borderTopStyle'), 'solid');
  assert.equal(await color('.panel', 'borderTopWidth'), '2px');
  assert.equal(await color('.panel', 'borderRadius'), '0px');
  assert.notEqual(await color('.panel', 'borderTopColor'), await color('.panel', 'borderBottomColor'));
  assert.match(await color('main', 'fontFamily'), /Arial/);
  assert.match(await color('.metric strong', 'fontFamily'), /Courier New/);
  assert.equal(await color('.map-viewport', 'backgroundColor'), 'rgb(22, 22, 22)');
  assert.equal(await color('.geographic-map', 'filter'), 'none');
  assert.equal(await page.locator('.retro-console').evaluate(el => getComputedStyle(el).getPropertyValue('--hot').trim()), '#a01f0f');
  assert.equal(await page.locator('.retro-console').evaluate(el => getComputedStyle(el).getPropertyValue('--ok').trim()), '#135c35');
  assert.equal(await page.locator('.retro-console').evaluate(el => getComputedStyle(el).getPropertyValue('--warn').trim()), '#705000');
  assert.equal(await page.locator('.join-card svg').isVisible(), true);
  await page.getByRole('button', { name: 'Link participants', exact: true }).click();
  await page.mouse.move(0, 0);
  assert.equal(await color('.cds--btn--primary', 'backgroundColor'), 'rgb(0, 0, 128)');
  await page.getByRole('button', { name: 'Done linking', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Participant to place' }).isDisabled(), true);
  await page.getByRole('link', { name: 'Scenarios', exact: true }).click();
  assert.equal(new URL(page.url()).hash, '#scenarios');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').evaluate(el => getComputedStyle(el).outlineStyle), 'dotted');
  for (const width of [1440, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`);
    assert.equal(await page.locator('.retro-console-header').isVisible(), true);
  }
  if (process.env.THEME_SCREENSHOT) await page.screenshot({ path: process.env.THEME_SCREENSHOT, fullPage: true });
  await page.goto(`${base}/admin?session=theme-review`);
  await page.waitForURL(url => url.pathname.replace(/\/$/, '') === '/station' && url.searchParams.get('session') === 'theme-review');
  await page.goto(base);
  assert.equal(await page.getByRole('heading', { name: 'Welcome to SkyMesh P2P' }).isVisible(), true);
  assert.equal(await color('[data-join-panel]', 'backgroundColor'), 'rgb(222, 222, 222)');
  assert.equal(await page.locator('.retro-console').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Retro theme acceptance passed: palette, map, linking, disabled control, keyboard focus, navigation, responsive widths, session redirect, landing isolation.');
} finally {
  await browser.close();
}
