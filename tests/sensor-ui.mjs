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
  const video = page.getByRole('button', { name: 'Open drone-demo.mp4', exact: true });
  await video.click();
  await page.getByRole('dialog', { name: 'drone-demo.mp4' }).waitFor();
  const videoLink = page.getByRole('link', { name: 'Watch on YouTube ↗' });
  assert.equal(await videoLink.getAttribute('href'), 'https://youtu.be/DUTQkbuzxtk?is=_DargxbSpjJiuzxG');
  assert.equal(await videoLink.getAttribute('target'), '_blank');
  await page.getByRole('button', { name: 'Close video viewer' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert((await video.boundingBox()).y >= (await page.getByRole('button', { name: 'Open skymesh-join.svg' }).boundingBox()).y);
  assert.equal(await page.getByText('SKYMESH / SENSOR WORKSTATION').count(), 0);
  assert.deepEqual(await page.getByRole('img', { name: 'Drone confidence over the last 60 seconds' }).evaluate(c => Array.from(c.getContext('2d').getImageData(0, 0, 1, 1).data)), [16, 18, 22, 255], 'High-contrast terminal background');
  assert.equal(await page.getByRole('button', { name: 'Stop sensor', exact: true }).count(), 0);
  assert(await page.getByRole('img', { name: 'SkyMesh robot logo in ASCII art' }).isVisible());
  await page.getByRole('button', { name: 'Open skymesh-join.svg' }).click();
  assert(await page.getByRole('dialog', { name: 'skymesh-join.svg' }).isVisible());
  assert.equal(await page.getByRole('dialog').getByRole('link').getAttribute('href'), `${base}/`);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
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
  await page.getByRole('button', { name: 'Open sensor dashboard' }).waitFor();
  await page.waitForTimeout(1600);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('skymesh.sensor.desktop')).minimized), true);
  assert.equal(await page.evaluate(() => window.sensorStreams.length), 1);
  assert.equal(await page.evaluate(() => window.sensorStreams[0].getAudioTracks()[0].readyState), 'live');
  assert.equal(await page.evaluate(() => window.sensorSockets.length), initialSockets, 'No reconnect during presentation changes');
  await page.getByRole('button', { name: 'Open sensor dashboard' }).click();
  assert.equal(await page.getByRole('heading', { name: /^Node / }).textContent(), node);
  const recordsAfter = Number(await page.locator('dt').filter({ hasText: /^Records held$/ }).evaluate(e => e.nextElementSibling.textContent));
  assert(recordsAfter > recordsBefore, 'Readings must continue publishing while minimized');
  assert.equal(await page.getByRole('tab', { name: 'Diagnostics', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: 'Close sensor window', exact: true }).click();
  await page.getByRole('region', { name: 'SkyMesh sensor window' }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('heading', { name: 'Welcome to SkyMesh' }).count(), 0);
  assert.equal(await page.evaluate(() => window.sensorStreams[0].getAudioTracks()[0].readyState), 'live');
  await page.getByRole('button', { name: 'Open sensor dashboard' }).click();
  await page.getByRole('region', { name: 'SkyMesh sensor window' }).waitFor();
  assert.equal(await page.evaluate(() => window.sensorStreams.length), 1);
  assert.equal(await page.evaluate(() => window.sensorSockets.length), initialSockets);
  await page.reload();
  await page.getByRole('button', { name: 'Resume sensor', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.sensorStreams.length), 0, 'Reload must not silently restart microphone');
  await page.getByRole('button', { name: 'Resume sensor', exact: true }).click();
  await page.getByRole('tab', { name: 'Diagnostics', exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await page.getByRole('tab', { name: 'Diagnostics', exact: true }).getAttribute('aria-selected'), 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.getByRole('region', { name: 'SkyMesh sensor window' }).evaluate(e => getComputedStyle(e).animationName), 'none');
  await page.getByRole('button', { name: 'Close sensor window', exact: true }).click();
  assert.deepEqual(errors, []);
  // Failure is still a usable relay, never a misleading zero-confidence sensor.
  const failed = await browser.newPage();
  await failed.route('**/drone_crnn.onnx', route => route.abort());
  await failed.goto(base);
  await failed.waitForFunction(() => [...document.querySelectorAll('button')].some(b => Object.keys(b).some(k => k.startsWith('__reactProps$'))));
  await failed.getByRole('button', { name: 'Enable microphone & join' }).click();
  await failed.getByText(/Detector unavailable:/).waitFor({ timeout: 60000 });
  assert(await failed.getByText('N/A', { exact: true }).isVisible());
  assert.equal(await failed.getByText(/Detector unavailable:/).evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(208, 208, 208)');
  assert(await failed.getByRole('tab', { name: 'Mesh', exact: true }).isVisible());
  console.log('PASS: real model + fake microphone, 4 responsive sizes, 3 tabs, keyboard navigation, minimize/restore, stable streams/sockets, close/reopen continuity, reload/resume, preference restoration, reduced motion, and detector failure.');
} finally { await browser.close(); }
