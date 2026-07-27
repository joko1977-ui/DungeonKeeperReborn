import * as THREE from 'three';
import { OWNER_COLORS, Owner, RoomType, Terrain, isSolid } from '../core/constants';
import { FLAG_REVEALED, TileMap } from '../core/tilemap';
import { PartBuilder } from './creatureModels';
import { SIDES, outwardSidesAt } from './roomShell';
import { celRamp } from './celRamp';

/**
 * The furniture that makes a room a room.
 *
 * A retextured floor is not a treasury — the original fills its rooms with
 * objects, and that is most of how you read a dungeon at a glance: gold heaps,
 * nests, training posts, bookshelves. So every room tile gets a piece of
 * furniture, one instanced draw call per room type, with per-tile rotation and
 * scale variation from a hash of the tile index so a big room doesn't look
 * stamped.
 *
 * Two rooms are centrepieces rather than tiled: the Dungeon Heart and the
 * portal each get a single large object at the middle of the room, because
 * that's what they are.
 */

/** Deterministic per-tile pseudo-random in [0,1). */
function tileRandom(tile: number, salt: number): number {
  let t = (tile * 73856093) ^ (salt * 19349663);
  t = Math.imul(t ^ (t >>> 13), 1274126177);
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

/* ------------------------------------------------------------- geometry -- */

/** A heap of coins. Scaled vertically at runtime by how full the vault is. */
function buildGoldPile(): THREE.BufferGeometry {
  const b = new PartBuilder();
  // Stacked discs of decreasing radius read as a heap from any angle.
  b.cylinder(0.30, 0.34, 0.06, 0, 0.03, 0, 0xe6b800);
  b.cylinder(0.23, 0.28, 0.06, 0.02, 0.09, -0.01, 0xffd700);
  b.cylinder(0.15, 0.20, 0.06, -0.02, 0.15, 0.02, 0xffd700);
  b.cylinder(0.07, 0.12, 0.05, 0.01, 0.20, 0, 0xffec8b);
  // A few loose coins spilled around the base.
  b.cylinder(0.055, 0.055, 0.018, -0.28, 0.01, 0.20, 0xf0c04a, 0, 0, 0.2);
  b.cylinder(0.055, 0.055, 0.018, 0.26, 0.01, -0.24, 0xffd45c, 0, 0, -0.15);
  b.cylinder(0.055, 0.055, 0.018, 0.05, 0.01, 0.31, 0xe0a838);
  return b.build();
}

/** A straw nest with a worn hollow in the middle. */
function buildLairNest(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.torus(0.27, 0.09, 0, 0.08, 0, 0xc09a52);
  b.cylinder(0.24, 0.26, 0.05, 0, 0.03, 0, 0x7a5a34);
  // Loose straws poking out of the rim.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    b.box(0.20, 0.015, 0.03,
      Math.cos(a) * 0.28, 0.13, Math.sin(a) * 0.28,
      0xd8b46a, 0, -a + 0.5, 0.12);
  }
  return b.build();
}

/** Eggs in a shallow nest, plus the odd shell fragment. */
function buildHatcheryNest(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.torus(0.26, 0.07, 0, 0.05, 0, 0xa8a45c);
  b.sphere(0.115, -0.09, 0.13, 0.05, 0xe8dfc0, 1, 1.28, 1);
  b.sphere(0.105, 0.10, 0.12, -0.04, 0xded4b2, 1, 1.28, 1);
  b.sphere(0.09, 0.01, 0.11, 0.15, 0xf0e8cc, 1, 1.25, 1);
  // A cracked shell that already hatched.
  b.sphere(0.08, 0.19, 0.06, 0.20, 0xd8cfae, 1, 0.5, 1);
  return b.build();
}

/** A wooden training dummy: post, crossbar, straw head, battered shield. */
function buildTrainingDummy(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.cylinder(0.055, 0.075, 0.72, 0, 0.36, 0, 0xa87c46);
  b.box(0.46, 0.055, 0.055, 0, 0.56, 0, 0xb88a50);
  b.sphere(0.11, 0, 0.70, 0, 0xe0c070);
  // Wrapped rags on the arms, and a dented iron plate on the chest.
  b.box(0.10, 0.09, 0.09, -0.20, 0.56, 0, 0xb0a080);
  b.box(0.10, 0.09, 0.09, 0.20, 0.56, 0, 0xb0a080);
  b.box(0.22, 0.24, 0.04, 0, 0.44, 0.07, 0xc0c6d4);
  // Base so it doesn't look like it's floating.
  b.cylinder(0.17, 0.20, 0.06, 0, 0.03, 0, 0x7a5a34);
  return b.build();
}

