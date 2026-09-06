// Run against a running app: UI_BASE_URL=http://localhost:3016 node tests/carbon-ui.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  const base = process.env.UI_BASE_URL ?? 'http://localhost:3000';
  await page.goto(`${base}/station`);
  assert(await page.locator('html').evaluate(el => el.classList.contains('cds--g100')));
  assert.equal(await page.locator('.cds--label').first().evaluate(el => getComputedStyle(el).color), 'rgb(198, 198, 198)');
  for (const panel of ['confidence', 'topology', 'scenario', 'activity', 'links', 'nodes']) {
    await page.getByLabel('Console panel', { exact: true }).selectOption(panel);
    assert(await page.locator(`[data-section="${panel}"]`).isVisible(), `${panel} must be visible`);
  }
  await page.getByLabel('Console panel', { exact: true }).selectOption('scenario');
  await page.getByRole('button', { name: /simulate drone/ }).click();
  await page.getByRole('button', { name: /reset drone/ }).waitFor();
  await page.getByRole('button', { name: /reset drone/ }).click();
  await page.getByRole('button', { name: /simulate drone/ }).waitFor();
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['/station', '/']) {
      await page.goto(`${base}${route}`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} overflows at ${width}px`);
      if (route === '/') {
        const button = page.getByRole('button', { name: 'Enable microphone & join' });
        assert(await page.getByRole('heading', { name: 'Welcome to SkyMesh' }).isVisible());
        assert((await button.boundingBox()).height >= 44);
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('Carbon UI passed: dark tokens, all panel selections, drone mode toggle, four viewport sizes, phone touch target, no runtime errors.');
} finally {
  await browser.close();
}
