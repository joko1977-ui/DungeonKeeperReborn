import {
  CLAIM_HEALTH,
  IMP_CARRY_CAPACITY,
  IMP_CLAIM_RATE,
  IMP_DIG_RATE,
  Owner,
  RoomType,
  TICKS_PER_SECOND,
  Terrain,
  isDiggable,
  isFlyable,
  isWalkable,
} from './constants';
import {
  CREATURE_SPECS,
  Creature,
  CreatureState,
  CreatureType,
  isHostileTo,
  maxHpOf,
  speedOf,
  strengthOf,
  xpForNextLevel,
} from './creatures';
import { PathFinder } from './pathfinding';
import { RoomIndex, heartTile, nearestRoomTile } from './rooms';
import { TileMap } from './tilemap';
import { simInt, simRandom } from './sim';

/**
 * Everything the creature AI is allowed to touch.
 *
 * Declared here rather than importing Game directly so the behaviour code stays
 * testable in isolation and there's no import cycle between sim and AI.
 */
export interface AIWorld {
  readonly map: TileMap;
  readonly rooms: RoomIndex;
  readonly finder: PathFinder;
  readonly creatures: Creature[];
  readonly tickCount: number;

  goldOf(owner: Owner): number;
  /** Store gold, capped by treasury size. Returns how much actually fit. */
  depositGold(owner: Owner, amount: number): number;
  /** Is there vault room for any more? Imps do not fetch what cannot be stored. */
  hasTreasurySpace(owner: Owner): boolean;
  /** Spend gold. Returns how much was actually available. */
  withdrawGold(owner: Owner, amount: number): number;

  /** Chickens available in the hatchery right now. */
  foodOf(owner: Owner): number;
  consumeFood(owner: Owner): boolean;

  /** Lair bookkeeping — one nest per creature. */
  claimLair(creature: Creature, tile: number): void;
  releaseLair(creature: Creature): void;
  isLairFree(tile: number): boolean;

  addResearch(owner: Owner, points: number): void;
  /**
   * Is this tile tagged for excavation by that owner?
   *
   * The player's tags live in a flag on the tile, but rival keepers need their
   * own orders — a shared flag would have a rival's imps cheerfully digging out
   * whatever the player tagged, and vice versa.
   */
  hasDigOrder(owner: Owner, x: number, y: number): boolean;
  /** Hit a door. Returns true when it breaks. */
  damageDoor(x: number, y: number, amount: number): boolean;
  /**
   * Hit a keeper's Dungeon Heart. Returns true when it stops.
   *
   * Nothing could damage a heart before this, which meant the level could be
   * neither won nor lost — the two conditions the whole game rests on.
   */
  damageHeart(owner: Owner, amount: number): boolean;
  /** Fraction of a keeper's heart still intact, 0..1. */
  heartIntegrity(owner: Owner): number;
  /** Tile this keeper's creatures have been called to, or -1. */
  rallyTile(owner: Owner): number;
  notify(message: string, cue?: string): void;
  /** Fire off a one-shot visual: 'dig' | 'claim' | 'hit' | 'gold' | 'sleep' | 'poof'. */
  effect(kind: string, x: number, y: number): void;
  onCreatureDied(creature: Creature): void;
}

/**
 * How far an imp will walk for gold lying on the floor, in tiles.
 *
 * Small on purpose — see the job ladder in `thinkImp`. Piles further off than
 * this are not abandoned, they are just not urgent: an imp with nothing tagged to
 * dig falls through to idling, and idle imps sweep them up.
 */
const LOOSE_GOLD_REACH = 9;

/** Squared distance in tile units. */
function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

/** How a creature of this type is allowed to move. */
function passableFor(map: TileMap, c: Creature) {
  const flying = CREATURE_SPECS[c.type].flying;
  return flying
    ? (x: number, y: number) => isFlyable(map.terrainAt(x, y))
    : (x: number, y: number) => isWalkable(map.terrainAt(x, y));
}

/** Nearest floor tile bordering `tile` that the creature can stand on. */
function adjacentStandTile(map: TileMap, tile: number, c: Creature): number {
  const tx = map.xOf(tile), ty = map.yOf(tile);
  const pass = passableFor(map, c);
  let best = -1, bestD = Infinity;
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dx, dy] of dirs) {
    const nx = tx + dx, ny = ty + dy;
    if (!map.inBounds(nx, ny) || !pass(nx, ny)) continue;
    const d = dist2(nx, ny, c.x, c.y);
    if (d < bestD) { bestD = d; best = map.idx(nx, ny); }
  }
  return best;
}

/* ========================================================== movement ===== */

/** Ask the pathfinder for a route and stash it on the creature. */
function setPathTo(world: AIWorld, c: Creature, tile: number): boolean {
  const { map } = world;
  const gx = map.xOf(tile), gy = map.yOf(tile);
  const path = world.finder.find(
    Math.round(c.x), Math.round(c.y), gx, gy, passableFor(map, c),
  );
  if (!path) { c.path = null; return false; }
  c.path = path;
  c.pathIndex = 0;
  return true;
}

