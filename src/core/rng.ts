/**
 * Small deterministic PRNG (mulberry32).
 *
 * Level generation is seeded so a given seed always produces the same realm —
 * handy for reporting a bug against "the map you get from seed 1997".
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
}

/**
 * Value noise on a grid, smoothed with a cosine interpolation.
 * Used for rock clusters and texture variation — good enough for both, and
 * cheap enough to run over a whole map at load time.
 */
export function valueNoise2D(rng: Rng, width: number, height: number, scale: number): Float32Array {
  const gw = Math.ceil(width / scale) + 2;
  const gh = Math.ceil(height / scale) + 2;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();

  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = x / scale, gy = y / scale;
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const fx = gx - x0, fy = gy - y0;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const a = grid[y0 * gw + x0];
      const b = grid[y0 * gw + x0 + 1];
      const c = grid[(y0 + 1) * gw + x0];
      const d = grid[(y0 + 1) * gw + x0 + 1];
      const top = a + (b - a) * sx;
      const bottom = c + (d - c) * sx;
      out[y * width + x] = top + (bottom - top) * sy;
    }
  }
  return out;
}
