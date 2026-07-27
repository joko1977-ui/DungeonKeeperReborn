import * as THREE from 'three';
import { Owner, ROOM_MAX_LEVEL, RoomType, Terrain } from '../core/constants';
import { FLAG_REVEALED, TileMap } from '../core/tilemap';
import { PartBuilder } from './creatureModels';
import { celRamp } from './celRamp';

/**
 * The architecture of a room, as opposed to its furniture.
 *
 * A room was a patch of floor texture with one small prop copied onto every
 * tile: nine identical bookshelves, nine identical gold heaps, all at the same
 * height, all lying flat. From the game's camera — which looks down — that reads
 * as a rug with ornaments on it. Nothing about it is *built*. You could not tell
 * a library from a treasury at a glance and you certainly could not tell where
 * one ended, because a room had no edge, no threshold and no vertical anything.
 *
 * What a building has, and this did not, is a footprint you can see: a raised
 * lip where the floor changes, posts at the corners holding it together, and
 * something on top of the posts that says what sort of building it is. All three
 * are silhouette, which is the only thing that survives being looked at from
 * above at twenty tiles.
 *
 * So every room now gets a shell. A chamfered kerb along each of its outward
 * edges, a post at every corner of its footprint, and a finial on the post that
 * differs by room — a coin over the treasury, a candle over the library, an egg
 * over the hatchery, a spike over the training room. The kerbs are one geometry
 * tinted per instance, so the whole dungeon's edging is a single draw call; the
 * posts are one small mesh per room type, because their tops are the entire
 * point and cannot be shared.
 */

/** Kerb segments drawn at once. A large dungeon has a few hundred. */
const MAX_KERB = 1600;

/** Posts drawn at once, per room type. */
const MAX_POSTS = 260;

/** How proud of the floor a kerb stands. */
const KERB_HEIGHT = 0.13;

/** Room types that get a shell at all. */
const SHELLED: readonly RoomType[] = [
  RoomType.Treasury, RoomType.Lair, RoomType.Hatchery, RoomType.TrainingRoom,
  RoomType.Library, RoomType.Workshop, RoomType.DungeonHeart, RoomType.Portal,
];

/** What an improved room's stonework is dressed toward. */
const GILT = new THREE.Color(0xffd98a);

/** Kerb tint per room, so the edging carries the room's own material. */
const KERB_COLOUR: Partial<Record<RoomType, number>> = {
  [RoomType.Treasury]: 0xbfae7c,
  [RoomType.Lair]: 0x8a6a44,
  [RoomType.Hatchery]: 0xa8a06a,
  [RoomType.TrainingRoom]: 0x9a8264,
  [RoomType.Library]: 0x6f7c96,
  [RoomType.Workshop]: 0x8d919c,
  [RoomType.DungeonHeart]: 0xa05a4c,
  [RoomType.Portal]: 0x8f6ab0,
};

/**
 * A kerb along the -Z edge of a tile, to be rotated into place.
 *
 * One of these per level, and they are different *masonry* rather than the same
 * masonry scaled. Scaling was what the first attempt did, and a bigger version
 * of the same lip reads as "the room got bigger", which is the one message it
 * must not send — size and investment are separate axes and the player is
 * spending gold on the second. So the courses change:
 *
 *   1  a plain chamfered lip: a threshold, and no more,
 *   2  a moulded kerb — a plinth, a step and a bead, the profile of something
 *      somebody detailed rather than poured,
 *   3  a parapet with balusters, standing knee high with a rail across the top.
 *
 * The third is deliberately the one with a visible *void* in it. Solid mass just
 * looks heavy; a rail with gaps under it looks built to enclose something, which
 * is what a room the player has poured gold into ought to look like.
 */