/**
 * Advance along the current path. Returns true when the destination is reached
 * (or there was never a path to begin with).
 *
 * Doors are left passable for the pathfinder on purpose. Making them solid
 * would send intruders looking for another way round and they would simply
 * never attack one; instead the route goes through, and a creature that
 * reaches a door it does not own stops and breaks it down.
 */
function advancePath(world: AIWorld, c: Creature, dt: number): boolean {
  const { map } = world;
  if (!c.path || c.pathIndex >= c.path.length) { c.path = null; return true; }

  const target = c.path[c.pathIndex];
  const tx = map.xOf(target), ty = map.yOf(target);
  const dx = tx - c.x, dy = ty - c.y;
  const d = Math.hypot(dx, dy);

  // A hostile door in the way: stop here and start hitting it.
  const door = map.doorAt(tx, ty);
  if (door !== 0 && map.ownerAt(tx, ty) !== c.owner && c.owner !== Owner.None) {
    c.facing = Math.atan2(dy, dx);
    c.state = CreatureState.Fighting;
    if (c.stateTimer % 10 === 0) {
      const damage = Math.max(2, strengthOf(c));
      if (world.damageDoor(tx, ty, damage)) c.state = CreatureState.Walking;
    }
    return false;
  }

  // Bail out if the world changed under us and the next step is now solid.
  if (!passableFor(map, c)(tx, ty)) { c.path = null; return true; }

  const step = speedOf(c) * dt;
  if (d <= step) {
    c.x = tx; c.y = ty;
    c.pathIndex++;
    if (c.pathIndex >= c.path.length) { c.path = null; return true; }
    return false;
  }
  c.x += (dx / d) * step;
  c.y += (dy / d) * step;
  c.facing = Math.atan2(dy, dx);
  return false;
}

/** Drift a step in a random direction — used for idling and milling about. */
function wander(world: AIWorld, c: Creature): void {
  const { map } = world;
  const pass = passableFor(map, c);
  for (let attempt = 0; attempt < 6; attempt++) {
    const a = simRandom() * Math.PI * 2;
    const r = 2 + simRandom() * 4;
    const nx = Math.round(c.x + Math.cos(a) * r);
    const ny = Math.round(c.y + Math.sin(a) * r);
    if (!map.inBounds(nx, ny) || !pass(nx, ny)) continue;
    if (setPathTo(world, c, map.idx(nx, ny))) {
      c.state = CreatureState.Walking;
      return;
    }
  }
}

/* ============================================================ combat ===== */

/** Nearest hostile creature within `range` tiles, or null. */
function findEnemy(world: AIWorld, c: Creature, range: number): Creature | null {
  let best: Creature | null = null;
  let bestD = range * range;
  for (const other of world.creatures) {
    if (other.id === c.id || other.inHand) continue;
    if (other.state === CreatureState.Dying) continue;
    if (!isHostileTo(c, other)) continue;
    const d = dist2(c.x, c.y, other.x, other.y);
    if (d < bestD) { bestD = d; best = other; }
  }
  return best;
}

/**
 * Nearest hostile standing on ground we own, however far off.
 *
 * Without this a raiding party that survives the first clash simply wanders
 * around your dungeon untouched forever: creatures only noticed enemies six
 * tiles away, so nobody ever went looking. A dungeon that does not hunt down
 * intruders never finishes a fight, which means a raid is never repelled and
 * the level stops progressing.
 */
function findIntruder(world: AIWorld, c: Creature, range: number): Creature | null {
  const { map } = world;
  let best: Creature | null = null;
  let bestD = range * range;
  for (const other of world.creatures) {
    if (other.id === c.id || other.inHand) continue;
    if (other.state === CreatureState.Dying) continue;
    if (!isHostileTo(c, other)) continue;
    // Only inside our own borders. Chasing enemies across the map turns every
    // creature into a wandering hero-hunter and empties the dungeon.
    if (map.ownerAt(Math.round(other.x), Math.round(other.y)) !== c.owner) continue;
    const d = dist2(c.x, c.y, other.x, other.y);
    if (d < bestD) { bestD = d; best = other; }
  }
  return best;
}

function applyDamage(world: AIWorld, attacker: Creature | null, victim: Creature, amount: number): void {
  victim.hp -= amount;
  world.effect('hit', victim.x, victim.y);
  if (victim.hp > 0) {
    // Being hit interrupts whatever comfortable thing you were doing.
    if (victim.state === CreatureState.Sleeping || victim.state === CreatureState.Eating) {
      victim.state = CreatureState.Idle;
      victim.path = null;
    }
    return;
  }
  victim.hp = 0;
  victim.state = CreatureState.Dying;
  victim.stateTimer = 0;
  if (attacker) {
    attacker.experience += 60;
    levelUpIfReady(world, attacker);
  }
}

