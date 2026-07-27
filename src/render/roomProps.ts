import * as THREE from 'three';
import { OWNER_COLORS, Owner, RoomType, Terrain, isSolid } from '../core/constants';
import { FLAG_REVEALED, TileMap } from '../core/tilemap';
import { PartBuilder } from './creatureModels';
import { SIDES, outwardSidesAt, roomInstances } from './roomShell';
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

/*
 * The hoard, in four tiers.
 *
 * It began as four stacked discs — a wedding cake. It then became a mound with
 * coins scattered over it, which was worse in a subtler way: a heap of loose
 * change is what you find in a dragon's cave, not what a keeper who employs
 * accountants keeps in his vault. Gold on a treasury floor has been *put* there
 * by somebody, and the tell is order. Coins go in stacks; bars go in courses;
 * barrels go in a pyramid with their hoops lined up.
 *
 * So there is no mound anywhere in here. Four tiers, and the progression is a
 * story about how rich the room is rather than how tall the pile is:
 *
 *   0  a few coins and a couple of short stacks — small change,
 *   1  a floor of proper stacks, counted and squared away,
 *   2  the stacks joined by a course of cast bars,
 *   3  barrels, stacked in a pyramid, with the bars and stacks beneath them.
 *
 * Which tier a tile wears comes from how much gold has reached it, so a vault
 * filling up changes what it is made of and not merely how big it is.
 */

/** Deterministic noise for laying out a geometry, so a build is repeatable. */
function goldRandom(n: number): number {
  const r = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return r - Math.floor(r);
}

/** The golds a hoard is made of. Never one flat yellow. */
const COIN_COLOURS = [0xd9a520, 0xf2c33c, 0xffd75e, 0xffe89a, 0xc9901c, 0xfff0bf];

const COIN_R = 0.056;
const COIN_T = 0.017;

/**
 * A stack of coins, counted out and squared up.
 *
 * Each coin is turned a few degrees off the one below and leans by a fraction of
 * a degree, because a stack of identical discs in perfect alignment reads as a
 * turned cylinder rather than as money. That is the whole difference: enough
 * irregularity that you can count the coins, not so much that nobody stacked
 * them.
 */
function coinStack(
  b: PartBuilder, x: number, z: number, count: number, seed: number, base = 0,
): void {
  for (let i = 0; i < count; i++) {
    const lean = (goldRandom(seed + i * 3.7) - 0.5) * 0.06;
    b.cylinder(
      COIN_R, COIN_R, COIN_T,
      x + lean * 0.10, base + COIN_T * (i + 0.5), z + lean * 0.10,
      COIN_COLOURS[(i + seed) % COIN_COLOURS.length],
      lean, goldRandom(seed + i * 9.1) * Math.PI, lean, 8,
    );
  }
}

/** A coin lying flat where it was dropped. */
function looseCoin(b: PartBuilder, x: number, z: number, seed: number): void {
  b.cylinder(
    COIN_R, COIN_R, COIN_T, x, COIN_T * 0.5, z,
    COIN_COLOURS[seed % COIN_COLOURS.length],
    (goldRandom(seed * 2.3) - 0.5) * 0.12, goldRandom(seed * 5.1) * Math.PI,
    (goldRandom(seed * 7.7) - 0.5) * 0.12, 8,
  );
}

/*
 * A cast bar.
 *
 * The first one was two stacked boxes, 0.155 long by 0.072 wide by 0.067 tall —
 * near square in section, which is a loaf. A Good Delivery bar is about
 * 250 x 80 x 45mm, so it is three times longer than it is wide and thinner than
 * it is wide again; get that ratio wrong and a row of them reads as pipes.
 *
 * The other half of it is the draft. A bar is cast in an open mould and lifted
 * out, so every face slopes: the top is noticeably smaller than the bottom on
 * all four sides, and the corners are the giveaway. That is a four-sided
 * frustum, which none of the primitives here can make — they all floor their
 * radial segments at eight to keep curved things smooth — so it is built
 * directly and handed over.
 */
const INGOT_LEN = 0.198;
const INGOT_WIDE = 0.066;
const INGOT_TALL = 0.038;

