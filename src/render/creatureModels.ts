import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CreatureType } from '../core/creatures';

/**
 * Creature models, built from primitives at load time.
 *
 * Each type produces three merged geometries — body, a limb that gets mirrored,
 * and a pair of eyes — so a whole species renders in three instanced draw calls
 * no matter how many of them are running about.
 *
 * ## Drawn for manga, and drawn for this camera
 *
 * Two things decide every proportion here.
 *
 * The first is the style: Japanese comic art, which is not realism with thicker
 * lines. It is a specific set of choices — a head far larger than anatomy allows,
 * hands and feet larger still, limbs that taper hard from a thick root to a thin
 * joint, hair and cloth in a few big swept clumps rather than many small ones,
 * and silhouettes built from *contrasting* shapes so two characters are told
 * apart at thumbnail size. Detail is spent on the parts that carry expression and
 * withheld from the parts that do not; an evenly-detailed model reads as a
 * technical drawing, which is the opposite of the target.
 *
 * The second is where the camera is. It looks down from a fixed tilt, so what
 * fills the screen is the *top* of a creature: the crown of the head, the
 * shoulders, and the outline its feet stand inside. A beautifully built face is
 * three pixels of chin from up there. So every species gets its manga read from
 * above — a big head disc, a distinctive crown (horns, hood, plume, shell, mane),
 * and a lighter cap of colour on the surfaces that face the sky, which is the
 * flat highlight zone a cel-shaded drawing would paint there.
 *
 * ## Why the detail is affordable
 *
 * Geometry is uploaded once per species and then instanced, so an extra part
 * costs vertex transform and never a draw call — twenty creatures cost what one
 * does. What is *not* free is segment count on a small part, which is why the
 * resolution floor scales with the part's radius (see `segsFor`): a claw the size
 * of a grain of rice gets eight sides, a skull gets twenty, and the saving on the
 * many small parts pays for the extra shapes.
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
 * How round a primitive of a given radius needs to be.
 *
 * A flat floor for every shape was the wrong tool twice over. At four to nine
 * segments — where this roster started — a sphere is a faceted lump and a horn is
 * a wedge, which is exactly the "too edgy" complaint. But raising *everything* to
 * sixteen spent the entire budget on parts too small to see it: a 2 cm claw and a
 * 30 cm skull were tessellated identically, and the claw is a dozen pixels.
 *
 * So the floor scales with the part. Big curved surfaces, where a facet spans
 * many pixels, get up to twenty sides; the small trim that makes up most of the
 * part count gets eight, which at its size is already smooth. Cheaper overall
 * than the flat floor was, and it buys the extra shapes below.
 */
function segsFor(r: number, requested: number, cap = 20): number {
  const floor = Math.round(8 + Math.min(1, Math.abs(r) * 3.2) * (cap - 8));
  return Math.max(floor, requested);
}

/**
 * Mix a colour toward white or black, for baked highlight and shadow zones.
 *
 * Cel shading paints an object as flat areas of light and dark rather than a
 * gradient, and the material can only decide that from the light direction. It
 * cannot know that the top of a head should be the light zone and the underside
 * of a jaw the dark one — but the *model* knows, so those zones are baked into
 * the vertex colours as separate parts. This is what keeps a creature legible
 * from directly above, where the real lighting flattens out.
 *
 * A mix rather than a multiply, which is the whole point. Multiplying by 1.3 is
 * fine on a dark green troll and catastrophic on pale steel: the knight's helm
 * highlight came out at pure white, taking the visor, the crest and the top of
 * the head with it into one flat blob. Mixing toward white cannot overshoot — a
 * light colour simply moves less — so the same number is safe on every base.
 *
 * `warm` pushes the result toward firelight, which is where every light in this
 * dungeon comes from; it scales with the mix so a subtle tint stays subtle.
 */
function tint(hex: number, amount: number, warm = 0): number {
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  const t = Math.max(-1, Math.min(1, amount));
  const toward = t > 0 ? 255 : 0;
  const mix = (channel: number, push: number): number =>
    clamp(channel + (toward - channel) * Math.abs(t) + push * Math.abs(t) * 60);
  return (mix((hex >> 16) & 255, warm) << 16)
    | (mix((hex >> 8) & 255, warm * 0.3) << 8)
    | mix(hex & 255, warm * -0.25);
}

/**
 * Accumulates coloured primitives, then merges them into one geometry.
 *
 * Exported because room furniture is built exactly the same way — chunky shapes,
 * flat vertex colours, merged into a single instanced draw.
 */
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
    const rings = segsFor(r * Math.max(sx, sy, sz), seg);
    const g = new THREE.SphereGeometry(r, rings, Math.max(6, Math.round(rings * 0.62)));
    g.scale(sx, sy, sz);
    g.translate(x, y, z);
    this.push(g, color);
    return this;
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, color: number,
    rx = 0, ry = 0, rz = 0): this {
    // Segmented rather than a bare cube. With smooth vertex normals across the
    // merged mesh this rounds the arrises very slightly, which is the difference
    // between a shape and a brick.
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
    const g = new THREE.ConeGeometry(r, h, segsFor(r, seg, 16));
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    this.push(g, color);
    return this;
  }

  cylinder(rt: number, rb: number, h: number, x: number, y: number, z: number, color: number,
    rx = 0, ry = 0, rz = 0, seg = 7): this {
    const g = new THREE.CylinderGeometry(rt, rb, h, segsFor(Math.max(rt, rb), seg));
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    this.push(g, color);
    return this;
  }

  /**
   * A rounded limb segment: the shape almost every part of a body actually is.
   *
   * Arms and legs were built from cylinders with a sphere stuck on the end, which
   * leaves a hard rim where the two meet — a bright ring of facets right where a
   * drawing would put a smooth taper. A capsule is one surface, so a limb reads as
   * a limb and the ink pass finds its silhouette instead of its seams.
   */
  capsule(r: number, len: number, x: number, y: number, z: number, color: number,
    rx = 0, ry = 0, rz = 0, seg = 7): this {
    const radial = segsFor(r, seg);
    const g = new THREE.CapsuleGeometry(r, len, Math.max(4, Math.round(radial * 0.4)), radial);
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    this.push(g, color);
    return this;
  }

  torus(radius: number, tube: number, x: number, y: number, z: number, color: number,
    rx = -Math.PI / 2, ry = 0, rz = 0, arc = Math.PI * 2): this {
    const g = new THREE.TorusGeometry(radius, tube, segsFor(tube, 8, 12),
      segsFor(radius, 20, 30), arc);
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
 * Eyes are where a stylised creature's personality lives, so they are built large
 * and built properly: a big coloured iris, a hard black pupil, an offset white
 * catchlight, and a lower lid to sit the eye in a face rather than on it. The
 * catchlight does most of the work — it is the difference between an eye and a
 * marble — and the lid is what stops a big eye reading as a bulge.
 *
 * Deliberately oversized against the skull, well past anatomical, which is
 * exactly the convention being borrowed. The pair is also slightly asymmetric,
 * because two identical eyes read as a machine.
 */
function eyePair(
  y: number, z: number, spread: number, r: number,
  iris = 0xffb020, angry = 0.0,
): THREE.BufferGeometry {
  const b = new PartBuilder();
  // Comic proportions: a good deal bigger than the anatomy would suggest.
  const R = r * 2.3;

  for (const side of [-1, 1]) {
    // One eye a fraction larger and higher — asymmetry is personality.
    const wobble = side < 0 ? 1.06 : 0.95;
    const e = R * wobble;
    const ex = side * spread * 1.08;
    const ey = y + (side < 0 ? e * 0.05 : -e * 0.04);

    // Sclera, flattened back into the head so it sits in a socket.
    b.sphere(e, ex, ey, z, 0xf4f0e6, 1, 1, 0.62, 9);
    // Iris, then a hard pupil in front of it.
    b.sphere(e * 0.64, ex, ey, z + e * 0.5, iris, 1, 1, 0.5, 8);
    b.sphere(e * 0.34, ex, ey, z + e * 0.72, 0x140c08, 1, 1, 0.5, 7);
    // The catchlight: high and off to one side, and the same side on both eyes so
    // they agree about where the light is.
    b.sphere(e * 0.21, ex - e * 0.3, ey + e * 0.34, z + e * 0.78, 0xffffff, 1, 1, 0.5, 6);
    // A second, tiny one low and opposite. Two catchlights is the trick that
    // makes an eye look wet.
    b.sphere(e * 0.09, ex + e * 0.34, ey - e * 0.38, z + e * 0.74, 0xffffff, 1, 1, 0.5, 5);

    // Lower lid, following the curve of the eye.
    b.sphere(e * 0.98, ex, ey - e * 0.82, z + e * 0.16, 0x1a1008, 1, 0.34, 0.7, 7);

    // A heavy brow ridge sloping inward. This is the whole expression: level brows
    // read as blank, angled ones read as furious.
    if (angry > 0) {
      b.sphere(e * 0.8, ex, ey + e * 1.06, z + e * 0.3, 0x1a1008,
        1.05, 0.3, 0.5, 7);
      b.box(e * 1.45, e * 0.34, e * 0.42,
        ex, ey + e * 1.12, z + e * 0.22, 0x1a1008, 0, 0, side * angry);
    }
  }
  return b.build();
}

/* -------------------------------------------------------- detail helpers -- */

/*
 * The shared vocabulary. Each of these is a shape a comic artist would draw in
 * one gesture, and the point of having them is consistency: every mane in the
 * roster is built by the same rule, so eleven species look like eleven drawings
 * by one hand rather than eleven separate attempts.
 */

/**
 * A clump of swept spikes — hair, fur, a mane, a crest, a plume.
 *
 * The manga signature, and the thing the old models had none of. Hair is not
 * drawn as strands but as a few big wedges of unequal length, fanned around an
 * axis and all sweeping the same way; the unequal lengths are what stop it
 * reading as a hedgehog. Each clump gets a sphere at its root so it grows out of
 * the head instead of being stuck to it.
 */
function tuft(
  b: PartBuilder, count: number, x: number, y: number, z: number,
  r: number, len: number, pitch: number, fan: number,
  color: number, tip = color,
): void {
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    // Deterministic irregularity: alternate long and short, and lean the outer
    // clumps further over than the middle ones.
    const long = 1 + (i % 2 === 0 ? 0.26 : -0.18) + Math.sin(i * 2.4) * 0.1;
    const yaw = (t - 0.5) * fan;
    const lean = pitch + Math.abs(t - 0.5) * 0.5;
    const cr = r * (1 - Math.abs(t - 0.5) * 0.35);
    const cl = len * long;
    // Root ball, then the wedge itself, angled out and back.
    b.sphere(cr * 1.05, x + Math.sin(yaw) * r * 0.6, y, z + Math.cos(yaw) * r * 0.2,
      color, 1, 1, 1, 6);
    b.cone(cr, cl,
      x + Math.sin(yaw) * (r * 0.6 + cl * 0.28 * Math.sin(yaw)),
      y + Math.cos(lean) * cl * 0.42,
      z + Math.cos(yaw) * r * 0.2 - Math.sin(lean) * cl * 0.42,
      i % 2 === 0 ? color : tip, lean, yaw, 0, 6);
  }
}