function levelUpIfReady(world: AIWorld, c: Creature): void {
  while (c.level < 10 && c.experience >= xpForNextLevel(c.level)) {
    c.experience -= xpForNextLevel(c.level);
    c.level++;
    c.hp = maxHpOf(c);
    world.effect('levelup', c.x, c.y);
    if (c.owner === Owner.Player) {
      world.notify(`Your ${CREATURE_SPECS[c.type].name} has reached level ${c.level}.`,
        'creature-levelled');
    }
  }
}

function doFighting(world: AIWorld, c: Creature, dt: number): void {
  const target = world.creatures.find((o) => o.id === c.targetCreature);
  if (!target || target.state === CreatureState.Dying || target.inHand) {
    c.targetCreature = -1;
    c.state = CreatureState.Idle;
    return;
  }
  const d = Math.hypot(target.x - c.x, target.y - c.y);
  c.facing = Math.atan2(target.y - c.y, target.x - c.x);

  if (d > 1.4) {
    // Close the distance, re-pathing every so often as the target moves.
    if (!c.path || c.stateTimer % 10 === 0) {
      setPathTo(world, c, world.map.idx(Math.round(target.x), Math.round(target.y)));
    }
    advancePath(world, c, dt);
    return;
  }
  c.path = null;
  // Swing roughly twice a second.
  if (c.stateTimer % 10 === 0) {
    const spec = CREATURE_SPECS[target.type];
    const damage = Math.max(1, strengthOf(c) - spec.defense * 0.5);
    applyDamage(world, c, target, damage);
    // Retaliate: a survivor stops what it's doing and hits back.
    if (target.hp > 0 && target.state !== CreatureState.Fighting) {
      target.state = CreatureState.Fighting;
      target.targetCreature = c.id;
      target.stateTimer = 5;
      target.path = null;
    }
  }
}

/* ============================================================= imps ====== */

/**
 * Imps are the engine of the dungeon: they dig, they claim, they haul, and
 * they never ask for wages. Their job list is a strict priority ladder, which
 * is what makes a swarm of them feel purposeful rather than random.
 */
function thinkImp(world: AIWorld, c: Creature): void {
  const { map } = world;
  const ix = Math.round(c.x), iy = Math.round(c.y);
  const pass = passableFor(map, c);

  // 1. Carrying gold? Get it into a treasury before doing anything else.
  if (c.goldHeld > 0) {
    // Already standing in the vault — hand it over where you are. Pathing to the
    // tile you are on is the kind of request a pathfinder is entitled to refuse,
    // and refusing it here would send the load back onto the floor in a loop.
    if (map.roomAt(ix, iy) === RoomType.Treasury && map.ownerAt(ix, iy) === c.owner) {
      c.targetTile = map.idx(ix, iy);
      c.state = CreatureState.Hauling;
      return;
    }
    const target = nearestRoomTile(map, world.rooms, c.owner, RoomType.Treasury, ix, iy);
    if (target >= 0 && setPathTo(world, c, target)) {
      c.state = CreatureState.Hauling;
      c.targetTile = target;
      return;
    }
    // Nowhere to put it, or no way to get there. Set it down where it stands
    // rather than deleting it: an unreachable treasury is a problem the player
    // can fix, and the gold should still be there when they do.
    map.dropGold(ix, iy, c.goldHeld);
    c.goldHeld = 0;
  }

  // 2. Gold on the floor nearby, and somewhere to put it.
  //
  // Ahead of digging, so an imp that has just brought a seam down ferries its own
  // spoil away instead of walking off to the next wall and leaving it — which is
  // exactly what the player is watching for when they tag a gold seam.
  //
  // But only what is *close*. Unbounded, this outranked tagged digging across the
  // whole map: one heap in a far corner would pull the entire workforce off the
  // slab the player had just marked, and the dig visibly stalled. Near enough to
  // be "the gold I am standing next to", not "any gold in the realm".
  if (world.hasTreasurySpace(c.owner)) {
    const pile = world.finder.findNearest(
      ix, iy,
      (x, y) => pass(x, y),
      (x, y) => map.looseGoldAt(x, y) > 0
        && Math.abs(x - ix) + Math.abs(y - iy) <= LOOSE_GOLD_REACH,
    );
    if (pile >= 0 && setPathTo(world, c, pile)) {
      c.targetTile = pile;
      c.state = CreatureState.Walking;
      return;
    }
  }

  // 3. Dig anything the keeper has tagged.
  const digTarget = world.finder.findNearest(
    ix, iy,
    (x, y) => pass(x, y),
    // Only tags with a reachable face are workable right now; the rest of a
    // tagged slab becomes diggable as the outer layer comes away.
    (x, y) => world.hasDigOrder(c.owner, x, y) && isDiggable(map.terrainAt(x, y))
      && map.hasExposedFace(x, y),
  );
  if (digTarget >= 0) {
    const stand = adjacentStandTile(map, digTarget, c);
    if (stand >= 0 && setPathTo(world, c, stand)) {
      c.targetTile = digTarget;
      c.state = CreatureState.Walking;
      return;
    }
  }

  // 3. Claim neutral floor that touches our territory.
  const claimTarget = world.finder.findNearest(
    ix, iy,
    (x, y) => pass(x, y),
    (x, y) => {
      const t = map.terrainAt(x, y);
      if (t === Terrain.Path) return map.touchesOwnedFloor(x, y, c.owner);
      // Enemy floor next to ours is fair game too.
      return t === Terrain.Claimed && map.ownerAt(x, y) !== c.owner
        && map.touchesOwnedFloor(x, y, c.owner);
    },
  );
  if (claimTarget >= 0 && setPathTo(world, c, claimTarget)) {
    c.targetTile = claimTarget;
    c.state = CreatureState.Walking;
    return;
  }

  // 4. Reinforce exposed earth walls around our floor.
  const wallTarget = world.finder.findNearest(
    ix, iy,
    (x, y) => pass(x, y),
    (x, y) => map.terrainAt(x, y) === Terrain.Earth && map.touchesOwnedFloor(x, y, c.owner),
    1200,
  );
  if (wallTarget >= 0) {
    const stand = adjacentStandTile(map, wallTarget, c);
    if (stand >= 0 && setPathTo(world, c, stand)) {
      c.targetTile = wallTarget;
      c.state = CreatureState.Walking;
      return;
    }
  }

  /*
   * 5. Fetch gold from anywhere at all.
   *
   * The near-range sweep at the top of the ladder is deliberately short, so that
   * one heap in a far corner cannot pull the whole workforce off a slab the
   * player has just tagged. But short and *only* short meant gold could be
   * stranded for the rest of the level: spoil an imp could not carry, a load set
   * down because the vault was briefly full or unreachable, the contents of a
   * seam dug out by an imp that then wandered off. None of it was lost — it sat
   * on the floor, in plain sight, with nobody ever coming back for it, which
   * from the player's chair is indistinguishable from it having been lost.
   *
   * So the same errand runs again with no distance limit, but only once there is
   * nothing to dig, claim or reinforce. It can never delay work; it just means
   * the dungeon eventually tidies up after itself.
   */
  if (world.hasTreasurySpace(c.owner)) {
    const stranded = world.finder.findNearest(
      ix, iy,
      (x, y) => pass(x, y),
      (x, y) => map.looseGoldAt(x, y) > 0,
    );
    if (stranded >= 0 && setPathTo(world, c, stranded)) {
      c.targetTile = stranded;
      c.state = CreatureState.Walking;
      return;
    }
  }

  // 6. Nothing to do. Mill about so the dungeon never looks frozen.
  wander(world, c);
}