function ingot(b: PartBuilder, x: number, y: number, z: number, yaw: number, tone: number): void {
  // Four radial segments puts a vertex on each axis, so a quarter turn brings
  // the flat faces square-on; the half-extent is then the radius over root two.
  const g = new THREE.CylinderGeometry(0.79, 1, INGOT_TALL, 4, 1);
  g.rotateY(Math.PI / 4);
  g.scale((INGOT_LEN / 2) * Math.SQRT2, 1, (INGOT_WIDE / 2) * Math.SQRT2);
  g.rotateY(yaw);
  g.translate(x, y + INGOT_TALL / 2, z);
  b.add(g, tone);
}

/**
 * A barrel of gold, lying on its side with its hoops showing.
 *
 * Hoops are short wide cylinders rather than tori: a torus is a couple of
 * hundred vertices for a band you see edge-on, and a treasury can be ninety
 * instances of this.
 */
function barrel(b: PartBuilder, x: number, y: number, z: number): void {
  const r = 0.082, len = 0.215;
  // Staves, with a slightly fatter belly ring so it is not a plain tube.
  b.cylinder(r, r, len, x, y, z, 0xe0ad2a, 0, 0, Math.PI / 2, 9);
  b.cylinder(r * 1.05, r * 1.05, len * 0.34, x, y, z, 0xf2c33c, 0, 0, Math.PI / 2, 9);
  // Iron hoops at the quarters and the ends.
  for (const off of [-0.40, 0.40]) {
    b.cylinder(r * 1.09, r * 1.09, 0.026, x + len * off, y, z, 0x5d5348, 0, 0, Math.PI / 2, 9);
  }
  // The lid, facing the camera side, with a stamp on it.
  b.cylinder(r * 0.98, r * 0.98, 0.018, x + len * 0.5, y, z, 0xc9901c, 0, 0, Math.PI / 2, 9);
  b.cylinder(r * 0.42, r * 0.42, 0.024, x + len * 0.52, y, z, 0xffe89a, 0, 0, Math.PI / 2, 7);
}

/** Tier 0: small change. A couple of short stacks and a few loose coins. */
function buildHoardChange(variant: number): THREE.BufferGeometry {
  const b = new PartBuilder();
  const m = variant ? -1 : 1;
  coinStack(b, m * -0.10, 0.06, 3, 11 + variant);
  coinStack(b, m * 0.09, -0.09, 4, 23 + variant);
  coinStack(b, m * 0.14, 0.15, 2, 37 + variant);
  for (let i = 0; i < 5; i++) {
    const a = goldRandom(51 + variant * 97 + i * 4.3) * Math.PI * 2;
    const r = 0.16 + goldRandom(51 + variant * 97 + i * 8.1) * 0.16;
    looseCoin(b, Math.cos(a) * r, Math.sin(a) * r, 51 + i + variant);
  }
  return b.build();
}

/** Tier 1: the floor of the vault, counted into proper stacks. */
function buildHoardStacks(variant: number): THREE.BufferGeometry {
  const b = new PartBuilder();
  const m = variant ? -1 : 1;
  // A loose grid rather than a lattice: stacked by hand, but stacked.
  const spots: Array<[number, number, number]> = [
    [-0.20, -0.18, 7], [0.00, -0.20, 5], [0.19, -0.14, 6],
    [-0.22, 0.04, 6], [-0.02, 0.02, 8], [0.20, 0.06, 5],
    [-0.12, 0.22, 4], [0.12, 0.21, 6],
  ];
  spots.forEach(([x, z, n], i) => {
    const jitter = (goldRandom(70 + variant * 31 + i) - 0.5) * 0.03;
    coinStack(b, m * x + jitter, z + jitter, n + (variant ? 1 : 0), 70 + i * 5 + variant);
  });
  for (let i = 0; i < 4; i++) {
    const a = goldRandom(140 + variant * 61 + i * 5.9) * Math.PI * 2;
    looseCoin(b, Math.cos(a) * 0.34, Math.sin(a) * 0.34, 140 + i + variant);
  }
  return b.build();
}

