import {
  DIG_HEALTH,
  GOLD_PER_SEAM,
  Owner,
  RoomType,
  Terrain,
} from './constants';
import { CreatureType, createCreature } from './creatures';
import { Game } from './game';
import { generateObjectives } from './objectives';
import { Rng, valueNoise2D } from './rng';
import { seedSim } from './sim';
import { TileMap } from './tilemap';

export interface LevelOptions {
  width?: number;
  height?: number;
  seed?: number;
  /** Gold in the player's treasury at the start. */
  startingGold?: number;
  startingImps?: number;
  /** 0 gentle, 1 ordinary, 2 nasty. Scales the objective numbers. */
  difficulty?: number;
}

/**
 * Builds a playable realm.
 *
 * The shape follows the original's first few levels: a small pre-claimed
 * dungeon around your heart, gold seams close enough to reach in the first
 * minute, richer veins further out, and a hero gate on the far side of the map
 * that eventually starts sending people to kill you.
 */
export function generateLevel(opts: LevelOptions = {}): Game {
  const width = opts.width ?? 72;
  const height = opts.height ?? 72;
  const seed = opts.seed ?? 1997;
  const rng = new Rng(seed);
  // Seed the simulation too, not just the map. A seeded map on an unseeded
  // game diverges within seconds, which makes the seed a lie.
  seedSim(seed);

  const map = new TileMap(width, height);

  // --- bedrock border and scattered impenetrable clusters -----------------
  const rockNoise = valueNoise2D(rng, width, height, 9);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = map.idx(x, y);
      const edge = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
      if (edge || rockNoise[i] > 0.78) {
        map.terrain[i] = Terrain.Rock;
        map.health[i] = 0;
      } else {
        map.terrain[i] = Terrain.Earth;
        map.health[i] = DIG_HEALTH[Terrain.Earth];
      }
    }
  }

  // --- gold seams ---------------------------------------------------------
  const goldNoise = valueNoise2D(rng, width, height, 5);
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const i = map.idx(x, y);
      if (map.terrain[i] !== Terrain.Earth) continue;
      if (goldNoise[i] > 0.80) {
        map.terrain[i] = Terrain.Gold;
        map.health[i] = DIG_HEALTH[Terrain.Gold];
        map.gold[i] = GOLD_PER_SEAM;
      }
    }
  }

  const heart = { x: Math.round(width * 0.28), y: Math.round(height * 0.68) };
  const heroGate = { x: Math.round(width * 0.78), y: Math.round(height * 0.24) };

  // Guarantee a starter seam within easy digging distance of the heart, so the
  // opening minute always has something to mine.
  placeGoldBlob(map, rng, heart.x + 7, heart.y - 5, 3);
  placeGoldBlob(map, rng, heart.x - 6, heart.y + 4, 3);

  // --- gem seam: the long-term economy, deliberately far away -------------
  const gem = { x: Math.round(width * 0.62), y: Math.round(height * 0.80) };
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = gem.x + dx, y = gem.y + dy;
      if (!map.inBounds(x, y)) continue;
      const i = map.idx(x, y);
      map.terrain[i] = Terrain.Gems;
      map.health[i] = DIG_HEALTH[Terrain.Gems];
      map.gold[i] = GOLD_PER_SEAM;
    }
  }
  // Ring the gems in bedrock so there's exactly one way in worth digging.
  ringWith(map, gem.x, gem.y, 3, Terrain.Rock, (x, y) => !(x === gem.x && y > gem.y));

  // --- water and lava features -------------------------------------------
  carveLiquid(map, rng, Math.round(width * 0.5), Math.round(height * 0.45), 5, Terrain.Water);
  carveLiquid(map, rng, Math.round(width * 0.66), Math.round(height * 0.58), 4, Terrain.Lava);

  // --- the player's starting dungeon --------------------------------------
  carveRoom(map, heart.x - 4, heart.y - 4, heart.x + 4, heart.y + 4, Owner.Player);
  stampRoom(map, heart.x - 1, heart.y - 1, heart.x + 1, heart.y + 1, RoomType.DungeonHeart);

  // A small treasury and hatchery so the opening isn't a cold start.
  carveRoom(map, heart.x + 5, heart.y - 2, heart.x + 7, heart.y + 1, Owner.Player);
  stampRoom(map, heart.x + 5, heart.y - 2, heart.x + 7, heart.y + 1, RoomType.Treasury);
  connect(map, heart.x + 4, heart.y, heart.x + 5, heart.y, Owner.Player);

  carveRoom(map, heart.x - 7, heart.y - 2, heart.x - 5, heart.y + 1, Owner.Player);
  stampRoom(map, heart.x - 7, heart.y - 2, heart.x - 5, heart.y + 1, RoomType.Lair);
  connect(map, heart.x - 5, heart.y, heart.x - 4, heart.y, Owner.Player);

  // The creature portal, a short corridor north of the heart.
  const portal = { x: heart.x, y: heart.y - 8 };
  carveRoom(map, portal.x - 1, portal.y - 1, portal.x + 1, portal.y + 1, Owner.Player);
  stampRoom(map, portal.x - 1, portal.y - 1, portal.x + 1, portal.y + 1, RoomType.Portal);
  connect(map, heart.x, heart.y - 4, portal.x, portal.y + 1, Owner.Player);

  // --- the hero gate ------------------------------------------------------
  carveRoom(map, heroGate.x - 2, heroGate.y - 2, heroGate.x + 2, heroGate.y + 2, Owner.Heroes);
  stampRoom(map, heroGate.x - 1, heroGate.y - 1, heroGate.x + 1, heroGate.y + 1, RoomType.Portal);
  // A path leading out of the gate, so heroes aren't sealed in bedrock.
  connect(map, heroGate.x, heroGate.y + 2, heroGate.x, heroGate.y + 9, Owner.None);

  // --- a rival keeper's dungeon -------------------------------------------
  // Given the same opening the player gets: a heart, a treasury to bank into, a
  // lair and a hatchery. Without those its portal admits nobody and its imps
  // have nowhere to put gold, and a rival that cannot grow is scenery.
  const rival = { x: Math.round(width * 0.74), y: Math.round(height * 0.72) };
  carveRoom(map, rival.x - 4, rival.y - 4, rival.x + 4, rival.y + 4, Owner.KeeperBlue);
  stampRoom(map, rival.x - 1, rival.y - 1, rival.x + 1, rival.y + 1, RoomType.DungeonHeart);
  stampRoom(map, rival.x + 2, rival.y - 4, rival.x + 4, rival.y - 2, RoomType.Treasury);
  stampRoom(map, rival.x - 4, rival.y + 2, rival.x - 2, rival.y + 4, RoomType.Lair);
  stampRoom(map, rival.x + 2, rival.y + 2, rival.x + 4, rival.y + 4, RoomType.Hatchery);

  const rivalPortal = { x: rival.x, y: rival.y - 7 };
  carveRoom(map, rivalPortal.x - 1, rivalPortal.y - 1,
    rivalPortal.x + 1, rivalPortal.y + 1, Owner.KeeperBlue);
  stampRoom(map, rivalPortal.x - 1, rivalPortal.y - 1,
    rivalPortal.x + 1, rivalPortal.y + 1, RoomType.Portal);
  connect(map, rival.x, rival.y - 4, rivalPortal.x, rivalPortal.y + 1, Owner.KeeperBlue);

  map.version++;

  // --- populate ------------------------------------------------------------
  const game = new Game(map);
  const player = game.keeper(Owner.Player);
  player.gold = opts.startingGold ?? 2500;
  player.mana = 3000;
  player.food = 0;

  const impCount = opts.startingImps ?? 4;
  for (let i = 0; i < impCount; i++) {
    const angle = (i / impCount) * Math.PI * 2;
    const x = heart.x + Math.round(Math.cos(angle) * 2.5);
    const y = heart.y + Math.round(Math.sin(angle) * 2.5);
    game.creatures.push(createCreature(CreatureType.Imp, Owner.Player, x, y));
  }

  // The rival's own workforce, and a little capital to build with.
  const blue = game.keeper(Owner.KeeperBlue);
  blue.gold = 1800;
  blue.mana = 1000;
  for (let i = 0; i < 4; i++) {
    game.creatures.push(
      createCreature(CreatureType.Imp, Owner.KeeperBlue, rival.x + (i % 2), rival.y + (i >> 1)));
  }
  game.registerRival(Owner.KeeperBlue);

  // --- the point of the level ---------------------------------------------
  game.setObjectives(generateObjectives(rng, {
    rivals: [Owner.KeeperBlue],
    difficulty: opts.difficulty ?? 1,
  }));

  map.revealRadius(heart.x, heart.y, 12);
  game.notify(
    'Your Dungeon Heart beats. Tag walls to dig, and claim what you dig.', 'level-start');

  return game;
}