/** Run the work an imp does once it has arrived at its target tile. */
function impWorkAtTarget(world: AIWorld, c: Creature): boolean {
  const { map } = world;
  if (c.targetTile < 0) return false;
  const tx = map.xOf(c.targetTile), ty = map.yOf(c.targetTile);
  if (dist2(c.x, c.y, tx, ty) > 2.5) return false;
  c.facing = Math.atan2(ty - c.y, tx - c.x);

  const terrain = map.terrainAt(tx, ty);

  // Excavating.
  if (world.hasDigOrder(c.owner, tx, ty) && isDiggable(terrain)) {
    c.state = CreatureState.Digging;
    const gold = map.digTile(tx, ty, IMP_DIG_RATE);
    if (c.stateTimer % 6 === 0) world.effect('dig', tx, ty);
    if (gold >= 0) {
      world.effect('poof', tx, ty);
      if (gold > 0) {
        c.goldHeld = Math.min(IMP_CARRY_CAPACITY, gold);
        // Whatever will not fit in a pair of hands stays on the floor to be
        // fetched, rather than being deleted where it fell.
        if (gold > c.goldHeld) map.dropGold(tx, ty, gold - c.goldHeld);
        world.effect('gold', tx, ty);
      }
      c.targetTile = -1;
      c.state = CreatureState.Idle;
      c.thinkCooldown = 0;
    }
    return true;
  }

  // Picking gold up off the floor. Ahead of claiming, because a heap can be
  // sitting on unclaimed rock and the claim would win the tile and never look
  // down at what was on it.
  if (c.goldHeld < IMP_CARRY_CAPACITY && map.looseGoldAt(tx, ty) > 0) {
    c.goldHeld += map.takeGold(tx, ty, IMP_CARRY_CAPACITY - c.goldHeld);
    world.effect('gold', tx, ty);
    c.targetTile = -1;
    c.state = CreatureState.Idle;
    c.thinkCooldown = 0;
    return true;
  }

  // Claiming floor.
  if (terrain === Terrain.Path || (terrain === Terrain.Claimed && map.ownerAt(tx, ty) !== c.owner)) {
    c.state = CreatureState.Claiming;
    if (map.claimTile(tx, ty, c.owner, IMP_CLAIM_RATE)) {
      world.effect('claim', tx, ty);
      c.targetTile = -1;
      c.state = CreatureState.Idle;
      c.thinkCooldown = 0;
    }
    return true;
  }

  // Reinforcing a wall.
  if (terrain === Terrain.Earth && map.touchesOwnedFloor(tx, ty, c.owner)) {
    c.state = CreatureState.Claiming;
    if (c.stateTimer > TICKS_PER_SECOND * 1.5) {
      map.reinforce(tx, ty, c.owner);
      world.effect('claim', tx, ty);
      c.targetTile = -1;
      c.state = CreatureState.Idle;
      c.thinkCooldown = 0;
    }
    return true;
  }

  // Delivering gold.
  if (c.goldHeld > 0 && map.roomAt(tx, ty) === RoomType.Treasury && map.ownerAt(tx, ty) === c.owner) {
    const stored = world.depositGold(c.owner, c.goldHeld);
    c.goldHeld -= stored;
    world.effect('gold', tx, ty);
    if (c.goldHeld > 0) {
      // A full treasury used to park every imp on it permanently: nothing fit,
      // so the load never cleared, so this branch kept reporting "still working"
      // and the whole workforce stopped digging for the rest of the level.
      //
      // So the load comes off the imp either way — but onto the floor, not into
      // nothing. `depositGold` has already said the treasury is full; a growing
      // heap of gold beside it says the same thing in the place the player is
      // actually looking, and none of it is lost when they build more vault.
      map.dropGold(tx, ty, c.goldHeld);
      c.goldHeld = 0;
    }
    // And sweep up whatever was spilled on this tile while the vault was full, so
    // overflow finds its way in once there is room without needing an errand.
    const spilled = map.looseGoldAt(tx, ty);
    if (spilled > 0) {
      const swept = world.depositGold(c.owner, spilled);
      if (swept > 0) map.takeGold(tx, ty, swept);
    }
    if (c.goldHeld <= 0) {
      c.goldHeld = 0;
      c.targetTile = -1;
      c.state = CreatureState.Idle;
      c.thinkCooldown = 0;
    }
    return true;
  }

  c.targetTile = -1;
  return false;
}

