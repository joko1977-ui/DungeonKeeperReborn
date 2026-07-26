import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CreatureType } from '../core/creatures';

/**
 * Creature models, built from primitives at load time.
 *
 * Each type produces three merged geometries — body, a limb that gets mirrored,
 * and a pair of glowing eyes — so a whole species renders in three instanced
 * draw calls no matter how many of them are running about.
 *
 * The models are stylised, not realistic, but they are built from real anatomy:
 * a jaw that opens off the skull, a browline, shoulders wider than the head,
 * tapering tails, hands with individual claws, and the gear each species would
 * actually carry. That detail is what separates a troll from a bile demon at a
 * glance, and a pile of spheres does not do it.
 *
 * Detail is affordable because geometry is uploaded once per species and then
 * instanced: extra parts cost vertex transform, never draw calls. Small
 * decorative pieces drop to four or five segments to keep the totals sane on a
 * tablet.
 */

export interface CreatureModel {
  body: THREE.BufferGeometry;
  limb: THREE.BufferGeometry;
  eyes: THREE.BufferGeometry;
  /** Where the limbs attach, in model space. */
  limbOffset: THREE.Vector3;
  /** Do limbs flap (wings) rather than swing (legs)? */
  flapping: boolean;
  /** Overall height, used to place name tags and pick radii. */
  height: number;
}

/**
 * Accumulates coloured primitives, then merges them into one geometry.
 *
 * Exported because room furniture is built exactly the same way — chunky
 * shapes, flat vertex colours, merged into a single instanced draw.
 */
/**
 * Floors on how coarse a primitive is allowed to be.
 *
 * Every shape in the roster used to be built at four to nine segments, which is
 * why the creatures read as *edgy*: at that resolution a sphere is a faceted
 * lump, a cone is a pyramid, and a horn is a wedge. Individual call sites all
 * asked for low counts to be frugal, and the frugality was misplaced — geometry
 * here is uploaded once per species and then instanced, so extra segments cost
 * vertex transform and never a draw call. Twenty creatures on screen cost
 * exactly what one does.
 *
 * Clamping centrally rather than editing several hundred call sites: each of
 * those numbers was chosen relative to the part's size, and the ratios between
 * them are still right. They just all needed a floor under them.
 */
const MIN_RADIAL = 16;
const MIN_CONE_RADIAL = 14;
const MIN_TORUS_RADIAL = 10;
const MIN_TORUS_TUBULAR = 28;

export class PartBuilder {
  private readonly parts: THREE.BufferGeometry[] = [];

  private push(geo: THREE.BufferGeometry, color: number): void {
    const c = new THREE.Color(color).convertSRGBToLinear();
    const n = geo.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // Merging requires a consistent attribute set across parts.
    geo.deleteAttribute('uv');
    this.parts.push(geo);
  }

  sphere(r: number, x: number, y: number, z: number, color: number,
    sx = 1, sy = 1, sz = 1, seg = 9): this {
    const rings = Math.max(MIN_RADIAL, seg);
    const g = new THREE.SphereGeometry(r, rings, Math.max(10, Math.round(rings * 0.7)));
    g.scale(sx, sy, sz);
    g.translate(x, y, z);
    this.push(g, color);
    return this;
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, color: number,
    rx = 0, ry = 0, rz = 0): this {
    // Segmented rather than a bare cube. With smooth vertex normals across the
    // merged mesh this rounds the arrises very slightly, which is the
    // difference between a shape and a brick.
    const g = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    this.push(g, color);
    return this;
  }

  cone(r: number, h: number, x: number, y: number, z: number, color: number,
    rx = 0, ry = 0, rz = 0, seg = 7): this {
    const g = new THREE.ConeGeometry(r, h, Math.max(MIN_CONE_RADIAL, seg));
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    this.push(g, color);
    return this;
  }

  cylinder(rt: number, rb: number, h: number, x: number, y: number, z: number, color: number,
    rx = 0, ry = 0, rz = 0, seg = 7): this {
    const g = new THREE.CylinderGeometry(rt, rb, h, Math.max(MIN_RADIAL, seg));
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    this.push(g, color);
    return this;
  }

  torus(radius: number, tube: number, x: number, y: number, z: number, color: number,
    rx = -Math.PI / 2, ry = 0, rz = 0, arc = Math.PI * 2): this {
    const g = new THREE.TorusGeometry(radius, tube, MIN_TORUS_RADIAL, MIN_TORUS_TUBULAR, arc);
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    this.push(g, color);
    return this;
  }

  build(): THREE.BufferGeometry {
    if (this.parts.length === 0) {
      // Merging needs at least one part; hand back something degenerate.
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3), 3));
      return g;
    }
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    if (!merged) throw new Error('failed to merge creature geometry');
    merged.computeVertexNormals();
    return merged;
  }
}

/**
 * A pair of eyes, built the way a comic draws them.
 *
 * These were two white spheres with an additive glow, which from any distance
 * was a pair of bright dots — no gaze, no expression, no character. Eyes are
 * where a stylised creature's personality lives, so they are now built
 * properly and built *large*: a big coloured iris, a hard black pupil, and an
 * offset white catchlight. The catchlight is what does most of the work; it is
 * the difference between an eye and a marble.
 *
 * Deliberately oversized against the skull — well past anatomical, which is
 * exactly the convention being borrowed. The pair is also slightly asymmetric,
 * because two identical eyes read as a machine.
 */
function eyePair(
  y: number, z: number, spread: number, r: number,
  iris = 0xffb020, angry = 0.0,
): THREE.BufferGeometry {
  const b = new PartBuilder();
  // Comic proportions: a good deal bigger than the anatomy would suggest.
  const R = r * 2.15;

  for (const side of [-1, 1]) {
    // One eye a fraction larger and higher — asymmetry is personality.
    const wobble = side < 0 ? 1.06 : 0.95;
    const e = R * wobble;
    const ex = side * spread * 1.08;
    const ey = y + (side < 0 ? e * 0.05 : -e * 0.04);

    // Sclera, flattened back into the head so it sits in a socket.
    b.sphere(e, ex, ey, z, 0xf4f0e6, 1, 1, 0.62, 9);
    // Iris, then a hard pupil in front of it.
    b.sphere(e * 0.62, ex, ey, z + e * 0.5, iris, 1, 1, 0.5, 8);
    b.sphere(e * 0.34, ex, ey, z + e * 0.72, 0x140c08, 1, 1, 0.5, 7);
    // The catchlight: high and off to one side, and the same side on both eyes
    // so they agree about where the light is.
    b.sphere(e * 0.2, ex - e * 0.3, ey + e * 0.34, z + e * 0.78, 0xffffff, 1, 1, 0.5, 6);

    // A heavy brow ridge sloping inward. This is the whole expression: level
    // brows read as blank, angled ones read as furious.
    if (angry > 0) {
      b.box(e * 1.5, e * 0.42, e * 0.5,
        ex, ey + e * 1.05, z + e * 0.25, 0x1a1008, 0, 0, side * angry);
    }
  }
  return b.build();
}

