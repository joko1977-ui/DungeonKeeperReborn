import {
  CLAIM_HEALTH,
  DIG_HEALTH,
  Owner,
  RoomType,
  Terrain,
  isDiggable,
  isSolid,
  isWalkable,
} from './constants';

/** Bit flags stored per tile. */
export const FLAG_MARKED = 1 << 0; // tagged for excavation by the player
export const FLAG_REVEALED = 1 << 1; // seen at least once (fog of war)
export const FLAG_VISIBLE = 1 << 2; // currently lit by an owned tile or creature

/**
 * The dungeon grid.
 *
 * Stored as parallel typed arrays rather than an array of objects: the renderer
 * walks the whole map every time geometry is rebuilt, and this keeps that a
 * linear scan over a few contiguous buffers.
 */
export class TileMap {
  readonly width: number;
  readonly height: number;

  readonly terrain: Uint8Array;
  readonly owner: Uint8Array;
  /** Remaining dig integrity for solid tiles, claim progress for floor. */
  readonly health: Float32Array;
  readonly room: Uint8Array;
  /** Index into GameState.rooms, or 0xffff for "no room". */
  readonly roomId: Uint16Array;
  /**
   * How far a room tile has been upgraded, 1 to ROOM_MAX_LEVEL. Zero off-room.
   *
   * Stored per tile rather than per building because a building is not an
   * object anywhere in this codebase — it is whatever set of touching tiles
   * happens to share a type and an owner, and that set changes every time you
   * extend or lose a corner of it. Levelling the tiles means a room that grows
   * keeps its level on the old part and starts the new part at one, which is
   * both easy to reason about and exactly what you would expect: you upgraded
   * that hall, not the ground you have just added to it.
   */
  readonly roomLevel: Uint8Array;
  /** Gold left in a seam, or gold stored on a treasury tile. */
  readonly gold: Uint16Array;
  readonly flags: Uint8Array;

  /* A tile carries at most one device, and it belongs to whoever owns the
     tile — so no separate owner array is needed for either. */
  /** TrapType, or 0. */
  readonly trap: Uint8Array;
  /** Firings left before a trap is spent. */
  readonly trapCharges: Uint8Array;
  /** DoorType, or 0. */
  readonly door: Uint8Array;
  /** Remaining door integrity. */
  readonly doorHp: Float32Array;