/** A bookshelf with coloured spines, and a candle on top. */
function buildBookshelf(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.box(0.62, 0.68, 0.22, 0, 0.34, 0, 0x6e5030);
  // Two shelves of books, each spine a slightly different colour and height.
  const spines = [0xc05a5a, 0x5a82c0, 0x6aac6a, 0xc0aa5a, 0x9a5aae, 0x4a9aae];
  for (let shelf = 0; shelf < 2; shelf++) {
    for (let i = 0; i < 6; i++) {
      const h = 0.19 + tileRandom(shelf * 31 + i, 7) * 0.06;
      b.box(0.075, h, 0.16,
        -0.24 + i * 0.096, 0.14 + shelf * 0.30 + h / 2, 0.02,
        spines[(i + shelf * 3) % spines.length]);
    }
  }
  // Shelf boards.
  b.box(0.60, 0.025, 0.20, 0, 0.13, 0, 0x4e3a22);
  b.box(0.60, 0.025, 0.20, 0, 0.43, 0, 0x4e3a22);
  // A candle, because a library needs somewhere for the light to come from.
  b.cylinder(0.022, 0.026, 0.10, 0.22, 0.73, 0, 0xe8e0c8);
  return b.build();
}

/** An anvil on a stump, with a hammer and a rack of stock iron. */
function buildWorkshopAnvil(): THREE.BufferGeometry {
  const b = new PartBuilder();
  // Stump. Colours run bright: this room is lit by torches, and a palette
  // picked as if for daylight arrives as a black blob down here.
  b.cylinder(0.16, 0.19, 0.26, -0.08, 0.13, 0.02, 0x94806a);
  // Anvil: waisted body, flat face, horn on one end.
  b.box(0.34, 0.07, 0.17, -0.08, 0.29, 0.02, 0xa9b2c2);
  b.box(0.18, 0.09, 0.12, -0.08, 0.22, 0.02, 0x8e96a6);
  b.cone(0.06, 0.16, 0.14, 0.30, 0.02, 0xb4bcc8, 0, 0, -Math.PI / 2);
  // Hammer left leaning on the stump.
  b.cylinder(0.016, 0.016, 0.30, 0.14, 0.16, -0.14, 0xbc9c70, 0.5, 0, 0.3);
  b.box(0.09, 0.05, 0.05, 0.20, 0.30, -0.06, 0x9aa0aa);
  // Iron bars stacked in a low rack. Kept short so a big workshop does not
  // turn into a thicket of overlapping bars.
  for (let i = 0; i < 3; i++) {
    b.cylinder(0.022, 0.022, 0.28, 0.20 + i * 0.045, 0.05 + i * 0.02, 0.20,
      i === 1 ? 0xcfd5e0 : 0xb2b8c4, 0, 0.35, Math.PI / 2);
  }
  // Sparks pit — a scorched patch so the tile reads as worked-in.
  b.cylinder(0.13, 0.13, 0.012, -0.28, 0.006, -0.22, 0x574d44);
  return b.build();
}

/** Rope railings for a bridge span. */
function buildBridgeRail(): THREE.BufferGeometry {
  const b = new PartBuilder();
  for (const side of [-1, 1]) {
    b.cylinder(0.022, 0.022, 0.30, side * 0.42, 0.15, -0.30, 0x9a7448);
    b.cylinder(0.022, 0.022, 0.30, side * 0.42, 0.15, 0.30, 0x9a7448);
    b.box(0.03, 0.02, 0.92, side * 0.42, 0.28, 0, 0xa8895a);
  }
  return b.build();
}

/**
 * The Dungeon Heart. One per room, at the centre.
 * Built around the origin so it can be spun and pulsed as a whole.
 */
function buildDungeonHeart(): THREE.BufferGeometry {
  const b = new PartBuilder();
  // Stone basin.
  b.cylinder(0.95, 1.15, 0.22, 0, 0.11, 0, 0x6e6558);
  b.torus(0.98, 0.10, 0, 0.24, 0, 0x8a7f6a);
  // Four pillars around the rim.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const px = Math.cos(a) * 0.92, pz = Math.sin(a) * 0.92;
    b.cylinder(0.09, 0.12, 1.15, px, 0.58, pz, 0x7a7062);
    b.box(0.24, 0.10, 0.24, px, 1.18, pz, 0x968a74);
  }
  return b.build();
}

