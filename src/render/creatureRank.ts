import * as THREE from 'three';
import { Creature, CreatureType } from '../core/creatures';
import { PartBuilder } from './creatureModels';

/**
 * What a creature earns by surviving.
 *
 * A number going up in a roster panel is not progression you can see. In the
 * original you could tell a veteran across the room, and that is most of why
 * training a creature felt worth the gold. So rank is worn: a promoted creature
 * grows, then gets fitted out, and a max-rank one is unmistakable.
 *
 * Three ranks, because two is not a progression and four is not legible at the
 * distance this game is played from:
 *
 *   - **Blooded** (4-6): plating over the shoulders and a row of iron studs
 *     down the spine. Scavenged, not issued — it does not match.
 *   - **Veteran** (7-8): heavier pauldrons with rivets, bracers, a jawguard,
 *     and spines that have grown into real spikes.
 *   - **Champion** (9-10): all of that in bright metal, plus a horned circlet
 *     and a banner on the back. This one has clearly killed a lot of people.
 *
 * The body underneath never changes, which matters: a champion troll must still
 * read as a troll and not as a generic armoured thing. Regalia is a separate
 * instanced layer drawn with the body's own matrix, so it costs one extra draw
 * call per species per rank and nothing per creature.
 *
 * Insects and flyers get a different family — carapace studs and wing-root
 * spurs. A fly in pauldrons is funny once and then it is just wrong.
 */

/** 0 = no regalia, 1 = blooded, 2 = veteran, 3 = champion. */
export type Rank = 0 | 1 | 2 | 3;

/**
 * Where a species' body actually is.
 *
 * Every offset below is a fraction of these rather than an absolute number.
 * Hard-coded offsets were the first attempt and they were wrong: the eleven
 * species differ enormously in build — a fly is a third the height of a bile
 * demon and a dragon is mostly length — so one set of numbers put armour beside
 * the creature rather than on it. Measuring the body's bounding box costs
 * nothing at load time and fits all of them.
 */
export interface BodyRig {
  /** Top of the body, model space. */
  top: number;
  /** Half-width across the shoulders. */
  half: number;
  /** Half-depth front to back. */
  depth: number;
}

/** Measure a body geometry so its kit can be placed against it. */
export function rigFor(body: THREE.BufferGeometry): BodyRig {
  body.computeBoundingBox();
  const box = body.boundingBox;
  if (!box) return { top: 1, half: 0.3, depth: 0.3 };
  return {
    top: Math.max(0.2, box.max.y),
    half: Math.max(0.08, Math.max(Math.abs(box.min.x), box.max.x)),
    depth: Math.max(0.08, Math.max(Math.abs(box.min.z), box.max.z)),
  };
}

/** Ranks that actually draw something. */
export const WORN_RANKS: readonly Rank[] = [1, 2, 3];

/**
 * Rank from creature level.
 *
 * Levels 1-3 are deliberately bare. A creature that arrives already decorated
 * has nothing left to earn, and the contrast against a fresh recruit is the
 * whole point.
 */
export function rankOf(level: number): Rank {
  if (level >= 9) return 3;
  if (level >= 7) return 2;
  if (level >= 4) return 1;
  return 0;
}

/** How much bigger a creature gets with rank. Champions are noticeably large. */
export function rankScale(level: number): number {
  return 1 + 0.042 * (level - 1);
}

/**
 * Scavenged iron, then steel, then polished steel with gold.
 *
 * Deliberately cool and bright. The first pass used olive-tinted trim, which
 * under warm torchlight and a heavily metallic material came out lurid green —
 * the metal has to fight the light in this scene, not agree with it.
 */
const IRON = [0x8d949f, 0xacb4c1, 0xd8dfe9];
const IRON_DARK = [0x646a74, 0x7d848f, 0xa3abb7];
const TRIM = [0x9a8a63, 0xc8a75c, 0xf5d477];

/**
 * Is this species built like something that wears armour?
 *
 * Flyers and the beetle are not, and the imp is a worker who would never be
 * issued any — it gets a heavier tool belt and brighter eyes instead.
 */
function family(type: CreatureType): 'plated' | 'carapace' {
  switch (type) {
    case CreatureType.Fly:
    case CreatureType.Beetle:
      return 'carapace';
    default:
      return 'plated';
  }
}

/* --------------------------------------------------------------- geometry -- */