/** Tier 2: the stacks joined by a course of cast bars. */
function buildHoardBars(variant: number): THREE.BufferGeometry {
  const b = new PartBuilder();
  const m = variant ? -1 : 1;
  // Bars in courses, each course set back and turned across the one below —
  // which is how anything heavy actually gets stacked so it does not walk.
  // Four courses. Three left the tier shorter than the stacks below it, and
  // a richer tier that stands lower than a poorer one reads as a step backwards.
  const rows = [4, 3, 2, 1];
  let y = 0;
  rows.forEach((n, row) => {
    const across = row % 2 === 1;
    for (let i = 0; i < n; i++) {
      const spread = (i - (n - 1) / 2) * 0.078;
      ingot(b, m * (across ? spread : -0.04), y, across ? 0.02 : spread,
        across ? Math.PI / 2 : 0, row === 1 ? 0xf0c542 : 0xe0ad2a);
    }
    y += INGOT_TALL;
  });
  const spots: Array<[number, number, number]> = [
    [-0.28, -0.20, 6], [0.24, -0.22, 5], [-0.26, 0.22, 5], [0.27, 0.18, 7], [0.05, 0.30, 4],
  ];
  spots.forEach(([x, z, n], i) => coinStack(b, m * x, z, n, 160 + i * 7 + variant));
  return b.build();
}

/** Tier 3: barrels, stacked clean, on a bed of bars and stacks. */
function buildHoardBarrels(variant: number): THREE.BufferGeometry {
  const b = new PartBuilder();
  const m = variant ? -1 : 1;
  const r = 0.082;

  // A pyramid: three, then two, then one, all lying the same way with their
  // hoops in line. The order is the point — this is a vault, not a cave.
  const rowZ = [-0.185, 0, 0.185];
  for (const z of rowZ) barrel(b, m * -0.02, r, z);
  for (const z of [-0.093, 0.093]) barrel(b, m * -0.02, r + 0.142, z);
  barrel(b, m * -0.02, r + 0.284, 0);

  // Bars stacked against the near side, and stacks of coins at the corners.
  for (let i = 0; i < 3; i++) {
    ingot(b, m * 0.30, i * INGOT_TALL, -0.10 + i * 0.010, Math.PI / 2,
      i === 1 ? 0xf0c542 : 0xe0ad2a);
  }
  const spots: Array<[number, number, number]> = [
    [0.30, 0.20, 6], [0.26, 0.32, 4], [-0.32, -0.28, 5], [-0.30, 0.30, 5],
  ];
  spots.forEach(([x, z, n], i) => coinStack(b, m * x, z, n + variant, 210 + i * 9 + variant));
  return b.build();
}

/** The four tiers, thinnest first. Index is how full the tile is. */
export const HOARD_TIERS: ReadonlyArray<(variant: number) => THREE.BufferGeometry> = [
  buildHoardChange, buildHoardStacks, buildHoardBars, buildHoardBarrels,
];

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

/**
 * What each of the player's rooms is actually holding, 0..1.
 *
 * A room's structure grows with its tile count; its *contents* grow with use,
 * and until now nothing showed the second. A treasury with fifty gold and a
 * treasury with fifty thousand were the same nine heaps, so the number in the
 * corner of the screen was the only evidence the economy existed. The whole
 * point of hoarding is watching the hoard.
 */