/* ------------------------------------------------------------- helpers --- */

/** Hollow out a rectangle into claimed floor for `owner` (or bare path). */
function carveRoom(
  map: TileMap, x0: number, y0: number, x1: number, y1: number, owner: Owner,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!map.inBounds(x, y)) continue;
      const i = map.idx(x, y);
      map.terrain[i] = owner === Owner.None ? Terrain.Path : Terrain.Claimed;
      map.owner[i] = owner;
      map.health[i] = owner === Owner.None ? 0 : 60;
      map.gold[i] = 0;
      map.flags[i] = 0;
    }
  }
}

/** Mark a carved rectangle as a room. */
function stampRoom(
  map: TileMap, x0: number, y0: number, x1: number, y1: number, room: RoomType,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!map.inBounds(x, y)) continue;
      map.room[map.idx(x, y)] = room;
    }
  }
}

/** Dig a one-tile corridor between two points (L-shaped). */
function connect(
  map: TileMap, x0: number, y0: number, x1: number, y1: number, owner: Owner,
): void {
  let x = x0, y = y0;
  const step = (a: number, b: number) => (a < b ? 1 : a > b ? -1 : 0);
  while (x !== x1) { carveRoom(map, x, y, x, y, owner); x += step(x, x1); }
  while (y !== y1) { carveRoom(map, x, y, x, y, owner); y += step(y, y1); }
  carveRoom(map, x1, y1, x1, y1, owner);
}