/** The beating heart itself — separate so it can pulse independently. */
function buildHeartCore(): THREE.BufferGeometry {
  const b = new PartBuilder();
  // Two lobes and a taper: a heart shape at a glance, cheap in triangles.
  b.sphere(0.28, -0.15, 0.62, 0, 0xb8231a);
  b.sphere(0.28, 0.15, 0.62, 0, 0xb8231a);
  b.cone(0.38, 0.52, 0, 0.30, 0, 0x9a1a12, Math.PI, 0, 0);
  b.sphere(0.30, 0, 0.60, 0, 0xa81f16, 1.15, 1, 1.05);
  return b.build();
}

/** The creature portal: a standing stone ring with a swirl inside. */
function buildPortalRing(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.torus(0.78, 0.13, 0, 0.06, 0, 0x6a5480, -Math.PI / 2);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.box(0.18, 0.34, 0.18, Math.cos(a) * 0.78, 0.18, Math.sin(a) * 0.78, 0x8a6ca8);
  }
  return b.build();
}

/** The glowing disc that sits inside the portal ring. */
function buildPortalSwirl(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.cylinder(0.70, 0.70, 0.03, 0, 0.10, 0, 0x9a5ad8);
  b.cylinder(0.44, 0.44, 0.03, 0, 0.13, 0, 0xc08aff);
  b.cylinder(0.20, 0.20, 0.03, 0, 0.16, 0, 0xe8d0ff);
  return b.build();
}

/*
 * Edge furniture: what stands against the wall rather than out on the floor.
 *
 * The nine-identical-props problem is not solved by adding more props, it is
 * solved by the props knowing where they are. A bookshelf belongs against a
 * wall with its spines facing in; a lectern belongs in the middle of the floor
 * with space round it. Stamp either one onto all nine tiles and you get a
 * storeroom, not a library.
 *
 * So each room now has two pieces. The edge piece is rotated to face inward and
 * pushed back against the boundary, and the interior piece stands free. A
 * three-by-three room is then eight of one round the outside and one of the
 * other in the middle, which is what a room looks like.
 *
 * Everything here is built facing -Z, the direction the placement code treats as
 * "toward the middle of the room".
 */

/** Treasury edge: a bound strongbox with the lid up and coins showing. */
function buildStrongbox(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.box(0.52, 0.24, 0.30, 0, 0.12, 0, 0x6b4c2c);
  // Iron bands and a lock plate.
  b.box(0.54, 0.05, 0.32, 0, 0.08, 0, 0x8a8f9a);
  b.box(0.10, 0.26, 0.33, -0.16, 0.13, 0, 0x8a8f9a);
  b.box(0.10, 0.26, 0.33, 0.16, 0.13, 0, 0x8a8f9a);
  // Lid, thrown back, and what is inside it.
  b.box(0.52, 0.06, 0.28, 0, 0.30, -0.14, 0x7a5734, -0.9, 0, 0);
  b.sphere(0.09, -0.10, 0.25, 0.02, 0xffd24a, 1.4, 0.5, 1.1, 7);
  b.sphere(0.08, 0.09, 0.25, -0.01, 0xffdf72, 1.3, 0.5, 1.0, 7);
  return b.build();
}

/** Lair edge: bones picked clean, stacked where they were dropped. */
function buildBonePile(): THREE.BufferGeometry {
  const b = new PartBuilder();
  const bone = 0xd9d0b6, old = 0xb8ae92;
  b.sphere(0.14, -0.06, 0.10, 0.02, bone, 1.2, 0.7, 1.0, 7);
  for (let i = 0; i < 4; i++) {
    const a = i * 1.31;
    b.capsule(0.026, 0.24, Math.cos(a) * 0.12, 0.05 + i * 0.012, Math.sin(a) * 0.10,
      i % 2 ? bone : old, 0, a, Math.PI / 2);
  }
  // A ribcage arc over the top, which is the bit that says "bones" at a glance.
  for (let i = 0; i < 3; i++) {
    b.torus(0.10 - i * 0.012, 0.016, 0.02 + i * 0.07, 0.13, -0.02, old, 0, Math.PI / 2, 0, Math.PI);
  }
  return b.build();
}

/** Hatchery edge: a feed trough on legs, with grain in it. */
function buildTrough(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.box(0.60, 0.13, 0.24, 0, 0.20, 0, 0x8f6f42);
  b.box(0.54, 0.09, 0.18, 0, 0.25, 0, 0xd9c07a);
  for (const s of [-1, 1]) {
    b.box(0.06, 0.16, 0.06, s * 0.24, 0.08, 0.07, 0x6f5432, 0, 0, s * 0.18);
    b.box(0.06, 0.16, 0.06, s * 0.24, 0.08, -0.07, 0x6f5432, 0, 0, s * 0.18);
  }
  return b.build();
}