/**
 * Send a hero at the closest Dungeon Heart it can reach.
 *
 * Whichever keeper it belongs to: the surface does not much care which of you it
 * is killing. Returns false if no heart is reachable, so the caller can fall
 * back to milling about rather than freezing on the spot.
 */
function marchOnNearestHeart(world: AIWorld, c: Creature): boolean {
  const { map } = world;
  let best = -1;
  let bestD = Infinity;
  for (const owner of [Owner.Player, Owner.KeeperBlue, Owner.KeeperGreen]) {
    const tile = heartTile(map, world.rooms, owner);
    if (tile < 0) continue;
    const d = dist2(c.x, c.y, map.xOf(tile), map.yOf(tile));
    if (d < bestD) { bestD = d; best = tile; }
  }
  if (best < 0) return false;
  if (!setPathTo(world, c, best)) return false;
  c.state = CreatureState.Walking;
  c.targetTile = best;
  return true;
}

/**
 * Tear at an enemy heart, one swing at a time.
 *
 * A defender who turns up interrupts this, because `updateCreature` re-checks
 * for enemies first — which is what makes an assault something you can answer
 * rather than a countdown you watch.
 */
function doHeartBreaking(world: AIWorld, c: Creature): void {
  const { map } = world;
  if (c.targetTile < 0) { c.state = CreatureState.Idle; return; }
  const tx = map.xOf(c.targetTile), ty = map.yOf(c.targetTile);
  const owner = map.ownerAt(tx, ty);

  // The heart may already be gone, or someone may have reclaimed the tile.
  if (map.roomAt(tx, ty) !== RoomType.DungeonHeart || owner === c.owner
    || owner === Owner.None) {
    c.targetTile = -1;
    c.state = CreatureState.Idle;
    c.thinkCooldown = 0;
    return;
  }
  if (dist2(c.x, c.y, tx, ty) > 2.5) {
    c.state = CreatureState.Idle;
    c.thinkCooldown = 0;
    return;
  }

  c.facing = Math.atan2(ty - c.y, tx - c.x);
  if (c.stateTimer % 10 !== 0) return;
  world.damageHeart(owner, strengthOf(c) * 1.5);
  world.effect('hit', tx + (simRandom() - 0.5), ty + (simRandom() - 0.5));
}

/**
 * A hostile Dungeon Heart tile next to this creature, or -1.
 *
 * Adjacency rather than range: you have to be standing on the thing to tear at
 * it, which is what makes the defender's counter-attack meaningful.
 */