export function buildKerb(level: number): THREE.BufferGeometry {
  const b = new PartBuilder();
  const stone = 0xffffff;
  const shade = 0xc2c2c2;
  const z = -0.44;

  if (level <= 1) {
    b.box(1.0, KERB_HEIGHT * 0.7, 0.17, 0, KERB_HEIGHT * 0.35, z, stone);
    b.box(1.0, KERB_HEIGHT * 0.42, 0.12, 0, KERB_HEIGHT * 0.86, z, stone);
    return b.build();
  }

  if (level === 2) {
    // Plinth, step, bead: three courses instead of two, each set back from the
    // one below, which is the whole of what a moulding is.
    b.box(1.0, KERB_HEIGHT * 0.5, 0.21, 0, KERB_HEIGHT * 0.25, z, shade);
    b.box(1.0, KERB_HEIGHT * 0.55, 0.155, 0, KERB_HEIGHT * 0.78, z, stone);
    b.box(1.0, KERB_HEIGHT * 0.28, 0.10, 0, KERB_HEIGHT * 1.18, z, stone);
    // A bead running the length of it, catching a highlight along the top edge.
    b.cylinder(0.030, 0.030, 1.0, 0, KERB_HEIGHT * 1.34, z, stone, 0, 0, Math.PI / 2, 6);
    return b.build();
  }

  /*
   * Level three: a parapet, and a tall one.
   *
   * The first cut of this stood about a quarter of a tile high, which is a kerb
   * with pretensions — from the playing camera it was indistinguishable from the
   * moulded course below it. A wall that encloses has to be tall enough to read
   * as a wall, so it goes to roughly two thirds the height of the rock around it
   * and the balusters carry most of that: the void between them is what says
   * "wall" rather than "step".
   */
  b.box(1.0, KERB_HEIGHT * 0.62, 0.28, 0, KERB_HEIGHT * 0.31, z, shade);
  for (let i = 0; i < 4; i++) {
    const x = -0.375 + i * 0.25;
    b.cylinder(0.044, 0.062, KERB_HEIGHT * 2.30, x, KERB_HEIGHT * 1.80, z, stone, 0, 0, 0, 6);
  }
  b.box(1.0, KERB_HEIGHT * 0.40, 0.22, 0, KERB_HEIGHT * 3.15, z, stone);
  b.box(1.0, KERB_HEIGHT * 0.22, 0.27, 0, KERB_HEIGHT * 3.46, z, shade);
  return b.build();
}

/**
 * The extra course a post gains per level, dropped over its shaft.
 *
 * Shared across every room type: it is the *stonework* that improves, and the
 * finial on top is what says which room it is. Building three variants of eight
 * posts would be twenty-four meshes to say one thing.
 */
export function buildCapital(level: number): THREE.BufferGeometry {
  const b = new PartBuilder();
  const stone = 0xa8a094;
  const dark = 0x6d675c;
  if (level === 2) {
    // A banded collar at the neck and a wider foot: it starts to look turned.
    b.cylinder(0.135, 0.155, 0.075, 0, 0.075, 0, dark, 0, 0, 0, 8);
    b.cylinder(0.115, 0.115, 0.045, 0, 0.62, 0, stone, 0, 0, 0, 8);
    return b.build();
  }
  // Level three: a fluted drum and a spread capital, the full order.
  b.cylinder(0.165, 0.190, 0.090, 0, 0.090, 0, dark, 0, 0, 0, 8);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.box(0.030, 0.52, 0.030, Math.cos(a) * 0.105, 0.40, Math.sin(a) * 0.105, stone);
  }
  b.cylinder(0.150, 0.120, 0.060, 0, 0.70, 0, stone, 0, 0, 0, 8);
  b.box(0.30, 0.045, 0.30, 0, 0.75, 0, dark);
  return b.build();
}

/**
 * A brazier for the corners of a fully improved room.
 *
 * The last level should not only be *smarter*, it should look like it holds
 * more, and nothing says a room is a place rather than a patch of floor like
 * standing fire at its corners. It is emissive rather than a real light: eight
 * corner lights would eat the forward renderer's budget to say one thing.
 */