/** Drop a rough circular blob of gold seam. */
function placeGoldBlob(map: TileMap, rng: Rng, cx: number, cy: number, r: number): void {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r + rng.float(-1, 1.5)) continue;
      const x = cx + dx, y = cy + dy;
      if (!map.inBounds(x, y)) continue;
      const i = map.idx(x, y);
      if (map.terrain[i] !== Terrain.Earth) continue;
      map.terrain[i] = Terrain.Gold;
      map.health[i] = DIG_HEALTH[Terrain.Gold];
      map.gold[i] = GOLD_PER_SEAM;
    }
  }
}

/** Fill a ring at radius `r` with a terrain, optionally leaving a gap. */
function ringWith(
  map: TileMap, cx: number, cy: number, r: number, t: Terrain,
  keepOpen?: (x: number, y: number) => boolean,
): void {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = cx + dx, y = cy + dy;
      if (!map.inBounds(x, y)) continue;
      if (keepOpen && !keepOpen(x, y)) continue;
      const i = map.idx(x, y);
      if (map.terrain[i] === Terrain.Gems) continue;
      map.terrain[i] = t;
      map.health[i] = 0;
    }
  }
}

/** Carve a blobby pool of water or lava. */
function carveLiquid(
  map: TileMap, rng: Rng, cx: number, cy: number, r: number, t: Terrain,
): void {
  for (let dy = -r - 2; dy <= r + 2; dy++) {
    for (let dx = -r - 2; dx <= r + 2; dx++) {
      const wobble = rng.float(-1.4, 1.4);
      if (Math.hypot(dx, dy) > r + wobble) continue;
      const x = cx + dx, y = cy + dy;
      if (!map.inBounds(x, y)) continue;
      const i = map.idx(x, y);
      if (map.terrain[i] === Terrain.Rock) continue;
      map.terrain[i] = t;
      map.owner[i] = Owner.None;
      map.health[i] = 0;
      map.gold[i] = 0;
    }
  }
}
