// UI_BASE_URL=http://localhost:3198 node tests/apex-webkit-ui.mjs
// WebKit engine coverage is not physical iOS/Safari chrome validation.
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
const base = process.env.UI_BASE_URL ?? 'http://localhost:3000';
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const fits = async label => {
      const limit = page.viewportSize().width;
      const measured = await page.evaluate(limit => ({ width: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('main *')].filter(e => !e.closest('svg') && e.getBoundingClientRect().right > limit + 1).map(e => ({ tag: e.tagName, class: e.className, right: e.getBoundingClientRect().right })) }), limit);
      assert(measured.width <= limit, `${engine.name()}: ${label} horizontal overflow ${JSON.stringify(measured)}`);
    };
    // Synthetic enlarged-content stress: double computed text sizes without
    // shrinking tap targets. This is not an OS text-size or browser zoom test.
    const enlargeText = () => page.evaluate(() => {
      const items = [...document.querySelectorAll('main *')].filter(e =>
        [...e.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()) && !e.closest('svg, pre, canvas'));
      const sizes = items.map(e => [e, parseFloat(getComputedStyle(e).fontSize)]);
      for (const [e, size] of sizes) e.style.fontSize = `${size * 2}px`;
    });
    await page.goto(base);
    await page.getByRole('button', { name: 'Enable microphone & join' }).waitFor();
    await fits('join');
    await enlargeText();
    await fits('enlarged join');
    await page.getByRole('button', { name: 'Enable microphone & join' }).scrollIntoViewIfNeeded();
    // Exercise loading and relay fallback through the real route/action.
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/drone_crnn.onnx', async route => { await held; await route.abort(); });
    await page.reload();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => Object.keys(b).some(k => k.startsWith('__reactProps$'))));
    await page.getByRole('button', { name: 'Enable microphone & join' }).tap();
    const preparing = page.getByRole('button', { name: 'Preparing your sensor…' });
    await preparing.waitFor();
    assert(await preparing.isDisabled());
    release();
    await page.getByText(/Detector unavailable:/).waitFor({ timeout: 60000 });
    const sensor = page.getByRole('region', { name: 'SkyMesh sensor window' });
    for (const [width, height] of [[320, 568], [390, 664], [390, 844], [844, 390]]) {
      await page.setViewportSize({ width, height });
      for (const tab of ['Monitor', 'Mesh', 'Diagnostics']) {
        await page.getByRole('tab', { name: tab, exact: true }).tap();
        await fits(`${width}x${height} ${tab}`);
      }
      await page.evaluate(() => scrollTo(0, 0));
      assert((await sensor.boundingBox()).y < 30);
      for (const [name, close] of [['Open skymesh-join.svg', 'Close QR image'], ['Open drone-demo.mp4', 'Close video viewer']]) {
        await page.getByRole('button', { name, exact: true }).tap();
        const box = await page.getByRole('dialog').boundingBox();
        assert(box.y >= 0 && box.y + box.height <= height + 1, `${engine.name()}: dialog fits height`);
        await page.getByRole('button', { name: close }).tap();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
      }
    }
    await page.setViewportSize({ width: 320, height: 568 });
    await page.getByRole('tab', { name: 'Monitor', exact: true }).tap();
    await enlargeText();
    await fits('enlarged sensor');
    await page.getByRole('button', { name: 'Minimize sensor window' }).tap();
    await sensor.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Open sensor dashboard' }).tap();
    await sensor.waitFor();
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine.name()}: four mobile viewports, all tabs, QR/video bounds, loading/failure, enlarged-content stress, minimize/restore.`);
  } finally { await browser.close(); }
}