export function buildBrazier(): THREE.BufferGeometry {
  const b = new PartBuilder();
  const iron = 0x4a443c;
  b.cylinder(0.070, 0.038, 0.32, 0, 0.16, 0, iron, 0, 0, 0, 6);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    b.box(0.034, 0.26, 0.034, Math.cos(a) * 0.095, 0.13, Math.sin(a) * 0.095, iron,
      Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25);
  }
  b.cylinder(0.190, 0.110, 0.105, 0, 0.38, 0, iron, 0, 0, 0, 9);
  // Coals, then flame. Sized to read as lit from the playing camera, which is
  // twenty tiles up — at the first size it was a spark on a stick.
  b.sphere(0.135, 0, 0.42, 0, 0xff7a1e, 1, 0.55, 1, 7);
  b.cone(0.115, 0.40, 0, 0.62, 0, 0xffc247, 0, 0, 0, 7);
  b.cone(0.062, 0.23, 0, 0.72, 0, 0xfff0b8, 0, 0, 0, 6);
  return b.build();
}

/** A corner post, with a per-room finial on top of it. */
function buildPost(room: RoomType): THREE.BufferGeometry {
  const b = new PartBuilder();
  const shaft = 0x9c9384;
  const dark = 0x6d675c;
  // Base, shaft, collar. Tall enough to break the skyline of a flat room.
  b.box(0.30, 0.08, 0.30, 0, 0.04, 0, dark);
  b.cylinder(0.085, 0.115, 0.72, 0, 0.44, 0, shaft, 0, 0, 0, 6);
  b.box(0.26, 0.07, 0.26, 0, 0.83, 0, dark);

  switch (room) {
    case RoomType.Treasury:
      // A coin stood on edge in a cradle.
      b.cylinder(0.135, 0.135, 0.034, 0, 1.00, 0, 0xffd24a, Math.PI / 2, 0, 0, 10);
      b.box(0.07, 0.12, 0.06, 0, 0.90, 0, 0x8a6a2a);
      break;
    case RoomType.Lair:
      // A skull on a spike: this is where things sleep, and what happens if not.
      b.sphere(0.125, 0, 0.98, 0, 0xd8cfb4, 1, 0.95, 1.1, 7);
      b.box(0.12, 0.06, 0.06, 0, 0.92, 0.09, 0xc0b696);
      break;
    case RoomType.Hatchery:
      b.sphere(0.115, 0, 0.98, 0, 0xefe6c6, 1, 1.32, 1, 8);
      break;
    case RoomType.TrainingRoom:
      // A blade, point up.
      b.box(0.065, 0.38, 0.025, 0, 1.10, 0, 0xc3cad6);
      b.box(0.19, 0.04, 0.06, 0, 0.90, 0, 0x7d6a4e);
      break;
    case RoomType.Library:
      // A candle, and it is the only light this room ever gets.
      b.cylinder(0.038, 0.042, 0.20, 0, 0.97, 0, 0xece4cc, 0, 0, 0, 7);
      b.cone(0.032, 0.095, 0, 1.14, 0, 0xffcc66);
      break;
    case RoomType.Workshop:
      // A tiny anvil, horn and all.
      b.box(0.23, 0.06, 0.12, 0, 0.97, 0, 0xb0b8c6);
      b.box(0.11, 0.065, 0.09, 0, 0.91, 0, 0x8f97a6);
      b.cone(0.045, 0.12, 0.16, 0.975, 0, 0xbcc4d0, 0, 0, -Math.PI / 2);
      break;
    case RoomType.DungeonHeart:
      // Horns, because this is the one you defend.
      for (const s of [-1, 1]) {
        b.cone(0.055, 0.30, s * 0.065, 1.02, 0, 0x8f2b22, 0, 0, s * 0.28);
      }
      break;
    case RoomType.Portal:
      b.sphere(0.10, 0, 0.98, 0, 0xc79cf5, 1, 1, 1, 7);
      b.torus(0.16, 0.026, 0, 0.98, 0, 0x8f6ab0, 0);
      break;
    default:
      b.sphere(0.085, 0, 0.94, 0, shaft, 1, 1, 1, 6);
      break;
  }
  return b.build();
}

/**
 * Which room a tile belongs to, as one comparable number, or -1 for none.
 *
 * Owner is part of the identity: two keepers' treasuries meeting along a line
 * are two buildings, and the seam between them should show.
 */