/* --------------------------------------------------------------- models -- */

/*
 * Each species is 25-40 primitives rather than the half-dozen it started as.
 * The budget goes on the things that make a silhouette readable at the game's
 * camera height: a jaw, a browline, back spines, a tail that tapers, hands
 * with claws, and gear. Small decorative parts drop to 5-6 segments, which is
 * what pays for the extra count — geometry is uploaded once per species and
 * instanced, so detail costs vertex transform, not draw calls.
 */

/** A swept pair of horns, mirrored about x. */
function horns(
  b: PartBuilder, r: number, h: number, x: number, y: number, z: number,
  color: number, tilt: number, sweep: number,
): void {
  b.cone(r, h, -x, y, z, color, tilt, 0, sweep, 5);
  b.cone(r, h, x, y, z, color, tilt, 0, -sweep, 5);
}

/** A row of shrinking dorsal spines running back along -z. */
function dorsalSpines(
  b: PartBuilder, count: number, z0: number, dz: number,
  y: number, dy: number, r: number, h: number, color: number,
): void {
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count - 1);
    b.cone(r * (1 - t * 0.55), h * (1 - t * 0.5),
      0, y + dy * i, z0 + dz * i, color, -0.25, 0, 0, 5);
  }
}

/** A tapering segmented tail curving away behind the creature. */
function tail(
  b: PartBuilder, segments: number, x: number, y: number, z: number,
  r: number, step: number, drop: number, color: number, tipColor: number,
): void {
  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    b.sphere(r * (1 - t * 0.62), x, y - drop * i, z - step * i, color,
      1, 0.9, 1.25, 6);
  }
  b.cone(r * 0.6, r * 2.4, x, y - drop * segments, z - step * segments,
    tipColor, -1.25, 0, 0, 5);
}

/** Two upward tusks. */
function tusks(
  b: PartBuilder, r: number, h: number, x: number, y: number, z: number, color: number,
): void {
  b.cone(r, h, -x, y, z, color, -2.5, 0, 0.18, 5);
  b.cone(r, h, x, y, z, color, -2.5, 0, -0.18, 5);
}

/* --------------------------------------------------------------- worker -- */

/**
 * The imp: the dungeon's put-upon workforce.
 *
 * Built to the art direction rather than to anatomy — stocky and muscular but
 * cartoonishly proportioned, with a head and hands far too big for the body.
 * That exaggeration is the whole personality: a realistically proportioned imp
 * is a small demon, and a small demon is not funny. Roughly a metre tall against
 * a 1.7 m creature, which is why it reads as staff rather than as a threat.
 *
 * The face carries it: a wide underbite full of teeth, a heavy brow, and two
 * deliberately mismatched eyes. Perfect symmetry is what makes a stylised face
 * look like a prop.
 */
function buildImp(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  // Skin runs bright at the thin parts — ears, fingers — where light would get
  // through. There is no subsurface term in this material, so the shading is
  // baked into the vertex colours instead.
  const thin = 0xe86a55;
  const belly = 0xd8674a;

  // Torso: barrel-chested and hunched, shoulders rolled forward over the work.
  b.sphere(0.30, 0, 0.34, -0.02, color, 1.12, 0.92, 1.0);
  b.sphere(0.23, 0, 0.27, 0.15, belly, 1.05, 0.86, 0.72, 8);
  // Deltoids: this is a creature that swings a pick all day.
  b.sphere(0.155, -0.25, 0.46, 0, color, 1, 0.92, 1, 8);
  b.sphere(0.155, 0.25, 0.46, 0, color, 1, 0.92, 1, 8);

  // Head, deliberately oversized: a third of the whole silhouette.
  b.sphere(0.28, 0, 0.72, 0.04, color, 1.12, 1.02, 1.0, 10);
  // Heavy brow ridge, and a blunt snout under it.
  b.box(0.38, 0.09, 0.18, 0, 0.81, 0.15, accent);
  b.sphere(0.15, 0, 0.66, 0.20, color, 1.15, 0.8, 1.0, 8);
  b.sphere(0.09, 0, 0.62, 0.27, thin, 1.3, 0.75, 1, 7);
  // Nostrils.
  b.sphere(0.022, -0.045, 0.655, 0.31, 0x5a1f14, 1, 1, 1, 5);
  b.sphere(0.022, 0.045, 0.655, 0.31, 0x5a1f14, 1, 1, 1, 5);

  // The grin: a wide jaw with an underbite and too many teeth.
  b.box(0.24, 0.075, 0.15, 0, 0.575, 0.20, accent);
  for (let i = 0; i < 5; i++) {
    const t = (i / 4 - 0.5) * 0.19;
    b.cone(0.021, 0.075, t, 0.625, 0.245, 0xf4ecd6, 0, 0, 0, 4);
  }
  // Two tusks from the lower jaw, one longer than the other.
  b.cone(0.032, 0.13, -0.085, 0.63, 0.235, 0xf4ecd6, -0.25, 0, 0.1, 5);
  b.cone(0.028, 0.10, 0.085, 0.62, 0.235, 0xf4ecd6, -0.25, 0, -0.1, 5);

  // Ears: big, swept back, and paler where they thin out.
  b.cone(0.115, 0.42, -0.24, 0.84, -0.05, accent, -0.35, 0, 1.0, 6);
  b.cone(0.115, 0.42, 0.24, 0.84, -0.05, accent, -0.35, 0, -1.0, 6);
  b.cone(0.065, 0.30, -0.23, 0.83, -0.02, thin, -0.35, 0, 1.0, 5);
  b.cone(0.065, 0.30, 0.23, 0.83, -0.02, thin, -0.35, 0, -1.0, 5);

  // Horn nubs, a ridge of spines, and a spade-tipped tail.
  horns(b, 0.038, 0.12, 0.11, 0.90, 0.02, accent, -0.4, 0.3);
  dorsalSpines(b, 3, -0.12, -0.08, 0.46, -0.03, 0.035, 0.09, accent);
  tail(b, 3, 0, 0.28, -0.26, 0.062, 0.11, 0.03, color, accent);

  // Loincloth and a working belt with a pouch.
  b.box(0.30, 0.17, 0.23, 0, 0.15, 0, 0x5a3a26);
  b.box(0.34, 0.055, 0.27, 0, 0.235, 0, 0x3d2820);
  b.box(0.10, 0.10, 0.07, 0.13, 0.20, 0.13, 0x6b4a30);

  // A pickaxe, carried across the back. An imp is never not working, and the
  // tool is most of what says so at a glance.
  b.cylinder(0.026, 0.026, 0.62, -0.02, 0.42, -0.19, 0x7a5432, 0.42, 0.5, 0.2, 6);
  b.box(0.045, 0.05, 0.34, -0.14, 0.70, -0.30, 0x8d949f, 0, 0.5, 0.15);
  b.cone(0.045, 0.16, -0.14, 0.70, -0.46, 0xacb4c1, Math.PI / 2, 0.5, 0, 5);
  b.cone(0.045, 0.16, -0.14, 0.70, -0.14, 0xacb4c1, -Math.PI / 2, 0.5, 0, 5);

  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      // Thick upper arm, narrow wrist, and a hand far too big for either.
      l.cylinder(0.068, 0.052, 0.20, 0, -0.10, 0, color, 0, 0, 0, 7);
      l.sphere(0.052, 0, -0.20, 0, color, 1, 1, 1, 7);
      l.cylinder(0.048, 0.042, 0.16, 0, -0.29, 0.01, color, 0, 0, 0, 7);
      l.sphere(0.075, 0, -0.395, 0.03, thin, 1.15, 0.8, 1.35, 8);
      // Three fingers and a thumb, all claw.
      for (let i = 0; i < 3; i++) {
        l.cone(0.022, 0.085, (i - 1) * 0.045, -0.425, 0.10, 0xf4ecd6, -Math.PI / 2, 0, 0, 4);
      }
      l.cone(0.020, 0.07, 0.06, -0.40, 0.02, 0xf4ecd6, -Math.PI / 2, 0, -0.6, 4);
      return l.build();
    })(),
    // Huge and yellow, with a hard scowl. An imp is the comic relief and its
    // face has to carry that from across the room.
    eyes: eyePair(0.755, 0.20, 0.115, 0.062, 0xffc21e, 0.6),
    limbOffset: new THREE.Vector3(0.16, 0.20, 0),
    flapping: false,
    height: 1.0,
  };
}

