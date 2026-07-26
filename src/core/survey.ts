import { OWNER_COLORS, Owner, RoomType, Terrain, isWalkable } from './constants';
import { RoomIndex, heartTile } from './rooms';
import { FLAG_REVEALED, TileMap } from './tilemap';

/**
 * What is worth digging, and which blocks to dig to get there.
 *
 * The complaint this exists to answer: you look at your dungeon and it is ringed
 * by two hundred identical brown blocks, and there is nothing to choose between
 * them. The objectives panel says "destroy the rival keeper's heart"; the
 * compass says he is somewhere north-east; and then you are staring at a wall
 * with no idea which part of it to tag. So you tag some at random, wait two
 * minutes, and find out you have opened a dead end. That is not exploration, it
 * is a coin toss with a wait attached, and it makes the map — the thing the
 * generator works hardest on — invisible.
 *
 * The fix is a survey: one multi-source Dijkstra outward from everything the
 * keeper owns, over a cost model where walking is nearly free, earth is dear,
 * reinforced masonry is dearer, and a gold or gem seam is *cheaper* than the
 * earth beside it, because a corridor that pays for itself is the corridor you
 * want. One pass gives every tile on the map a "what would it cost me to reach
 * this" number, and everything else falls out of that field:
 *
 *   - the route to a prize is the field walked downhill from the prize,
 *   - a seam's worth is its gold weighed against the cost of reaching it,
 *   - and both come from the same numbers, so they never disagree.
 *
 * ## What it does not give away
 *
 * Routes are planned through rock the player has not seen — they have to be, or
 * the plan would stop at the first unexcavated tile and answer nothing. But only
 * the *revealed prefix* is ever handed to the renderer, plus the bearing of the
 * next step beyond it. So what you get is "dig these four blocks, then keep
 * heading that way", which is what a keeper with a map of his own excavations
 * would know. What you do not get is the layout of the caverns beyond, the
 * position of the seams inside them, or any help once you are there.
 */

/** Dig cost of entering a tile, or -1 for "no imp will ever get through". */
export function digCost(terrain: Terrain, mine: boolean): number {
  switch (terrain) {
    // Impassable: bedrock cannot be dug at all, and liquids cannot be tunnelled.
    case Terrain.Rock: case Terrain.Water: case Terrain.Lava: return -1;
    // Ground you already hold, then ground that merely exists.
    case Terrain.Claimed: return mine ? 1 : 3;
    case Terrain.Path: return 2;
    // Seams are cheaper than the dirt around them on purpose. Given two ways to
    // the same place, the one that pays wages on the way is the better plan, and
    // an imp digs a seam no slower than earth.
    case Terrain.Gems: return 4;
    case Terrain.Gold: return 6;
    case Terrain.Earth: return 9;
    // Somebody reinforced this. Going round is nearly always right.
    case Terrain.Wall: return 30;
    default: return -1;
  }
}

/** A worthwhile place to dig toward, and the blocks that get you there. */
export interface SurveyRoute {
  key: string;
  label: string;
  colour: number;
  /** Tiles from your own ground outward to the prize. */
  path: number[];
  /** How many leading tiles of `path` the player has actually seen. */
  known: number;
  /** Total dig cost of the whole route. */
  cost: number;
}

/** A seam of gold or gems, as one prize rather than as N tiles. */
export interface SurveySeam {
  /** The tile to hang a marker over: the one nearest the cluster's middle. */
  tile: number;
  tiles: number;
  gold: number;
  gems: boolean;
  /** Dig cost to reach it, or -1 if no route exists. */
  cost: number;
}

export interface Survey {
  routes: SurveyRoute[];
  seams: SurveySeam[];
  /** The map version this was computed from. */
  version: number;
}

/** A binary min-heap over tile indices, keyed by an external score array. */
class CostHeap {
  private items: Int32Array;
  private size = 0;

  constructor(private readonly score: Float64Array, capacity: number) {
    this.items = new Int32Array(Math.max(16, capacity));
  }

  get length(): number { return this.size; }
  clear(): void { this.size = 0; }

  push(tile: number): void {
    if (this.size === this.items.length) {
      const grown = new Int32Array(this.items.length * 2);
      grown.set(this.items);
      this.items = grown;
    }
    let i = this.size++;
    this.items[i] = tile;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.score[this.items[parent]] <= this.score[this.items[i]]) break;
      const swap = this.items[parent];
      this.items[parent] = this.items[i];
      this.items[i] = swap;
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0];
    this.size--;
    if (this.size > 0) {
      this.items[0] = this.items[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let best = i;
        if (l < this.size && this.score[this.items[l]] < this.score[this.items[best]]) best = l;
        if (r < this.size && this.score[this.items[r]] < this.score[this.items[best]]) best = r;
        if (best === i) break;
        const swap = this.items[best];
        this.items[best] = this.items[i];
        this.items[i] = swap;
        i = best;
      }
    }
    return top;
  }
}

/**
 * The cost field itself: what it would take to reach every tile on the map.
 *
 * Four-neighbour, not eight. A corridor is dug square, and a route that cut
 * diagonally through a corner would describe a tunnel no imp can produce.
 */
export class DigField {
  readonly cost: Float64Array;
  /** Which neighbour each tile was reached from, for walking a route back. */
  readonly from: Int32Array;

  private readonly map: TileMap;
  private readonly heap: CostHeap;

  constructor(map: TileMap) {
    this.map = map;
    const n = map.width * map.height;
    this.cost = new Float64Array(n);
    this.from = new Int32Array(n);
    this.heap = new CostHeap(this.cost, n);
  }

