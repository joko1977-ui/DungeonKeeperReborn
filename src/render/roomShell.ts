import * as THREE from 'three';
import { Owner, RoomType, Terrain } from '../core/constants';
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
 * Chamfered rather than a plain bar: a rectangular block lit from above shows
 * one flat top and nothing else, where a chamfer gives a lit upper face and a
 * shadowed skirt and therefore an edge you can see. The whole reason for this
 * thing is that it should be visible from directly overhead.
 */
function buildKerb(): THREE.BufferGeometry {
  const b = new PartBuilder();
  const stone = 0xffffff;
  // Skirt, then a narrower cap: two boxes make the chamfer in silhouette.
  b.box(1.0, KERB_HEIGHT * 0.7, 0.17, 0, KERB_HEIGHT * 0.35, -0.44, stone);
  b.box(1.0, KERB_HEIGHT * 0.42, 0.12, 0, KERB_HEIGHT * 0.86, -0.44, stone);
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

export class RoomShell {
  readonly group = new THREE.Group();

  private readonly map: TileMap;
  private readonly material: THREE.MeshToonMaterial;
  private readonly kerb: THREE.InstancedMesh;
  private readonly posts = new Map<RoomType, THREE.InstancedMesh>();
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

    this.kerb = new THREE.InstancedMesh(buildKerb(), this.material, MAX_KERB);
    this.kerb.castShadow = true;
    this.kerb.receiveShadow = true;
    this.kerb.frustumCulled = false;
    this.kerb.count = 0;
    this.kerb.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.kerb.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(MAX_KERB * 3), 3);
    this.kerb.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.kerb);

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
    let kerbN = 0;
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

      for (let s = 0; s < 4; s++) {
        if (!outward[s] || kerbN >= MAX_KERB) continue;
        dummy.position.set(x, 0, y);
        dummy.rotation.set(0, (s * Math.PI) / 2, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        this.kerb.setMatrixAt(kerbN, dummy.matrix);
        colour.setHex(tint);
        this.kerb.setColorAt(kerbN, colour);
        kerbN++;
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
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        mesh.setMatrixAt(at, dummy.matrix);
        postN.set(room, at + 1);
      }
    }

    this.kerb.count = kerbN;
    this.kerb.instanceMatrix.needsUpdate = true;
    if (this.kerb.instanceColor) this.kerb.instanceColor.needsUpdate = true;
    this.kerb.computeBoundingSphere();

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
    this.kerb.geometry.dispose();
    for (const mesh of this.posts.values()) mesh.geometry.dispose();
    this.material.dispose();
  }
}