/** Training edge: a rack of practice weapons leaning against the wall. */
function buildWeaponRack(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.box(0.62, 0.06, 0.14, 0, 0.06, 0.02, 0x7a5c38);
  b.box(0.62, 0.05, 0.06, 0, 0.52, 0.06, 0x8a6a42);
  for (const s of [-1, 1]) b.box(0.06, 0.58, 0.06, s * 0.28, 0.29, 0.06, 0x8a6a42);
  // Three arms in the rack, each a different length so the top line is ragged.
  const kit = [[-0.17, 0.62, 0xc3cad6], [0.02, 0.74, 0xb0b8c6], [0.19, 0.55, 0xc9d0dc]];
  for (const [x, h, col] of kit) {
    b.cylinder(0.020, 0.020, h, x, h / 2, 0.02, 0x9a7a4c, 0.10, 0, 0);
    b.box(0.055, 0.20, 0.02, x, h - 0.06, 0.02, col, 0.10, 0, 0);
  }
  return b.build();
}

/** Library interior: a lectern with an open book on it. */
function buildLectern(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.cylinder(0.17, 0.21, 0.05, 0, 0.025, 0, 0x4e3a22);
  b.cylinder(0.045, 0.055, 0.50, 0, 0.27, 0, 0x6e5030);
  // The sloped desk, and the book lying open on it.
  b.box(0.36, 0.04, 0.26, 0, 0.53, 0, 0x7a5a34, -0.42, 0, 0);
  b.box(0.16, 0.03, 0.22, -0.09, 0.58, 0.01, 0xf2ead2, -0.42, 0, 0.05);
  b.box(0.16, 0.03, 0.22, 0.09, 0.58, 0.01, 0xe8dfc4, -0.42, 0, -0.05);
  // Scrolls in a basket at the foot of it.
  for (let i = 0; i < 3; i++) {
    b.cylinder(0.028, 0.028, 0.20, 0.19 + i * 0.03, 0.10 + i * 0.02, 0.16,
      0xe0d3ab, 0.5, i * 0.7, 0.35);
  }
  return b.build();
}

/** Workshop edge: a cluttered bench with a vice and a rack of stock. */
function buildWorkbench(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.box(0.66, 0.06, 0.28, 0, 0.42, 0, 0x8a6a42);
  for (const s of [-1, 1]) {
    b.box(0.07, 0.40, 0.07, s * 0.28, 0.20, 0.09, 0x6f5432);
    b.box(0.07, 0.40, 0.07, s * 0.28, 0.20, -0.09, 0x6f5432);
  }
  // A vice clamped to the near end, and offcuts on the top.
  b.box(0.12, 0.10, 0.14, -0.24, 0.50, 0.02, 0x8f97a6);
  b.cylinder(0.018, 0.018, 0.16, -0.24, 0.50, 0.12, 0xb0b8c6, Math.PI / 2, 0, 0);
  b.box(0.20, 0.05, 0.10, 0.10, 0.47, 0.02, 0xb0b8c6, 0, 0.3, 0);
  b.cylinder(0.022, 0.022, 0.26, 0.20, 0.47, -0.06, 0xcfd5e0, 0, 0.9, Math.PI / 2);
  // Tools hung on the wall behind it.
  b.box(0.04, 0.22, 0.02, -0.10, 0.74, -0.12, 0x9aa0aa);
  b.box(0.14, 0.05, 0.02, 0.08, 0.78, -0.12, 0x9aa0aa);
  b.box(0.03, 0.18, 0.02, 0.08, 0.68, -0.12, 0xbc9c70);
  return b.build();
}

/* --------------------------------------------------------------- render -- */

/**
 * How much of a room's boundary the edge piece takes over.
 *
 * For most rooms the answer is "all of it": shelves, racks and benches belong
 * against the wall, and the middle is the floor you work on. But in a treasury
 * and a hatchery the tiled piece *is* the room's contents — the gold you are
 * hoarding, the eggs you are growing — and evicting eight tiles of it to make
 * room for scenery would be lying about the state of the game. Those two get
 * their edge piece on the corners only, where it frames the contents instead of
 * replacing them.
 */
type EdgeRule = 'boundary' | 'corners';