/**
 * A flat highlight cap, for the surface that faces the camera.
 *
 * The single most useful part in this file for the view the game is actually
 * played from. A lighter, slightly flattened dome laid over the crown of a head
 * or the top of a shell gives the top-down silhouette an internal edge and a
 * light zone, so a creature reads as a lit form rather than as a flat blob of
 * species colour.
 */
function crown(
  b: PartBuilder, r: number, x: number, y: number, z: number,
  color: number, sx = 1, sz = 1,
): void {
  b.sphere(r, x, y, z, tint(color, 0.20, 1), sx, 0.42, sz, 9);
}

/** A swept pair of horns, mirrored about x. */
function horns(
  b: PartBuilder, r: number, h: number, x: number, y: number, z: number,
  color: number, tilt: number, sweep: number,
): void {
  for (const s of [-1, 1]) {
    // Root, taper, tip: a horn that narrows in two stages curves to the eye even
    // though every piece of it is straight.
    b.sphere(r * 1.15, s * x, y, z, tint(color, -0.16), 1, 1, 1, 7);
    b.cone(r, h * 0.62, s * x, y + h * 0.26, z, color, tilt, 0, s * -sweep, 7);
    b.cone(r * 0.6, h * 0.55,
      s * (x + Math.sin(sweep) * h * 0.5), y + h * 0.62, z - Math.sin(tilt) * h * 0.5,
      tint(color, 0.14), tilt * 1.5, 0, s * -sweep * 1.7, 6);
  }
}

/** A row of shrinking dorsal spines running back along -z. */
function dorsalSpines(
  b: PartBuilder, count: number, z0: number, dz: number,
  y: number, dy: number, r: number, h: number, color: number,
): void {
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count - 1);
    // A blade rather than a spike: flattened across, which is what makes a ridge
    // read as a fin from the side and as a line from above.
    b.sphere(r * (1 - t * 0.5), 0, y + dy * i + h * (1 - t * 0.5) * 0.4, z0 + dz * i,
      color, 0.5, (h / r) * (1 - t * 0.5) * 0.9, 1.5, 7);
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
      1, 0.92, 1.25, 7);
    // A pale scute along the underside, so the tail has a top and a bottom.
    if (i % 2 === 0) {
      b.sphere(r * (1 - t * 0.62) * 0.7, x, y - drop * i - r * 0.5, z - step * i,
        tint(color, 0.16), 0.9, 0.4, 1.1, 6);
    }
  }
  b.cone(r * 0.62, r * 2.6, x, y - drop * segments, z - step * segments,
    tipColor, -1.25, 0, 0, 7);
}

/** Two upward tusks. */
function tusks(
  b: PartBuilder, r: number, h: number, x: number, y: number, z: number, color: number,
): void {
  for (const s of [-1, 1]) {
    b.cone(r, h, s * x, y, z, color, -2.5, 0, s * 0.18, 7);
    b.sphere(r * 0.9, s * x, y - h * 0.3, z, tint(color, -0.12), 1, 1, 1, 6);
  }
}

/** A curved claw: two cones, the second kicked over. */
function claw(
  b: PartBuilder, r: number, h: number, x: number, y: number, z: number,
  color: number, pitch: number, side = 1,
): void {
  b.cone(r, h * 0.6, x, y, z, color, pitch, 0, 0, 6);
  b.cone(r * 0.55, h * 0.55,
    x + side * h * 0.06, y - Math.cos(pitch) * h * 0.2, z + Math.sin(pitch) * h * 0.3,
    tint(color, 0.11), pitch * 1.35, 0, side * 0.3, 6);
}

/**
 * A hand: a wide palm, individual fingers, and a thumb.
 *
 * Hands are drawn oversized in this style — often as large as the head — because
 * they are how a character gestures, and a gesture at this camera distance is
 * carried entirely by silhouette. Four separate digits cost almost nothing at
 * `segsFor`'s small-part resolution and read from much further away than a mitten.
 */
function hand(
  b: PartBuilder, r: number, x: number, y: number, z: number,
  skin: number, nail: number, digits = 3,
): void {
  b.sphere(r, x, y, z, skin, 1.2, 0.78, 1.15, 8);
  // Knuckle line, a shade darker, across the front of the palm.
  b.sphere(r * 0.5, x, y + r * 0.2, z + r * 0.75, tint(skin, -0.14), 2.1, 0.6, 0.5, 7);
  for (let i = 0; i < digits; i++) {
    const t = digits === 1 ? 0 : i / (digits - 1) - 0.5;
    const fx = x + t * r * 1.5;
    // Two joints per finger, thinning toward the tip.
    b.capsule(r * 0.29, r * 0.5, fx, y, z + r * 1.15, skin, Math.PI / 2, 0, 0, 6);
    b.capsule(r * 0.24, r * 0.4, fx, y - r * 0.05, z + r * 1.75, skin, Math.PI / 2 + 0.2, 0, 0, 6);
    b.cone(r * 0.24, r * 0.7, fx, y - r * 0.18, z + r * 2.15, nail, -Math.PI / 2 + 0.3, 0, 0, 6);
  }
  // Thumb, out to the side and swung forward.
  b.capsule(r * 0.3, r * 0.55, x + r * 0.9, y - r * 0.1, z + r * 0.4, skin, 0.7, 0, -0.9, 6);
  b.cone(r * 0.24, r * 0.6, x + r * 1.3, y - r * 0.25, z + r * 0.9, nail, -1.1, 0, -1.0, 6);
}

/**
 * A tapered arm or leg, root to joint to tip.
 *
 * Two capsules and a ball, with the upper one much thicker than the lower. That
 * taper is the whole difference between a drawn limb and a length of pipe, and it
 * is the rule the old cylinders broke: they were nearly the same width top and
 * bottom, so a shoulder and a wrist looked alike.
 */
function taperedLimb(
  b: PartBuilder, rTop: number, rMid: number, upper: number, lower: number,
  color: number, joint = tint(color, -0.12), lean = 0.0,
): number {
  b.sphere(rTop * 1.1, 0, 0, 0, color, 1, 1, 1, 8);
  b.capsule(rTop, upper, 0, -upper * 0.5 - rTop * 0.4, 0, color, lean, 0, 0, 8);
  const kneeY = -(upper + rTop * 0.8);
  b.sphere(rMid * 1.15, 0, kneeY, Math.sin(lean) * upper * 0.5, joint, 1, 1, 1, 8);
  b.capsule(rMid, lower, 0, kneeY - lower * 0.5 - rMid * 0.4,
    Math.sin(lean) * upper * 0.5 + lower * 0.1, color, -lean * 0.6, 0, 0, 8);
  return kneeY - lower - rMid * 0.8;
}

/* --------------------------------------------------------------- worker -- */

/**
 * The imp: the dungeon's put-upon workforce.
 *
 * Two and a half heads tall, which is the proportion a comic uses for a mascot
 * rather than a monster. Everything is pushed to the extreme of the style: the
 * skull is a third of the whole silhouette, the hands are the size of the skull,
 * the legs are stumps, and the ears are as long as the head is wide. A
 * realistically proportioned imp is a small demon, and a small demon is not
 * funny — the exaggeration *is* the characterisation.
 *
 * The face is built to be read at a glance from above and behind: a wide
 * underbite full of crooked teeth, a heavy scowling brow, one snaggle tooth
 * bigger than the other, and a scruff of hair between the horns so the crown of
 * the head is not a bald dome.
 */