export function roomIdentityAt(map: TileMap, x: number, y: number): number {
  if (!map.inBounds(x, y)) return -1;
  const i = map.idx(x, y);
  if (map.terrain[i] !== Terrain.Claimed) return -1;
  const room = map.room[i] as RoomType;
  if (room === RoomType.None) return -1;
  return room * 8 + (map.owner[i] as Owner);
}

/** Tile sides that leave the room, anticlockwise from -Z. */
export const SIDES: ReadonlyArray<readonly [number, number]> =
  [[0, -1], [-1, 0], [0, 1], [1, 0]];

/**
 * For each of a tile's four sides, whether it leaves the room.
 *
 * This is what tells furniture where it is standing. A bookshelf belongs
 * against a wall facing in; a lectern belongs in the middle of the floor. Until
 * something knew the difference, every room was the same object stamped onto
 * every one of its tiles, which is why a library and a treasury had the same
 * shape and only a different colour of clutter.
 */
export function outwardSidesAt(map: TileMap, x: number, y: number): boolean[] {
  const self = roomIdentityAt(map, x, y);
  return SIDES.map(([dx, dy]) => roomIdentityAt(map, x + dx, y + dy) !== self);
}

/**
 * How big the room each tile belongs to actually is.
 *
 * A room is not a tile type, it is a *building*, and until something counted the
 * building nothing could respond to its size: a twenty-tile treasure hall got
 * the same four knee-high posts as a three-by-three one, so expanding a room
 * changed the number on the panel and nothing you could see. Which makes the
 * central decision of the whole economy — spend gold widening this room, or
 * spend it elsewhere — invisible at the point where you make it.
 *
 * One flood fill per rebuild gives every tile the size of its own connected
 * room, and everything that should grow with a building hangs off that number.
 *
 * Returns, per tile index, the size of its room and where that room's middle
 * is. Size is zero for tiles in no room.
 */
export interface RoomInstances {
  size: Int32Array;
  midX: Float32Array;
  midY: Float32Array;
}

