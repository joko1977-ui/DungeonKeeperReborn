import { Rng } from './rng';

/**
 * The simulation's one source of randomness.
 *
 * Everything in `src/core` that needs a random number takes it from here rather
 * than from `Math.random`. That matters for two reasons, and the second is the
 * one that bites:
 *
 *   - A seed becomes a promise. "Realm seed 1997" implied a reproducible level,
 *     but the map was seeded while the *game* was not, so the same seed diverged
 *     within seconds and no two runs of it played alike.
 *   - The headless test could not be trusted. With combat that can genuinely go
 *     either way, an unseeded simulation made the suite flaky: the same code
 *     passed and failed on alternate runs, which is worse than no test at all
 *     because it teaches you to ignore failures.
 *
 * Reseeded by the level generator so a fresh level always starts from a known
 * state, including across a restart.
 */
let rng = new Rng(1997);

/** Restart the stream. Called once when a level is generated. */
export function seedSim(seed: number): void {
  rng = new Rng(seed >>> 0 || 1);
}

/** Uniform float in [0, 1). */
export function simRandom(): number {
  return rng.next();
}

/** Integer in [0, n). Returns 0 for an empty range. */
export function simInt(n: number): number {
  return n <= 0 ? 0 : Math.floor(rng.next() * n);
}

/** A uniformly chosen element, or undefined when there is nothing to choose. */
export function simPick<T>(items: readonly T[]): T | undefined {
  return items.length === 0 ? undefined : items[simInt(items.length)];
}