function buildImp(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  // Skin runs bright at the thin parts — ears, fingers — where light would get
  // through. There is no subsurface term in this material, so it is baked in.
  const thin = tint(color, 0.20, 1);
  const belly = tint(color, 0.13, 1);
  const dark = tint(color, -0.26);
  const bone = 0xf4ecd6;

  // Torso: small, round and hunched, because the head is the star.
  b.sphere(0.26, 0, 0.32, -0.02, color, 1.14, 0.94, 1.0);
  b.sphere(0.20, 0, 0.26, 0.13, belly, 1.04, 0.86, 0.72, 8);
  // Deltoids — this is a creature that swings a pick all day.
  for (const s of [-1, 1]) {
    b.sphere(0.135, s * 0.235, 0.43, 0, color, 1, 0.95, 1, 8);
    b.sphere(0.075, s * 0.245, 0.50, -0.01, tint(color, 0.14, 1), 1.1, 0.6, 1.1, 7);
  }

  // The head: enormous, and slightly wider than it is tall.
  b.sphere(0.325, 0, 0.76, 0.02, color, 1.1, 1.0, 0.98, 12);
  crown(b, 0.30, 0, 0.94, -0.02, color, 1.05, 1.0);
  // Cheeks, a blunt snout, and a nose with real nostrils.
  b.sphere(0.135, -0.20, 0.70, 0.16, belly, 1, 0.9, 0.8, 8);
  b.sphere(0.135, 0.20, 0.70, 0.16, belly, 1, 0.9, 0.8, 8);
  b.sphere(0.155, 0, 0.685, 0.22, belly, 1.2, 0.82, 1.0, 9);
  b.sphere(0.085, 0, 0.655, 0.30, thin, 1.3, 0.8, 1, 8);
  b.sphere(0.026, -0.045, 0.645, 0.335, 0x4a1a10, 1, 1, 1, 6);
  b.sphere(0.026, 0.045, 0.645, 0.335, 0x4a1a10, 1, 1, 1, 6);

  // The grin: a wide lower jaw shoved forward, with too many teeth in it.
  b.sphere(0.155, 0, 0.585, 0.22, belly, 1.35, 0.62, 0.95, 9);
  b.sphere(0.12, 0, 0.615, 0.27, 0x3a1210, 1.4, 0.4, 0.5, 8);
  for (let i = 0; i < 6; i++) {
    const t = (i / 5 - 0.5) * 0.21;
    // Alternating sizes and a slight lean: crooked teeth, not a comb.
    const s = i % 2 === 0 ? 1 : 0.72;
    b.cone(0.021 * s, 0.08 * s, t, 0.628, 0.255, bone, 0, 0, (i - 2.5) * 0.06, 6);
  }
  // Two lower tusks, one distinctly longer. Symmetry is what makes a stylised
  // face look like a prop.
  b.cone(0.034, 0.15, -0.09, 0.635, 0.245, bone, -0.28, 0, 0.12, 7);
  b.cone(0.027, 0.10, 0.09, 0.625, 0.245, bone, -0.25, 0, -0.1, 7);

  // Ears: as long as the head is wide, swept back, and translucent at the tips.
  for (const s of [-1, 1]) {
    b.sphere(0.075, s * 0.27, 0.82, -0.02, color, 1, 1.1, 0.8, 7);
    b.cone(0.115, 0.44, s * 0.32, 0.88, -0.07, color, -0.35, 0, s * -1.05, 8);
    b.cone(0.062, 0.32, s * 0.31, 0.87, -0.03, thin, -0.35, 0, s * -1.05, 7);
  }

  // A scruff of hair between the horn nubs, then the horns and a spade tail.
  tuft(b, 5, 0, 0.99, -0.06, 0.05, 0.15, -0.7, 2.2, dark, tint(dark, 0.22));
  horns(b, 0.036, 0.13, 0.115, 0.96, 0.04, accent, -0.4, 0.34);
  dorsalSpines(b, 3, -0.12, -0.08, 0.44, -0.03, 0.03, 0.08, accent);
  tail(b, 3, 0, 0.26, -0.24, 0.058, 0.11, 0.03, color, accent);

  // Loincloth, a working belt, and a pouch that swings.
  b.sphere(0.17, 0, 0.14, 0, 0x5a3a26, 1.05, 0.95, 0.9, 8);
  b.torus(0.175, 0.028, 0, 0.225, 0, 0x3d2820);
  b.sphere(0.055, 0.135, 0.19, 0.10, 0x6b4a30, 1, 1.1, 0.8, 7);
  b.box(0.05, 0.035, 0.02, 0, 0.225, 0.175, 0xb8903a);

  // Arms hanging forward, ending in hands the size of the skull.
  //
  // On the body rather than as the swinging limb, because the limb slot has to be
  // the legs: it is what the walk cycle drives, and legs that never move on a
  // creature that spends the whole game bustling across the dungeon is the one
  // animation error you would actually notice.
  for (const s of [-1, 1]) {
    b.capsule(0.052, 0.12, s * 0.255, 0.34, 0.03, color, 0.35, 0, s * 0.1, 8);
    b.sphere(0.046, s * 0.27, 0.235, 0.09, color, 1, 1, 1, 7);
    b.capsule(0.042, 0.09, s * 0.275, 0.17, 0.135, color, 0.75, 0, 0, 8);
    hand(b, 0.072, s * 0.285, 0.105, 0.19, thin, bone, 3);
  }

  // A pickaxe across the back. An imp is never not working, and the tool is most
  // of what says so from behind, which is where you usually see one.
  b.capsule(0.024, 0.60, -0.02, 0.42, -0.19, 0x7a5432, 0.42, 0.5, 0.2, 7);
  b.sphere(0.05, -0.14, 0.70, -0.30, 0x8d949f, 1, 1, 3.4, 8);
  b.cone(0.048, 0.17, -0.14, 0.70, -0.47, 0xacb4c1, Math.PI / 2, 0.5, 0, 8);
  b.cone(0.048, 0.17, -0.14, 0.70, -0.13, 0xacb4c1, -Math.PI / 2, 0.5, 0, 8);

  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      // Stumpy leg, oversized foot. Length is set by where the hip is: a limb
      // longer than its own attachment height stands *through* the floor.
      l.sphere(0.058, 0, 0, 0, color, 1, 1, 1, 8);
      l.capsule(0.05, 0.05, 0, -0.06, 0, color, 0, 0, 0, 8);
      l.sphere(0.062, 0, -0.145, 0.035, thin, 1.3, 0.6, 1.7, 9);
      for (let i = -1; i <= 1; i++) {
        l.cone(0.014, 0.05, i * 0.036, -0.152, 0.13, bone, -Math.PI / 2, 0, 0, 6);
      }
      return l.build();
    })(),
    // Huge and yellow, with a hard scowl. An imp is the comic relief and its face
    // has to carry that from across the room.
    eyes: eyePair(0.775, 0.235, 0.125, 0.064, 0xffc21e, 0.6),
    limbOffset: new THREE.Vector3(0.115, 0.19, 0),
    flapping: false,
    height: 1.15,
  };
}

/* -------------------------------------------------------------- insects -- */

/**
 * The fly: all eyes and fuzz.
 *
 * The manga read on an insect is to take the one feature a person finds uncanny
 * and make it the whole face. So the compound eyes are enormous and glassy, and
 * everything behind them is soft — a fur ruff at the collar and a banded abdomen —
 * so the silhouette is a bright head and a fuzzy comma.
 */
function buildFly(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const fuzz = 0xd8e0b0;
  const chitin = tint(accent, -0.20);

  // Segmented abdomen tapering back, banded like a real dipteran.
  b.sphere(0.18, 0, 0.32, -0.06, color, 1.15, 1, 1.2, 10);
  b.torus(0.17, 0.035, 0, 0.32, -0.14, chitin, Math.PI / 2);
  b.sphere(0.15, 0, 0.31, -0.26, accent, 1.1, 1, 1.1, 9);
  b.torus(0.14, 0.03, 0, 0.31, -0.33, chitin, Math.PI / 2);
  b.sphere(0.115, 0, 0.30, -0.41, color, 1, 1, 1, 8);
  b.cone(0.075, 0.17, 0, 0.30, -0.56, chitin, -Math.PI / 2, 0, 0, 8);
  crown(b, 0.16, 0, 0.42, -0.14, color, 1.1, 2.2);

  // Thorax under a collar of fur. Two rings of tufts, because one reads as a
  // washer and two reads as bristle.
  b.sphere(0.145, 0, 0.33, 0.13, accent, 1.1, 1.05, 1, 9);
  b.torus(0.135, 0.04, 0, 0.34, 0.09, fuzz, Math.PI / 2);
  tuft(b, 5, 0, 0.44, 0.10, 0.028, 0.11, 0.3, 2.6, fuzz, 0xf0f4d0);
  tuft(b, 3, 0, 0.40, -0.02, 0.024, 0.09, -0.4, 2.0, fuzz, 0xf0f4d0);

  // Head, proboscis, antennae.
  b.sphere(0.11, 0, 0.34, 0.29, color, 1, 1, 0.95, 9);
  b.capsule(0.03, 0.11, 0, 0.27, 0.39, 0x6a5a2a, Math.PI / 2 - 0.4, 0, 0, 7);
  b.sphere(0.028, 0, 0.235, 0.45, 0x8a7a3a, 1.3, 0.8, 1, 6);
  for (const s of [-1, 1]) {
    b.cone(0.014, 0.14, s * 0.05, 0.45, 0.34, 0x4a4020, -0.5, 0, s * -0.4, 6);
    b.sphere(0.02, s * 0.062, 0.51, 0.31, 0x5a5028, 1, 1.4, 1, 6);
    // Wing roots.
    b.sphere(0.048, s * 0.10, 0.42, 0.09, fuzz, 1, 0.6, 1, 7);
  }
  // Bristles down the back.
  for (let i = 0; i < 4; i++) {
    b.cone(0.011, 0.075, 0, 0.44 - i * 0.01, 0.02 - i * 0.13, 0x4a4020, -0.6, 0, 0, 6);
  }
  return {
    body: b.build(),
    // A veined wing: leading-edge spar plus thin membrane panels.
    limb: (() => {
      const l = new PartBuilder();
      l.capsule(0.014, 0.40, 0, 0, -0.20, 0xb8c88a, Math.PI / 2, 0, 0, 6);
      l.sphere(0.05, 0.03, -0.004, -0.19, 0xe8f0d8, 2.0, 0.1, 7.2, 9);
      l.sphere(0.03, 0.06, -0.008, -0.30, 0xdce8c8, 1.6, 0.1, 6.6, 8);
      return l.build();
    })(),
    eyes: eyePair(0.36, 0.35, 0.09, 0.068, 0x8ad4ff, 0.55),
    limbOffset: new THREE.Vector3(0.09, 0.42, 0.08),
    flapping: true,
    height: 0.62,
  };
}

