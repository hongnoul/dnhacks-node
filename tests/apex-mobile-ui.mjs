// UI_BASE_URL=http://localhost:3198 node tests/apex-mobile-ui.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.UI_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fits = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
  for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await page.goto(base);
    const join = page.getByRole('button', { name: 'Enable microphone & join' });
    await join.waitFor();
    await fits();
    const box = await join.boundingBox();
    assert(box.height >= 48);
    if (width <= 390) assert(box.y + box.height <= height, 'Join action visible on portrait phones');
    await join.scrollIntoViewIfNeeded();
    assert(await join.isVisible());
  }
  // Exercise the public failure path without requiring hardware permissions.
  await page.route('**/drone_crnn.onnx', route => route.abort());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/?session=mobile-acceptance`);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => Object.keys(b).some(k => k.startsWith('__reactProps$'))));
  await page.getByRole('button', { name: 'Enable microphone & join' }).tap();
  await page.getByText(/Detector unavailable:/).waitFor({ timeout: 60000 });
  const sensor = page.getByRole('region', { name: 'SkyMesh sensor window' });
  const node = await page.getByRole('heading', { name: /^Node / }).textContent();
  for (const [width, height] of [[320, 568], [390, 664], [390, 844], [844, 390], [800, 900]]) {
    await page.setViewportSize({ width, height });
    for (const tab of ['Monitor', 'Mesh', 'Diagnostics']) {
      await page.getByRole('tab', { name: tab, exact: true }).tap();
      await fits();
      assert.equal(await page.getByRole('heading', { name: /^Node / }).textContent(), node);
    }
    await page.evaluate(() => scrollTo(0, 0));
    assert((await sensor.boundingBox()).y < 30, 'Sensor starts at top, not below scattered icons');
    assert.equal(await sensor.locator('header').first().evaluate(e => getComputedStyle(e).touchAction), 'auto');
    const qr = page.getByRole('button', { name: 'Open skymesh-join.svg' });
    assert((await qr.boundingBox()).y >= (await sensor.boundingBox()).y + (await sensor.boundingBox()).height);
    await qr.tap();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const box = await dialog.boundingBox();
    assert(box.y >= 0 && box.y + box.height <= height + 1, 'Dialog fits resized viewport');
    assert.match(await dialog.getByRole('link').getAttribute('href'), /session=mobile-acceptance/);
    await page.getByRole('button', { name: 'Close QR image' }).tap();
    await dialog.waitFor({ state: 'hidden' });
    assert(await qr.evaluate(e => e === document.activeElement), 'Close restores launcher focus');
  }
  await page.setViewportSize({ width: 390, height: 664 });
  await page.getByRole('tab', { name: 'Monitor', exact: true }).tap();
  await page.getByRole('button', { name: 'Minimize sensor window' }).tap();
  await sensor.waitFor({ state: 'hidden' });
  const restore = page.getByRole('button', { name: 'Open sensor dashboard' });
  await restore.tap();
  await sensor.waitFor();
  assert.equal(await page.getByRole('heading', { name: /^Node / }).textContent(), node);
  // Actual touch gesture on the title bar must scroll, not drag the window.
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => scrollTo(0, 0));
  const before = await page.evaluate(() => scrollY);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 35 }] });
  for (let y = 35; y >= 0; y -= 5) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 100, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(y => scrollY > y, before);
  assert.equal(await sensor.evaluate(e => getComputedStyle(e).translate), 'none');
  if (process.env.JCODE_SCRATCH_DIR) await page.screenshot({ path: `${process.env.JCODE_SCRATCH_DIR}/apex-mobile.png`, fullPage: true });
  // Emulate nonzero CSS environment insets, not merely a notched device size.
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 44, bottom: 34, left: 0, right: 0 } });
  const padding = () => page.locator('main').evaluate(e => {
    const s = getComputedStyle(e);
    return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft];
  });
  assert.deepEqual(await padding(), ['44px', '12px', '34px', '12px']);
  await page.setViewportSize({ width: 844, height: 390 });
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 21, left: 44, right: 44 } });
  assert.deepEqual(await padding(), ['12px', '44px', '21px', '44px']);
  await page.getByRole('button', { name: 'Open skymesh-join.svg' }).tap();
  const safeDialog = await page.getByRole('dialog').boundingBox();
  assert(safeDialog.x >= 44 && safeDialog.x + safeDialog.width <= 800 && safeDialog.height <= 345);
  await page.getByRole('button', { name: 'Close QR image' }).tap();
  await page.setViewportSize({ width: 390, height: 844 });
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 44, bottom: 34, left: 0, right: 0 } });
  await page.goto(base);
  assert.deepEqual(await padding(), ['44px', '12px', '34px', '12px']);
  // Existing admin public boundary still forwards session context to station.
  await page.goto(`${base}/admin/?session=mobile-acceptance`);
  await page.waitForURL(url => /^\/station\/?$/.test(url.pathname) && url.searchParams.get('session') === 'mobile-acceptance');
  assert.deepEqual(errors, []);
  console.log('PASS: compact join, five sensor viewport sizes, all tabs, session-preserving QR, bounded dialogs, touch scrolling, minimize/restore, and admin redirect.');
} finally { await browser.close(); }