function adjacentEnemyHeart(world: AIWorld, c: Creature): number {
  const { map } = world;
  const cx = Math.round(c.x), cy = Math.round(c.y);
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const x = cx + dx, y = cy + dy;
    if (!map.inBounds(x, y)) continue;
    if (map.roomAt(x, y) !== RoomType.DungeonHeart) continue;
    const owner = map.ownerAt(x, y);
    if (owner === c.owner || owner === Owner.None) continue;
    return map.idx(x, y);
  }
  return -1;
}

/**
 * Head for the nearest hostile heart, if we are already inside their dungeon.
 *
 * This is what a creature dropped into an enemy dungeon does, and it is how the
 * original's raids resolved: get in, find the heart, break it. Restricting it to
 * creatures already standing on enemy ground keeps the whole roster from
 * marching off to war the moment a rival exists.
 */
function siegeEnemyHeart(world: AIWorld, c: Creature): boolean {
  const { map } = world;
  const cx = Math.round(c.x), cy = Math.round(c.y);
  const ground = map.ownerAt(cx, cy);
  if (ground === c.owner || ground === Owner.None || ground === Owner.Heroes) return false;

  const heart = heartTile(map, world.rooms, ground);
  if (heart < 0) return false;
  if (!setPathTo(world, c, heart)) return false;
  c.state = CreatureState.Walking;
  c.targetTile = heart;
  return true;
}

/* ==================================================== regular creatures == */

/**
 * Non-worker creatures run on needs first, job second — hunger and exhaustion
 * outrank whatever you'd like them to be doing, which is exactly why the
 * original punishes you for building a training room before a hatchery.
 */
function thinkCreature(world: AIWorld, c: Creature): void {
  const { map } = world;
  const ix = Math.round(c.x), iy = Math.round(c.y);
  const spec = CREATURE_SPECS[c.type];

  // Enemies in the room trump everything.
  const enemy = findEnemy(world, c, 6);
  if (enemy) {
    c.state = CreatureState.Fighting;
    c.targetCreature = enemy.id;
    c.path = null;
    return;
  }

  // Standing next to an enemy heart with nobody left to fight? Break it.
  const heart = adjacentEnemyHeart(world, c);
  if (heart >= 0) {
    c.state = CreatureState.AttackingHeart;
    c.targetTile = heart;
    c.path = null;
    return;
  }

  // Intruders in the dungeon get hunted. This is what turns "some heroes got in"
  // into a fight that ends, and it is what a keeper's creatures are for.
  const intruder = findIntruder(world, c, 30);
  if (intruder) {
    const tile = map.idx(Math.round(intruder.x), Math.round(intruder.y));
    if (setPathTo(world, c, tile)) {
      c.state = CreatureState.Walking;
      c.targetTile = tile;
      c.targetCreature = intruder.id;
      return;
    }
  }

  // Disgruntled creatures walk out through the portal. This applies to rival
  // keepers too: exempting them let a bankrupt rival keep an army it could not
  // pay for, and it out-grew the player purely by being immune to its own
  // mistakes.
  if (c.anger >= 100 && c.owner !== Owner.Heroes) {
    const portal = nearestRoomTile(map, world.rooms, c.owner, RoomType.Portal, ix, iy);
    if (portal >= 0 && setPathTo(world, c, portal)) {
      c.state = CreatureState.LeavingDungeon;
      c.targetTile = portal;
      if (c.owner === Owner.Player) {
        world.notify(`Your ${spec.name} is leaving in disgust!`, 'creature-left');
      }
      return;
    }
  }

  // Hungry: find a chicken.
  if (c.hunger > 65 && world.foodOf(c.owner) > 0) {
    const hatchery = nearestRoomTile(map, world.rooms, c.owner, RoomType.Hatchery, ix, iy);
    if (hatchery >= 0 && setPathTo(world, c, hatchery)) {
      c.state = CreatureState.Walking;
      c.targetTile = hatchery;
      return;
    }
  }

  // Tired or hurt: go to bed.
  if (c.tiredness > 70 || c.hp < maxHpOf(c) * 0.4) {
    if (c.lairTile >= 0 && map.roomAt(map.xOf(c.lairTile), map.yOf(c.lairTile)) === RoomType.Lair) {
      if (setPathTo(world, c, c.lairTile)) {
        c.state = CreatureState.Walking;
        c.targetTile = c.lairTile;
        return;
      }
    }
    const lair = nearestRoomTile(
      map, world.rooms, c.owner, RoomType.Lair, ix, iy,
      (t) => world.isLairFree(t),
    );
    if (lair >= 0 && setPathTo(world, c, lair)) {
      world.claimLair(c, lair);
      c.state = CreatureState.Walking;
      c.targetTile = lair;
      return;
    }
    // No bed available: that's what makes creatures angry.
    c.anger = Math.min(100, c.anger + 6);
  }

  // Heroes came down here to do something. Left to the code below they had no
  // job, no lair and nothing to want, so they fell through to `wander` and
  // pottered about the map at random — which is why a raid never actually
  // arrived and never actually ended. They march on the nearest keeper's heart,
  // whoever it belongs to: heroes are everybody's problem.
  if (c.owner === Owner.Heroes) {
    if (marchOnNearestHeart(world, c)) return;
    wander(world, c);
    return;
  }

  // Called to arms. This outranks the creature's job because that is the whole
  // point of the spell: it is how a keeper invades. You cannot drop creatures on
  // ground you do not own, so without a standing rally there is no way to press
  // an attack into a rival's dungeon at all.
  const rally = world.rallyTile(c.owner);
  if (rally >= 0) {
    const rx = map.xOf(rally), ry = map.yOf(rally);
    if (dist2(c.x, c.y, rx, ry) > 9) {
      if (setPathTo(world, c, rally)) {
        c.state = CreatureState.Walking;
        c.targetTile = rally;
        return;
      }
    } else {
      // Already at the flag: hold the ground instead of drifting home.
      c.state = CreatureState.Idle;
      c.path = null;
      c.thinkCooldown = TICKS_PER_SECOND * 2;
      return;
    }
  }

  // A creature standing in someone else's dungeon is there to wreck it. This is
  // what the Hand of Evil is for: drop your monsters on a rival's floor and they
  // go looking for the heart.
  if (siegeEnemyHeart(world, c)) return;

  // Otherwise, do the job this creature is here for.
  for (const job of spec.jobs) {
    if (job === RoomType.TrainingRoom && world.goldOf(c.owner) < 50) continue;
    const tile = nearestRoomTile(map, world.rooms, c.owner, job, ix, iy);
    if (tile >= 0 && setPathTo(world, c, tile)) {
      c.state = CreatureState.Walking;
      c.targetTile = tile;
      return;
    }
  }

  wander(world, c);
}

