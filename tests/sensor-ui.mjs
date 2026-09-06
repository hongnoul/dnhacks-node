// UI_BASE_URL=http://localhost:3000 node tests/sensor-ui.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const base = process.env.UI_BASE_URL ?? 'http://localhost:3000';
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.sensorStreams = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await original(...args); window.sensorStreams.push(stream); return stream;
    };
    window.sensorSockets = [];
    const OriginalSocket = window.WebSocket;
    window.WebSocket = class extends OriginalSocket {
      constructor(...args) { super(...args); window.sensorSockets.push(this); }
    };
  });
  await page.goto(base);
  await page.getByRole('button', { name: 'Enable microphone & join' }).click();
  await page.getByRole('heading', { name: /^Node / }).waitFor({ timeout: 60000 });
  assert.equal(await page.getByText(/Detector unavailable:/).count(), 0, 'Real ONNX model must load');
  await page.waitForFunction(() => window.sensorStreams.length === 1);
  assert.equal(await page.getByRole('heading', { name: 'Drone confidence' }).evaluate(e => getComputedStyle(e).color), 'rgb(23, 23, 23)');
  const node = await page.getByRole('heading', { name: /^Node / }).textContent();
  const initialSockets = await page.evaluate(() => window.sensorSockets.length);
  for (const width of [1440, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const tab of ['Monitor', 'Mesh', 'Diagnostics']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await page.waitForTimeout(250);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tab} must fit ${width}px`);
      assert.equal(await page.getByRole('tab', { name: tab, exact: true }).getAttribute('aria-selected'), 'true');
      if (process.env.JCODE_SCRATCH_DIR) await page.screenshot({ path: `${process.env.JCODE_SCRATCH_DIR}/sensor-${tab}-${width}.png`, fullPage: true });
    }
  }
  await page.getByRole('tab', { name: 'Monitor', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'Mesh', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('tab', { name: 'Diagnostics', exact: true }).getAttribute('aria-selected'), 'true');
  const recordsBefore = Number(await page.locator('dt').filter({ hasText: /^Records held$/ }).evaluate(e => e.nextElementSibling.textContent));
  await page.getByRole('button', { name: 'Minimize sensor window' }).click();
  await page.getByRole('button', { name: 'Restore sensor' }).waitFor();
  await page.waitForTimeout(1600);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('skymesh.sensor.desktop')).minimized), true);
  assert.equal(await page.evaluate(() => window.sensorStreams.length), 1);
  assert.equal(await page.evaluate(() => window.sensorStreams[0].getAudioTracks()[0].readyState), 'live');
  assert.equal(await page.evaluate(() => window.sensorSockets.length), initialSockets, 'No reconnect during presentation changes');
  await page.getByRole('button', { name: 'Restore sensor' }).click();
  assert.equal(await page.getByRole('heading', { name: /^Node / }).textContent(), node);
  const recordsAfter = Number(await page.locator('dt').filter({ hasText: /^Records held$/ }).evaluate(e => e.nextElementSibling.textContent));
  assert(recordsAfter > recordsBefore, 'Readings must continue publishing while minimized');
  assert.equal(await page.getByRole('tab', { name: 'Diagnostics', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: 'Stop sensor', exact: true }).click();
  await page.getByRole('button', { name: 'Resume sensor', exact: true }).waitFor();
  await page.waitForFunction(() => window.sensorStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')));
  await page.waitForFunction(() => window.sensorSockets.every(s => s.readyState === WebSocket.CLOSED));
  await page.reload();
  await page.getByRole('button', { name: 'Resume sensor', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.sensorStreams.length), 0, 'Reload must not silently restart microphone');
  await page.getByRole('button', { name: 'Resume sensor', exact: true }).click();
  await page.getByRole('tab', { name: 'Diagnostics', exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await page.getByRole('tab', { name: 'Diagnostics', exact: true }).getAttribute('aria-selected'), 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.getByRole('region', { name: 'SkyMesh sensor window' }).evaluate(e => getComputedStyle(e).animationName), 'none');
  await page.getByRole('button', { name: 'Stop sensor', exact: true }).click();
  assert.deepEqual(errors, []);
  // Failure is still a usable relay, never a misleading zero-confidence sensor.
  const failed = await browser.newPage();
  await failed.route('**/drone_crnn.onnx', route => route.abort());
  await failed.goto(base);
  await failed.getByRole('button', { name: 'Enable microphone & join' }).click();
  await failed.getByText(/Detector unavailable:/).waitFor({ timeout: 60000 });
  assert(await failed.getByText('N/A', { exact: true }).isVisible());
  assert(await failed.getByRole('tab', { name: 'Mesh', exact: true }).isVisible());
  console.log('PASS: real model + fake microphone, 4 responsive sizes, 3 tabs, keyboard navigation, minimize/restore, stable streams/sockets, stop cleanup, reload/resume, preference restoration, reduced motion, and detector failure.');
} finally { await browser.close(); }
