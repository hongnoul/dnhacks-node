import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const base = process.env.APP_URL ?? 'http://127.0.0.1:3027';
const output = process.env.JCODE_SCRATCH_DIR;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const style = (locator, properties) => locator.evaluate((element, names) => {
    const css = getComputedStyle(element);
    return Object.fromEntries(names.map(name => [name, css[name]]));
  }, properties);
  async function checkViewer(scope) {
    const explorer = scope.getByRole('region', { name: 'Hardware explorer' });
    await explorer.locator('canvas').waitFor();
    await explorer.locator('[role="status"]').waitFor({ state: 'detached' });
    const grid = explorer.locator('canvas').locator('../..');
    assert.equal((await grid.textContent()).trim(), '', 'model grid has no text overlays');
    assert.equal(await explorer.getByText(/SM-01|100 mm|proportions illustrative/).count(), 0);
    assert.equal(await explorer.locator('fieldset legend').allTextContents().then(values => values.join(',')), 'Components,Details');
    const front = explorer.getByRole('button', { name: 'Front', exact: true });
    await front.click();
    assert.equal(await front.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await style(front, ['borderRadius', 'fontSize', 'transitionDuration', 'borderTopColor']), {
      borderRadius: '0px', fontSize: '12px', transitionDuration: '0s', borderTopColor: 'rgb(128, 128, 128)',
    });
    assert((await front.boundingBox()).height <= 32, 'desktop toolbar is compact');
    const selected = explorer.getByRole('button', { name: 'Acoustic array', exact: true });
    await selected.hover();
    assert.equal((await style(selected, ['backgroundColor'])).backgroundColor, 'rgb(0, 0, 128)', 'selected row stays navy on hover');
    await page.keyboard.press('Tab');
    await selected.focus();
    assert.equal((await style(selected, ['outlineStyle'])).outlineStyle, 'dotted');
    await explorer.getByRole('button', { name: 'Radio antenna', exact: true }).click();
    assert(await explorer.getByText(/Proposed LoRa/).isVisible());
    await explorer.getByRole('button', { name: 'Reset view' }).click();
    assert.equal(await explorer.getByRole('button', { name: 'Perspective', exact: true }).getAttribute('aria-pressed'), 'true');
  }
  await page.goto(`${base}/hardware/`);
  await checkViewer(page);
  if (output) await page.getByRole('region', { name: 'Hardware explorer' }).screenshot({ path: `${output}/retro-hardware-page.png` });
  await page.goto(`${base}/station/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Hardware reference', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: /Hardware Viewer/ });
  await checkViewer(dialog);
  assert((await dialog.locator('header').boundingBox()).height <= 32, 'classic compact titlebar');
  if (output) await dialog.screenshot({ path: `${output}/retro-hardware-dialog.png` });
  await page.keyboard.press('Escape');

  // Keep the icon test independent of physical microphone permission.
  await page.route('**/drone_crnn.onnx', route => route.abort());
  await page.goto(`${base}/?session=retro-hardware-check`);
  await page.getByRole('button', { name: 'Enable microphone & join' }).click();
  await page.getByRole('region', { name: 'SkyMesh sensor window' }).waitFor();
  const icon = page.getByRole('button', { name: 'skymesh-node.glb', exact: true });
  const video = page.getByRole('button', { name: 'Open drone-demo.mp4', exact: true });
  const properties = ['fontFamily', 'fontSize', 'backgroundColor', 'borderStyle', 'cursor'];
  assert.deepEqual(await style(icon, properties), await style(video, properties), 'GLB shares existing desktop file chrome');
  assert.deepEqual(await style(icon.locator('span').first(), ['width', 'height', 'borderColor', 'boxShadow']), await style(video.locator('span').first(), ['width', 'height', 'borderColor', 'boxShadow']));
  assert.equal((await icon.locator('span').first().boundingBox()).width, 146);
  assert.equal((await style(icon, ['cursor'])).cursor, 'grab');
  if (output) await page.screenshot({ path: `${output}/retro-hardware-desktop.png`, fullPage: true });
  async function drag(dx, dy) {
    const box = await icon.boundingBox();
    const x = box.x + box.width / 2, y = box.y + 40;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 12 }); await page.mouse.up();
  }
  const before = await icon.boundingBox();
  await drag(110, 45);
  const after = await icon.boundingBox();
  assert(Math.abs(after.x - before.x - 110) < 2);
  assert(Math.abs(after.y - before.y - 45) < 2);
  assert.equal(await page.getByRole('dialog').count(), 0, 'dragging must not open the model');
  await icon.click();
  dialog = page.getByRole('dialog', { name: /Hardware Viewer/ });
  await checkViewer(dialog);
  await page.keyboard.press('Escape');
  assert(await icon.evaluate(element => element === document.activeElement));
  await drag(-2000, -2000);
  const bounded = await icon.boundingBox();
  assert(bounded.x >= 0 && bounded.y >= 0, 'icon remains inside desktop');
  await icon.focus(); await page.keyboard.press('Enter'); await dialog.waitFor();
  await page.keyboard.press('Escape');

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await icon.scrollIntoViewIfNeeded();
    assert.equal((await style(icon, ['position'])).position, 'relative');
    assert.equal((await icon.locator('span').first().boundingBox()).width, 80);
    assert(await icon.evaluate(element => ['none', '0px', '0px 0px'].includes(getComputedStyle(element).translate)), 'resize resets desktop drag offset');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await icon.click(); await dialog.waitFor();
    assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth));
    assert((await dialog.getByRole('button', { name: 'Front', exact: true }).boundingBox()).height >= 44);
    if (output) await dialog.screenshot({ path: `${output}/retro-hardware-mobile-${width}.png` });
    await page.getByRole('button', { name: 'Close hardware viewer' }).click();
  }
  assert.match(page.url(), /session=retro-hardware-check/);
  assert.deepEqual(errors, []);
  console.log('PASS: text-free grid, classic group boxes and compact controls across page/station/sensor, navy selection, dotted focus, shared 146px/80px GLB file styling, exact drag displacement, no drag-open, bounds, keyboard open, focus restore, mobile reflow and touch targets.');
} finally { await browser.close(); }