/** Work performed once a creature has arrived somewhere meaningful. */
function creatureWorkAtTarget(world: AIWorld, c: Creature): boolean {
  const { map } = world;
  if (c.targetTile < 0) return false;
  const tx = map.xOf(c.targetTile), ty = map.yOf(c.targetTile);
  if (dist2(c.x, c.y, tx, ty) > 1.2) return false;

  const room = map.roomAt(tx, ty);
  switch (room) {
    case RoomType.Hatchery:
      if (c.hunger > 5) {
        c.state = CreatureState.Eating;
        if (c.stateTimer % 12 === 0 && world.consumeFood(c.owner)) {
          c.hunger = Math.max(0, c.hunger - 45);
          c.hp = Math.min(maxHpOf(c), c.hp + maxHpOf(c) * 0.1);
          world.effect('eat', c.x, c.y);
        }
        if (c.hunger <= 5) { c.targetTile = -1; c.state = CreatureState.Idle; c.thinkCooldown = 0; }
        return true;
      }
      return false;

    case RoomType.Lair:
      c.state = CreatureState.Sleeping;
      c.tiredness = Math.max(0, c.tiredness - 0.9);
      c.hp = Math.min(maxHpOf(c), c.hp + maxHpOf(c) * 0.004);
      if (c.stateTimer % 25 === 0) world.effect('sleep', c.x, c.y);
      if (c.tiredness <= 2 && c.hp >= maxHpOf(c) * 0.95) {
        c.state = CreatureState.Idle;
        c.targetTile = -1;
        c.thinkCooldown = 0;
      }
      return true;

    case RoomType.TrainingRoom: {
      c.state = CreatureState.Training;
      if (c.stateTimer % 20 === 0) {
        // Training costs the keeper gold — the room is a money sink by design.
        if (world.withdrawGold(c.owner, 25) >= 25) {
          c.experience += 30;
          levelUpIfReady(world, c);
          world.effect('train', c.x, c.y);
        } else {
          c.state = CreatureState.Idle;
          c.targetTile = -1;
          c.thinkCooldown = 0;
          return true;
        }
      }
      c.tiredness = Math.min(100, c.tiredness + 0.18);
      c.hunger = Math.min(100, c.hunger + 0.14);
      return true;
    }

    case RoomType.Workshop:
      // The workshop's output is tallied centrally; the creature just works.
      c.state = CreatureState.Manufacturing;
      if (c.stateTimer % 18 === 0) world.effect('train', c.x, c.y);
      c.tiredness = Math.min(100, c.tiredness + 0.14);
      c.hunger = Math.min(100, c.hunger + 0.10);
      return true;

    case RoomType.Library:
      c.state = CreatureState.Researching;
      world.addResearch(c.owner, 0.5 * c.level);
      if (c.stateTimer % 30 === 0) world.effect('research', c.x, c.y);
      c.tiredness = Math.min(100, c.tiredness + 0.1);
      return true;

    case RoomType.Portal:
      if (c.state === CreatureState.LeavingDungeon) {
        world.effect('poof', c.x, c.y);
        world.notify(`Your ${CREATURE_SPECS[c.type].name} has abandoned you.`, 'creature-left');
        c.hp = 0;
        c.state = CreatureState.Dying;
        c.stateTimer = 100; // skip the death animation; it walked out
        return true;
      }
      return false;

    default:
      return false;
  }
}