interface PropBatch {
  mesh: THREE.InstancedMesh;
  /** What stands against the room's boundary, facing in. Null if it has none. */
  edgeMesh: THREE.InstancedMesh | null;
  edgeRule: EdgeRule;
  /**
   * Tiles that took the interior piece, in the instance order they were written.
   *
   * The treasury re-lays its heaps every frame to grow them with the vault, and
   * it has to write them to the same slots the rebuild used. Walking the room's
   * whole tile list instead put heaps on the corner tiles that are now chests,
   * with the counts out of step — the piles ended up under the furniture and
   * some tiles got nothing at all.
   */
  interiorTiles: number[];
  /** Room this furniture belongs to. */
  room: RoomType;
  /** Tiles it was placed on, for animation that needs to know where. */
  tiles: number[];
}

const MAX_PROPS = 900;

export class RoomPropRenderer {
  readonly group = new THREE.Group();

  private readonly map: TileMap;
  private readonly material: THREE.MeshToonMaterial;
  private readonly goldMaterial: THREE.MeshToonMaterial;
  private readonly loosePiles: THREE.InstancedMesh;
  private readonly heartMaterial: THREE.MeshToonMaterial;
  private readonly portalMaterial: THREE.MeshToonMaterial;
  /** Both centrepieces light their own chamber. */
  private readonly heartLights: THREE.PointLight[] = [];
  private readonly portalLights: THREE.PointLight[] = [];
  private readonly batches = new Map<RoomType, PropBatch>();

  /** Centrepieces, one per room instance rather than per tile. */
  private readonly heartBase: THREE.InstancedMesh;
  private readonly heartCore: THREE.InstancedMesh;
  private readonly portalRing: THREE.InstancedMesh;
  private readonly portalSwirl: THREE.InstancedMesh;
  private heartSpots: Array<{ x: number; y: number; owner: Owner }> = [];
  private portalSpots: Array<{ x: number; y: number }> = [];

  private lastVersion = -1;
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();

  /** How full the player's treasury is, 0..1 — drives gold pile height. */
  private goldFill = 0;

