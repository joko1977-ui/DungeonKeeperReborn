import { TileMap } from './tilemap';

/**
 * A* over the tile grid, plus a breadth-first "find me the nearest X" search.
 *
 * Both allocate their scratch buffers once and reuse them. Creature AI calls in
 * here constantly, and re-allocating a few thousand-element arrays per creature
 * per second was the first thing to show up in a profile.
 */

const DIRS8: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/** Test whether a creature of a given movement class may enter a tile. */
export type Passable = (x: number, y: number) => boolean;

/** A binary min-heap keyed by f-score, storing tile indices. */
class MinHeap {
  private heap: Int32Array;
  private score: Float32Array;
  private size = 0;

  constructor(capacity: number, score: Float32Array) {
    this.heap = new Int32Array(capacity);
    this.score = score;
  }

  clear(): void { this.size = 0; }
  get length(): number { return this.size; }

  push(v: number): void {
    if (this.size === this.heap.length) {
      const grown = new Int32Array(this.heap.length * 2);
      grown.set(this.heap);
      this.heap = grown;
    }
    let i = this.size++;
    this.heap[i] = v;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.score[this.heap[parent]] <= this.score[this.heap[i]]) break;
      const tmp = this.heap[parent];
      this.heap[parent] = this.heap[i];
      this.heap[i] = tmp;
      i = parent;
    }
  }

  pop(): number {
    const top = this.heap[0];
    this.size--;
    if (this.size > 0) {
      this.heap[0] = this.heap[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let best = i;
        if (l < this.size && this.score[this.heap[l]] < this.score[this.heap[best]]) best = l;
        if (r < this.size && this.score[this.heap[r]] < this.score[this.heap[best]]) best = r;
        if (best === i) break;
        const tmp = this.heap[best];
        this.heap[best] = this.heap[i];
        this.heap[i] = tmp;
        i = best;
      }
    }
    return top;
  }
}

export class PathFinder {
  private readonly map: TileMap;
  private readonly gScore: Float32Array;
  private readonly fScore: Float32Array;
  private readonly cameFrom: Int32Array;
  /** Stamp-based visited marking so we never have to clear the big arrays. */
  private readonly stamp: Int32Array;
  private currentStamp = 0;
  private readonly open: MinHeap;

  /** BFS scratch, kept separate so a BFS can run inside a path callback. */
  private readonly bfsStamp: Int32Array;
  private bfsCurrentStamp = 0;
  private readonly bfsQueue: Int32Array;

  constructor(map: TileMap) {
    this.map = map;
    const n = map.width * map.height;
    this.gScore = new Float32Array(n);
    this.fScore = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    this.stamp = new Int32Array(n);
    this.open = new MinHeap(1024, this.fScore);
    this.bfsStamp = new Int32Array(n);
    this.bfsQueue = new Int32Array(n);
  }

  /**
   * Find a path from (sx,sy) to (gx,gy).
   *
   * Returns a flat array of tile indices from the first step to the goal
   * (excluding the start), or null if unreachable within `maxNodes`.
   */
  find(
    sx: number, sy: number,
    gx: number, gy: number,
    passable: Passable,
    maxNodes = 6000,
  ): Int32Array | null {
    const { map } = this;
    if (!map.inBounds(sx, sy) || !map.inBounds(gx, gy)) return null;
    const start = map.idx(sx, sy);
    const goal = map.idx(gx, gy);
    if (start === goal) return new Int32Array(0);
    if (!passable(gx, gy)) return null;

    const s = ++this.currentStamp;
    this.open.clear();
    this.stamp[start] = s;
    this.gScore[start] = 0;
    this.fScore[start] = octile(sx, sy, gx, gy);
    this.cameFrom[start] = -1;
    this.open.push(start);

    let expanded = 0;
    while (this.open.length > 0) {
      const current = this.open.pop();
      if (current === goal) return this.reconstruct(start, goal);
      if (++expanded > maxNodes) return null;

      const cx = map.xOf(current), cy = map.yOf(current);
      const cg = this.gScore[current];

      for (const [dx, dy, cost] of DIRS8) {
        const nx = cx + dx, ny = cy + dy;
        if (!map.inBounds(nx, ny) || !passable(nx, ny)) continue;
        // No cutting corners diagonally through a solid pair.
        if (dx !== 0 && dy !== 0) {
          if (!passable(cx + dx, cy) || !passable(cx, cy + dy)) continue;
        }
        const ni = map.idx(nx, ny);
        const tentative = cg + cost;
        if (this.stamp[ni] === s && tentative >= this.gScore[ni]) continue;
        this.stamp[ni] = s;
        this.gScore[ni] = tentative;
        this.fScore[ni] = tentative + octile(nx, ny, gx, gy);
        this.cameFrom[ni] = current;
        this.open.push(ni);
      }
    }
    return null;
  }

  private reconstruct(start: number, goal: number): Int32Array {
    let n = 0;
    for (let c = goal; c !== start && c !== -1; c = this.cameFrom[c]) n++;
    const out = new Int32Array(n);
    let i = n - 1;
    for (let c = goal; c !== start && c !== -1; c = this.cameFrom[c]) out[i--] = c;
    return out;
  }

  /**
   * Breadth-first search outward from a start tile for the nearest tile the
   * predicate accepts. `traversable` gates how the search spreads; `accept`
   * decides what counts as a hit — they differ because an imp looks for a
   * *solid* wall to mine while only ever *walking* on floor.
   *
   * Returns the tile index of the nearest match, or -1.
   */
  findNearest(
    sx: number, sy: number,
    traversable: Passable,
    accept: (x: number, y: number) => boolean,
    maxNodes = 4000,
  ): number {
    const { map } = this;
    if (!map.inBounds(sx, sy)) return -1;
    const s = ++this.bfsCurrentStamp;
    let head = 0, tail = 0;
    const start = map.idx(sx, sy);
    this.bfsStamp[start] = s;
    this.bfsQueue[tail++] = start;
    let expanded = 0;

    while (head < tail) {
      const current = this.bfsQueue[head++];
      const cx = map.xOf(current), cy = map.yOf(current);
      if (accept(cx, cy)) return current;
      if (++expanded > maxNodes) return -1;

      for (const [dx, dy] of DIRS8) {
        const nx = cx + dx, ny = cy + dy;
        if (!map.inBounds(nx, ny)) continue;
        const ni = map.idx(nx, ny);
        if (this.bfsStamp[ni] === s) continue;
        // Spread only through traversable tiles, but still *test* the solid
        // neighbours we bump into — that's how mining targets get found.
        if (!traversable(nx, ny)) {
          if (accept(nx, ny)) {
            this.bfsStamp[ni] = s;
            return ni;
          }
          continue;
        }
        if (dx !== 0 && dy !== 0) {
          if (!traversable(cx + dx, cy) || !traversable(cx, cy + dy)) continue;
        }
        this.bfsStamp[ni] = s;
        if (tail < this.bfsQueue.length) this.bfsQueue[tail++] = ni;
      }
    }
    return -1;
  }
}

/** Octile distance: the right heuristic for 8-way movement with √2 diagonals. */
export function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
  return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
}