/* -------------------------------------------------------------- insects -- */

function buildFly(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  // Segmented abdomen tapering back, banded like a real dipteran.
  b.sphere(0.19, 0, 0.32, -0.06, color, 1.15, 1, 1.2);
  b.sphere(0.155, 0, 0.31, -0.26, accent, 1.1, 1, 1.1, 7);
  b.sphere(0.12, 0, 0.30, -0.42, color, 1, 1, 1, 6);
  b.cone(0.08, 0.16, 0, 0.30, -0.56, accent, -Math.PI / 2, 0, 0, 6);
  // Thorax with a furry collar.
  b.sphere(0.15, 0, 0.33, 0.14, accent, 1.1, 1.05, 1, 7);
  b.torus(0.13, 0.035, 0, 0.33, 0.10, 0xd8e0b0, Math.PI / 2);
  // Head, proboscis, antennae.
  b.sphere(0.115, 0, 0.34, 0.30, color, 1, 1, 0.95, 7);
  b.cone(0.035, 0.16, 0, 0.28, 0.40, 0x6a5a2a, Math.PI / 2, 0, 0, 5);
  b.cone(0.014, 0.13, -0.05, 0.44, 0.34, 0x4a4020, -0.5, 0, 0.4, 4);
  b.cone(0.014, 0.13, 0.05, 0.44, 0.34, 0x4a4020, -0.5, 0, -0.4, 4);
  // Wing roots and bristles along the back.
  b.sphere(0.05, -0.10, 0.42, 0.10, 0xd8e0b0, 1, 0.6, 1, 5);
  b.sphere(0.05, 0.10, 0.42, 0.10, 0xd8e0b0, 1, 0.6, 1, 5);
  for (let i = 0; i < 4; i++) {
    b.cone(0.012, 0.07, 0, 0.44 - i * 0.01, 0.02 - i * 0.13, 0x4a4020, -0.6, 0, 0, 4);
  }
  return {
    body: b.build(),
    // A veined wing: leading-edge spar plus a thin membrane panel.
    limb: (() => {
      const l = new PartBuilder();
      l.box(0.028, 0.014, 0.42, 0, 0, -0.20, 0xb8c88a);
      l.box(0.10, 0.006, 0.36, 0.03, -0.004, -0.19, 0xe8f0d8);
      l.box(0.05, 0.006, 0.22, 0.06, -0.006, -0.30, 0xdce8c8);
      return l.build();
    })(),
    eyes: eyePair(0.36, 0.36, 0.085, 0.062, 0x8ad4ff, 0.55),
    limbOffset: new THREE.Vector3(0.09, 0.42, 0.08),
    flapping: true,
    height: 0.62,
  };
}

function buildBeetle(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const shell = 0x5a4632;
  // Low domed carapace with a split down the middle and segment ridges.
  b.sphere(0.36, 0, 0.24, -0.04, shell, 1.25, 0.66, 1.45);
  b.box(0.045, 0.13, 0.74, 0, 0.36, -0.04, accent);
  for (let i = 0; i < 3; i++) {
    b.box(0.62 - i * 0.09, 0.035, 0.05, 0, 0.33 - i * 0.02, -0.22 - i * 0.14, accent);
  }
  // Pale underbelly plates.
  b.sphere(0.30, 0, 0.13, -0.04, 0x8a7048, 1.15, 0.35, 1.3, 7);
  // Head with a horn, mandibles and antennae.
  b.sphere(0.17, 0, 0.22, 0.42, color, 1.05, 0.85, 0.95, 7);
  b.cone(0.06, 0.26, 0, 0.32, 0.46, accent, -0.9, 0, 0, 6);
  b.cone(0.055, 0.28, -0.11, 0.18, 0.60, accent, Math.PI / 2, 0, 0.34, 5);
  b.cone(0.055, 0.28, 0.11, 0.18, 0.60, accent, Math.PI / 2, 0, -0.34, 5);
  b.cone(0.03, 0.12, -0.15, 0.16, 0.68, 0xc8a860, Math.PI / 2, 0, 0.9, 4);
  b.cone(0.03, 0.12, 0.15, 0.16, 0.68, 0xc8a860, Math.PI / 2, 0, -0.9, 4);
  b.cone(0.016, 0.20, -0.09, 0.32, 0.52, 0x3a2c1c, -0.7, 0, 0.5, 4);
  b.cone(0.016, 0.20, 0.09, 0.32, 0.52, 0x3a2c1c, -0.7, 0, -0.5, 4);
  // Rear spiracles.
  b.sphere(0.05, -0.22, 0.20, -0.42, accent, 1, 1, 1, 5);
  b.sphere(0.05, 0.22, 0.20, -0.42, accent, 1, 1, 1, 5);
  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      l.cylinder(0.035, 0.028, 0.20, 0, -0.10, 0, accent, 0, 0, 0.42, 5);
      l.cylinder(0.026, 0.018, 0.20, 0.07, -0.27, 0, accent, 0, 0, -0.5, 5);
      l.cone(0.022, 0.07, 0.11, -0.38, 0.02, 0x2a1e12, Math.PI / 2, 0, 0, 4);
      return l.build();
    })(),
    eyes: eyePair(0.28, 0.52, 0.10, 0.045, 0xc4f04a, 0.2),
    limbOffset: new THREE.Vector3(0.28, 0.16, 0.10),
    flapping: false,
    height: 0.74,
  };
}