/**
 * The beetle: a shield with legs.
 *
 * The one species whose whole design is its top surface, which makes it the
 * easiest to draw for this camera and the hardest to make interesting from any
 * other. A low domed shell split down the middle, plates stepping back along it,
 * and a single great horn thrown forward — a rhinoceros beetle, which is the
 * insect a Japanese comic reaches for, and reads instantly from directly above.
 */
function buildBeetle(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  // Lighter than a real beetle's brown. At this size, against a dark dungeon and
  // inside an ink outline, 0x5a4632 came out as a black lozenge with no shell
  // detail in it at all — the plates, the split and the horn were all invisible.
  const shell = 0x7d5f3a;
  const glossy = tint(shell, 0.26, 1);
  const bone = 0xc8a860;

  // Low domed carapace, split, with segment ridges stepping back.
  b.sphere(0.36, 0, 0.24, -0.04, shell, 1.25, 0.66, 1.45, 14);
  crown(b, 0.30, 0, 0.36, -0.06, shell, 1.15, 1.35);
  b.sphere(0.03, 0, 0.36, -0.04, tint(shell, -0.44), 1, 1.2, 22, 7);
  for (let i = 0; i < 4; i++) {
    b.sphere(0.28 - i * 0.045, 0, 0.335 - i * 0.02, -0.20 - i * 0.13, glossy,
      1.05, 0.14, 0.28, 9);
  }
  // Pale underbelly plates.
  b.sphere(0.30, 0, 0.13, -0.04, 0x8a7048, 1.15, 0.35, 1.3, 9);
  // Pronotum and head, with the horn coming off the front of it.
  b.sphere(0.19, 0, 0.24, 0.30, tint(shell, 0.11), 1.15, 0.7, 0.8, 10);
  b.sphere(0.15, 0, 0.22, 0.44, color, 1.05, 0.85, 0.95, 9);
  b.cone(0.062, 0.20, 0, 0.32, 0.46, accent, -0.95, 0, 0, 8);
  b.cone(0.036, 0.16, 0, 0.44, 0.55, tint(accent, 0.14), -1.2, 0, 0, 7);
  // The lower half of the pincer, and mandibles either side of it.
  b.cone(0.05, 0.16, 0, 0.14, 0.54, accent, 1.1, 0, 0, 7);
  for (const s of [-1, 1]) {
    b.cone(0.05, 0.26, s * 0.11, 0.18, 0.58, accent, Math.PI / 2, 0, s * -0.34, 7);
    b.cone(0.028, 0.13, s * 0.15, 0.16, 0.68, bone, Math.PI / 2, 0, s * -0.9, 6);
    b.capsule(0.014, 0.16, s * 0.09, 0.33, 0.50, 0x3a2c1c, -0.7, 0, s * -0.5, 6);
    b.sphere(0.026, s * 0.155, 0.42, 0.56, 0x3a2c1c, 1, 1, 1.6, 6);
    // Rear spiracles.
    b.sphere(0.048, s * 0.22, 0.20, -0.42, accent, 1, 1, 1, 7);
  }
  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      // Splayed out sideways rather than hanging down, so a low body still has
      // room for a leg between it and the floor.
      l.capsule(0.030, 0.11, 0.05, -0.045, 0, accent, 0, 0, 0.85, 7);
      l.sphere(0.034, 0.10, -0.085, 0, tint(accent, -0.16), 1, 1, 1, 7);
      l.capsule(0.020, 0.11, 0.145, -0.125, 0, accent, 0, 0, -0.35, 7);
      // Barbs down the shin, the way a beetle's leg is toothed.
      for (let i = 0; i < 3; i++) {
        l.cone(0.011, 0.035, 0.15 + i * 0.006, -0.10 - i * 0.03, 0.02, 0x2a1e12, 1.2, 0, -1.2, 5);
      }
      l.cone(0.018, 0.07, 0.175, -0.155, 0.03, 0x2a1e12, Math.PI / 2 - 0.4, 0, 0, 6);
      return l.build();
    })(),
    eyes: eyePair(0.275, 0.52, 0.105, 0.05, 0xc4f04a, 0.2),
    limbOffset: new THREE.Vector3(0.28, 0.16, 0.10),
    flapping: false,
    height: 0.58,
  };
}

/* --------------------------------------------------------------- brutes -- */

/**
 * The troll: shoulders with a head hidden in them.
 *
 * The manga brute is drawn as an inverted triangle — an enormous shoulder mass
 * tapering to small hips, with a tiny head sunk between the trapezii and arms
 * long enough to reach the floor. The head being *too small* is the joke, and it
 * is the same joke inverted from the imp: proportion carrying character in both
 * directions.
 *
 * A shaggy mane over the shoulders and skull is what stops the top-down view
 * being two green boulders, and it gives this one the one thing the roster was
 * short of: hair with weight to it.
 */
function buildTroll(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const belly = tint(color, 0.16, 1);
  const dark = tint(color, -0.20);
  const bone = 0xe8e0c0;

  // Barrel chest and heavy gut, shoulders far wider than the head is tall.
  b.sphere(0.40, 0, 0.74, -0.02, color, 1.22, 1.15, 0.95, 14);
  b.sphere(0.32, 0, 0.50, 0.10, belly, 1.15, 0.95, 0.9, 10);
  b.sphere(0.20, 0, 0.30, 0.04, color, 1.0, 0.8, 0.9, 9);
  for (const s of [-1, 1]) {
    b.sphere(0.25, s * 0.40, 0.95, -0.02, color, 1, 0.95, 1, 11);
    b.sphere(0.14, s * 0.46, 1.07, -0.04, accent, 1, 0.7, 1, 8);
  }

  // Small head, low between the shoulders, with a jutting jaw.
  b.sphere(0.185, 0, 1.02, 0.12, color, 1.05, 0.95, 1, 10);
  b.sphere(0.135, 0, 0.95, 0.22, belly, 1.3, 0.7, 0.9, 9);
  tusks(b, 0.034, 0.16, 0.075, 0.90, 0.25, bone);
  for (const s of [-1, 1]) {
    b.cone(0.048, 0.14, s * 0.19, 1.04, 0.02, accent, 0, 0, s * -1.2, 7);
  }

  // The mane: over the crown, then a heavier fall across the shoulders.
  tuft(b, 7, 0, 1.14, 0.04, 0.05, 0.24, -0.55, 2.8, dark, tint(dark, 0.26));
  tuft(b, 5, 0, 1.06, -0.22, 0.06, 0.26, -1.0, 3.0, dark, tint(dark, 0.20));
  for (const s of [-1, 1]) {
    tuft(b, 3, s * 0.30, 1.06, -0.10, 0.05, 0.20, -0.9, 1.6, dark, tint(dark, 0.22));
  }

  // Long apelike arms hanging past the knees, ending in fists the size of the
  // head. Modelled on the body rather than as limbs so they hang still — a troll
  // that swings all four reads as a puppet.
  for (const s of [-1, 1]) {
    b.capsule(0.115, 0.30, s * 0.45, 0.74, 0.02, color, 0.12, 0, 0, 9);
    b.sphere(0.105, s * 0.47, 0.54, 0.04, dark, 1, 1, 1, 8);
    b.capsule(0.10, 0.26, s * 0.48, 0.40, 0.06, color, 0.2, 0, 0, 9);
    b.sphere(0.14, s * 0.49, 0.20, 0.08, accent, 1.15, 0.98, 1.1, 9);
    b.sphere(0.06, s * 0.49, 0.24, 0.17, tint(accent, -0.20), 2.1, 0.7, 0.5, 8);
    for (let i = -1; i <= 1; i++) {
      claw(b, 0.024, 0.10, s * 0.49 + i * 0.055, 0.16, 0.18, bone, -Math.PI / 2 + 0.2, s);
    }
  }

  // Hunched back, spine ridge, and a belt with a buckle.
  b.sphere(0.22, 0, 0.98, -0.26, color, 1.3, 0.82, 0.9, 10);
  dorsalSpines(b, 4, -0.22, -0.06, 0.92, -0.10, 0.045, 0.13, accent);
  b.torus(0.32, 0.045, 0, 0.40, 0.02, 0x4a3520, Math.PI / 2 - 0.1);
  b.sphere(0.075, 0, 0.40, 0.28, 0xb8a050, 1.1, 1.2, 0.4, 8);
  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      // Tree-trunk thigh, thick ankle, and a flat splayed foot. Short, because a
      // brute is drawn with its mass up top — and because the hip is only half a
      // metre off the ground, which is all the room a leg has.
      const ankle = taperedLimb(l, 0.13, 0.105, 0.11, 0.10, color, dark, 0.06);
      l.sphere(0.115, 0, ankle - 0.02, 0.06, accent, 1.3, 0.66, 1.6, 9);
      for (let i = -1; i <= 1; i++) {
        claw(l, 0.026, 0.09, i * 0.062, ankle - 0.03, 0.17, bone, -Math.PI / 2, i || 1);
      }
      return l.build();
    })(),
    eyes: eyePair(1.05, 0.25, 0.078, 0.05, 0xffd24a, 0.7),
    limbOffset: new THREE.Vector3(0.19, 0.50, 0),
    flapping: false,
    height: 1.5,
  };
}

/**
 * The demon spawn: the fast one.
 *
 * Where the troll is mass, this is line. A lean reptile leaning into its run,
 * counterweighted by a whip tail, with everything swept backward — horns, jaw,
 * spines, wing stubs — so the silhouette has a direction even when it is standing
 * still. That backward sweep is the manga shorthand for speed, and it is the one
 * thing that separates this from a small dragon.
 *
 * Layered chest plates and a nape of dark spines give it the surface detail the
 * long shapes would otherwise lack.
 */
