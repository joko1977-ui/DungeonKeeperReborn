import {
  Owner,
  ROOM_SPECS,
  RoomType,
  TICKS_PER_SECOND,
  Terrain,
  isDiggable,
  isWalkable,
} from './constants';
import { CREATURE_SPECS, Creature, CreatureState } from './creatures';
import { PathFinder } from './pathfinding';
import { RoomIndex, heartTile } from './rooms';
import { TileMap } from './tilemap';

/**
 * A rival keeper who actually plays.
 *
 * "Destroy the rival keeper" is only a goal worth having if the rival is doing
 * something while you do it. A heart sitting in a static box is a target, not an
 * opponent — you can ignore it for an hour and it will be exactly as it was.
 *
 * So this runs the same loop the player runs, badly and slowly, in a fixed
 * order: order some digging, take the ground your imps opened up, build the room
 * you most obviously lack, and once you have monsters spare, send some of them
 * to break the player's heart. It is not clever. It does not need to be — the
 * pressure comes from it being *always on*, which is the thing the original's
 * rivals actually did to you.
 *
 * Deliberately not modelled: tagging gold optimally, traps, spells, prisons.
 * A rival who played perfectly would be miserable to face at this scale.
 */

/** How often a keeper thinks. Cheap, but no point running it every tick. */
const THINK_INTERVAL = TICKS_PER_SECOND * 2;

/** Dig orders outstanding at once. More than this and the imps thrash. */
const MAX_ORDERS = 18;

/**
 * How far from its heart a keeper will bother to dig.
 *
 * Without a leash it tunnels until it owns the map, because there is always one
 * more tile on the border. A keeper with a home region reads as an opponent
 * holding ground; one that claims everything reads as a bug.
 */
const REACH = 22;

/** Tiles it will claim in total. Past this it consolidates instead of sprawling. */
const TERRITORY_CAP = 420;

/**
 * Rooms a keeper builds, in the order it wants them.
 *
 * Kept short on purpose. Lair tiles are the cap on how many creatures a portal
 * will admit, so a long list of lairs turns the rival into an army the player
 * cannot answer — it does not need to win, it needs to be a threat.
 */
const BUILD_ORDER: readonly RoomType[] = [
  RoomType.Treasury,
  RoomType.Lair,
  RoomType.Hatchery,
  RoomType.TrainingRoom,
  RoomType.Treasury,
  RoomType.Workshop,
];

/** Monsters a keeper keeps at home before it will send anyone out to raid. */
const GARRISON = 3;

/** What the keeper AI needs from the game. */
export interface KeeperAiWorld {
  readonly map: TileMap;
  readonly rooms: RoomIndex;
  readonly finder: PathFinder;
  readonly creatures: Creature[];
  readonly tickCount: number;
  goldOf(owner: Owner): number;
  withdrawGold(owner: Owner, amount: number): number;
  buildFor(owner: Owner, type: RoomType, x0: number, y0: number, x1: number, y1: number): boolean;
  effect(kind: string, x: number, y: number): void;
}

export class KeeperBrain {
  readonly owner: Owner;

  /** Tiles this keeper has told its imps to dig out. */
  readonly digOrders = new Set<number>();

  /** Where in BUILD_ORDER it has got to. */
  private buildStep = 0;
  private nextThink = 0;
  /** Set once it has decided to attack, so raids come in bursts not a trickle. */
  private raidUntil = -1;

  constructor(owner: Owner) {
    this.owner = owner;
  }

  update(world: KeeperAiWorld): void {
    if (world.tickCount < this.nextThink) return;
    // Stagger rivals so two keepers never think on the same tick.
    this.nextThink = world.tickCount + THINK_INTERVAL + (this.owner % 3);

    // Orders on tiles that have already been dug out are just noise.
    for (const tile of [...this.digOrders]) {
      if (!isDiggable(world.map.terrain[tile] as Terrain)) this.digOrders.delete(tile);
    }

    const heart = heartTile(world.map, world.rooms, this.owner);
    if (heart < 0) {
      // No heart, no keeper. Its creatures are on their own from here.
      this.digOrders.clear();
      return;
    }

    this.orderDigging(world, heart);
    this.tryBuild(world);
    this.maybeRaid(world, heart);
  }

  /* ------------------------------------------------------------ digging -- */