/* --------------------------------------------------------------- brutes -- */

function buildTroll(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const belly = 0x8fae6a;
  // Barrel chest, heavy gut, shoulders wider than the head is tall.
  b.sphere(0.38, 0, 0.72, -0.02, color, 1.2, 1.15, 0.95);
  b.sphere(0.32, 0, 0.50, 0.10, belly, 1.15, 0.95, 0.9, 7);
  b.sphere(0.24, -0.38, 0.94, -0.02, color, 1, 0.95, 1);
  b.sphere(0.24, 0.38, 0.94, -0.02, color, 1, 0.95, 1);
  b.sphere(0.14, -0.44, 1.06, -0.04, accent, 1, 0.7, 1, 6);
  b.sphere(0.14, 0.44, 1.06, -0.04, accent, 1, 0.7, 1, 6);
  // Small head sunk between the shoulders.
  b.sphere(0.20, 0, 1.02, 0.10, color, 1.05, 0.95, 1);
  b.box(0.30, 0.07, 0.14, 0, 1.09, 0.19, accent);
  b.sphere(0.11, 0, 0.94, 0.24, belly, 1.15, 0.8, 1, 6);
  tusks(b, 0.035, 0.15, 0.075, 0.90, 0.24, 0xe8e0c0);
  b.cone(0.05, 0.13, -0.19, 1.04, 0.02, accent, 0, 0, 1.2, 5);
  b.cone(0.05, 0.13, 0.19, 1.04, 0.02, accent, 0, 0, -1.2, 5);
  // Long apelike arms hanging past the knees, ending in fists.
  for (const s of [-1, 1]) {
    b.cylinder(0.115, 0.10, 0.40, s * 0.44, 0.76, 0.02, color, 0.12, 0, 0, 6);
    b.sphere(0.10, s * 0.46, 0.55, 0.04, color, 1, 1, 1, 6);
    b.cylinder(0.10, 0.095, 0.34, s * 0.47, 0.38, 0.06, color, 0.2, 0, 0, 6);
    b.sphere(0.135, s * 0.48, 0.20, 0.09, accent, 1.1, 0.95, 1.05, 7);
    b.cone(0.026, 0.09, s * 0.52, 0.14, 0.17, 0xd8d0b0, Math.PI / 2, 0, 0, 4);
  }
  // Hunched back, spine bumps, belt.
  b.sphere(0.22, 0, 0.96, -0.24, color, 1.3, 0.8, 0.9, 7);
  dorsalSpines(b, 4, -0.20, -0.06, 0.92, -0.10, 0.05, 0.12, accent);
  b.box(0.62, 0.09, 0.50, 0, 0.40, 0, 0x4a3520);
  b.box(0.16, 0.13, 0.06, 0, 0.40, 0.28, 0xb8a050);
  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      l.cylinder(0.135, 0.115, 0.26, 0, -0.13, 0, color, 0, 0, 0, 6);
      l.sphere(0.11, 0, -0.26, 0, color, 1, 1, 1, 6);
      l.cylinder(0.11, 0.10, 0.22, 0, -0.38, 0.01, color, 0, 0, 0, 6);
      l.sphere(0.12, 0, -0.50, 0.06, accent, 1.25, 0.7, 1.55, 6);
      for (let i = -1; i <= 1; i++) {
        l.cone(0.026, 0.08, i * 0.06, -0.51, 0.17, 0xd8d0b0, -Math.PI / 2, 0, 0, 4);
      }
      return l.build();
    })(),
    eyes: eyePair(1.05, 0.24, 0.075, 0.05, 0xffd24a, 0.7),
    limbOffset: new THREE.Vector3(0.19, 0.42, 0),
    flapping: false,
    height: 1.5,
  };
}

function buildDemonSpawn(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const scale = 0xd8935a;
  // Lean reptilian biped leaning forward, counterweighted by the tail.
  b.sphere(0.27, 0, 0.62, 0.02, color, 1.05, 1.2, 0.95);
  b.sphere(0.21, 0, 0.52, 0.16, scale, 1.0, 1.05, 0.7, 7);
  b.box(0.30, 0.20, 0.06, 0, 0.62, 0.20, scale);
  b.sphere(0.17, -0.25, 0.80, 0, color, 1, 0.9, 1, 7);
  b.sphere(0.17, 0.25, 0.80, 0, color, 1, 0.9, 1, 7);
  // Neck and a proper wedge-shaped head with a jaw.
  b.cylinder(0.11, 0.14, 0.18, 0, 0.90, 0.06, color, 0.35, 0, 0, 6);
  b.sphere(0.17, 0, 1.00, 0.10, color, 1, 0.95, 1.15);
  b.cone(0.13, 0.30, 0, 0.98, 0.30, color, Math.PI / 2, 0, 0, 6);
  b.box(0.16, 0.06, 0.24, 0, 0.90, 0.28, scale);
  b.sphere(0.035, -0.05, 1.00, 0.42, 0x2a1008, 1, 1, 1, 4);
  b.sphere(0.035, 0.05, 1.00, 0.42, 0x2a1008, 1, 1, 1, 4);
  for (let i = 0; i < 3; i++) {
    b.cone(0.022, 0.07, -0.07, 0.94, 0.26 + i * 0.07, 0xf0e8d0, Math.PI, 0, 0, 4);
    b.cone(0.022, 0.07, 0.07, 0.94, 0.26 + i * 0.07, 0xf0e8d0, Math.PI, 0, 0, 4);
  }
  horns(b, 0.055, 0.34, 0.13, 1.10, -0.02, accent, -0.75, 0.42);
  b.cone(0.03, 0.14, -0.16, 0.98, 0.06, accent, -0.4, 0, 0.9, 4);
  b.cone(0.03, 0.14, 0.16, 0.98, 0.06, accent, -0.4, 0, -0.9, 4);
  // Vestigial wings, back spines and a long whip tail.
  b.cone(0.07, 0.26, -0.24, 0.78, -0.14, accent, -1.1, 0, 0.8, 5);
  b.cone(0.07, 0.26, 0.24, 0.78, -0.14, accent, -1.1, 0, -0.8, 5);
  dorsalSpines(b, 5, -0.10, -0.09, 0.76, -0.045, 0.05, 0.15, accent);
  tail(b, 5, 0, 0.52, -0.30, 0.09, 0.15, 0.05, color, accent);
  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      l.sphere(0.11, 0, -0.06, 0, color, 1, 1.2, 1, 6);
      l.cylinder(0.075, 0.06, 0.22, 0, -0.24, -0.02, color, -0.2, 0, 0, 6);
      l.sphere(0.06, 0, -0.36, 0.02, color, 1, 1, 1, 5);
      l.cylinder(0.055, 0.05, 0.18, 0, -0.46, 0.04, color, 0.3, 0, 0, 6);
      l.sphere(0.065, 0, -0.56, 0.10, accent, 1.1, 0.6, 1.5, 6);
      for (let i = -1; i <= 1; i++) {
        l.cone(0.02, 0.08, i * 0.045, -0.57, 0.20, 0xf0e8d0, -Math.PI / 2, 0, 0, 4);
      }
      return l.build();
    })(),
    eyes: eyePair(1.03, 0.24, 0.075, 0.05, 0xff5c3a, 0.85),
    limbOffset: new THREE.Vector3(0.15, 0.44, 0),
    flapping: false,
    height: 1.35,
  };
}