function buildDemonSpawn(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const scale = tint(color, 0.20, 1);
  const dark = tint(accent, -0.28);
  const bone = 0xf0e8d0;

  // Torso pitched forward off the hips.
  b.sphere(0.26, 0, 0.62, 0.02, color, 1.06, 1.2, 0.95, 12);
  b.sphere(0.20, 0, 0.50, 0.16, scale, 1.0, 1.05, 0.7, 10);
  // Chest plates, stacked and overlapping down the front.
  for (let i = 0; i < 4; i++) {
    b.sphere(0.13 - i * 0.012, 0, 0.68 - i * 0.10, 0.19 - i * 0.012, scale,
      1.15, 0.2, 0.55, 9);
  }
  for (const s of [-1, 1]) {
    b.sphere(0.165, s * 0.25, 0.80, 0, color, 1, 0.9, 1, 10);
    b.sphere(0.085, s * 0.27, 0.87, -0.01, tint(color, 0.14), 1.1, 0.55, 1.1, 8);
  }

  // Neck and a wedge skull with a real jaw hinge.
  b.capsule(0.10, 0.14, 0, 0.90, 0.06, color, 0.35, 0, 0, 9);
  b.sphere(0.175, 0, 1.01, 0.11, color, 1, 0.95, 1.15, 11);
  crown(b, 0.15, 0, 1.12, 0.10, color, 1.05, 1.15);
  b.cone(0.125, 0.32, 0, 0.99, 0.32, color, Math.PI / 2, 0, 0, 9);
  b.sphere(0.075, 0, 0.90, 0.28, scale, 1.5, 0.55, 1.9, 9);
  b.sphere(0.03, -0.05, 1.01, 0.44, 0x2a1008, 1, 1, 1, 6);
  b.sphere(0.03, 0.05, 1.01, 0.44, 0x2a1008, 1, 1, 1, 6);
  for (let i = 0; i < 4; i++) {
    for (const s of [-1, 1]) {
      b.cone(0.020, 0.07, s * 0.07, 0.945, 0.24 + i * 0.06, bone, Math.PI, 0, 0, 6);
    }
  }
  horns(b, 0.05, 0.32, 0.13, 1.11, -0.02, accent, -0.8, 0.44);
  for (const s of [-1, 1]) {
    b.cone(0.028, 0.15, s * 0.16, 0.99, 0.06, accent, -0.4, 0, s * -0.9, 6);
  }
  // Nape spines, vestigial wings, back ridge and tail.
  tuft(b, 5, 0, 1.02, -0.10, 0.032, 0.17, -1.25, 2.0, dark, tint(dark, 0.26));
  for (const s of [-1, 1]) {
    b.cone(0.065, 0.26, s * 0.24, 0.78, -0.14, accent, -1.1, 0, s * -0.8, 7);
    b.sphere(0.03, s * 0.30, 0.86, -0.24, tint(accent, 0.14), 1, 1, 1, 6);
  }
  dorsalSpines(b, 5, -0.10, -0.09, 0.76, -0.045, 0.045, 0.16, accent);
  tail(b, 5, 0, 0.52, -0.30, 0.085, 0.15, 0.05, color, accent);
  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      // A digitigrade leg: the ankle is high and the foot is long, which is what
      // makes a runner look like a runner.
      l.sphere(0.10, 0, -0.045, 0, color, 1, 1.2, 1, 9);
      l.capsule(0.066, 0.11, 0, -0.175, -0.02, color, -0.2, 0, 0, 9);
      l.sphere(0.054, 0, -0.275, 0.02, scale, 1, 1, 1, 8);
      l.capsule(0.047, 0.10, 0, -0.35, 0.04, color, 0.3, 0, 0, 8);
      l.sphere(0.058, 0, -0.415, 0.09, accent, 1.15, 0.55, 1.55, 8);
      for (let i = -1; i <= 1; i++) {
        claw(l, 0.018, 0.085, i * 0.043, -0.425, 0.18, bone, -Math.PI / 2, i || 1);
      }
      claw(l, 0.016, 0.065, 0, -0.405, -0.055, bone, Math.PI / 2 - 0.3, 1);
      return l.build();
    })(),
    eyes: eyePair(1.04, 0.25, 0.078, 0.052, 0xff5c3a, 0.85),
    limbOffset: new THREE.Vector3(0.15, 0.44, 0),
    flapping: false,
    height: 1.35,
  };
}

/**
 * The bile demon: enormous, and pleased about it.
 *
 * A stack of sagging lobes rather than one ball, widest low down, with creases
 * between them — the difference between flesh and a balloon. Comically small arms
 * on a body that size, a head sunk into the fat with jowls and a hanging chin,
 * and tusks that curl up past the eyes.
 *
 * Grotesque, but drawn round: every silhouette curve is convex, which is what
 * keeps it in the same style as the rest of the roster rather than tipping into
 * horror.
 */
function buildBileDemon(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const gut = tint(color, 0.22, 1);
  const wart = accent;
  const bone = 0xe8e0c0;

  // The stack: three overlapping lobes at different heights and offsets.
  b.sphere(0.50, 0, 0.72, -0.04, color, 1.05, 0.86, 1.0, 14);
  b.sphere(0.58, 0, 0.46, 0.02, color, 1.10, 0.80, 1.05, 15);
  b.sphere(0.52, 0, 0.30, 0.06, color, 1.14, 0.60, 1.08, 14);
  // Smaller and further back than the other crowns, and low enough to sit behind
  // the head rather than over it: at full size this dome was the largest thing on
  // the creature and it swallowed the face whole.
  crown(b, 0.34, 0, 0.94, -0.24, color, 1.15, 0.95);
  // Belly proper, hanging forward over the legs.
  b.sphere(0.44, 0, 0.40, 0.30, gut, 1.05, 0.92, 0.72, 13);
  b.sphere(0.34, 0, 0.22, 0.34, gut, 1.0, 0.60, 0.62, 10);
  // Creases between the lobes.
  b.torus(0.50, 0.075, 0, 0.58, 0.02, wart, Math.PI / 2 - 0.18);
  b.torus(0.52, 0.070, 0, 0.34, 0.04, wart, Math.PI / 2 - 0.12);
  b.torus(0.42, 0.055, 0, 0.17, 0.06, wart, Math.PI / 2 - 0.08);

  // Boils, in clusters rather than evenly scattered, each with a pale head.
  const boils: Array<[number, number, number, number]> = [
    [-0.42, 0.86, -0.16, 0.075], [-0.30, 0.94, -0.26, 0.055], [-0.46, 0.74, -0.28, 0.05],
    [0.40, 0.90, -0.20, 0.070], [0.50, 0.78, -0.10, 0.048],
    [0.14, 0.98, -0.34, 0.060], [-0.08, 1.00, -0.30, 0.042],
    [-0.54, 0.44, -0.18, 0.062], [0.56, 0.40, -0.22, 0.055],
    [0.24, 0.20, -0.44, 0.050],
  ];
  for (const [x, y, z, r] of boils) {
    b.sphere(r, x, y, z, wart, 1, 0.85, 1, 7);
    b.sphere(r * 0.45, x, y + r * 0.6, z, 0xd8e08a, 1, 1, 1, 6);
  }
  // Two rows of blunt spines down the back.
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    for (const s of [-1, 1]) {
      b.cone(0.055 - t * 0.018, 0.20 - t * 0.06,
        s * (0.16 + t * 0.05), 1.02 - t * 0.20, -0.30 - t * 0.10,
        wart, -0.5 - t * 0.3, 0, s * -0.25, 7);
    }
  }

  // Head: wide, jowly, sunk into the shoulders, with a real mouth in it.
  b.sphere(0.26, 0, 1.10, 0.16, color, 1.15, 0.92, 1.0, 12);
  b.sphere(0.19, -0.16, 1.00, 0.20, color, 1, 0.85, 1, 9);
  b.sphere(0.19, 0.16, 1.00, 0.20, color, 1, 0.85, 1, 9);
  b.sphere(0.22, 0, 0.94, 0.24, gut, 1.2, 0.55, 0.9, 10);
  b.sphere(0.14, 0, 1.21, 0.27, wart, 1.5, 0.4, 0.7, 9);
  b.sphere(0.20, 0, 1.02, 0.34, 0x3a1a12, 1.15, 0.42, 0.6, 9);
  // Fangs around the mouth, upper and lower.
  for (let i = -2; i <= 2; i++) {
    b.cone(0.026, 0.09, i * 0.075, 0.98, 0.38, bone, Math.PI, 0, 0, 6);
    if (i !== 0) b.cone(0.022, 0.07, i * 0.06, 1.08, 0.38, bone, 0, 0, 0, 6);
  }
  // The big curving tusks, each with a bound brass ring.
  for (const s of [-1, 1]) {
    b.cone(0.06, 0.34, s * 0.20, 1.02, 0.26, bone, -2.35, 0, s * 0.22, 8);
    b.cone(0.035, 0.16, s * 0.235, 1.30, 0.20, tint(bone, 0.08), -2.8, 0, s * 0.3, 7);
    b.torus(0.045, 0.014, s * 0.215, 1.14, 0.20, 0xb8903a, -0.9, 0, s * 0.2);
    b.cone(0.035, 0.12, s * 0.24, 1.22, 0.06, wart, -0.5, 0, s * 0.5, 6);
  }

  // Shoulder spikes, and arms far too short to reach anything.
  for (const s of [-1, 1]) {
    b.sphere(0.22, s * 0.50, 0.90, -0.02, color, 1, 0.9, 1, 10);
    b.cone(0.10, 0.34, s * 0.52, 1.02, -0.10, wart, -0.95, 0, s * -0.55, 7);
    b.cone(0.065, 0.22, s * 0.34, 1.06, -0.24, wart, -1.05, 0, s * -0.35, 7);
    b.capsule(0.11, 0.24, s * 0.60, 0.68, 0.08, color, 0.45, 0, s * 0.1, 9);
    b.sphere(0.095, s * 0.63, 0.52, 0.18, gut, 1, 1, 1, 8);
    b.capsule(0.095, 0.18, s * 0.65, 0.40, 0.24, color, 0.7, 0, 0, 9);
    hand(b, 0.105, s * 0.66, 0.28, 0.30, gut, bone, 3);
  }
  // A strap over the gut, because something has to hold all that up.
  b.torus(0.50, 0.045, 0, 0.40, 0.02, 0x5a4028, Math.PI / 2 - 0.12);
  b.sphere(0.085, 0, 0.40, 0.46, 0xb8903a, 1.1, 1.1, 0.4, 8);
  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      // A leg with no visible knee: all thigh, ending in a splayed pad.
      l.capsule(0.175, 0.10, 0, -0.06, 0, color, 0, 0, 0, 10);
      l.torus(0.15, 0.04, 0, -0.125, 0, gut, Math.PI / 2);
      l.sphere(0.15, 0, -0.175, 0.03, gut, 1.15, 0.7, 1.35, 9);
      for (let i = -1; i <= 1; i++) {
        claw(l, 0.03, 0.11, i * 0.078, -0.185, 0.20, bone, -Math.PI / 2, i || 1);
      }
      l.cone(0.026, 0.08, 0, -0.185, -0.14, bone, Math.PI / 2, 0, 0, 6);
      return l.build();
    })(),
    eyes: eyePair(1.145, 0.325, 0.105, 0.052, 0xa8ff70, 0.4),
    limbOffset: new THREE.Vector3(0.27, 0.28, 0),
    flapping: false,
    height: 1.6,
  };
}

