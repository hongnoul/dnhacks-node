// Public acceptance: an operator can survey the array by distance alone.
//
// The unit tests prove the solver; this proves the workflow a person actually
// performs — join, admit, measure, preview, apply — and that what lands in the
// replicated log is the surveyed shape with its uncertainty, not a shape the
// operator dragged into place.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.APP_URL ?? 'http://127.0.0.1:8127';
const session = `survey-${Date.now()}`;

/** Ground truth: a 6 x 4 m rectangle. Only the distances are ever entered. */
const TRUTH = { n01: [0, 0], n02: [6, 0], n03: [6, 4], n04: [0, 4] };
const IDS = Object.keys(TRUTH);
const trueDist = (a, b) => Math.hypot(TRUTH[a][0] - TRUTH[b][0], TRUTH[a][1] - TRUTH[b][1]);

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const errors = [];
  context.on('weberror', e => errors.push(String(e.error())));
  const page = await context.newPage();
  await page.goto(`${base}/station/?session=${session}`);
  await page.locator('.unified-console').waitFor();

  // Join and admit four participants.
  for (const id of IDS) {
    const phone = await context.newPage();
    await phone.goto(`${base}/?node=${id}&session=${session}`);
    await phone.getByRole('button', { name: /Enable microphone & join/i }).click();
    const admit = page.getByRole('button', { name: 'admit', exact: true }).first();
    await admit.waitFor({ timeout: 60000 });
    await admit.click();
    await page.locator(`[data-node-id="${id}"]`).waitFor();
  }
  const survey = page.locator('[data-section="survey"]');
  await survey.scrollIntoViewIfNeeded();

  // Four participants means six pairs, every one of them offered.
  const boxes = survey.locator('input[aria-label^="Measured distance from"]');
  assert.equal(await boxes.count(), 6, 'every unordered pair gets a box');

  // Nothing is placed yet: the survey must not have invented positions.
  assert.equal(
    await page.locator('.map-card [data-node-id][data-placed="true"]').count(), 0,
    'no participant is placed before the survey is applied'
  );

  /** Fill each box from the truth layout, reading which pair it belongs to. */
  async function enterAll(mutate = () => null) {
    for (let i = 0; i < await boxes.count(); i++) {
      const box = boxes.nth(i);
      const [, a, b] = (await box.getAttribute('aria-label'))
        .match(/from (\S+) to (\S+),/);
      const d = mutate(a, b) ?? trueDist(a, b);
      await box.fill(d.toFixed(3));
    }
  }
  await enterAll();

  // Four participants is six pairs against a nine-parameter shape: redundancy 1.
  // The panel must say the check is weak rather than that everything agrees,
  // because at this redundancy a blunder is absorbed rather than exposed.
  await assert.doesNotReject(
    survey.getByText(/a wrong entry can hide in the fit/).waitFor({ timeout: 5000 }),
    'a barely-redundant survey must not claim the measurements were checked'
  );
  assert.equal(await survey.getByText(/measurements agree/).count(), 0,
    'agreement is only claimable with enough spare measurements');

  // Preview must not publish: the map moves, the log does not.
  await survey.getByRole('button', { name: 'preview on map', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.map-card [data-node-id="n01"]') !== null);
  assert.equal(
    await page.locator('.map-card [data-node-id][data-placed="true"]').count(), 0,
    'preview is a proposal, not a placement'
  );

  await survey.getByRole('button', { name: 'apply positions', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelectorAll('.map-card [data-node-id][data-placed="true"]').length === 4);

  // The published shape must match the tape, up to the rotation and reflection
  // that distances genuinely cannot fix.
  const placed = await page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll('[data-section=nodes] tbody tr')].map(tr => [
      tr.querySelector('td:first-child')?.textContent?.trim(),
      tr.querySelector('td:nth-child(3)')?.textContent?.trim(),
    ])));
  const parsed = {};
  for (const [id, cell] of Object.entries(placed)) {
    const m = cell.match(/^(-?[\d.]+), (-?[\d.]+) ±([\d.]+)$/);
    assert.ok(m, `${id} should read "x, y ±sigma", got "${cell}"`);
    parsed[id] = { x: +m[1], y: +m[2], sigma: +m[3] };
    // Tape-grade geometry: a sigma near a metre would mean the solve gave up.
    assert.ok(parsed[id].sigma > 0 && parsed[id].sigma < 0.3,
      `${id} sigma ${parsed[id].sigma} should be tape-grade`);
  }
  for (const a of IDS) for (const b of IDS) {
    if (a >= b) continue;
    const got = Math.hypot(parsed[a].x - parsed[b].x, parsed[a].y - parsed[b].y);
    assert.ok(Math.abs(got - trueDist(a, b)) < 0.05,
      `${a}-${b}: published ${got.toFixed(2)} m vs measured ${trueDist(a, b).toFixed(2)} m`);
  }

  // Orientation is the operator's to set, and must not deform the array.
  await survey.getByRole('button', { name: /rotate \+15/ }).click();
  await survey.getByRole('button', { name: 'apply positions', exact: true }).click();
  await page.waitForTimeout(300);
  const turned = await page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll('[data-section=nodes] tbody tr')].map(tr => [
      tr.querySelector('td:first-child')?.textContent?.trim(),
      tr.querySelector('td:nth-child(3)')?.textContent?.trim().match(/^(-?[\d.]+), (-?[\d.]+)/).slice(1).map(Number),
    ])));
  const moved = IDS.some(id => Math.hypot(turned[id][0] - parsed[id].x, turned[id][1] - parsed[id].y) > 0.3);
  assert.ok(moved, 'rotating should actually turn the array');
  for (const a of IDS) for (const b of IDS) {
    if (a >= b) continue;
    const got = Math.hypot(turned[a][0] - turned[b][0], turned[a][1] - turned[b][1]);
    assert.ok(Math.abs(got - trueDist(a, b)) < 0.05, `${a}-${b} deformed by rotation`);
  }

  // A mistyped distance must flag itself where it was typed.
  await enterAll((a, b) => (a === IDS[0] && b === IDS[1] ? trueDist(a, b) + 2 : null));
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-section="survey"] input.survey-bad').length > 0);
  await survey.getByText(/re-measure it/).waitFor({ timeout: 5000 });

  // Clearing must not leave the console asserting a survey it no longer has.
  await survey.getByRole('button', { name: 'clear', exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-section="survey"] input[aria-label^="Measured"]')]
      .every(i => i.value === ''));

  assert.deepEqual(errors, [], 'no page errors');
  console.log('survey-ui: ok');
} finally {
  await browser.close();
}