function buildBileDemon(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const gut = 0xc4d468;      // pale, taut underbelly
  const wart = accent;       // darker growths, spines and brow
  const bone = 0xe8e0c0;

  // The body is a sagging stack, not a ball: three overlapping lobes at
  // different heights and offsets, widest low down, so it reads as weight.
  b.sphere(0.50, 0, 0.72, -0.04, color, 1.05, 0.86, 1.0);
  b.sphere(0.58, 0, 0.46, 0.02, color, 1.10, 0.80, 1.05);
  b.sphere(0.52, 0, 0.24, 0.06, color, 1.14, 0.62, 1.08);
  // Belly proper, hanging forward over the legs.
  b.sphere(0.44, 0, 0.34, 0.30, gut, 1.05, 0.92, 0.72);
  b.sphere(0.34, 0, 0.16, 0.34, gut, 1.0, 0.62, 0.62, 7);
  // Creases between the lobes — this is what makes it read as flesh.
  b.torus(0.50, 0.075, 0, 0.58, 0.02, wart, Math.PI / 2 - 0.18);
  b.torus(0.52, 0.070, 0, 0.34, 0.04, wart, Math.PI / 2 - 0.12);
  b.torus(0.42, 0.055, 0, 0.14, 0.06, wart, Math.PI / 2 - 0.08);

  // Boils, in clusters rather than evenly scattered.
  const boils: Array<[number, number, number, number]> = [
    [-0.42, 0.86, -0.16, 0.075], [-0.30, 0.94, -0.26, 0.055], [-0.46, 0.74, -0.28, 0.05],
    [0.40, 0.90, -0.20, 0.070], [0.50, 0.78, -0.10, 0.048],
    [0.14, 0.98, -0.34, 0.060], [-0.08, 1.00, -0.30, 0.042],
    [-0.54, 0.44, -0.18, 0.062], [0.56, 0.40, -0.22, 0.055],
    [0.24, 0.20, -0.44, 0.050],
  ];
  for (const [x, y, z, r] of boils) {
    b.sphere(r, x, y, z, wart, 1, 0.85, 1, 5);
    b.sphere(r * 0.45, x, y + r * 0.6, z, 0xd8e08a, 1, 1, 1, 4);
  }
  // Two rows of blunt spines down the back.
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    for (const sx of [-1, 1]) {
      b.cone(0.055 - t * 0.018, 0.20 - t * 0.06,
        sx * (0.16 + t * 0.05), 1.02 - t * 0.20, -0.30 - t * 0.10,
        wart, -0.5 - t * 0.3, 0, sx * -0.25, 5);
    }
  }

  // Head: wide, jowly, sunk into the shoulders, with a real mouth.
  b.sphere(0.26, 0, 1.10, 0.16, color, 1.15, 0.92, 1.0);
  b.sphere(0.19, -0.16, 1.00, 0.20, color, 1, 0.85, 1, 6);   // jowls
  b.sphere(0.19, 0.16, 1.00, 0.20, color, 1, 0.85, 1, 6);
  b.sphere(0.22, 0, 0.94, 0.24, gut, 1.2, 0.55, 0.9, 7);      // sagging chin
  b.box(0.40, 0.09, 0.16, 0, 1.20, 0.28, wart);               // heavy brow
  b.sphere(0.20, 0, 1.02, 0.34, 0x3a1a12, 1.15, 0.42, 0.6, 6); // open maw
  // Lower fangs and upper teeth around the mouth.
  for (let i = -2; i <= 2; i++) {
    b.cone(0.026, 0.09, i * 0.075, 0.98, 0.38, bone, Math.PI, 0, 0, 4);
    if (i !== 0) b.cone(0.022, 0.07, i * 0.06, 1.08, 0.38, bone, 0, 0, 0, 4);
  }
  // The big curving tusks, with a bound ring on each.
  b.cone(0.06, 0.34, -0.20, 1.02, 0.26, bone, -2.35, 0, 0.22, 6);
  b.cone(0.06, 0.34, 0.20, 1.02, 0.26, bone, -2.35, 0, -0.22, 6);
  b.torus(0.045, 0.014, -0.215, 1.14, 0.20, 0xb8903a, -0.9, 0, 0.2);
  b.torus(0.045, 0.014, 0.215, 1.14, 0.20, 0xb8903a, -0.9, 0, -0.2);
  b.cone(0.035, 0.12, -0.24, 1.22, 0.06, wart, -0.5, 0, 0.5, 4);
  b.cone(0.035, 0.12, 0.24, 1.22, 0.06, wart, -0.5, 0, -0.5, 4);

  // Shoulder spikes and short, thick arms with clawed hands.
  for (const s of [-1, 1]) {
    b.sphere(0.22, s * 0.50, 0.90, -0.02, color, 1, 0.9, 1, 7);
    b.cone(0.10, 0.34, s * 0.52, 1.02, -0.10, wart, -0.95, 0, s * -0.55, 5);
    b.cone(0.065, 0.22, s * 0.34, 1.06, -0.24, wart, -1.05, 0, s * -0.35, 5);
    b.cylinder(0.115, 0.10, 0.30, s * 0.60, 0.68, 0.08, color, 0.45, 0, s * 0.1, 6);
    b.sphere(0.095, s * 0.63, 0.52, 0.18, color, 1, 1, 1, 6);
    b.cylinder(0.10, 0.095, 0.22, s * 0.65, 0.40, 0.24, color, 0.7, 0, 0, 6);
    b.sphere(0.115, s * 0.66, 0.28, 0.34, gut, 1.05, 0.9, 1.1, 6);
    for (let i = -1; i <= 1; i++) {
      b.cone(0.026, 0.10, s * 0.66 + i * 0.06, 0.24, 0.44, bone, -Math.PI / 2, 0, 0, 4);
    }
  }
  // A strap over the gut, because something has to hold all that up.
  b.torus(0.50, 0.045, 0, 0.40, 0.02, 0x5a4028, Math.PI / 2 - 0.12);
  b.box(0.16, 0.14, 0.06, 0, 0.40, 0.44, 0xb8903a);
  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      l.cylinder(0.175, 0.155, 0.20, 0, -0.10, 0, color, 0, 0, 0, 6);
      l.torus(0.15, 0.04, 0, -0.19, 0, gut, Math.PI / 2);
      l.sphere(0.15, 0, -0.26, 0.03, gut, 1.15, 0.7, 1.35, 6);
      for (let i = -1; i <= 1; i++) {
        l.cone(0.032, 0.10, i * 0.075, -0.27, 0.20, bone, -Math.PI / 2, 0, 0, 4);
      }
      l.cone(0.028, 0.08, 0, -0.27, -0.14, bone, Math.PI / 2, 0, 0, 4);
      return l.build();
    })(),
    eyes: eyePair(1.14, 0.32, 0.10, 0.05, 0xa8ff70, 0.4),
    limbOffset: new THREE.Vector3(0.27, 0.28, 0),
    flapping: false,
    height: 1.6,
  };
}