/* ------------------------------------------------------- casters, wyrms -- */

/**
 * The warlock: a silhouette in a hood.
 *
 * The most purely graphic design in the roster, and the one that gains most from
 * the camera being overhead: a hood is a cone, and a cone from above is a perfect
 * dark circle with a point of face in it. Everything else is drawn to hang — a
 * heavy mantle, a hem that flares, long sleeves the hands disappear into, and a
 * beard falling out of the shadow where a face should be.
 *
 * Nothing here is anatomy. It is a shape with a light in it, which is how a comic
 * draws a wizard.
 */
function buildWarlock(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const trim = 0x453c7e;
  const lit = tint(color, 0.22, 0);
  const hair = 0xd8d0e8;

  // Robe: a cone, a flared hem, and a rolled edge, so it reads as cloth.
  b.cone(0.33, 0.84, 0, 0.42, 0, color, 0, 0, 0, 14);
  b.cone(0.40, 0.22, 0, 0.11, 0, trim, 0, 0, 0, 14);
  b.torus(0.36, 0.05, 0, 0.06, 0, trim);
  // Folds down the robe: rounded ridges, not battens.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    b.sphere(0.035, Math.cos(a) * 0.28, 0.43, Math.sin(a) * 0.28,
      i % 2 ? trim : tint(color, -0.16), 1, 12, 1, 7);
  }
  // Shoulders, mantle, and a deep hood with the face in shadow.
  b.sphere(0.27, 0, 0.84, 0, accent, 1.15, 0.44, 1.15, 11);
  b.sphere(0.20, 0, 0.90, -0.03, tint(accent, 0.18), 1.2, 0.3, 1.2, 10);
  b.torus(0.22, 0.045, 0, 0.90, 0, trim);
  b.sphere(0.175, 0, 0.95, 0.02, color, 1, 1.05, 1, 10);
  b.cone(0.215, 0.34, 0, 1.08, -0.05, accent, 0.2, 0, 0, 12);
  crown(b, 0.14, 0, 1.16, -0.09, accent, 1.0, 1.0);
  // The hollow of the hood, and the beard hanging out of it.
  b.sphere(0.135, 0, 0.93, 0.10, 0x0e0a1a, 1, 1, 0.8, 8);
  tuft(b, 5, 0, 0.86, 0.10, 0.045, 0.22, 1.5, 1.4, hair, 0xf0ecff);
  // Sleeved arms; the hands stay hidden except for the one on the staff.
  for (const s of [-1, 1]) {
    b.capsule(0.085, 0.26, s * 0.24, 0.68, 0.04, color, 0.25, 0, s * -0.2, 9);
    b.cone(0.11, 0.16, s * 0.28, 0.53, 0.10, accent, Math.PI, 0, s * -0.2, 8);
  }
  b.sphere(0.07, 0.30, 0.48, 0.13, 0xd8c8b0, 1, 1, 1, 8);
  // Staff: shaft, binding, and a crystal that does not touch it.
  b.capsule(0.026, 1.14, 0.32, 0.60, 0.10, 0x4a3826, 0, 0, 0.05, 8);
  b.torus(0.045, 0.014, 0.32, 0.86, 0.10, 0xb89040);
  b.cone(0.085, 0.17, 0.32, 1.24, 0.10, lit, 0, 0, 0, 8);
  b.cone(0.085, 0.15, 0.32, 1.09, 0.10, lit, Math.PI, 0, 0, 8);
  b.sphere(0.03, 0.32, 1.165, 0.10, 0xf0e0ff, 1, 1, 1, 7);
  // Belt, pouch, and a chained book at the hip.
  b.torus(0.30, 0.035, 0, 0.52, 0, trim);
  b.sphere(0.06, -0.26, 0.46, 0.14, 0x6a4a2a, 1, 1.15, 0.7, 8);
  b.box(0.16, 0.20, 0.06, 0.26, 0.44, -0.10, 0x7a2a2a);
  b.box(0.14, 0.18, 0.02, 0.26, 0.44, -0.13, 0xd8c8a0);
  b.torus(0.05, 0.008, 0.26, 0.54, -0.10, 0xb89040, 0, 0.4, 0);
  return {
    body: b.build(),
    // Only the hem moves; a robed caster should not have visible legs.
    limb: new PartBuilder()
      .sphere(0.07, 0, -0.04, 0.03, trim, 1, 0.7, 1.4, 8)
      .sphere(0.045, 0, -0.07, 0.13, 0x2a1e14, 1, 0.6, 1.2, 7)
      .build(),
    eyes: eyePair(0.95, 0.20, 0.055, 0.044, 0xc07aff, 0.5),
    limbOffset: new THREE.Vector3(0.10, 0.07, 0),
    flapping: false,
    height: 1.35,
  };
}

/**
 * The dragon: a big head on a long body.
 *
 * Western dragons are drawn with small heads and huge bodies. Comic dragons are
 * drawn the other way round, because the head is where the character is, and this
 * one follows the comic: a broad skull with a crown of horns fanning back, a
 * short heavy neck, and the body and tail trailing behind as line rather than
 * mass.
 *
 * The crown is doing double duty. It is the manga read on a dragon, and from
 * directly overhead it is the only part of the animal that says which way it is
 * facing.
 */
function buildDragon(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const belly = tint(color, 0.22, 1);
  const bone = 0xf0e8d0;

  // Deep chest, long body, haunches.
  b.sphere(0.38, 0, 0.66, -0.02, color, 1.0, 0.95, 1.4, 14);
  b.sphere(0.30, 0, 0.50, 0.10, belly, 0.95, 0.75, 1.2, 11);
  crown(b, 0.32, 0, 0.82, -0.06, color, 1.0, 1.35);
  for (const s of [-1, 1]) {
    b.sphere(0.28, s * 0.26, 0.56, -0.26, color, 1, 1, 1.1, 11);
  }
  // Belly scutes: rings across the underside, which is what makes a long body
  // read as a serpent rather than a sausage.
  for (let i = 0; i < 4; i++) {
    b.sphere(0.22 - i * 0.02, 0, 0.42 - i * 0.01, 0.24 - i * 0.16, belly,
      1.0, 0.16, 0.3, 9);
  }
  // Short neck in three tapering segments.
  for (let i = 0; i < 3; i++) {
    b.sphere(0.175 - i * 0.014, 0, 0.82 + i * 0.12, 0.24 + i * 0.13, color, 1, 1, 1.1, 10);
  }
  // Skull: broad pan, blunt snout, hinged jaw, teeth, nostrils.
  b.sphere(0.21, 0, 1.16, 0.58, color, 1.12, 0.92, 1.1, 12);
  crown(b, 0.19, 0, 1.28, 0.56, color, 1.05, 1.0);
  b.cone(0.145, 0.34, 0, 1.13, 0.84, color, Math.PI / 2, 0, 0, 10);
  b.sphere(0.085, 0, 1.03, 0.80, belly, 1.4, 0.5, 2.0, 10);
  b.sphere(0.032, -0.055, 1.15, 1.00, 0x2a1008, 1, 1, 1, 6);
  b.sphere(0.032, 0.055, 1.15, 1.00, 0x2a1008, 1, 1, 1, 6);
  for (let i = 0; i < 4; i++) {
    const z = 0.70 + i * 0.08;
    for (const s of [-1, 1]) {
      b.cone(0.023, 0.085, s * 0.077, 1.05, z, bone, Math.PI, 0, 0, 6);
    }
  }
  // The crown: a main pair of horns, a swept pair behind, and cheek spikes.
  horns(b, 0.055, 0.38, 0.13, 1.30, 0.46, accent, -0.9, 0.38);
  horns(b, 0.035, 0.26, 0.19, 1.24, 0.38, accent, -1.15, 0.55);
  for (const s of [-1, 1]) {
    b.cone(0.032, 0.17, s * 0.18, 1.14, 0.52, accent, -0.3, 0, s * -1.0, 6);
    b.cone(0.024, 0.12, s * 0.14, 1.03, 0.66, accent, -0.5, 0, s * -1.2, 6);
  }
  b.cone(0.028, 0.15, 0, 1.06, 0.95, accent, -0.9, 0, 0, 6);
  // Dorsal ridge from the neck out along the tail, then the tail itself.
  dorsalSpines(b, 7, 0.30, -0.16, 0.94, -0.045, 0.055, 0.21, accent);
  tail(b, 6, 0, 0.58, -0.44, 0.145, 0.20, 0.045, color, accent);
  // Tail fin: two blades rather than a spike, so it reads from above.
  for (const s of [-1, 1]) {
    b.sphere(0.11, s * 0.05, 0.34, -1.58, accent, 0.35, 1.5, 1.9, 9);
  }
  return {
    body: b.build(),
    // A membraned wing: arm bones, finger struts, panels between.
    limb: (() => {
      const l = new PartBuilder();
      l.capsule(0.048, 0.28, 0, 0.02, -0.16, color, Math.PI / 2, 0, 0, 9);
      l.sphere(0.055, 0, 0.03, -0.33, color, 1, 1, 1, 8);
      l.capsule(0.032, 0.38, 0, 0.06, -0.55, accent, Math.PI / 2 - 0.2, 0, 0, 8);
      l.sphere(0.16, 0, -0.10, -0.42, accent, 0.09, 1.6, 2.9, 9);
      l.sphere(0.13, 0, -0.16, -0.72, accent, 0.08, 1.5, 2.6, 8);
      // The membrane, in one panel with a lit inner face.
      l.sphere(0.26, 0.15, -0.10, -0.46, 0x8a2a1e, 1.3, 0.05, 1.9, 10);
      l.sphere(0.20, 0.16, -0.115, -0.46, tint(0x8a2a1e, 0.20, 1), 1.2, 0.03, 1.7, 9);
      l.cone(0.02, 0.10, 0, 0.10, -0.80, bone, -Math.PI / 2, 0, 0, 6);
      return l.build();
    })(),
    eyes: eyePair(1.21, 0.70, 0.09, 0.052, 0xffa030, 0.9),
    limbOffset: new THREE.Vector3(0.30, 0.86, -0.06),
    flapping: true,
    height: 1.6,
  };
}