  /** Bumped whenever anything the renderer cares about changes. */
  version = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.terrain = new Uint8Array(n).fill(Terrain.Earth);
    this.owner = new Uint8Array(n);
    this.health = new Float32Array(n);
    this.room = new Uint8Array(n);
    this.roomId = new Uint16Array(n).fill(0xffff);
    this.roomLevel = new Uint8Array(n);
    this.gold = new Uint16Array(n);
    this.flags = new Uint8Array(n);
    this.trap = new Uint8Array(n);
    this.trapCharges = new Uint8Array(n);
    this.door = new Uint8Array(n);
    this.doorHp = new Float32Array(n);
    for (let i = 0; i < n; i++) this.health[i] = DIG_HEALTH[Terrain.Earth];
  }

  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  terrainAt(x: number, y: number): Terrain {
    if (!this.inBounds(x, y)) return Terrain.Rock;
    return this.terrain[this.idx(x, y)] as Terrain;
  }

  ownerAt(x: number, y: number): Owner {
    if (!this.inBounds(x, y)) return Owner.None;
    return this.owner[this.idx(x, y)] as Owner;
  }

  /** Door type on a tile, or 0. */
  doorAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    return this.door[this.idx(x, y)];
  }

  /** Trap type on a tile, or 0. */
  trapAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    return this.trap[this.idx(x, y)];
  }

  roomAt(x: number, y: number): RoomType {
    if (!this.inBounds(x, y)) return RoomType.None;
    return this.room[this.idx(x, y)] as RoomType;
  }

  isWalkableAt(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return isWalkable(this.terrain[this.idx(x, y)] as Terrain);
  }

  isSolidAt(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return true;
    return isSolid(this.terrain[this.idx(x, y)] as Terrain);
  }

  /** Set terrain and reset the derived per-tile state that goes with it. */
  setTerrain(x: number, y: number, t: Terrain, owner: Owner = Owner.None): void {
    if (!this.inBounds(x, y)) return;
    const i = this.idx(x, y);
    this.terrain[i] = t;
    this.owner[i] = owner;
    this.health[i] = isSolid(t) ? (DIG_HEALTH[t] ?? 0) : 0;
    if (!isSolid(t)) this.flags[i] &= ~FLAG_MARKED;
    // Only rock buries gold. This used to clear the counter for any terrain that
    // was not a seam, which was correct while `gold` meant "gold in this wall" and
    // silently destructive once a floor tile could hold a heap: claiming the ground
    // under a pile runs through here, so an imp's own spoil vanished the moment
    // another imp claimed the tile it was standing on.
    if (isSolid(t) && t !== Terrain.Gold && t !== Terrain.Gems) this.gold[i] = 0;
    // A room cannot outlive the floor it was built on: dug out, reverted to bare
    // path or filled back in, the building on this tile is gone.
    if (t !== Terrain.Claimed) {
      this.room[i] = RoomType.None;
      this.roomId[i] = 0xffff;
      this.roomLevel[i] = 0;
    }
    // A device cannot survive the floor under it being dug out or reclaimed.
    this.trap[i] = 0;
    this.trapCharges[i] = 0;
    this.door[i] = 0;
    this.doorHp[i] = 0;
    this.version++;
  }

  /* ------------------------------------------------------------ marking -- */

  isMarked(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return (this.flags[this.idx(x, y)] & FLAG_MARKED) !== 0;
  }

  /**
   * Tag a tile for excavation.
   *
   * Anything diggable you have already laid eyes on can be tagged, even deep
   * inside a slab — imps work inward from whichever face is reachable, so a
   * dragged block of tags excavates layer by layer. Vision is the only gate,
   * which is what stops you tagging treasure you have not discovered yet.
   */
  mark(x: number, y: number, on: boolean): boolean {
    if (!this.inBounds(x, y)) return false;
    const i = this.idx(x, y);
    const t = this.terrain[i] as Terrain;
    if (!isDiggable(t)) return false;
    if (on && (this.flags[i] & FLAG_REVEALED) === 0) return false;
    if (on) this.flags[i] |= FLAG_MARKED;
    else this.flags[i] &= ~FLAG_MARKED;
    this.version++;
    return true;
  }

  /** True if at least one orthogonal neighbour is floor an imp could stand on. */
  hasExposedFace(x: number, y: number): boolean {
    return (
      this.isWalkableAt(x - 1, y) ||
      this.isWalkableAt(x + 1, y) ||
      this.isWalkableAt(x, y - 1) ||
      this.isWalkableAt(x, y + 1)
    );
  }

  /* ------------------------------------------------------------- digging -- */

  /**
   * Apply dig damage. Returns the gold released if the tile broke through,
   * or -1 while the tile still stands.
   */
  digTile(x: number, y: number, amount: number): number {
    const i = this.idx(x, y);
    const t = this.terrain[i] as Terrain;
    if (!isDiggable(t) && t !== Terrain.Wall) return -1;

    // Gem seams never run out; they yield on every completed pass.
    this.health[i] -= amount;
    if (this.health[i] > 0) {
      this.version++;
      return -1;
    }

    const released = this.gold[i];
    // Handed to the caller, so it must not also stay in the tile.
    if (t !== Terrain.Gems) this.gold[i] = 0;
    if (t === Terrain.Gems) {
      // Reset and keep the seam standing — infinite, but slow.
      this.health[i] = DIG_HEALTH[Terrain.Gems];
      this.version++;
      return released;
    }

    this.setTerrain(x, y, Terrain.Path, Owner.None);
    return t === Terrain.Gold ? released : 0;
  }

  /* ---------------------------------------------------------- loose gold -- */

  /*
   * Gold lying on the floor.
   *
   * The same `gold` array a seam uses, because it is the same thing seen at a
   * different moment: gold that is in this tile and not yet in anybody's vault.
   * A solid tile's is a seam, a floor tile's is a heap somebody has to come and
   * fetch.
   *
   * This exists because a seam holds 750 and an imp can carry 250, and the other
   * 500 was being deleted the instant the wall came down — two thirds of every
   * seam in the game, silently. Loose piles are how the original handles it, they
   * make the shortfall visible instead of invisible, and they give a full treasury
   * somewhere to overflow to rather than a hole to pour into.
   */

  /** Gold heaped on a floor tile, waiting to be carried. */
  looseGoldAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    const i = this.idx(x, y);
    return isSolid(this.terrain[i] as Terrain) ? 0 : this.gold[i];
  }

  /** Put gold down on a floor tile. Returns what would not fit in the counter. */
  dropGold(x: number, y: number, amount: number): number {
    if (amount <= 0 || !this.inBounds(x, y)) return amount;
    const i = this.idx(x, y);
    if (isSolid(this.terrain[i] as Terrain)) return amount;
    // The array is 16-bit; a heap that large means something else is wrong, but
    // silently wrapping to zero would be worse than refusing the surplus.
    const room = 65535 - this.gold[i];
    const put = Math.min(amount, room);
    this.gold[i] += put;
    this.version++;
    return amount - put;
  }

  /** Take up to `max` gold off a floor tile. Returns what was picked up. */
  takeGold(x: number, y: number, max: number): number {
    if (max <= 0 || !this.inBounds(x, y)) return 0;
    const i = this.idx(x, y);
    if (isSolid(this.terrain[i] as Terrain)) return 0;
    const took = Math.min(max, this.gold[i]);
    if (took > 0) {
      this.gold[i] -= took;
      this.version++;
    }
    return took;
  }

  /* ------------------------------------------------------------ claiming -- */

  /**
   * Push a floor tile toward a keeper's ownership. Returns true on the tick the
   * tile flips. Claiming an enemy tile first has to grind their claim back to
   * zero, which is why contested corridors flicker back and forth.
   */
  claimTile(x: number, y: number, by: Owner, amount: number): boolean {
    const i = this.idx(x, y);
    const t = this.terrain[i] as Terrain;
    if (t !== Terrain.Path && t !== Terrain.Claimed) return false;
    if (this.owner[i] === by && t === Terrain.Claimed) return false;

    if (this.owner[i] !== Owner.None && this.owner[i] !== by) {
      this.health[i] -= amount;
      if (this.health[i] > 0) return false;
      /*
       * Take the ground and the building on it comes down with it.
       *
       * You cannot capture an enemy room — nothing in the original works that
       * way and nothing here should either. What you capture is *floor*, one
       * tile at a time, and a room standing on floor that is no longer its
       * owner's has nothing to stand on. Without this the terrain reverted and
       * the room did not, leaving a rival's treasury sitting on neutral rock,
       * still counted, still furnished, and owned by nobody.
       */
      this.owner[i] = Owner.None;
      this.terrain[i] = Terrain.Path;
      this.health[i] = 0;
      this.room[i] = RoomType.None;
      this.roomId[i] = 0xffff;
      this.roomLevel[i] = 0;
      this.version++;
      return false;
    }

    this.health[i] += amount;
    if (this.health[i] < CLAIM_HEALTH) {
      this.version++;
      return false;
    }
    this.terrain[i] = Terrain.Claimed;
    this.owner[i] = by;
    this.health[i] = CLAIM_HEALTH;
    this.version++;
    return true;
  }

  /** Reinforce a diggable wall into an owned Wall tile. */
  reinforce(x: number, y: number, by: Owner): boolean {
    const i = this.idx(x, y);
    if (this.terrain[i] !== Terrain.Earth) return false;
    // Only walls touching your own floor can be reinforced.
    if (!this.touchesOwnedFloor(x, y, by)) return false;
    this.terrain[i] = Terrain.Wall;
    this.owner[i] = by;
    this.health[i] = DIG_HEALTH[Terrain.Wall];
    this.flags[i] &= ~FLAG_MARKED;
    this.version++;
    return true;
  }

  touchesOwnedFloor(x: number, y: number, by: Owner): boolean {
    const dirs = [
      [-1, 0], [1, 0], [0, -1], [0, 1],
    ];
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (!this.inBounds(nx, ny)) continue;
      const j = this.idx(nx, ny);
      if (this.terrain[j] === Terrain.Claimed && this.owner[j] === by) return true;
    }
    return false;
  }

  /* ------------------------------------------------------- fog of war ---- */

  reveal(x: number, y: number): void {
    if (!this.inBounds(x, y)) return;
    this.flags[this.idx(x, y)] |= FLAG_REVEALED | FLAG_VISIBLE;
  }

  isRevealed(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return (this.flags[this.idx(x, y)] & FLAG_REVEALED) !== 0;
  }

  /** Reveal a filled square around a point — a creature's or room's sight. */
  revealRadius(cx: number, cy: number, r: number): void {
    const r2 = r * r;
    for (let y = Math.max(0, cy - r); y <= Math.min(this.height - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(this.width - 1, cx + r); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) this.flags[this.idx(x, y)] |= FLAG_REVEALED | FLAG_VISIBLE;
      }
    }
  }

  /* ---------------------------------------------------------- iteration -- */

  /** Every tile of a terrain type owned by `owner`. Used to find rooms/targets. */
  *tilesOwnedBy(owner: Owner): Generator<number> {
    for (let i = 0; i < this.owner.length; i++) {
      if (this.owner[i] === owner) yield i;
    }
  }

  countOwned(owner: Owner): number {
    let n = 0;
    for (let i = 0; i < this.owner.length; i++) {
      if (this.owner[i] === owner && this.terrain[i] === Terrain.Claimed) n++;
    }
    return n;
  }

  xOf(i: number): number { return i % this.width; }
  yOf(i: number): number { return (i / this.width) | 0; }
}