/* ------------------------------------------------------- casters, wyrms -- */

function buildWarlock(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const trim = 0x2a2450;
  // Robe: a cone plus a flared hem, so it reads as cloth and not a traffic cone.
  b.cone(0.33, 0.84, 0, 0.42, 0, color, 0, 0, 0, 9);
  b.cone(0.40, 0.22, 0, 0.11, 0, trim, 0, 0, 0, 9);
  b.torus(0.36, 0.05, 0, 0.06, 0, trim);
  // Vertical fold lines down the robe.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    b.box(0.035, 0.62, 0.035, Math.cos(a) * 0.27, 0.40, Math.sin(a) * 0.27, trim);
  }
  // Shoulders, mantle and a deep hood with the face in shadow.
  b.sphere(0.26, 0, 0.84, 0, accent, 1.15, 0.42, 1.15, 8);
  b.torus(0.22, 0.045, 0, 0.90, 0, trim);
  b.sphere(0.175, 0, 0.94, 0.02, color, 1, 1.05, 1, 8);
  b.cone(0.21, 0.30, 0, 1.06, -0.04, accent, 0.18, 0, 0, 8);
  b.sphere(0.135, 0, 0.93, 0.10, 0x0e0a1a, 1, 1, 0.8, 6);
  b.cone(0.09, 0.22, 0, 0.86, 0.10, 0xd8d0e8, Math.PI, 0, 0, 6);
  // Sleeved arms with pale hands, one gripping the staff.
  for (const s of [-1, 1]) {
    b.cylinder(0.085, 0.10, 0.34, s * 0.24, 0.68, 0.04, color, 0.25, 0, s * -0.2, 6);
    b.sphere(0.075, s * 0.29, 0.50, 0.12, 0xd8c8b0, 1, 1, 1, 6);
  }
  // Staff: shaft, binding, and a crystal head.
  b.cylinder(0.028, 0.032, 1.20, 0.32, 0.60, 0.10, 0x4a3826, 0, 0, 0.05, 6);
  b.torus(0.045, 0.014, 0.32, 0.86, 0.10, 0xb89040);
  b.cone(0.085, 0.16, 0.32, 1.22, 0.10, accent, 0, 0, 0, 5);
  b.cone(0.085, 0.14, 0.32, 1.08, 0.10, accent, Math.PI, 0, 0, 5);
  // Belt, pouch and a chained book at the hip.
  b.torus(0.30, 0.035, 0, 0.52, 0, trim);
  b.box(0.12, 0.14, 0.08, -0.26, 0.46, 0.14, 0x6a4a2a);
  b.box(0.16, 0.20, 0.06, 0.26, 0.44, -0.10, 0x7a2a2a);
  b.box(0.14, 0.18, 0.02, 0.26, 0.44, -0.13, 0xd8c8a0);
  return {
    body: b.build(),
    // Only the hem moves; a robed caster shouldn't have visible legs.
    limb: new PartBuilder()
      .box(0.13, 0.09, 0.19, 0, -0.04, 0.03, trim)
      .box(0.09, 0.05, 0.06, 0, -0.07, 0.13, 0x2a1e14)
      .build(),
    eyes: eyePair(0.95, 0.20, 0.055, 0.042, 0xc07aff, 0.5),
    limbOffset: new THREE.Vector3(0.10, 0.07, 0),
    flapping: false,
    height: 1.35,
  };
}