export function roomInstances(map: TileMap): RoomInstances {
  const sizes = new Int32Array(map.room.length);
  const midX = new Float32Array(map.room.length);
  const midY = new Float32Array(map.room.length);
  const seen = new Uint8Array(map.room.length);
  const stack: number[] = [];
  const members: number[] = [];

  for (let start = 0; start < sizes.length; start++) {
    if (seen[start]) continue;
    const self = roomIdentityAt(map, map.xOf(start), map.yOf(start));
    seen[start] = 1;
    if (self < 0) continue;

    stack.length = 0;
    members.length = 0;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      members.push(i);
      const x = map.xOf(i), y = map.yOf(i);
      for (const [dx, dy] of SIDES) {
        const nx = x + dx, ny = y + dy;
        if (!map.inBounds(nx, ny)) continue;
        const j = map.idx(nx, ny);
        if (seen[j]) continue;
        if (roomIdentityAt(map, nx, ny) !== self) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    let sx = 0, sy = 0;
    for (const m of members) { sx += map.xOf(m); sy += map.yOf(m); }
    const cx = sx / members.length, cy = sy / members.length;
    for (const m of members) {
      sizes[m] = members.length;
      midX[m] = cx;
      midY[m] = cy;
    }
  }
  return { size: sizes, midX, midY };
}

/**
 * How grand a building of this many tiles should look, 0..1.
 *
 * Deliberately not linear. The step from a three-by-three room to a six-by-six
 * is the one the player feels, and doubling again after that should still read
 * as bigger without the posts growing into towers.
 */
export function grandeur(tiles: number): number {
  return Math.min(1, Math.max(0, (tiles - 4) / 28));
}

export class RoomShell {
  readonly group = new THREE.Group();

  private readonly map: TileMap;
  private readonly material: THREE.MeshToonMaterial;
  /** One kerb mesh per level: different masonry, not the same masonry scaled. */
  private readonly kerbs: THREE.InstancedMesh[] = [];
  private readonly posts = new Map<RoomType, THREE.InstancedMesh>();
  /** The extra course a post gains at level two and three. */
  private readonly capitals: THREE.InstancedMesh[] = [];
  /** Corner fire, for rooms taken all the way. */
  private readonly braziers: THREE.InstancedMesh;
  private readonly emberMaterial: THREE.MeshBasicMaterial;
  private readonly dummy = new THREE.Object3D();
  private readonly colour = new THREE.Color();
  private lastVersion = -1;

  constructor(map: TileMap) {
    this.map = map;
    // Same toon ramp as everything else, so masonry the player builds shades
    // like the masonry they dug through.
    this.material = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: celRamp(),
    });

    for (let level = 1; level <= ROOM_MAX_LEVEL; level++) {
      const mesh = new THREE.InstancedMesh(buildKerb(level), this.material, MAX_KERB);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor =
        new THREE.InstancedBufferAttribute(new Float32Array(MAX_KERB * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.kerbs.push(mesh);
      this.group.add(mesh);
    }

    for (const level of [2, 3]) {
      const mesh = new THREE.InstancedMesh(buildCapital(level), this.material, MAX_POSTS);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.capitals.push(mesh);
      this.group.add(mesh);
    }

    // Unlit, so the flame stays flame-coloured in a room the torches do not
    // reach — a brazier that shades to brown is a bucket.
    this.emberMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.braziers = new THREE.InstancedMesh(buildBrazier(), this.emberMaterial, MAX_POSTS);
    this.braziers.frustumCulled = false;
    this.braziers.count = 0;
    this.braziers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.braziers);

    for (const room of SHELLED) {
      const mesh = new THREE.InstancedMesh(buildPost(room), this.material, MAX_POSTS);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.posts.set(room, mesh);
      this.group.add(mesh);
    }
  }

  syncIfDirty(): boolean {
    if (this.map.version === this.lastVersion) return false;
    this.lastVersion = this.map.version;
    this.rebuild();
    return true;
  }

  private rebuild(): void {
    const { map, dummy, colour } = this;
    const { size: sizes } = roomInstances(map);
    const kerbN = [0, 0, 0];
    const capitalN = [0, 0];
    let brazierN = 0;
    const postN = new Map<RoomType, number>();
    for (const room of SHELLED) postN.set(room, 0);

    for (let i = 0; i < map.room.length; i++) {
      if ((map.flags[i] & FLAG_REVEALED) === 0) continue;
      const room = map.room[i] as RoomType;
      const tint = KERB_COLOUR[room];
      if (tint === undefined) continue;
      if (map.terrain[i] !== Terrain.Claimed) continue;

      const x = map.xOf(i), y = map.yOf(i);
      const outward = outwardSidesAt(map, x, y);

      /*
       * Two things make a building look important, and they are different.
       *
       * Size is how much floor it covers; level is how much has been spent on
       * the floor it has. They have to read differently or upgrading looks like
       * the room got bigger, so size thickens and heightens the stonework while
       * level *gilds* it — the kerb brightens toward gold and the columns grow
       * a course at a time.
       */
      const grand = grandeur(sizes[i]);
      const level = Math.max(1, map.roomLevel[i]);
      const kerbScale = (1 + grand * 0.55) * (1 + (level - 1) * 0.16);

      const kerbMesh = this.kerbs[level - 1];
      for (let s = 0; s < 4; s++) {
        if (!outward[s] || kerbN[level - 1] >= MAX_KERB) continue;
        dummy.position.set(x, 0, y);
        dummy.rotation.set(0, (s * Math.PI) / 2, 0);
        // Size still stretches the stonework; the level chose which stonework.
        dummy.scale.set(1, kerbScale, 1 + grand * 0.35);
        dummy.updateMatrix();
        kerbMesh.setMatrixAt(kerbN[level - 1], dummy.matrix);
        colour.setHex(tint).lerp(GILT, (level - 1) * 0.32);
        kerbMesh.setColorAt(kerbN[level - 1], colour);
        kerbN[level - 1]++;
      }

      /*
       * A post wherever two outward sides meet.
       *
       * That is the definition of a convex corner of the footprint, so a
       * three-by-three room gets exactly four posts and a long hall gets one at
       * each end of each run — which is where a builder would put them, and
       * which keeps a big room from turning into a picket fence.
       */
      const mesh = this.posts.get(room);
      if (!mesh) continue;

      /*
       * Extra columns down the long walls of a big hall.
       *
       * Corner posts alone meant a large room was a bigger rectangle with the
       * same four markers on it — the span between them grew and grew and
       * nothing held it up. Every fourth tile of a run gets its own column once
       * the room is worth the name, so the colonnade lengthens as you build.
       */
      if (grand > 0.22) {
        for (let s = 0; s < 4; s++) {
          const next = (s + 1) & 3, prev = (s + 3) & 3;
          if (!outward[s] || outward[next] || outward[prev]) continue;
          if (((x * 3 + y * 5) & 3) !== 0) continue;
          const at = postN.get(room) ?? 0;
          if (at >= MAX_POSTS) break;
          dummy.position.set(x + SIDES[s][0] * 0.5, 0, y + SIDES[s][1] * 0.5);
          dummy.rotation.set(0, Math.atan2(SIDES[s][0], SIDES[s][1]), 0);
          dummy.scale.setScalar((0.72 + grand * 0.5) * (1 + (level - 1) * 0.17));
          dummy.updateMatrix();
          mesh.setMatrixAt(at, dummy.matrix);
          postN.set(room, at + 1);
        }
      }

      for (let s = 0; s < 4; s++) {
        const next = (s + 1) & 3;
        if (!outward[s] || !outward[next]) continue;
        const at = postN.get(room) ?? 0;
        if (at >= MAX_POSTS) break;
        // The corner shared by the two sides.
        const cx = (SIDES[s][0] + SIDES[next][0]) * 0.5;
        const cz = (SIDES[s][1] + SIDES[next][1]) * 0.5;
        dummy.position.set(x + cx, 0, y + cz);
        dummy.rotation.set(0, Math.atan2(cx, cz), 0);
        // Corner columns grow with the hall they hold up, and again with what
        // has been spent on it.
        dummy.scale.setScalar((0.9 + grand * 0.75) * (1 + (level - 1) * 0.17));
        dummy.updateMatrix();
        mesh.setMatrixAt(at, dummy.matrix);
        postN.set(room, at + 1);

        // The improved courses ride the same matrix as the post they dress.
        if (level >= 2 && capitalN[level - 2] < MAX_POSTS) {
          this.capitals[level - 2].setMatrixAt(capitalN[level - 2], dummy.matrix);
          capitalN[level - 2]++;
        }
        // And a fully improved room burns a fire at each of its corners.
        if (level >= ROOM_MAX_LEVEL && brazierN < MAX_POSTS) {
          dummy.translateY(0.98);
          dummy.updateMatrix();
          this.braziers.setMatrixAt(brazierN, dummy.matrix);
          brazierN++;
        }
      }
    }

    for (let k = 0; k < this.kerbs.length; k++) {
      const mesh = this.kerbs[k];
      mesh.count = kerbN[k];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    for (let k = 0; k < this.capitals.length; k++) {
      this.capitals[k].count = capitalN[k];
      this.capitals[k].instanceMatrix.needsUpdate = true;
      this.capitals[k].computeBoundingSphere();
    }
    this.braziers.count = brazierN;
    this.braziers.instanceMatrix.needsUpdate = true;
    this.braziers.computeBoundingSphere();

    for (const [room, mesh] of this.posts) {
      mesh.count = postN.get(room) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** Drop the shell when the frame rate is struggling. */
  setEnabled(on: boolean): void {
    this.group.visible = on;
  }

  dispose(): void {
    for (const m of this.kerbs) m.geometry.dispose();
    for (const m of this.capitals) m.geometry.dispose();
    this.braziers.geometry.dispose();
    this.emberMaterial.dispose();
    for (const mesh of this.posts.values()) mesh.geometry.dispose();
    this.material.dispose();
  }
}