/* ---------------------------------------------------------------- heroes -- */

/**
 * The dwarf: a beard with a helmet on it.
 *
 * Three heads tall, and the middle one is beard. The manga read on a dwarf is to
 * let two features eat the whole design — the helm and the beard — until the body
 * is just the thing carrying them, with big boots underneath and a pick over the
 * shoulder. Braided, forked, and wide enough to hide the chest, because a small
 * beard on a short character reads as a chin strap.
 */
function buildDwarf(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const mail = 0x8a8f9a;
  const steel = tint(mail, 0.16);
  const hair = 0xe8e0d0;
  const brass = 0xb89040;

  // Short and wide: the silhouette is a box with a beard hung off it.
  b.sphere(0.28, 0, 0.44, 0, accent, 1.28, 1.0, 0.95, 12);
  b.sphere(0.24, 0, 0.38, 0.10, mail, 1.15, 0.8, 0.7, 10);
  for (const s of [-1, 1]) {
    b.sphere(0.165, s * 0.29, 0.58, 0, mail, 1, 0.85, 1, 9);
    b.sphere(0.09, s * 0.30, 0.65, 0, steel, 1.15, 0.5, 1.15, 8);
  }
  // Head, then the beard: a broad mass with a fork and two braids in it.
  b.sphere(0.175, 0, 0.72, 0.02, color, 1, 0.95, 1, 10);
  b.sphere(0.20, 0, 0.56, 0.08, hair, 1.15, 1.15, 0.85, 11);
  b.sphere(0.13, -0.07, 0.42, 0.06, hair, 1, 1.1, 0.8, 9);
  b.sphere(0.13, 0.07, 0.42, 0.06, hair, 1, 1.1, 0.8, 9);
  for (const s of [-1, 1]) {
    // Moustache, sweeping out and up.
    b.sphere(0.075, s * 0.115, 0.665, 0.115, hair, 1.5, 0.6, 1, 8);
    // A braid, ringed in brass at the end.
    b.capsule(0.035, 0.10, s * 0.145, 0.40, 0.08, hair, 0.1, 0, s * 0.15, 8);
    b.torus(0.036, 0.012, s * 0.15, 0.325, 0.08, brass, -Math.PI / 2, 0, s * 0.15);
    b.cone(0.03, 0.07, s * 0.15, 0.285, 0.08, hair, Math.PI, 0, 0, 6);
    // Eyebrows to match the beard.
    b.sphere(0.05, s * 0.075, 0.795, 0.115, hair, 1.5, 0.55, 0.8, 7);
  }
  // Helm: a dome, a nasal bar, a rivetted band, and a pair of stubby wings.
  b.sphere(0.19, 0, 0.82, 0, mail, 1.02, 0.66, 1.02, 12);
  crown(b, 0.17, 0, 0.90, 0, mail, 1.0, 1.0);
  b.capsule(0.022, 0.12, 0, 0.76, 0.175, steel, 0, 0, 0, 7);
  b.torus(0.185, 0.028, 0, 0.78, 0, brass);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.sphere(0.02, Math.cos(a) * 0.175, 0.80, Math.sin(a) * 0.175, brass, 1, 1, 1, 6);
  }
  for (const s of [-1, 1]) {
    b.sphere(0.10, s * 0.20, 0.88, -0.02, steel, 0.28, 1.3, 0.9, 8);
  }
  // Arms, and a pick over the shoulder.
  for (const s of [-1, 1]) {
    b.capsule(0.072, 0.18, s * 0.32, 0.44, 0.03, accent, 0.2, 0, 0, 9);
    b.sphere(0.075, s * 0.34, 0.29, 0.10, color, 1, 1, 1, 8);
  }
  b.capsule(0.028, 0.60, 0.30, 0.52, 0.14, 0x5a4028, 0.35, 0, 0.18, 8);
  b.sphere(0.055, 0.36, 0.82, 0.24, mail, 3.4, 0.7, 0.9, 9);
  b.cone(0.05, 0.17, 0.51, 0.84, 0.28, steel, Math.PI / 2, 0.3, 0, 7);
  b.cone(0.04, 0.13, 0.21, 0.80, 0.20, steel, -Math.PI / 2, 0.3, 0, 6);
  b.torus(0.28, 0.04, 0, 0.34, 0, 0x5a4028, Math.PI / 2 - 0.1);
  b.sphere(0.07, 0, 0.34, 0.24, brass, 1.1, 1.1, 0.4, 8);
  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      // Stumpy leg, enormous boot. The boot is most of what you see of a dwarf.
      l.capsule(0.082, 0.06, 0, -0.06, 0, accent, 0, 0, 0, 9);
      l.capsule(0.072, 0.05, 0, -0.145, 0, mail, 0, 0, 0, 8);
      l.sphere(0.085, 0, -0.205, 0.05, 0x4a3520, 1.15, 0.75, 1.5, 9);
      l.sphere(0.05, 0, -0.235, 0.11, 0x2a1e14, 1.5, 0.4, 1.0, 7);
      return l.build();
    })(),
    eyes: eyePair(0.755, 0.155, 0.065, 0.036, 0x6ad0ff, 0.35),
    limbOffset: new THREE.Vector3(0.13, 0.22, 0),
    flapping: false,
    height: 1.05,
  };
}

/**
 * The archer: hood, ponytail, cloak.
 *
 * Slender where the rest of the roster is heavy, which is the point — a roster
 * reads by contrast. The manga devices are all in the outline: a big hood pulled
 * forward so the face is shadow, a long ponytail out the back of it, and a cloak
 * that trails, so the silhouette has motion in it while standing still.
 *
 * The ponytail is also the only thing that tells you which way an archer is
 * facing from above, which is why it is as long as it is.
 */
function buildArcher(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  const leather = 0x8a6a44;
  const hair = 0x8a5528;
  const bone = 0xd8d0c0;

  // Narrow chest over a jerkin, with a rolled collar.
  b.sphere(0.22, 0, 0.64, 0, color, 0.95, 1.25, 0.8, 11);
  b.sphere(0.19, 0, 0.62, 0.02, leather, 1.05, 1.3, 0.9, 11);
  b.sphere(0.075, 0, 0.84, 0.03, tint(leather, 0.18), 1.9, 0.6, 1.4, 9);
  for (const s of [-1, 1]) {
    b.sphere(0.14, s * 0.24, 0.86, 0, color, 1, 0.85, 1, 9);
    // Straps crossing the chest, which is most of the surface detail here.
    b.sphere(0.03, s * 0.09, 0.68, 0.15, tint(leather, -0.28), 1, 5.4, 0.7, 7);
  }
  // Hood, pulled forward, with the face lost in it.
  b.sphere(0.16, 0, 0.96, 0.02, accent, 1, 1, 1, 10);
  b.cone(0.205, 0.32, 0, 1.07, -0.05, color, 0.22, 0, 0, 11);
  crown(b, 0.14, 0, 1.14, -0.09, color, 1.0, 1.0);
  b.sphere(0.12, 0, 0.95, 0.09, 0x120e08, 1, 1, 0.8, 8);
  // Ponytail: one thick clump, bound, with a fan at the end.
  b.capsule(0.045, 0.16, 0, 0.94, -0.20, hair, 1.15, 0, 0, 8);
  b.torus(0.045, 0.012, 0, 0.90, -0.29, 0x3a2a18, 0.4);
  tuft(b, 4, 0, 0.86, -0.32, 0.032, 0.19, 1.5, 1.2, hair, tint(hair, 0.22));
  // Cloak, and a quiver across the back.
  b.cone(0.30, 0.62, 0, 0.62, -0.14, color, 0, 0, 0, 12);
  b.sphere(0.12, 0, 0.34, -0.24, tint(color, -0.20), 1.6, 1.4, 0.4, 9);
  b.capsule(0.06, 0.26, -0.20, 0.72, -0.18, leather, 0.35, 0, 0.3, 8);
  for (let i = 0; i < 3; i++) {
    b.capsule(0.007, 0.20, -0.20 + i * 0.03, 0.98, -0.20, 0x8a7048, 0.35, 0, 0.3, 5);
    b.cone(0.02, 0.06, -0.20 + i * 0.03, 1.06, -0.22, bone, 0.35, 0, 0.3, 6);
  }
  // Bow: three angled staves plus a string, which reads as a curve.
  b.capsule(0.016, 0.30, 0.30, 0.86, 0.06, 0x7a5a2a, 0, 0, 0.30, 7);
  b.capsule(0.018, 0.26, 0.34, 0.62, 0.06, 0x7a5a2a, 0, 0, 0.02, 7);
  b.capsule(0.016, 0.30, 0.30, 0.38, 0.06, 0x7a5a2a, 0, 0, -0.30, 7);
  b.box(0.008, 0.86, 0.008, 0.22, 0.62, 0.06, 0xe0dcc8);
  b.sphere(0.07, 0.28, 0.60, 0.10, 0xd8c8a8, 1, 1, 1, 8);
  b.torus(0.24, 0.03, 0, 0.46, 0, 0x3a2a18);
  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      const ankle = taperedLimb(l, 0.055, 0.042, 0.12, 0.11, color, leather);
      l.sphere(0.06, 0, ankle - 0.01, 0.05, 0x3a2a18, 1.15, 0.7, 1.5, 8);
      // A cuff at the top of the boot.
      l.torus(0.05, 0.016, 0, ankle + 0.08, 0.01, tint(leather, 0.14), Math.PI / 2);
      return l.build();
    })(),
    eyes: eyePair(0.96, 0.14, 0.056, 0.036, 0x4ac8d8, 0.45),
    limbOffset: new THREE.Vector3(0.11, 0.36, 0),
    flapping: false,
    height: 1.35,
  };
}