function buildDragon(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const belly = 0xe8b070;
  // Deep chest, long body, haunches.
  b.sphere(0.38, 0, 0.66, -0.02, color, 1.0, 0.95, 1.4);
  b.sphere(0.30, 0, 0.50, 0.10, belly, 0.95, 0.75, 1.2, 7);
  b.sphere(0.28, -0.26, 0.56, -0.26, color, 1, 1, 1.1, 7);
  b.sphere(0.28, 0.26, 0.56, -0.26, color, 1, 1, 1.1, 7);
  // Neck in three tapering segments.
  for (let i = 0; i < 3; i++) {
    b.sphere(0.17 - i * 0.018, 0, 0.82 + i * 0.13, 0.24 + i * 0.13, color, 1, 1, 1.1, 7);
  }
  // Skull, snout, jaw, teeth, nostrils.
  b.sphere(0.19, 0, 1.16, 0.58, color, 1.05, 0.95, 1.15);
  b.cone(0.14, 0.36, 0, 1.12, 0.84, color, Math.PI / 2, 0, 0, 6);
  b.box(0.18, 0.07, 0.30, 0, 1.02, 0.76, belly);
  b.sphere(0.035, -0.055, 1.14, 1.00, 0x2a1008, 1, 1, 1, 4);
  b.sphere(0.035, 0.055, 1.14, 1.00, 0x2a1008, 1, 1, 1, 4);
  for (let i = 0; i < 4; i++) {
    const z = 0.70 + i * 0.08;
    b.cone(0.024, 0.08, -0.075, 1.05, z, 0xf0e8d0, Math.PI, 0, 0, 4);
    b.cone(0.024, 0.08, 0.075, 1.05, z, 0xf0e8d0, Math.PI, 0, 0, 4);
  }
  horns(b, 0.06, 0.40, 0.13, 1.28, 0.46, accent, -0.85, 0.35);
  b.cone(0.035, 0.16, -0.17, 1.14, 0.52, accent, -0.3, 0, 1.0, 4);
  b.cone(0.035, 0.16, 0.17, 1.14, 0.52, accent, -0.3, 0, -1.0, 4);
  b.cone(0.03, 0.14, 0, 1.05, 0.94, accent, -0.9, 0, 0, 4);
  // Dorsal ridge running from the neck out along the tail, then the tail.
  dorsalSpines(b, 7, 0.30, -0.16, 0.94, -0.045, 0.06, 0.20, accent);
  tail(b, 6, 0, 0.58, -0.44, 0.15, 0.20, 0.045, color, accent);
  b.cone(0.14, 0.30, 0, 0.32, -1.60, accent, -1.4, 0, 0, 5);
  return {
    body: b.build(),
    // A membraned wing: arm bones, three finger struts, panels between.
    limb: (() => {
      const l = new PartBuilder();
      l.cylinder(0.05, 0.04, 0.34, 0, 0.02, -0.16, color, Math.PI / 2, 0, 0, 6);
      l.sphere(0.055, 0, 0.03, -0.33, color, 1, 1, 1, 5);
      l.cylinder(0.035, 0.025, 0.44, 0, 0.06, -0.55, accent, Math.PI / 2 - 0.2, 0, 0, 6);
      l.box(0.02, 0.30, 0.56, 0, -0.10, -0.42, accent);
      l.box(0.018, 0.24, 0.44, 0, -0.16, -0.72, accent);
      l.box(0.34, 0.014, 0.50, 0.15, -0.10, -0.46, 0x8a2a1e);
      l.cone(0.02, 0.09, 0, 0.10, -0.80, 0xf0e8d0, -Math.PI / 2, 0, 0, 4);
      return l.build();
    })(),
    eyes: eyePair(1.20, 0.68, 0.085, 0.05, 0xffa030, 0.9),
    limbOffset: new THREE.Vector3(0.30, 0.86, -0.06),
    flapping: true,
    height: 1.6,
  };
}

/* ---------------------------------------------------------------- heroes -- */

function buildDwarf(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const mail = 0x8a8f9a;
  // Short and wide: the silhouette is a box with a beard.
  b.sphere(0.28, 0, 0.44, 0, accent, 1.25, 1.0, 0.95);
  b.sphere(0.24, 0, 0.38, 0.10, mail, 1.15, 0.8, 0.7, 7);
  b.sphere(0.16, -0.28, 0.58, 0, mail, 1, 0.85, 1, 6);
  b.sphere(0.16, 0.28, 0.58, 0, mail, 1, 0.85, 1, 6);
  // Head is mostly beard and helmet.
  b.sphere(0.175, 0, 0.72, 0.02, color, 1, 0.95, 1, 7);
  b.cone(0.20, 0.38, 0, 0.56, 0.12, 0xe8e0d0, Math.PI, 0, 0, 7);
  b.sphere(0.11, -0.13, 0.66, 0.10, 0xe8e0d0, 1, 1.2, 1, 6);
  b.sphere(0.11, 0.13, 0.66, 0.10, 0xe8e0d0, 1, 1.2, 1, 6);
  b.cone(0.10, 0.22, 0, 0.60, -0.14, 0xd8d0c0, -0.4, 0, 0, 6);
  b.sphere(0.19, 0, 0.82, 0, mail, 1, 0.62, 1, 8);
  b.box(0.05, 0.16, 0.05, 0, 0.76, 0.17, 0x6a7078);
  b.torus(0.185, 0.028, 0, 0.78, 0, 0xb89040);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.sphere(0.022, Math.cos(a) * 0.17, 0.86, Math.sin(a) * 0.17, 0xb89040, 1, 1, 1, 4);
  }
  // Arms and a pickaxe over the shoulder.
  for (const s of [-1, 1]) {
    b.cylinder(0.075, 0.065, 0.24, s * 0.31, 0.44, 0.03, accent, 0.2, 0, 0, 6);
    b.sphere(0.075, s * 0.33, 0.30, 0.10, color, 1, 1, 1, 6);
  }
  b.cylinder(0.03, 0.032, 0.66, 0.30, 0.52, 0.14, 0x5a4028, 0.35, 0, 0.18, 6);
  b.box(0.34, 0.07, 0.09, 0.36, 0.82, 0.24, mail, 0, 0.3, 0.2);
  b.cone(0.05, 0.16, 0.50, 0.84, 0.28, mail, Math.PI / 2, 0.3, 0, 5);
  b.box(0.44, 0.07, 0.30, 0, 0.34, 0, 0x5a4028);
  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      l.cylinder(0.085, 0.075, 0.18, 0, -0.09, 0, accent, 0, 0, 0, 6);
      l.cylinder(0.07, 0.065, 0.14, 0, -0.24, 0, mail, 0, 0, 0, 6);
      l.sphere(0.08, 0, -0.32, 0.05, 0x4a3520, 1.1, 0.7, 1.4, 6);
      return l.build();
    })(),
    eyes: eyePair(0.76, 0.16, 0.065, 0.035, 0x6ad0ff, 0.35),
    limbOffset: new THREE.Vector3(0.13, 0.22, 0),
    flapping: false,
    height: 1.05,
  };
}

function buildArcher(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const leather = 0x6a5236;
  b.sphere(0.23, 0, 0.64, 0, color, 0.95, 1.25, 0.8);
  b.box(0.34, 0.44, 0.20, 0, 0.62, 0.02, leather);
  b.sphere(0.14, -0.24, 0.86, 0, color, 1, 0.85, 1, 6);
  b.sphere(0.14, 0.24, 0.86, 0, color, 1, 0.85, 1, 6);
  // Hood and cloak.
  b.sphere(0.16, 0, 0.96, 0.02, accent, 1, 1, 1, 7);
  b.cone(0.20, 0.30, 0, 1.06, -0.04, color, 0.2, 0, 0, 7);
  b.sphere(0.12, 0, 0.95, 0.09, 0x120e08, 1, 1, 0.8, 6);
  b.cone(0.30, 0.62, 0, 0.62, -0.14, color, 0, 0, 0, 8);
  // Quiver of arrows across the back.
  b.cylinder(0.065, 0.075, 0.34, -0.20, 0.72, -0.18, leather, 0.35, 0, 0.3, 6);
  for (let i = 0; i < 3; i++) {
    b.cylinder(0.008, 0.008, 0.22, -0.20 + i * 0.03, 0.98, -0.20, 0x8a7048, 0.35, 0, 0.3, 4);
    b.cone(0.022, 0.06, -0.20 + i * 0.03, 1.06, -0.22, 0xd8d0c0, 0.35, 0, 0.3, 4);
  }
  // Bow: three angled staves plus a string, which reads as a curve.
  b.cylinder(0.018, 0.018, 0.34, 0.30, 0.86, 0.06, 0x7a5a2a, 0, 0, 0.30, 5);
  b.cylinder(0.020, 0.020, 0.30, 0.34, 0.62, 0.06, 0x7a5a2a, 0, 0, 0.02, 5);
  b.cylinder(0.018, 0.018, 0.34, 0.30, 0.38, 0.06, 0x7a5a2a, 0, 0, -0.30, 5);
  b.box(0.008, 0.86, 0.008, 0.22, 0.62, 0.06, 0xe0dcc8);
  b.sphere(0.07, 0.28, 0.60, 0.10, 0xd8c8a8, 1, 1, 1, 6);
  b.torus(0.24, 0.03, 0, 0.46, 0, 0x3a2a18);
  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      l.cylinder(0.06, 0.05, 0.24, 0, -0.12, 0, leather, 0, 0, 0, 6);
      l.cylinder(0.05, 0.045, 0.20, 0, -0.34, 0.01, color, 0, 0, 0, 6);
      l.sphere(0.06, 0, -0.46, 0.05, 0x3a2a18, 1.1, 0.7, 1.4, 6);
      return l.build();
    })(),
    eyes: eyePair(0.96, 0.14, 0.055, 0.035, 0x4ac8d8, 0.45),
    limbOffset: new THREE.Vector3(0.11, 0.36, 0),
    flapping: false,
    height: 1.35,
  };
}