/**
 * Armour for an upright creature, in the body's own model space.
 *
 * All positions are fractions of the measured rig, so the same design fits a fly
 * and a bile demon without either of them wearing it in the wrong place. Piece
 * *thickness* also scales with build: a pauldron sized for an imp disappears on
 * a dragon, and one sized for a dragon swallows an imp.
 */
function buildPlated(rank: Rank, rig: BodyRig): THREE.BufferGeometry {
  const b = new PartBuilder();
  const i = rank - 1;
  const metal = IRON[i], dark = IRON_DARK[i], trim = TRIM[i];
  const { top, half, depth } = rig;

  // Anchors, as fractions of the body. Shoulders sit a little above the middle
  // of the mass; the head is near the top; kit rides just outside the silhouette
  // so it never sinks inside the body.
  //
  // Width is always clamped against height. The bounding box's half-width is the
  // widest point of the whole model, and on a winged creature that is the
  // wingtip — sizing a circlet from it gave the dragon a crown wider than it was
  // tall. Height is the more honest proxy for how big an animal's head and
  // shoulders are.
  const build = Math.min(half, top * 0.45);
  const headHalf = Math.min(half * 0.45, top * 0.2);
  const shoulderY = top * 0.60;
  const headY = top * 0.82;
  const armX = build * 0.85;
  const backZ = -Math.min(depth, top * 0.5) * 0.55;
  const frontZ = Math.min(depth, top * 0.5) * 0.45;
  const unit = Math.min(build * 0.7, top * 0.24);

  // Shoulder plates. These do the most work: they widen the silhouette, which
  // is what you actually read at playing distance.
  for (const side of [-1, 1]) {
    const px = side * armX;
    b.sphere(unit * (0.33 + rank * 0.05), px, shoulderY, 0, metal, 1.2, 0.55, 1.0, 8);
    b.box(unit * 0.3, unit * 0.13, unit * 0.44, px, shoulderY - unit * 0.2, 0,
      dark, 0, 0, side * 0.3);
    if (rank >= 2) {
      for (let r = 0; r < 3; r++) {
        b.sphere(unit * 0.075, px + side * unit * 0.16, shoulderY + unit * 0.14,
          (r - 1) * unit * 0.28, trim, 1, 1, 0.6, 5);
      }
      // A spike out over each shoulder.
      b.cone(unit * 0.12, unit * 0.55, px + side * unit * 0.34, shoulderY + unit * 0.14, 0,
        metal, 0, 0, side * -1.05, 5);
    }
    if (rank >= 3) {
      b.cylinder(unit * 0.22, unit * 0.24, unit * 0.36,
        px + side * unit * 0.06, shoulderY - unit * 0.5, 0, metal, 0, 0, side * 0.18, 7);
      b.torus(unit * 0.23, unit * 0.045,
        px + side * unit * 0.06, shoulderY - unit * 0.34, 0, trim, 0, 0, 0);
    }
  }

  // A collar between the pauldrons. Deliberately a ring rather than a strap: a
  // flat plate across the chest reads as a floating slab from the overhead-ish
  // angle this game is actually played at, whatever it looks like side-on.
  b.torus(build * 0.55, unit * 0.11, 0, shoulderY - unit * 0.18, 0, dark, -1.35, 0, 0);
  b.sphere(unit * 0.15, 0, shoulderY - unit * 0.3, frontZ * 0.8, trim, 1, 1, 0.7, 6);

  // Studs down the spine, growing into spikes with rank.
  const spines = rank >= 2 ? 4 : 3;
  for (let sp = 0; sp < spines; sp++) {
    const t = sp / Math.max(1, spines - 1);
    b.cone(unit * (0.11 + rank * 0.025), unit * (0.26 + rank * 0.2),
      0, shoulderY - t * top * 0.1, backZ * (0.6 + t * 0.5), metal, -0.5, 0, 0, 5);
  }

  if (rank >= 2) {
    // A jawguard. The cheapest way to make a face look hardened.
    b.box(headHalf * 1.5, unit * 0.26, unit * 0.36, 0, headY - top * 0.1, frontZ * 0.85, metal);
    b.sphere(unit * 0.11, 0, headY - top * 0.1, frontZ * 1.05, trim, 1, 1, 0.8, 5);
  }

  if (rank >= 3) {
    // A horned circlet. Not a crown — nobody gave it to them.
    b.torus(headHalf * 1.15, unit * 0.1, 0, headY + top * 0.06, 0, trim, -Math.PI / 2, 0, 0);
    for (const side of [-1, 1]) {
      b.cone(unit * 0.19, unit * 1.05, side * headHalf, headY + top * 0.16, 0,
        metal, -0.2, 0, side * -0.5, 6);
      b.sphere(unit * 0.13, side * headHalf, headY + top * 0.08, 0, trim, 1, 1, 1, 5);
    }
    // A single tall spike at the front of the circlet.
    b.cone(unit * 0.15, unit * 0.6, 0, headY + top * 0.14, frontZ * 0.5, trim, 0, 0, 0, 6);

    // A crest of blades along the spine, rather than the banner this first had.
    // A banner is a flat panel, and from overhead a flat panel is a slab hanging
    // in the air next to the creature — it read as a bug on every species.
    for (let sp = 0; sp < 3; sp++) {
      b.cone(unit * 0.13, unit * (0.85 - sp * 0.16), 0,
        shoulderY + top * 0.06 - sp * top * 0.05, backZ * (0.7 + sp * 0.35),
        trim, -0.42, 0, 0, 5);
    }
  }
  return b.build();
}