/**
 * The knight: the one drawn as a hero.
 *
 * Everything is broad and symmetrical and vertical, which is the visual language
 * of the character you are *supposed* to be afraid of — and the deliberate
 * opposite of the monsters, all of whom lean, sag or sweep. Wide pauldrons, a
 * tall great helm, a kite shield, a straight sword.
 *
 * The plume is the manga flourish and the reason this silhouette works from
 * above: a long crest of hair off the crown of the helm, sweeping back, so a
 * knight coming down a corridor is a red arrow pointing at you.
 */
function buildKnight(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  // Not the near-white it was. A highlight has to be lighter than the base, and
  // 0xd0d6e0 left nowhere above it to go: the crest, the visor and the crown of
  // the helm all clipped to the same flat white.
  const steel = 0xb2bacb;
  const dark = 0x5a6070;
  // A third colour, and not the species accent, which is the shield's navy: a
  // navy plume on pale steel is invisible, and the crest is the whole reason this
  // silhouette reads from above. Heraldic crimson is what the plate wants behind
  // it and what nothing else in the roster is wearing.
  const plume = 0xb02430;

  // Plate cuirass with a raised centre ridge.
  b.sphere(0.29, 0, 0.68, 0, color, 1.12, 1.25, 0.85, 13);
  b.sphere(0.10, 0, 0.68, 0.14, steel, 0.7, 2.4, 0.8, 9);
  b.torus(0.26, 0.045, 0, 0.48, 0, dark);
  // Pauldrons: layered plates rather than one ball, which is what makes armour
  // read as armour and not as a shoulder.
  for (const s of [-1, 1]) {
    b.sphere(0.22, s * 0.33, 0.94, 0, steel, 1, 0.85, 1.05, 11);
    b.sphere(0.185, s * 0.35, 0.86, 0, tint(steel, -0.18), 1.05, 0.42, 1.1, 10);
    b.sphere(0.16, s * 0.36, 0.79, 0, tint(steel, -0.28), 1.05, 0.34, 1.05, 9);
    // Spike out sideways, well clear of the helm. Angled up they sat either side
    // of the head and read as part of it — the knight appeared to be wearing a
    // hat rather than pauldrons.
    b.cone(0.085, 0.19, s * 0.46, 0.97, 0, accent, -0.25, 0, s * -1.15, 7);
  }
  // Great helm: a barrel with a domed top, a visor slit, and breathing holes.
  b.cylinder(0.175, 0.185, 0.28, 0, 1.08, 0.02, steel, 0, 0, 0, 12);
  b.sphere(0.175, 0, 1.22, 0.02, steel, 1, 0.68, 1, 12);
  crown(b, 0.155, 0, 1.30, 0.01, steel, 1.0, 1.0);
  b.box(0.26, 0.045, 0.05, 0, 1.10, 0.17, 0x0a0a10);
  b.sphere(0.155, 0, 1.11, 0.10, tint(steel, -0.20), 1.05, 0.5, 1.0, 10);
  for (let i = 0; i < 4; i++) {
    b.sphere(0.014, -0.06 + i * 0.04, 1.00, 0.175, 0x0a0a10, 1, 1, 1, 6);
  }
  // The plume: a crest socket, then a long fall of hair down the back.
  b.sphere(0.04, 0, 1.34, 0.02, 0xb89040, 1.2, 0.8, 1.2, 8);
  tuft(b, 7, 0, 1.38, -0.02, 0.062, 0.40, -0.30, 1.3, plume, tint(plume, 0.20));
  tuft(b, 5, 0, 1.30, -0.16, 0.055, 0.34, -1.05, 1.2, plume, tint(plume, 0.16));
  // Arms.
  for (const s of [-1, 1]) {
    b.capsule(0.082, 0.20, s * 0.37, 0.76, 0.02, steel, 0.15, 0, 0, 9);
    b.sphere(0.08, s * 0.39, 0.60, 0.06, dark, 1, 1, 1, 8);
    b.capsule(0.072, 0.16, s * 0.41, 0.46, 0.06, steel, 0.2, 0, 0, 9);
    b.torus(0.075, 0.018, s * 0.40, 0.66, 0.04, dark, Math.PI / 2 - 0.2);
  }
  // Sword: grip, crossguard, blade, pommel.
  b.capsule(0.024, 0.12, 0.44, 0.34, 0.10, 0x3a2a18, 0, 0, -0.22, 7);
  b.sphere(0.035, 0.46, 0.25, 0.10, 0xb89040, 1, 1, 1, 7);
  b.box(0.20, 0.045, 0.05, 0.42, 0.44, 0.10, 0xb89040, 0, 0, -0.22);
  b.box(0.075, 0.76, 0.022, 0.50, 0.82, 0.10, steel, 0, 0, -0.22);
  b.cone(0.04, 0.13, 0.59, 1.22, 0.10, steel, 0, 0, -0.22, 6);
  // Kite shield, with a boss and a rim.
  b.sphere(0.20, -0.44, 0.74, 0.10, accent, 1.0, 1.25, 0.16, 11);
  b.cone(0.19, 0.24, -0.44, 0.44, 0.10, accent, Math.PI, 0.28, 0, 8);
  b.sphere(0.065, -0.46, 0.76, 0.15, steel, 1, 1, 0.6, 8);
  b.sphere(0.20, -0.45, 0.74, 0.115, tint(accent, -0.28), 1.03, 1.28, 0.1, 11);
  b.box(0.34, 0.05, 0.05, -0.44, 0.93, 0.10, steel, 0, 0.28, 0);
  // Tassets over the hips.
  for (const s of [-1, 1]) {
    b.sphere(0.13, s * 0.10, 0.40, 0.02, dark, 1, 1.1, 1.4, 9);
  }
  return {
    body: b.build(),
    limb: (() => {
      const l = new PartBuilder();
      const ankle = taperedLimb(l, 0.09, 0.072, 0.12, 0.11, steel, dark);
      // Poleyn over the knee, and a sabaton on the end.
      l.sphere(0.075, 0, -0.20, 0.045, steel, 1.1, 0.9, 0.8, 8);
      l.sphere(0.085, 0, ankle - 0.01, 0.06, dark, 1.1, 0.75, 1.6, 9);
      l.sphere(0.05, 0, ankle - 0.03, 0.15, steel, 1.2, 0.5, 1.0, 7);
      return l.build();
    })(),
    eyes: eyePair(1.105, 0.155, 0.05, 0.029, 0x9ad8ff, 0.75),
    limbOffset: new THREE.Vector3(0.15, 0.44, 0),
    flapping: false,
    height: 1.8,
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

/**
 * Lift a colour until it can be seen in a dungeon.
 *
 * The species colours were chosen as *descriptions* — a beetle is dark brown, a
 * warlock's robe is midnight violet — and read perfectly well on a swatch. In the
 * game they are lit by torchlight, sat on near-black basalt and wrapped in a dark
 * ink outline, and at that point a colour below about a third brightness has
 * nothing left to distinguish it: the troll's mane, the warlock's robe and the
 * beetle's shell all resolved to the same featureless hole.
 *
 * Manga colouring solves this the same way, and for the same reason — ink already
 * supplies the darkest value in the picture, so the fill has to sit above it or
 * the drawing collapses into a blot. Mixing toward white rather than raising each
 * channel keeps the hue, so a dark brown beetle stays a brown beetle.
 */
const VALUE_FLOOR = 0.40;

function readable(hex: number): number {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const luma = (0.3 * r + 0.6 * g + 0.1 * b) / 255;
  if (luma >= VALUE_FLOOR) return hex;
  // How far toward white it has to travel to clear the floor.
  return tint(hex, (VALUE_FLOOR - luma) / (1 - luma));
}

const cache = new Map<CreatureType, CreatureModel>();

export function getCreatureModel(type: CreatureType, color: number, accent: number): CreatureModel {
  let model = cache.get(type);
  if (!model) {
    model = BUILDERS[type](readable(color), readable(accent));
    cache.set(type, model);
  }
  return model;
}

/** How many limbs a species renders (legs in pairs, wings in pairs). */
export function limbCountFor(type: CreatureType): number {
  return type === CreatureType.Beetle ? 6 : 2;
}