export interface RoomStock {
  /** Gold the keeper holds, and what his vaults could take. */
  gold: number;
  goldCap: number;
  /** How stocked every other room is, 0..1. */
  fills: Partial<Record<RoomType, number>>;
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
   * Every interior prop this batch wrote, with the room it belongs to.
   *
   * `rank` counts outward from the middle of its own room and `total` is how
   * many that room has, so how stocked a room looks is decided per *building*.
   * Doing it per batch — one quota shared across every library on the map —
   * meant three libraries between them showed a single lectern, and expanding
   * one room emptied the others.
   *
   * The treasury re-lays its heaps every frame to grow them with the vault, and
   * it has to write them to the same slots the rebuild used. Walking the room's
   * whole tile list instead put heaps on the corner tiles that are now chests,
   * with the counts out of step — the piles ended up under the furniture and
   * some tiles got nothing at all.
   */
  interiorTiles: Array<{ tile: number; rank: number; total: number }>;
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
  private stock: RoomStock = { gold: 0, goldCap: 0, fills: {} };
  /** Last fill each room was laid out for, so it is only redone when it moves. */
  private readonly lastFill = new Map<RoomType, number>();
  /** Hoard meshes, indexed by tier then variant. */
  private readonly goldTiers: THREE.InstancedMesh[][] = [];

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
      [RoomType.Treasury, HOARD_TIERS[1](0), buildStrongbox(), 'corners'],
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
     * The hoard, in three tiers of two.
     *
     * Two variants of each because instancing means every tile of a full vault
     * wears the same geometry, and at nine or ninety tiles that repeat is the
     * loudest thing in the room — the same crown in the same place, forty times.
     * A random turn about the vertical does not hide it, since the pile is seen
     * from above and its plan is what you read. The second variant is reseeded
     * *and* mirrored, so its loot lands on the other side.
     */
    for (let tier = 0; tier < HOARD_TIERS.length; tier++) {
      const row: THREE.InstancedMesh[] = [];
      for (let variant = 0; variant < 2; variant++) {
        // The middle tier's first variant is the treasury batch's own mesh,
        // already built above; the rest are made here.
        const existing = tier === 1 && variant === 0
          ? this.batches.get(RoomType.Treasury)?.mesh : undefined;
        if (existing) { row.push(existing); continue; }
        const geo = HOARD_TIERS[tier](variant);
        const mesh = new THREE.InstancedMesh(geo, this.goldMaterial, MAX_PROPS);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.count = 0;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        row.push(mesh);
        this.group.add(mesh);
      }
      this.goldTiers.push(row);
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
    this.loosePiles = new THREE.InstancedMesh(HOARD_TIERS[0](0), this.goldMaterial, MAX_PROPS);
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

    this.lastFill.clear();
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

    const instances = roomInstances(map);
    const midDist = (t: number): number =>
      (map.xOf(t) - instances.midX[t]) ** 2 + (map.yOf(t) - instances.midY[t]) ** 2;

    // Lay out the tiled furniture, each piece according to where it stands.
    for (const batch of this.batches.values()) {
      // Grouped by building, and inside each one middle-first: a partly stocked
      // room should look partly stocked, not randomly moth-eaten.
      batch.tiles.sort((a, b) => {
        const ka = instances.midX[a] * 4096 + instances.midY[a];
        const kb = instances.midX[b] * 4096 + instances.midY[b];
        return ka !== kb ? ka - kb : midDist(a) - midDist(b);
      });
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
          batch.interiorTiles.push({ tile, rank: 0, total: 1 });
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
        batch.interiorTiles.push({ tile, rank: 0, total: 0 });
      }

      // Number each building's interior pieces outward from its own middle.
      let runStart = 0;
      for (let k = 0; k <= batch.interiorTiles.length; k++) {
        const sameRoom = k < batch.interiorTiles.length
          && instances.midX[batch.interiorTiles[k].tile]
            === instances.midX[batch.interiorTiles[runStart].tile]
          && instances.midY[batch.interiorTiles[k].tile]
            === instances.midY[batch.interiorTiles[runStart].tile];
        if (sameRoom) continue;
        const total = k - runStart;
        for (let j = runStart; j < k; j++) {
          batch.interiorTiles[j].rank = j - runStart;
          batch.interiorTiles[j].total = total;
        }
        runStart = k;
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
  /** Push what the rooms are holding. Called every frame; costs nothing. */
  setStock(stock: RoomStock): void {
    this.stock = stock;
  }

  /** Animate the pieces that move. */
  update(time: number): void {
    const { dummy } = this;
    const map = this.map;

    /*
     * The hoard, tile by tile.
     *
     * The simulation keeps gold as one number per keeper, so the heaps have to
     * be shared out here. Filling every tile equally was what it used to do, and
     * it meant a nearly-empty vault and a nearly-full one differed by a few
     * centimetres of height across nine identical cones — invisible. Poured
     * instead: each tile takes a full load before the next one gets anything, so
     * gold coming in visibly *spreads*, and a vault at a third full is a third
     * covered. Middle out, because that is where a pile starts.
     */
    const treasury = this.batches.get(RoomType.Treasury);
    if (treasury && this.goldTiers.length === HOARD_TIERS.length) {
      // Every vault fills to the same fraction, because gold is one pool: a
      // keeper a third of the way to full has three vaults a third covered, not
      // one packed and two bare.
      const fraction = this.stock.goldCap > 0
        ? Math.max(0, Math.min(1, this.stock.gold / this.stock.goldCap))
        : 0;
      const counts = HOARD_TIERS.map(() => [0, 0]);
      for (const slot of treasury.interiorTiles) {
        // How much of this tile's own load has arrived. The hoard is poured
        // outward from the middle, so the leading tiles brim before the outer
        // ones have anything.
        const here = Math.max(0, Math.min(1, fraction * slot.total - slot.rank));
        if (here <= 0.02) continue;
        /*
         * Small change, stacks, bars, barrels. Changing what the gold is *made
         * of* is what makes a filling vault read as getting richer; a single
         * shape that only scales says "more of the same", however big it gets.
         */
        const tier = Math.min(
          HOARD_TIERS.length - 1, Math.floor(here * HOARD_TIERS.length),
        );
        const tile = slot.tile;
        const x = map.xOf(tile), y = map.yOf(tile);
        const scale = 0.86 + tileRandom(tile, 2) * 0.26;
        const ox = (tileRandom(tile, 3) - 0.5) * 0.22;
        const oz = (tileRandom(tile, 4) - 0.5) * 0.22;
        // Within a tier the pile still swells, so gold arriving between one
        // threshold and the next is not a dead zone where nothing happens.
        // Within a tier the arrangement still grows a little, so gold arriving
        // between one threshold and the next is not a dead zone.
        const band = here * HOARD_TIERS.length - tier;
        const grow = 0.84 + band * 0.22;
        const wobble = 0.85 + tileRandom(tile, 5) * 0.3;
        dummy.position.set(x + ox, 0, y + oz);
        dummy.rotation.set(0, tileRandom(tile, 1) * Math.PI * 2, 0);
        dummy.scale.set(scale * grow, scale * grow * wobble, scale * grow);
        dummy.updateMatrix();
        // Which of the two builds this tile happens to have is fixed by the
        // tile, so a hoard does not flip its crown to the other side every time
        // a coin arrives.
        const variant = tileRandom(tile, 8) < 0.5 ? 0 : 1;
        const mesh = this.goldTiers[tier][variant];
        mesh.setMatrixAt(counts[tier][variant]++, dummy.matrix);
      }
      for (let t = 0; t < HOARD_TIERS.length; t++) {
        for (let v = 0; v < 2; v++) {
          this.goldTiers[t][v].count = counts[t][v];
          this.goldTiers[t][v].instanceMatrix.needsUpdate = true;
        }
      }
    }

    /*
     * Everything else: as much furniture as the room has reason to hold.
     *
     * Pieces were laid out grouped by building and middle-first, so each room's
     * quota is the leading run of its own group. It cannot be done by trimming
     * the mesh's instance count — one batch holds every library on the map, and
     * a count only clips the tail — so the surplus is compacted out instead.
     *
     * At least one piece always stands. A training room with nobody in it is
     * still a training room, and a bare floor would read as unbuilt.
     */
    for (const batch of this.batches.values()) {
      if (batch.room === RoomType.Treasury || batch.room === RoomType.Bridge) continue;
      const fill = this.stock.fills[batch.room];
      if (fill === undefined || batch.interiorTiles.length === 0) continue;
      if (this.lastFill.get(batch.room) === fill) continue;
      this.lastFill.set(batch.room, fill);

      let n = 0;
      for (const slot of batch.interiorTiles) {
        const quota = Math.max(1, Math.ceil(fill * slot.total));
        if (slot.rank >= quota) continue;
        const tile = slot.tile;
        const x = map.xOf(tile), y = map.yOf(tile);
        const scale = 0.86 + tileRandom(tile, 2) * 0.26;
        dummy.position.set(
          x + (tileRandom(tile, 3) - 0.5) * 0.22, 0, y + (tileRandom(tile, 4) - 0.5) * 0.22,
        );
        dummy.rotation.set(0, tileRandom(tile, 1) * Math.PI * 2, 0);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        batch.mesh.setMatrixAt(n++, dummy.matrix);
      }
      batch.mesh.count = n;
      batch.mesh.instanceMatrix.needsUpdate = true;
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
    for (const row of this.goldTiers) for (const m of row) m.geometry.dispose();
    for (const m of [this.heartBase, this.heartCore, this.portalRing, this.portalSwirl]) {
      m.geometry.dispose();
    }
    this.material.dispose();
    this.goldMaterial.dispose();
    this.heartMaterial.dispose();
    this.portalMaterial.dispose();
  }
}