  /** Flood outward from every tile a keeper holds. */
  compute(owner: Owner): void {
    const { map, cost, from, heap } = this;
    cost.fill(Infinity);
    from.fill(-1);
    heap.clear();

    for (let i = 0; i < cost.length; i++) {
      if (map.owner[i] !== owner) continue;
      if (!isWalkable(map.terrain[i] as Terrain)) continue;
      cost[i] = 0;
      heap.push(i);
    }
    // A keeper with nothing left still gets a plan, measured from his heart.
    if (heap.length === 0) return;

    const settled = new Uint8Array(cost.length);
    while (heap.length > 0) {
      const i = heap.pop();
      if (settled[i]) continue;
      settled[i] = 1;
      const x = map.xOf(i), y = map.yOf(i);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (!map.inBounds(nx, ny)) continue;
        const j = map.idx(nx, ny);
        if (settled[j]) continue;
        const step = digCost(map.terrain[j] as Terrain, map.owner[j] === owner);
        if (step < 0) continue;
        const next = cost[i] + step;
        if (next >= cost[j]) continue;
        cost[j] = next;
        from[j] = i;
        heap.push(j);
      }
    }
  }

  /** Walk the field downhill from a prize back to the keeper's own ground. */
  route(target: number): number[] {
    if (!Number.isFinite(this.cost[target])) return [];
    const out: number[] = [];
    for (let t = target; t >= 0; t = this.from[t]) {
      out.push(t);
      if (out.length > this.cost.length) break; // paranoia; the field is a tree
    }
    return out.reverse();
  }
}

/** Group touching seam tiles so a vein is one prize, not fourteen. */
function clusterSeams(map: TileMap, field: DigField): SurveySeam[] {
  const seen = new Uint8Array(map.terrain.length);
  const out: SurveySeam[] = [];
  const stack: number[] = [];

  for (let start = 0; start < map.terrain.length; start++) {
    if (seen[start]) continue;
    const t = map.terrain[start] as Terrain;
    if (t !== Terrain.Gold && t !== Terrain.Gems) continue;
    // Only seams you have actually laid eyes on. Advertising the ones you have
    // not found would delete prospecting from the game.
    if ((map.flags[start] & FLAG_REVEALED) === 0) { seen[start] = 1; continue; }

    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    let sx = 0, sy = 0, n = 0, gold = 0, gems = false, cheapest = Infinity;
    const members: number[] = [];

    while (stack.length > 0) {
      const i = stack.pop()!;
      members.push(i);
      sx += map.xOf(i); sy += map.yOf(i); n++;
      gold += map.gold[i];
      if (map.terrain[i] === Terrain.Gems) gems = true;
      if (field.cost[i] < cheapest) cheapest = field.cost[i];
      const x = map.xOf(i), y = map.yOf(i);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (!map.inBounds(nx, ny)) continue;
        const j = map.idx(nx, ny);
        if (seen[j]) continue;
        const nt = map.terrain[j] as Terrain;
        if (nt !== Terrain.Gold && nt !== Terrain.Gems) continue;
        if ((map.flags[j] & FLAG_REVEALED) === 0) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }

    const cx = sx / n, cy = sy / n;
    let best = members[0], bestD = Infinity;
    for (const m of members) {
      const d = (map.xOf(m) - cx) ** 2 + (map.yOf(m) - cy) ** 2;
      if (d < bestD) { bestD = d; best = m; }
    }
    out.push({
      tile: best, tiles: n, gold, gems,
      cost: Number.isFinite(cheapest) ? cheapest : -1,
    });
  }
  return out;
}

/** How much of a route the player has already uncovered. */
function knownPrefix(map: TileMap, path: number[]): number {
  let k = 0;
  while (k < path.length && (map.flags[path[k]] & FLAG_REVEALED) !== 0) k++;
  return k;
}

/**
 * Plan the keeper's excavations.
 *
 * `liveKeepers` is who is still in the game — passed in rather than looked up so
 * this stays a pure function of the map and can be run headlessly.
 */
export function surveyDungeon(
  map: TileMap, rooms: RoomIndex, liveKeepers: readonly Owner[], field: DigField,
): Survey {
  field.compute(Owner.Player);

  const routes: SurveyRoute[] = [];

  const addRoute = (key: string, label: string, colour: number, target: number): void => {
    if (target < 0) return;
    const path = field.route(target);
    // A one-tile route is a prize you are already standing on.
    if (path.length < 2) return;
    routes.push({
      key, label, colour, path,
      known: knownPrefix(map, path),
      cost: field.cost[target],
    });
  };

  for (const owner of liveKeepers) {
    if (owner === Owner.Player) continue;
    addRoute(
      `keeper-${owner}`, 'Rival Keeper', OWNER_COLORS[owner],
      heartTile(map, rooms, owner),
    );
  }

  // The hero gate, as the thing you may want to reach — the same door the raids
  // come out of, which is why it is drawn in the heroes' colour and not yours.
  const gates = rooms.tilesOf(map, Owner.Heroes, RoomType.Portal);
  if (gates.length > 0) {
    let best = gates[0];
    for (const g of gates) if (field.cost[g] < field.cost[best]) best = g;
    addRoute('heroes', 'Hero Gate', 0xbcd8ff, best);
  }

  // An unclaimed portal is the single best thing to dig for early, and it is the
  // one prize a new player never finds, because nothing points at it.
  for (const portal of rooms.tilesOf(map, Owner.None, RoomType.Portal)) {
    if ((map.flags[portal] & FLAG_REVEALED) === 0) continue;
    addRoute(`portal-${portal}`, 'Portal', 0xb277ff, portal);
    break;
  }

  const seams = clusterSeams(map, field)
    .filter((s) => s.cost >= 0)
    // Richest first, so a capped display keeps the seams worth crossing a map for.
    .sort((a, b) => b.gold - a.gold);

  return { routes, seams, version: map.version };
}
