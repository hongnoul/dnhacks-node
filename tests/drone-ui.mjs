import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const base = process.env.UI_BASE_URL ?? 'http://localhost:3000';
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Three.js exposes scene observation for devtools. Use it to inspect the
  // actual component's scene without adding test-only globals to production.
  await page.addInitScript(() => {
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__droneScenes = [];
    window.__THREE_DEVTOOLS__.addEventListener('observe', event => {
      if (event.detail.isScene) window.__droneScenes.push(event.detail);
    });
    window.__droneRotors = () => {
      const rotors = [];
      for (const scene of window.__droneScenes) {
        scene.traverse(part => { if (part.name.startsWith('rotor-')) rotors.push(part); });
      }
      return rotors;
    };
  });
  await page.goto(`${base}/station`);
  await page.getByText('Drone audio test', { exact: true }).click();
  await page.waitForFunction(() => window.__droneRotors().length === 4);
  const canvas = page.locator('.drone-model canvas');
  assert(await canvas.isVisible());
  const geometry = await page.evaluate(() => {
    const rotors = window.__droneRotors();
    const model = rotors[0].parent;
    let meshCount = 0;
    model.traverse(part => { if (part.isMesh) meshCount++; });
    return {
      meshCount,
      stageChildren: model.parent.children.length,
      aligned: rotors.every(rotor => {
        const shaft = model.getObjectByName(rotor.name.slice('rotor-'.length));
        const centre = shaft.geometry.boundingBox.getCenter(rotor.position.clone());
        return Math.abs(rotor.position.x - centre.x) < 1e-6 &&
          Math.abs(rotor.position.z - centre.z) < 1e-6 &&
          rotor.position.y >= shaft.geometry.boundingBox.min.y &&
          rotor.position.y <= shaft.geometry.boundingBox.max.y &&
          rotor.children.length === 1;
      }),
    };
  });
  assert.deepEqual(geometry, { meshCount: 65, stageChildren: 1, aligned: true });
  const angles = () => page.evaluate(() => window.__droneRotors().map(rotor => rotor.rotation.y));
  const idle = await angles();
  await page.waitForTimeout(250);
  assert.deepEqual(await angles(), idle);

  await page.getByRole('button', { name: 'play drone', exact: true }).click();
  await page.waitForFunction(() => {
    const audio = document.querySelector('audio');
    return !audio.paused && audio.currentTime > 0 && window.__droneRotors().every(rotor => rotor.rotation.y > 0);
  });
  await page.getByRole('button', { name: 'stop', exact: true }).click();
  await page.waitForTimeout(100);
  const stopped = await angles();
  await page.waitForTimeout(250);
  assert.deepEqual(await angles(), stopped);
  assert(await page.locator('audio').evaluate(audio => audio.paused));
  await page.getByRole('button', { name: 'wind', exact: true }).click();
  await page.waitForTimeout(250);
  assert.deepEqual(await angles(), stopped);
  await page.getByRole('button', { name: 'drone', exact: true }).click();

  if (process.env.JCODE_SCRATCH_DIR) {
    await page.locator('.drone-model').screenshot({ path: `${process.env.JCODE_SCRATCH_DIR}/drone-propellers-fixed.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const size = await canvas.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
  assert(size.width > 0 && size.width <= 390 && size.height > 0);
  assert.deepEqual(errors, []);
  console.log('PASS: four shaft-aligned original propellers, no duplicate props, real audio spins/stops blades, wind leaves them idle, mobile/retina canvas renders.');
} finally {
  await browser.close();
}