  /**
   * Tag earth on the edge of its territory, preferring gold.
   *
   * Expanding outward from what it already owns is what makes a rival's dungeon
   * visibly grow, and growing toward gold is what keeps it solvent enough to
   * keep building.
   */
  private orderDigging(world: KeeperAiWorld, heart: number): void {
    if (this.digOrders.size >= MAX_ORDERS) return;
    const { map } = world;
    if (map.countOwned(this.owner) >= TERRITORY_CAP) return;
    const hx = map.xOf(heart), hy = map.yOf(heart);

    // Walk our own floor and look at what borders it.
    const candidates: Array<{ tile: number; score: number }> = [];
    for (const i of map.tilesOwnedBy(this.owner)) {
      const x = map.xOf(i), y = map.yOf(i);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (!map.inBounds(nx, ny)) continue;
        const n = map.idx(nx, ny);
        if (this.digOrders.has(n)) continue;
        const t = map.terrain[n] as Terrain;
        if (!isDiggable(t)) continue;

        // Gold and gems first, then whatever is closest to home so the dungeon
        // stays a dungeon instead of a spray of disconnected tunnels.
        const d = Math.abs(nx - hx) + Math.abs(ny - hy);
        if (d > REACH) continue;
        let score = -d;
        if (t === Terrain.Gold) score += 40;
        if (t === Terrain.Gems) score += 70;
        candidates.push({ tile: n, score });
      }
    }
    if (candidates.length === 0) return;

    candidates.sort((a, b) => b.score - a.score);
    const want = Math.min(candidates.length, MAX_ORDERS - this.digOrders.size);
    for (let i = 0; i < want; i++) this.digOrders.add(candidates[i].tile);
  }

  /* ----------------------------------------------------------- building -- */

  /** Build the next room on the list, if it can afford it and has the space. */
  private tryBuild(world: KeeperAiWorld): void {
    if (this.buildStep >= BUILD_ORDER.length) return;
    const type = BUILD_ORDER[this.buildStep];
    const spec = ROOM_SPECS[type];
    const cost = spec.cost * 9;
    if (world.goldOf(this.owner) < cost) return;

    const spot = this.findBuildSpot(world, 3, 3);
    if (!spot) return;
    if (world.buildFor(this.owner, type, spot.x, spot.y, spot.x + 2, spot.y + 2)) {
      this.buildStep++;
    }
  }

  /** A block of its own bare claimed floor, big enough and free of rooms. */
  private findBuildSpot(
    world: KeeperAiWorld, w: number, h: number,
  ): { x: number; y: number } | null {
    const { map } = world;
    for (const i of map.tilesOwnedBy(this.owner)) {
      const x = map.xOf(i), y = map.yOf(i);
      let ok = true;
      for (let dy = 0; dy < h && ok; dy++) {
        for (let dx = 0; dx < w && ok; dx++) {
          const nx = x + dx, ny = y + dy;
          if (!map.inBounds(nx, ny)) { ok = false; break; }
          const n = map.idx(nx, ny);
          if (map.terrain[n] !== Terrain.Claimed || map.owner[n] !== this.owner
            || map.room[n] !== RoomType.None) ok = false;
        }
      }
      if (ok) return { x, y };
    }
    return null;
  }

  /* ------------------------------------------------------------- raiding -- */

  /**
   * Send the surplus at the player's heart.
   *
   * A keeper that threw everything at you the moment it had two creatures would
   * die to the first counter-attack and never bother you again. Keeping a
   * garrison back means it survives its own raids, so the pressure recurs.
   */
  private maybeRaid(world: KeeperAiWorld, heart: number): void {
    const { map } = world;
    const mine = world.creatures.filter(
      (c) => c.owner === this.owner && !CREATURE_SPECS[c.type].worker
        && c.state !== CreatureState.Dying && !c.inHand,
    );
    if (mine.length <= GARRISON) return;

    const target = heartTile(map, world.rooms, Owner.Player);
    if (target < 0) return;

    // Commit for a while once it decides, so a raid arrives as a group.
    if (world.tickCount > this.raidUntil) {
      this.raidUntil = world.tickCount + TICKS_PER_SECOND * 45;
    }

    const tx = map.xOf(target), ty = map.yOf(target);
    let sent = 0;
    for (const c of mine) {
      if (sent >= mine.length - GARRISON) break;
      // Leave whoever is already busy fighting or on the road.
      if (c.state === CreatureState.Fighting) continue;
      if (c.path && c.path.length > 0) continue;
      const path = world.finder.find(
        Math.round(c.x), Math.round(c.y), tx, ty,
        (px, py) => isWalkable(map.terrainAt(px, py)),
      );
      if (!path) continue;
      c.path = path;
      c.pathIndex = 0;
      c.targetTile = target;
      c.state = CreatureState.Walking;
      sent++;
    }
    if (sent > 0) world.effect('rally', map.xOf(heart), map.yOf(heart));
  }
}
