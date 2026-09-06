import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalDots } from '../app/lib/bottomGraph.ts';
test('terminal dots exclude invalid, stale and future readings', () => {
  assert.deepEqual(terminalDots([{t: -1, p: 1}, {t: 60001, p: 1}, {t: 60000, p: NaN}], 60000, 61, 11), []);
});
test('terminal dots map endpoints and clamp probability', () => {
  assert.deepEqual(terminalDots([{t: 0, p: -1}, {t: 60000, p: 2}], 60000, 61, 11), [[0, 10], [60, 0]]);
});
test('terminal dots interpolate nearby readings without filling missing history', () => {
  const dots = terminalDots([{t: 60000, p: 1}, {t: 59000, p: 0}], 60000, 61, 11);
  assert.equal(dots.length, 11);
  assert(dots.every(([x,y]) => x >= 59 && x <= 60 && y >= 0 && y <= 10));
  assert.deepEqual(terminalDots([], 60000, 61, 11), []);
});