/* ============================================================== tick ===== */

/** Advance one creature by one simulation tick. */
export function updateCreature(world: AIWorld, c: Creature, dt: number): void {
  c.stateTimer++;

  if (c.inHand) {
    c.state = CreatureState.InHand;
    return;
  }

  if (c.state === CreatureState.Dying) {
    if (c.stateTimer > TICKS_PER_SECOND * 1.2) world.onCreatureDied(c);
    return;
  }

  const spec = CREATURE_SPECS[c.type];
  if (c.hasteTicks > 0) c.hasteTicks--;

  // Needs creep upward whenever the creature isn't resting.
  if (!spec.worker) {
    if (c.state !== CreatureState.Eating) c.hunger = Math.min(100, c.hunger + 100 / spec.appetite);
    if (c.state !== CreatureState.Sleeping) c.tiredness = Math.min(100, c.tiredness + 0.035);
    if (c.hunger > 90 || c.tiredness > 95) c.anger = Math.min(100, c.anger + 0.05);
    else if (c.anger > 0 && c.state === CreatureState.Sleeping) c.anger = Math.max(0, c.anger - 0.08);
    // Starving creatures waste away.
    if (c.hunger >= 100) c.hp -= maxHpOf(c) * 0.0008;
    if (c.hp <= 0) {
      c.hp = 0;
      c.state = CreatureState.Dying;
      c.stateTimer = 0;
      return;
    }
  }

  // Being dropped leaves a creature briefly dazed, like the original's thud.
  if (c.state === CreatureState.Stunned) {
    if (c.stateTimer < TICKS_PER_SECOND * 0.6) return;
    c.state = CreatureState.Idle;
    c.thinkCooldown = 0;
  }

  if (c.state === CreatureState.Fighting) {
    doFighting(world, c, dt);
    return;
  }

  if (c.state === CreatureState.AttackingHeart) {
    doHeartBreaking(world, c);
    return;
  }

  // A defender always notices an intruder, whatever it was busy with.
  if (!spec.worker && c.stateTimer % 8 === 0) {
    const enemy = findEnemy(world, c, 4.5);
    if (enemy) {
      c.state = CreatureState.Fighting;
      c.targetCreature = enemy.id;
      c.path = null;
      return;
    }
  }

  // Walk the current path; on arrival, try to work.
  if (c.path) {
    const arrived = advancePath(world, c, dt);
    if (!arrived) {
      // Hauling is a kind of walking, and it survives the overwrite. It was not
      // surviving: the state lasted exactly one tick before this line replaced it,
      // so an imp on its way to the vault reported itself as merely Walking to the
      // tooltip and the message log for the whole journey.
      if (c.state !== CreatureState.LeavingDungeon && c.state !== CreatureState.Hauling) {
        c.state = CreatureState.Walking;
      }
      return;
    }
  }

  const worked = spec.worker ? impWorkAtTarget(world, c) : creatureWorkAtTarget(world, c);
  if (worked) return;

  // Idle: re-plan, but not every tick — thinking is the expensive part.
  if (c.thinkCooldown > 0) {
    c.thinkCooldown--;
    if (c.state === CreatureState.Walking) c.state = CreatureState.Idle;
    return;
  }
  c.thinkCooldown = 8 + simInt(12);
  c.stateTimer = 0;

  if (spec.worker) thinkImp(world, c);
  else thinkCreature(world, c);
}

/** Hurt a creature from outside the AI (spells, traps, the player's slap). */
export function damageCreature(world: AIWorld, victim: Creature, amount: number): void {
  applyDamage(world, null, victim, amount);
}

/** Heal a creature, capped at its level-adjusted maximum. */
export function healCreature(c: Creature, amount: number): void {
  c.hp = Math.min(maxHpOf(c), c.hp + amount);
}

/**
 * The slap. Speeds a creature up and hurts it a little — the original's blunt
 * instrument for making a lazy creature work faster.
 */
export function slapCreature(world: AIWorld, c: Creature): void {
  if (c.state === CreatureState.Dying || c.inHand) return;
  c.hasteTicks = TICKS_PER_SECOND * 6;
  c.anger = Math.min(100, c.anger + 4);
  c.hp -= maxHpOf(c) * 0.03;
  world.effect('slap', c.x, c.y);
  if (c.state === CreatureState.Sleeping) {
    c.state = CreatureState.Idle;
    c.thinkCooldown = 0;
    c.stateTimer = 0;
  }
  if (c.hp <= 0) {
    c.hp = 0;
    c.state = CreatureState.Dying;
    c.stateTimer = 0;
  }
}

/** Imps are summoned, not hatched; keep the spawn rules with the AI. */
export function impCost(existingImps: number): number {
  return Math.round(200 * Math.pow(1.35, existingImps));
}

export { CreatureType };
export const CLAIM_TOTAL = CLAIM_HEALTH;
