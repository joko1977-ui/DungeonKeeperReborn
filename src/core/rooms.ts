import {
  Owner,
  ROOM_SPECS,
  RoomType,
  TREASURY_TILE_CAPACITY,
  Terrain,
} from './constants';
import { TileMap } from './tilemap';

/**
 * A lookup of "which tiles belong to room R owned by keeper K".
 *
 * Rebuilt lazily whenever the map version changes. The AI hits this every time
 * a creature picks a job, so a full scan per query was never going to fly; a
 * scan per *map edit* is fine, since edits are rare compared to queries.
 */
export class RoomIndex {
  private mapVersion = -1;
  private readonly buckets = new Map<number, number[]>();

  private static key(owner: Owner, type: RoomType): number {
    return owner * 16 + type;
  }

  refresh(map: TileMap): void {
    if (map.version === this.mapVersion) return;
    this.mapVersion = map.version;
    this.buckets.clear();
    const { room, owner, terrain } = map;
    for (let i = 0; i < room.length; i++) {
      const r = room[i] as RoomType;
      if (r === RoomType.None) continue;
      if (terrain[i] !== Terrain.Claimed) continue;
      const k = RoomIndex.key(owner[i] as Owner, r);
      let list = this.buckets.get(k);
      if (!list) this.buckets.set(k, (list = []));
      list.push(i);
    }
  }

  tilesOf(map: TileMap, owner: Owner, type: RoomType): number[] {
    this.refresh(map);
    return this.buckets.get(RoomIndex.key(owner, type)) ?? [];
  }

  count(map: TileMap, owner: Owner, type: RoomType): number {
    return this.tilesOf(map, owner, type).length;
  }
}

/** How much gold a keeper's treasury can hold. */
export function treasuryCapacity(map: TileMap, index: RoomIndex, owner: Owner): number {
  return index.count(map, owner, RoomType.Treasury) * TREASURY_TILE_CAPACITY;
}

export interface BuildResult {
  placed: number;
  spent: number;
  /** Why nothing (or not everything) was placed, for the UI to echo. */
  reason: string | null;
}

/**
 * Attempt to build `type` across a rectangle of tiles.
 *
 * Follows the original's forgiving behaviour: tiles that can't take the room are
 * skipped silently rather than aborting the whole drag, and you're only charged
 * for what actually got built.
 */
export function buildRoom(
  map: TileMap,
  owner: Owner,
  type: RoomType,
  x0: number, y0: number, x1: number, y1: number,
  availableGold: number,
): BuildResult {
  const spec = ROOM_SPECS[type];
  if (!spec.buildable) return { placed: 0, spent: 0, reason: 'That room cannot be built.' };

  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);

  let placed = 0;
  let spent = 0;
  let sawIneligible = false;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!map.inBounds(x, y)) continue;
      const i = map.idx(x, y);
      const isOwnedFloor = map.terrain[i] === Terrain.Claimed && map.owner[i] === owner;
      if (!isOwnedFloor || map.room[i] !== RoomType.None) {
        if (!isOwnedFloor) sawIneligible = true;
        continue;
      }
      if (spent + spec.cost > availableGold) {
        return {
          placed, spent,
          reason: placed > 0 ? 'You ran out of gold.' : 'You do not have enough gold.',
        };
      }
      map.room[i] = type;
      spent += spec.cost;
      placed++;
    }
  }
  if (placed > 0) map.version++;
  return {
    placed, spent,
    reason: placed === 0 && sawIneligible ? 'Rooms must be built on your own floor.' : null,
  };
}

/** Tear a room out again. Refunds half the build cost, as in the original. */
export function sellRoom(
  map: TileMap,
  owner: Owner,
  x: number, y: number,
): { refund: number; type: RoomType } {
  if (!map.inBounds(x, y)) return { refund: 0, type: RoomType.None };
  const i = map.idx(x, y);
  const type = map.room[i] as RoomType;
  if (type === RoomType.None || map.owner[i] !== owner) {
    return { refund: 0, type: RoomType.None };
  }
  const spec = ROOM_SPECS[type];
  if (!spec.buildable) return { refund: 0, type: RoomType.None };

  map.room[i] = RoomType.None;
  map.gold[i] = 0;
  map.version++;
  return { refund: Math.floor(spec.cost / 2), type };
}

/** The tile a keeper's dungeon heart sits on, or -1. */
export function heartTile(map: TileMap, index: RoomIndex, owner: Owner): number {
  const tiles = index.tilesOf(map, owner, RoomType.DungeonHeart);
  return tiles.length > 0 ? tiles[(tiles.length / 2) | 0] : -1;
}

/**
 * Pick the room tile of `type` closest to (x,y) that passes `free`.
 * Returns a tile index, or -1 when the room is full or absent.
 */
export function nearestRoomTile(
  map: TileMap,
  index: RoomIndex,
  owner: Owner,
  type: RoomType,
  x: number, y: number,
  free?: (tile: number) => boolean,
): number {
  const tiles = index.tilesOf(map, owner, type);
  let best = -1;
  let bestD = Infinity;
  for (const t of tiles) {
    if (free && !free(t)) continue;
    const dx = map.xOf(t) - x, dy = map.yOf(t) - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}
