// APP_URL=http://127.0.0.1:3017 node tests/simulation-alerts-ui.mjs
// Uses the real dashboard, relay, and sensor pages. No synthetic alert injection.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.APP_URL ?? 'http://localhost:3000';
// A deterministic silent microphone exercises the real audio/mel/ONNX pipeline.
// Simulations must not manufacture positive detections even while it is running.
const scratch = process.env.JCODE_SCRATCH_DIR ?? joinPath(homedir(), '.jcode', 'scratch');
mkdirSync(scratch, { recursive: true });
const fixtureDir = mkdtempSync(joinPath(scratch, 'simulation-audio-'));
const audioPath = joinPath(fixtureDir, 'silence.wav');
const wav = Buffer.alloc(44 + 32000);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
writeFileSync(audioPath, wav);
const browser = await chromium.launch({ headless: true, args: [
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${audioPath}`,
] });
const errors = [];
const session = `simulation-ui-${Date.now()}`;
try {
  const admin = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  admin.on('pageerror', e => errors.push(e.message));
  await admin.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', e => {
          const msg = JSON.parse(e.data);
          if (msg.ctrl === 'state') window.simulationRelayState = msg;
        });
      }
    };
  });
  await admin.goto(`${base}/station/?session=${session}`);
  await admin.getByRole('heading', { name: /Scenario controls/ }).waitFor({ timeout: 60000 });

  async function join(id, relayOnly = true) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', e => errors.push(e.message));
    // Exercise the important relay-only case: the demo does not need a microphone.
    if (relayOnly) await page.route('**/drone_crnn.onnx', route => route.abort());
    await page.addInitScript(() => {
      window.simulationMessages = [];
      window.outboundReadings = 0;
      window.localReadings = new Map();
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', e => {
            const msg = JSON.parse(e.data);
            if (msg.ctrl === 'simulation') window.simulationMessages.push(msg.alert);
          });
        }
        send(value) {
          const msg = JSON.parse(value);
          for (const r of msg.payload?.r ?? []) {
            if (r.type === 'reading' && r.origin === new URLSearchParams(location.search).get('node')) {
              window.localReadings.set(`${r.boot}:${r.seq}`, r);
              window.outboundReadings = window.localReadings.size;
            }
          }
          return super.send(value);
        }
      };
    });
    await page.goto(`${base}/?session=${session}&node=${id}`);
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => Object.keys(b).some(k => k.startsWith('__reactProps$'))));
    await page.getByRole('button', { name: 'Enable microphone & join' }).click();
    await page.getByRole('heading', { name: `Node ${id}`, exact: true }).waitFor({ timeout: 60000 });
    if (relayOnly) await page.getByText(/Detector unavailable:/).waitFor();
    else assert.equal(await page.getByText(/Detector unavailable:/).count(), 0, 'real ONNX detector loaded');
    return page;
  }
  const first = await join('n01');
  const second = await join('n02', false);
  const channel = first.getByRole('region', { name: '▧ Simulation channel', exact: true });
  const secondChannel = second.getByRole('region', { name: '▧ Simulation channel', exact: true });
  await admin.getByRole('button', { name: 'admit all', exact: true }).click();
  await first.getByText('Admitted to mesh', { exact: true }).waitFor();
  await second.getByText('Admitted to mesh', { exact: true }).waitFor();
  await admin.getByRole('button', { name: 'full mesh', exact: true }).click();
  await admin.getByRole('button', { name: 'auto-place', exact: true }).click();
  await admin.getByRole('button', { name: 'Fit participant area', exact: true }).click();
  await admin.waitForFunction(() => document.querySelectorAll('[data-node-id]').length >= 2);
  await second.waitForFunction(() => window.localReadings.size >= 3);
  const liveReadingsBefore = await second.evaluate(() => window.localReadings.size);
  const liveDetectionsBefore = await second.locator('dt').filter({ hasText: /^Detections$/ }).evaluate(el => el.nextElementSibling.textContent);
  assert.equal(liveDetectionsBefore, '0', 'silent microphone has no baseline detections');
  const simulationEventsBefore = await first.evaluate(() => window.simulationMessages.length);
  assert.equal(simulationEventsBefore, 0, 'no notices exist before a scenario is executed');

  async function mapClick(x, y) {
    const map = admin.locator('.room-map svg').first();
    await map.scrollIntoViewIfNeeded();
    const rect = await map.boundingBox();
    await map.click({ position: { x: rect.width * x / 12, y: rect.height * y / 8 } });
  }
  async function event(page, kind, phase) {
    await page.waitForFunction(({ kind, phase }) => window.simulationMessages.some(a => a.kind === kind && a.phase === phase), { kind, phase }, { timeout: 20000 });
  }
  const notices = admin.getByRole('region', { name: 'Node simulation acknowledgements' });

  // A real blast cuts n01's links, but its simulation notification still arrives.
  await admin.getByRole('button', { name: '◌ simulate impact', exact: true }).click();
  await mapClick(9.6, 4.8);
  await event(first, 'impact', 'started');
  await event(second, 'impact', 'started');
  await admin.waitForFunction(() => window.simulationRelayState?.links.some(l => !l.up && (l.a === 'n01' || l.b === 'n01')));
  const cutMeshLinks = await admin.evaluate(() => window.simulationRelayState.links.filter(l => !l.up).map(l => `${l.a}|${l.b}`));
  assert.deepEqual([...cutMeshLinks].sort(), ['admin|n01', 'n01|n02'], 'actual relay state confirms n01 is partitioned');
  await channel.getByText('AFFECTS YOUR NODE (simulated)', { exact: true }).waitFor();
  await secondChannel.getByText('SESSION ONLY · your node is not affected', { exact: true }).waitFor();
  await channel.getByRole('button', { name: 'Acknowledge', exact: true }).click();
  await channel.getByRole('button', { name: 'Acknowledged', exact: true }).waitFor();
  await notices.getByText('1/2 acknowledged', { exact: true }).waitFor();
  const ackObservation = await notices.locator('li').filter({ hasText: '1/2 acknowledged' }).innerText();
  assert.equal(await first.evaluate(() => window.outboundReadings), 0);
  assert.equal(await first.getByText('N/A', { exact: true }).count(), 1);
  assert.equal(await first.locator('dt').filter({ hasText: /^Detections$/ }).evaluate(el => el.nextElementSibling.textContent), '0');
  await event(first, 'impact', 'restored');
  await admin.waitForFunction(() => window.simulationRelayState.links.every(l => l.up));
  await channel.getByText('Restored', { exact: true }).waitFor();
  assert.equal(await channel.locator('li').count(), 1, 'restoration replaces active blast phase');
  console.log('PASS blast delivery through partition, node-specific context, ACK round-trip, restoration, zero synthetic detections');

  // Manual route placement and cancellation notify even with the sensor minimized.
  await first.getByRole('button', { name: 'Minimize sensor window' }).click();
  await first.getByRole('region', { name: 'SkyMesh sensor window' }).waitFor({ state: 'hidden' });
  await admin.getByRole('button', { name: '◈ simulate drone', exact: true }).click();
  await mapClick(1, 2);
  await mapClick(11, 6);
  await admin.getByRole('button', { name: 'start flight', exact: true }).click();
  await event(first, 'drone', 'started');
  await event(second, 'drone', 'contact');
  await admin.getByRole('button', { name: 'reset drone', exact: true }).click();
  await event(first, 'drone', 'cancelled');
  await channel.getByText('Cancelled', { exact: true }).waitFor();
  assert(await channel.isVisible());
  console.log('PASS manual drone start, proximity contact, reset and minimized sensor delivery');

  // One-click replay, interference and natural completion use the same channel.
  await admin.getByRole('button', { name: '↻ replay scenario', exact: true }).click();
  await event(first, 'interference', 'started');
  await event(first, 'drone', 'completed');
  await event(first, 'interference', 'restored');
  const received = await first.evaluate(() => window.simulationMessages);
  const completed = received.findLast(a => a.kind === 'drone' && a.phase === 'completed');
  assert.deepEqual([...completed.affectedNodes].sort(), ['n01', 'n02']);
  const contacts = received.filter(a => a.runId === completed.runId && a.phase === 'contact');
  assert(contacts.length >= 1 && contacts.length <= 2, 'proximity emits once per node, not per animation frame');
  await admin.getByRole('button', { name: '− disable random node', exact: true }).click();
  await event(first, 'isolation', 'started');
  await event(first, 'isolation', 'restored');
  console.log('PASS replay, all drone contacts, natural completion, interference and isolation lifecycle');

  // Compact, usable panel with no overflow and keyboard-operable controls.
  for (const width of [1440, 390, 320]) {
    await first.setViewportSize({ width, height: 900 });
    await channel.scrollIntoViewIfNeeded();
    const rect = await channel.boundingBox();
    assert(rect.x >= 0 && rect.x + rect.width <= width, `channel fits ${width}px`);
    assert(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}px`);
    if (process.env.JCODE_SCRATCH_DIR) await first.screenshot({ path: `${process.env.JCODE_SCRATCH_DIR}/simulation-alert-${width}.png`, fullPage: true });
  }
  await channel.getByRole('button', { name: 'Collapse simulation channel', exact: true }).click();
  const expand = channel.getByRole('button', { name: 'Expand simulation channel', exact: true });
  await expand.focus();
  await first.keyboard.press('Enter');
  await channel.getByRole('button', { name: 'Collapse simulation channel', exact: true }).waitFor();
  await first.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await channel.evaluate(e => getComputedStyle(e).animationName), 'none');
  assert.equal(await first.evaluate(() => window.outboundReadings), 0);
  const liveReadingsAfter = await second.evaluate(() => [...window.localReadings.values()]);
  assert(liveReadingsAfter.length > liveReadingsBefore, 'real model continues publishing while simulations run');
  assert(liveReadingsAfter.every(r => r.d === false), 'no simulation alters the live detector verdict');
  assert.equal(await second.locator('dt').filter({ hasText: /^Detections$/ }).evaluate(el => el.nextElementSibling.textContent), liveDetectionsBefore);
  const observedPhases = [...new Set((await first.evaluate(() => window.simulationMessages)).map(a => `${a.kind}:${a.phase}`))];
  const observations = {
    transport: 'production build, real relay, two independent browser contexts',
    simulationEventsBefore,
    simulationEventsAfter: await first.evaluate(() => new Set(window.simulationMessages.map(a => a.id)).size),
    cutMeshLinks,
    receivedPhases: observedPhases,
    blastAcknowledgement: ackObservation,
    relayOnlyNodeReadings: await first.evaluate(() => window.outboundReadings),
    liveOnnxReadingsBefore: liveReadingsBefore,
    liveOnnxReadingsAfter: liveReadingsAfter.length,
    liveOnnxPositiveVerdicts: liveReadingsAfter.filter(r => r.d).length,
    liveDetectionsBefore: Number(liveDetectionsBefore),
    liveDetectionsAfter: Number(await second.locator('dt').filter({ hasText: /^Detections$/ }).evaluate(el => el.nextElementSibling.textContent)),
    replayContactEvents: contacts.length,
    replayAffectedNodes: completed.affectedNodes,
    verifiedViewportWidths: [1440, 390, 320],
    browserErrors: errors,
  };
  console.log('OBSERVED_ACCEPTANCE', JSON.stringify(observations));
  if (process.env.JCODE_SCRATCH_DIR) writeFileSync(joinPath(scratch, 'simulation-acceptance-observations.json'), JSON.stringify(observations, null, 2));
  assert.deepEqual(errors, []);
  console.log('PASS responsive simulation panel, keyboard controls, reduced motion and no browser errors');
} finally {
  await browser.close();
  unlinkSync(audioPath);
  rmdirSync(fixtureDir);
}
