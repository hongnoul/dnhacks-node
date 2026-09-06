// rng.ts — seeded pseudo-randomness.
//
// The simulation samples packet loss and measurement noise. With Math.random()
// a failing test could not be reproduced and "the same run twice" would not be a
// property anyone could assert, so every draw comes from here.

/** mulberry32 — small, fast, good enough for loss draws and Gaussian noise. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller, one value per call. Mean 0, unit variance. */
export function gaussian(rng: () => number): number {
  // rng() can return exactly 0, and log(0) is -Infinity.
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