  constructor(map: TileMap) {
    this.map = map;

    // Furniture is a mix of wood, straw, stone and metal in one merged mesh, so
    // this is a compromise: rough enough for timber, metallic enough that the
    // gold heaps and the anvil catch the dungeon's reflection instead of
    // reading as flat paint.
    /*
     * Toon, on the same ramp as the creatures and the walls.
     *
     * The furniture was the last physically-based thing in the frame, and it
     * showed: a metallic anvil with a smooth environment reflection standing on a
     * cel-shaded floor, next to a cel-shaded troll. Reflections are the giveaway
     * — nothing in a drawing reflects its surroundings — so they go, and what
     * carries the material now is the shape and the flat colour it was built with.
     */
    this.material = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: celRamp(),
    });
    // Gold keeps a faint glow of its own instead of a mirror finish: it is the one
    // thing in a treasury that has to read as treasure from across the room, and
    // with no specular left that has to come from somewhere.
    this.goldMaterial = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: celRamp(),
      emissive: new THREE.Color(0x6a4a12),
      emissiveIntensity: 0.55,
    });
    // The heart and the portal each need their OWN emissive colour. Sharing one
    // material with white emissive drowned the per-instance keeper colour and
    // rendered the heart as a white blob.
    this.heartMaterial = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: celRamp(),
      emissive: new THREE.Color(0x6a0f0c),
      emissiveIntensity: 0.35,
    });
    this.portalMaterial = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: celRamp(),
      emissive: new THREE.Color(0x4a2078),
      emissiveIntensity: 0.4,
    });

    /*
     * Interior piece, then edge piece.
     *
     * The Library's pair is the clearest case of why they are two: the shelf was
     * the room's only prop and it was stamped on all nine tiles, so a library was
     * a block of shelving with no floor to read in. The shelf is now what stands
     * against the wall, and the lectern is what the room is *for*.
     *
     * The Bridge has no edge piece: it is a span, not an enclosure, and its rails
     * already run along both sides of every tile.
     */
    const tiled: Array<
      [RoomType, THREE.BufferGeometry, THREE.BufferGeometry | null, EdgeRule]
    > = [
      [RoomType.Treasury, buildGoldPile(), buildStrongbox(), 'corners'],
      [RoomType.Lair, buildLairNest(), buildBonePile(), 'boundary'],
      [RoomType.Hatchery, buildHatcheryNest(), buildTrough(), 'corners'],
      [RoomType.TrainingRoom, buildTrainingDummy(), buildWeaponRack(), 'boundary'],
      [RoomType.Library, buildLectern(), buildBookshelf(), 'boundary'],
      [RoomType.Workshop, buildWorkshopAnvil(), buildWorkbench(), 'boundary'],
      [RoomType.Bridge, buildBridgeRail(), null, 'boundary'],
    ];
    for (const [room, geo, edgeGeo, edgeRule] of tiled) {
      const material = room === RoomType.Treasury ? this.goldMaterial : this.material;
      const make = (g: THREE.BufferGeometry): THREE.InstancedMesh => {
        const m = new THREE.InstancedMesh(g, material, MAX_PROPS);
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        m.count = 0;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(m);
        return m;
      };
      const mesh = make(geo);
      const edgeMesh = edgeGeo ? make(edgeGeo) : null;
      this.batches.set(room, { mesh, edgeMesh, edgeRule, room, tiles: [], interiorTiles: [] });
    }

    /*
     * Gold lying on the floor.
     *
     * A seam holds three imp-loads, so mining one leaves two of them on the
     * ground, and a full treasury sends every delivery back out onto the flags.
     * Both used to be invisible — the gold simply stopped existing — and the
     * player's only evidence was a number that would not go up. A heap you can
     * see is the difference between a bug and a situation.
     */
    this.loosePiles = new THREE.InstancedMesh(buildGoldPile(), this.goldMaterial, MAX_PROPS);
    this.loosePiles.castShadow = true;
    this.loosePiles.receiveShadow = true;
    this.loosePiles.frustumCulled = false;
    this.loosePiles.count = 0;
    this.loosePiles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.loosePiles);

    this.heartBase = new THREE.InstancedMesh(buildDungeonHeart(), this.material, 8);
    this.heartCore = new THREE.InstancedMesh(buildHeartCore(), this.heartMaterial, 8);
    this.portalRing = new THREE.InstancedMesh(buildPortalRing(), this.material, 8);
    this.portalSwirl = new THREE.InstancedMesh(buildPortalSwirl(), this.portalMaterial, 8);
    for (const m of [this.heartBase, this.heartCore, this.portalRing, this.portalSwirl]) {
      m.castShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
    this.heartCore.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(8 * 3).fill(1), 3);

    // A dungeon heart and a portal are the brightest things in their rooms.
    // Two of each: yours and the nearest rival's. Every extra point light is
    // paid for in every lit fragment, and this budget is shared with torches.
    for (let i = 0; i < 2; i++) {
      const heart = new THREE.PointLight(0xff4a2a, 0, 8, 1.9);
      const portal = new THREE.PointLight(0xa060ff, 0, 6.5, 2.0);
      this.heartLights.push(heart);
      this.portalLights.push(portal);
      this.group.add(heart, portal);
    }
  }

  /** Rebuild placement when the dungeon changes. */
  syncIfDirty(): boolean {
    if (this.map.version === this.lastVersion) return false;
    this.lastVersion = this.map.version;
    this.rebuild();
    return true;
  }

  private rebuild(): void {
    const map = this.map;
    const { dummy } = this;

    for (const batch of this.batches.values()) {
      batch.tiles.length = 0;
      batch.interiorTiles.length = 0;
    }
    // Collect the tiles of each centrepiece room so we can find its middle.
    const heartTiles = new Map<Owner, number[]>();
    const portalTiles = new Map<Owner, number[]>();

    for (let i = 0; i < map.room.length; i++) {
      if ((map.flags[i] & FLAG_REVEALED) === 0) continue;
      if (map.terrain[i] !== Terrain.Claimed) continue;
      const room = map.room[i] as RoomType;
      if (room === RoomType.None) continue;

      if (room === RoomType.DungeonHeart || room === RoomType.Portal) {
        const bucket = room === RoomType.DungeonHeart ? heartTiles : portalTiles;
        const owner = map.owner[i] as Owner;
        let list = bucket.get(owner);
        if (!list) bucket.set(owner, (list = []));
        list.push(i);
        continue;
      }
      const batch = this.batches.get(room);
      if (batch && batch.tiles.length < MAX_PROPS) batch.tiles.push(i);
    }

    // Lay out the tiled furniture, each piece according to where it stands.
    for (const batch of this.batches.values()) {
      let n = 0, edgeN = 0;
      for (const tile of batch.tiles) {
        const x = map.xOf(tile), y = map.yOf(tile);
        const scale = 0.86 + tileRandom(tile, 2) * 0.26;

        // A bridge is a span, not a room: its rails stay square to the tile and
        // it has no inside or outside to speak of.
        if (batch.room === RoomType.Bridge) {
          dummy.position.set(x, 0, y);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.setScalar(1);
          dummy.updateMatrix();
          batch.mesh.setMatrixAt(n++, dummy.matrix);
          batch.interiorTiles.push(tile);
          continue;
        }

        const outward = outwardSidesAt(map, x, y);
        let sides = 0, sx = 0, sz = 0;
        for (let s = 0; s < 4; s++) {
          if (!outward[s]) continue;
          sides++;
          sx += SIDES[s][0];
          sz += SIDES[s][1];
        }

        const wantsEdge = batch.edgeRule === 'corners'
          ? sides === 2
          : sides > 0 && sides < 3;
        if (batch.edgeMesh && wantsEdge) {
          /*
           * Against the boundary, facing in.
           *
           * The piece is modelled facing -Z, so the yaw that turns -Z toward the
           * middle of the room is the bearing of the *inward* direction — the
           * negated sum of the outward sides. On a corner tile that sum points
           * diagonally, and the piece tucks into the corner at forty-five
           * degrees, which is exactly where a real one would end up.
           */
          const len = Math.hypot(sx, sz) || 1;
          const inx = -sx / len, inz = -sz / len;
          dummy.position.set(x - inx * 0.24, 0, y - inz * 0.24);
          dummy.rotation.set(0, Math.atan2(-inx, -inz), 0);
          dummy.scale.setScalar(scale);
          dummy.updateMatrix();
          batch.edgeMesh.setMatrixAt(edgeN++, dummy.matrix);
          continue;
        }

        // Out on the floor: free to sit at any angle, nudged off the grid.
        const spin = tileRandom(tile, 1) * Math.PI * 2;
        const ox = (tileRandom(tile, 3) - 0.5) * 0.22;
        const oz = (tileRandom(tile, 4) - 0.5) * 0.22;
        dummy.position.set(x + ox, 0, y + oz);
        dummy.rotation.set(0, spin, 0);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        batch.mesh.setMatrixAt(n++, dummy.matrix);
        batch.interiorTiles.push(tile);
      }
      batch.mesh.count = n;
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.mesh.computeBoundingSphere();
      if (batch.edgeMesh) {
        batch.edgeMesh.count = edgeN;
        batch.edgeMesh.instanceMatrix.needsUpdate = true;
        batch.edgeMesh.computeBoundingSphere();
      }
    }

    // Loose gold, wherever it is lying. Sized by how much is in the heap, so a
    // seam that has just come down reads differently from a single dropped load.
    let piles = 0;
    for (let i = 0; i < map.gold.length && piles < MAX_PROPS; i++) {
      if (map.gold[i] === 0) continue;
      if ((map.flags[i] & FLAG_REVEALED) === 0) continue;
      if (isSolid(map.terrain[i] as Terrain)) continue;
      const heap = Math.min(1, map.gold[i] / 750);
      const x = map.xOf(i), y = map.yOf(i);
      dummy.position.set(
        x + (tileRandom(i, 5) - 0.5) * 0.3, 0, y + (tileRandom(i, 6) - 0.5) * 0.3,
      );
      dummy.rotation.set(0, tileRandom(i, 7) * Math.PI * 2, 0);
      dummy.scale.setScalar(0.34 + heap * 0.42);
      dummy.updateMatrix();
      this.loosePiles.setMatrixAt(piles++, dummy.matrix);
    }
    this.loosePiles.count = piles;
    this.loosePiles.instanceMatrix.needsUpdate = true;
    this.loosePiles.computeBoundingSphere();

    // Place one centrepiece at the middle of each heart and portal room.
    this.heartSpots = [];
    for (const [owner, tiles] of heartTiles) {
      const centre = this.centroid(tiles);
      this.heartSpots.push({ ...centre, owner });
    }
    this.portalSpots = [];
    for (const [, tiles] of portalTiles) {
      this.portalSpots.push(this.centroid(tiles));
    }

    this.heartBase.count = this.heartSpots.length;
    this.heartCore.count = this.heartSpots.length;
    this.portalRing.count = this.portalSpots.length;
    this.portalSwirl.count = this.portalSpots.length;

    this.heartSpots.forEach((spot, i) => {
      dummy.position.set(spot.x, 0, spot.y);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      this.heartBase.setMatrixAt(i, dummy.matrix);
      // The heart wears its keeper's colour.
      this.color.setHex(OWNER_COLORS[spot.owner]);
      this.heartCore.setColorAt(i, this.color);
    });
    this.portalSpots.forEach((spot, i) => {
      dummy.position.set(spot.x, 0, spot.y);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      this.portalRing.setMatrixAt(i, dummy.matrix);
    });

    this.heartLights.forEach((l, i) => {
      const spot = this.heartSpots[i];
      if (spot) { l.position.set(spot.x, 1.1, spot.y); l.visible = true; }
      else { l.visible = false; l.intensity = 0; }
    });
    this.portalLights.forEach((l, i) => {
      const spot = this.portalSpots[i];
      if (spot) { l.position.set(spot.x, 0.8, spot.y); l.visible = true; l.intensity = 2.2; }
      else { l.visible = false; l.intensity = 0; }
    });

    this.heartBase.instanceMatrix.needsUpdate = true;
    this.portalRing.instanceMatrix.needsUpdate = true;
    if (this.heartCore.instanceColor) this.heartCore.instanceColor.needsUpdate = true;
  }

  private centroid(tiles: number[]): { x: number; y: number } {
    let sx = 0, sy = 0;
    for (const t of tiles) { sx += this.map.xOf(t); sy += this.map.yOf(t); }
    return { x: sx / tiles.length, y: sy / tiles.length };
  }

  /** How full the treasury is, so the gold visibly piles up as you mine. */
  setGoldFill(fill: number): void {
    this.goldFill = Math.max(0, Math.min(1, fill));
  }

  /** Animate the pieces that move. */
  update(time: number): void {
    const { dummy } = this;
    const map = this.map;

    // Gold heaps grow with the vault's contents — a treasury you can read.
    const treasury = this.batches.get(RoomType.Treasury);
    if (treasury && treasury.mesh.count > 0) {
      // Full vaults should look heaped, not like traffic cones.
      const height = 0.35 + this.goldFill * 0.5;
      let n = 0;
      for (const tile of treasury.interiorTiles) {
        const x = map.xOf(tile), y = map.yOf(tile);
        const scale = 0.86 + tileRandom(tile, 2) * 0.26;
        const ox = (tileRandom(tile, 3) - 0.5) * 0.22;
        const oz = (tileRandom(tile, 4) - 0.5) * 0.22;
        // Vary each pile a little so the surface isn't a flat plateau.
        const wobble = 0.8 + tileRandom(tile, 5) * 0.4;
        dummy.position.set(x + ox, 0, y + oz);
        dummy.rotation.set(0, tileRandom(tile, 1) * Math.PI * 2, 0);
        dummy.scale.set(scale, scale * height * wobble, scale);
        dummy.updateMatrix();
        treasury.mesh.setMatrixAt(n++, dummy.matrix);
      }
      treasury.mesh.instanceMatrix.needsUpdate = true;
    }

    // The heart beats: a sharp contraction and a slow release, not a sine.
    if (this.heartCore.count > 0) {
      const beat = (time * 0.8) % 1;
      const pulse = 1 + 0.13 * Math.exp(-beat * 7) + 0.05 * Math.exp(-((beat - 0.22) ** 2) * 90);
      this.heartSpots.forEach((spot, i) => {
        dummy.position.set(spot.x, 0, spot.y);
        dummy.rotation.set(0, time * 0.18, 0);
        dummy.scale.set(pulse, pulse, pulse);
        dummy.updateMatrix();
        this.heartCore.setMatrixAt(i, dummy.matrix);
      });
      this.heartCore.instanceMatrix.needsUpdate = true;
      this.heartMaterial.emissiveIntensity = 0.3 + 0.22 * Math.exp(-beat * 6);
      // The chamber brightens on each beat, but only a little.
      const lit = 3 + 2.5 * Math.exp(-beat * 6);
      for (let i = 0; i < this.heartLights.length; i++) {
        if (this.heartSpots[i]) this.heartLights[i].intensity = lit;
      }
    }

    // The portal turns slowly and bobs, so it never looks like a painted disc.
    if (this.portalSwirl.count > 0) {
      this.portalSpots.forEach((spot, i) => {
        dummy.position.set(spot.x, 0.02 + Math.sin(time * 1.6 + i) * 0.03, spot.y);
        dummy.rotation.set(0, -time * 0.7, 0);
        const s = 1 + Math.sin(time * 2.1 + i) * 0.04;
        dummy.scale.set(s, 1, s);
        dummy.updateMatrix();
        this.portalSwirl.setMatrixAt(i, dummy.matrix);
      });
      this.portalSwirl.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      b.mesh.geometry.dispose();
      b.edgeMesh?.geometry.dispose();
    }
    for (const m of [this.heartBase, this.heartCore, this.portalRing, this.portalSwirl]) {
      m.geometry.dispose();
    }
    this.material.dispose();
    this.goldMaterial.dispose();
    this.heartMaterial.dispose();
    this.portalMaterial.dispose();
  }
}