function buildKnight(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const steel = 0xd0d6e0;
  const dark = 0x5a6070;
  // Plate cuirass with a raised centre ridge.
  b.sphere(0.29, 0, 0.68, 0, color, 1.1, 1.25, 0.85);
  b.box(0.10, 0.46, 0.10, 0, 0.68, 0.16, steel);
  b.torus(0.26, 0.045, 0, 0.48, 0, dark);
  b.sphere(0.22, -0.32, 0.94, 0, steel, 1, 0.85, 1.05, 7);
  b.sphere(0.22, 0.32, 0.94, 0, steel, 1, 0.85, 1.05, 7);
  b.cone(0.10, 0.16, -0.38, 1.04, 0, accent, -0.3, 0, 0.5, 5);
  b.cone(0.10, 0.16, 0.38, 1.04, 0, accent, -0.3, 0, -0.5, 5);
  // Great helm with a visor slit and a crest.
  b.cylinder(0.175, 0.185, 0.28, 0, 1.08, 0.02, steel, 0, 0, 0, 8);
  b.sphere(0.175, 0, 1.22, 0.02, steel, 1, 0.65, 1, 8);
  b.box(0.26, 0.045, 0.05, 0, 1.10, 0.17, 0x0a0a10);
  for (let i = 0; i < 4; i++) {
    b.box(0.03, 0.03, 0.04, -0.06 + i * 0.04, 1.00, 0.18, 0x0a0a10);
  }
  b.box(0.05, 0.20, 0.30, 0, 1.34, -0.02, accent);
  b.cone(0.06, 0.20, 0, 1.46, -0.02, accent, 0, 0, 0, 5);
  // Arms.
  for (const s of [-1, 1]) {
    b.cylinder(0.085, 0.075, 0.26, s * 0.36, 0.76, 0.02, steel, 0.15, 0, 0, 6);
    b.sphere(0.08, s * 0.38, 0.60, 0.06, dark, 1, 1, 1, 6);
    b.cylinder(0.075, 0.07, 0.22, s * 0.40, 0.46, 0.06, steel, 0.2, 0, 0, 6);
  }
  // Sword: grip, crossguard, blade, pommel.
  b.cylinder(0.026, 0.026, 0.16, 0.44, 0.34, 0.10, 0x3a2a18, 0, 0, -0.22, 5);
  b.sphere(0.035, 0.46, 0.25, 0.10, 0xb89040, 1, 1, 1, 5);
  b.box(0.20, 0.045, 0.05, 0.42, 0.44, 0.10, 0xb89040, 0, 0, -0.22);
  b.box(0.075, 0.76, 0.022, 0.50, 0.82, 0.10, steel, 0, 0, -0.22);
  b.cone(0.04, 0.12, 0.59, 1.22, 0.10, steel, 0, 0, -0.22, 4);
  // Kite shield.
  b.box(0.36, 0.46, 0.05, -0.44, 0.72, 0.10, accent, 0, 0.28, 0);
  b.cone(0.18, 0.22, -0.44, 0.44, 0.10, accent, Math.PI, 0.28, 0, 6);
  b.sphere(0.07, -0.46, 0.74, 0.14, steel, 1, 1, 0.6, 6);
  b.box(0.36, 0.05, 0.055, -0.44, 0.92, 0.10, steel, 0, 0.28, 0);
  // Tassets.
  b.box(0.34, 0.16, 0.24, 0, 0.42, 0, dark);
  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      l.cylinder(0.095, 0.08, 0.22, 0, -0.11, 0, steel, 0, 0, 0, 6);
      l.sphere(0.075, 0, -0.24, 0, dark, 1, 1, 1, 5);
      l.cylinder(0.075, 0.07, 0.20, 0, -0.36, 0.01, steel, 0, 0, 0, 6);
      l.sphere(0.085, 0, -0.48, 0.06, dark, 1.1, 0.7, 1.5, 6);
      return l.build();
    })(),
    eyes: eyePair(1.10, 0.16, 0.05, 0.028, 0x9ad8ff, 0.75),
    limbOffset: new THREE.Vector3(0.15, 0.38, 0),
    flapping: false,
    height: 1.65,
  };
}

/* ------------------------------------------------------------- registry -- */

const BUILDERS: Record<CreatureType, (color: number, accent: number) => CreatureModel> = {
  [CreatureType.Imp]: buildImp,
  [CreatureType.Fly]: buildFly,
  [CreatureType.Beetle]: buildBeetle,
  [CreatureType.Troll]: buildTroll,
  [CreatureType.DemonSpawn]: buildDemonSpawn,
  [CreatureType.Warlock]: buildWarlock,
  [CreatureType.BileDemon]: buildBileDemon,
  [CreatureType.Dragon]: buildDragon,
  [CreatureType.Dwarf]: buildDwarf,
  [CreatureType.Archer]: buildArcher,
  [CreatureType.Knight]: buildKnight,
};

const cache = new Map<CreatureType, CreatureModel>();

export function getCreatureModel(type: CreatureType, color: number, accent: number): CreatureModel {
  let model = cache.get(type);
  if (!model) {
    model = BUILDERS[type](color, accent);
    cache.set(type, model);
  }
  return model;
}

/** How many limbs a species renders (legs in pairs, wings in pairs). */
export function limbCountFor(type: CreatureType): number {
  return type === CreatureType.Beetle ? 6 : 2;
}