/**
 * Carapace hardening, for the things that are already armoured.
 *
 * Same read — bigger, spikier, brighter with rank — expressed as the shell
 * thickening rather than as kit being strapped on. A fly in pauldrons is funny
 * once and then it is just wrong.
 */
function buildCarapace(rank: Rank, rig: BodyRig): THREE.BufferGeometry {
  const b = new PartBuilder();
  const i = rank - 1;
  const metal = IRON[i], trim = TRIM[i];
  const { top, half, depth } = rig;
  // Tighter against height than it looks like it needs to be, for the same reason
  // the crown is: the widest creature in the roster is wider than it is tall, and
  // a collar scaled off its half-width came out as a hoop standing clear of the
  // body on both sides. Kit has to look strapped to a shoulder, not hung on a peg.
  const build = Math.min(half, top * 0.42);
  const unit = Math.min(build * 0.75, top * 0.3);
  const backY = top * 0.78;

  // Studs across the shell, in one row then two.
  const rows = rank >= 2 ? 2 : 1;
  for (let row = 0; row < rows; row++) {
    const off = rows === 1 ? 0 : (row === 0 ? -1 : 1) * build * 0.34;
    for (let sp = 0; sp < 3; sp++) {
      b.cone(unit * (0.13 + rank * 0.03), unit * (0.24 + rank * 0.18),
        off, backY, (sp - 1) * depth * 0.42, metal, -0.35, 0, 0, 5);
    }
  }

  // A collar where the head meets the thorax.
  b.torus(build * 0.7, unit * (0.09 + rank * 0.02), 0, top * 0.6,
    Math.min(depth, top * 0.5) * 0.4, trim, -1.2, 0, 0);

  if (rank >= 2) {
    // Spurs at the wing roots.
    for (const side of [-1, 1]) {
      b.cone(unit * 0.14, unit * 0.72, side * build * 0.82, top * 0.68, 0,
        metal, 0, 0, side * -1.15, 5);
    }
  }
  if (rank >= 3) {
    // A crest along the back, and gilding round the shell edge.
    for (let sp = 0; sp < 3; sp++) {
      b.cone(unit * 0.13, unit * (0.66 - sp * 0.12), 0, backY + top * 0.1,
        (sp - 1) * depth * 0.36, trim, -0.25, 0, 0, 5);
    }
    b.torus(build * 0.95, unit * 0.07, 0, top * 0.42, 0, trim, -Math.PI / 2, 0, 0);
  }
  return b.build();
}

/** Build the regalia geometry for one species at one rank. */
export function buildRankRegalia(
  type: CreatureType, rank: Rank, rig: BodyRig,
): THREE.BufferGeometry {
  return family(type) === 'carapace'
    ? buildCarapace(rank, rig)
    : buildPlated(rank, rig);
}

/* ------------------------------------------------------------------ aura -- */

/**
 * A champion's aura: a slow ring of light at its feet.
 *
 * Only at the top rank, and only ever one ring, because the moment several
 * creatures have auras the floor stops reading as floor.
 */
export function auraStrength(c: Creature, time: number): number {
  if (rankOf(c.level) < 3) return 0;
  return 0.55 + 0.45 * Math.sin(time * 1.7 + c.seed * 6);
}

/** Eye glow multiplier: a champion's eyes are lit from inside. */
export function eyeGlowFor(level: number): number {
  return 1 + rankOf(level) * 0.45;
}
