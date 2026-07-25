import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CreatureType } from '../core/creatures';

/**
 * Creature models, built from primitives at load time.
 *
 * Each type produces three merged geometries — body, a limb that gets mirrored,
 * and a pair of glowing eyes — so a whole species renders in three instanced
 * draw calls no matter how many of them are running about. The silhouettes are
 * deliberately chunky and readable from the game's usual camera height, which
 * is what the sprites they stand in for were built to do.
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
    sx = 1, sy = 1, sz = 1): this {
    const g = new THREE.SphereGeometry(r, 10, 8);
    g.scale(sx, sy, sz);
    g.translate(x, y, z);
    this.push(g, color);
    return this;
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, color: number,
    rx = 0, ry = 0, rz = 0): this {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    this.push(g, color);
    return this;
  }

  cone(r: number, h: number, x: number, y: number, z: number, color: number,
    rx = 0, ry = 0, rz = 0): this {
    const g = new THREE.ConeGeometry(r, h, 8);
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    this.push(g, color);
    return this;
  }

  cylinder(rt: number, rb: number, h: number, x: number, y: number, z: number, color: number,
    rx = 0, ry = 0, rz = 0): this {
    const g = new THREE.CylinderGeometry(rt, rb, h, 8);
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    this.push(g, color);
    return this;
  }

  torus(radius: number, tube: number, x: number, y: number, z: number, color: number,
    rx = -Math.PI / 2, ry = 0, rz = 0, arc = Math.PI * 2): this {
    const g = new THREE.TorusGeometry(radius, tube, 6, 14, arc);
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

/** A pair of glowing eyes at a given head position. */
function eyePair(y: number, z: number, spread: number, r: number): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.sphere(r, -spread, y, z, 0xffffff);
  b.sphere(r, spread, y, z, 0xffffff);
  return b.build();
}

/* --------------------------------------------------------------- models -- */

function buildImp(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  // Hunched torso and oversized head — the original's put-upon little worker.
  b.sphere(0.30, 0, 0.34, 0, color, 1, 0.95, 1.05);
  b.sphere(0.24, 0, 0.66, 0.06, color, 1.1, 1, 1);
  // Ears, swept back.
  b.cone(0.09, 0.30, -0.20, 0.78, -0.04, accent, 0, 0, 0.9);
  b.cone(0.09, 0.30, 0.20, 0.78, -0.04, accent, 0, 0, -0.9);
  // Snout and tail.
  b.cone(0.10, 0.16, 0, 0.62, 0.24, accent, Math.PI / 2, 0, 0);
  b.cone(0.06, 0.34, 0, 0.30, -0.28, accent, -0.9, 0, 0);
  return {
    body: b.build(),
    limb: new PartBuilder().cylinder(0.06, 0.05, 0.30, 0, -0.15, 0, accent).build(),
    eyes: eyePair(0.70, 0.20, 0.09, 0.045),
    limbOffset: new THREE.Vector3(0.13, 0.18, 0),
    flapping: false,
    height: 0.95,
  };
}

function buildFly(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  b.sphere(0.16, 0, 0.30, 0, color, 1.5, 1, 1);
  b.sphere(0.13, 0, 0.32, 0.20, accent, 1, 1, 1);
  b.cone(0.07, 0.20, 0, 0.28, -0.26, accent, -Math.PI / 2, 0, 0);
  return {
    body: b.build(),
    // A thin translucent-looking blade reads as a wing at this size.
    limb: new PartBuilder().box(0.05, 0.02, 0.34, 0, 0, -0.14, 0xe8f0d8).build(),
    eyes: eyePair(0.34, 0.28, 0.08, 0.05),
    limbOffset: new THREE.Vector3(0.10, 0.40, 0),
    flapping: true,
    height: 0.6,
  };
}

function buildBeetle(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  // Low, wide carapace with a ridge down the middle.
  b.sphere(0.34, 0, 0.22, 0, color, 1.25, 0.62, 1.5);
  b.box(0.06, 0.10, 0.62, 0, 0.36, 0, accent);
  b.sphere(0.16, 0, 0.22, 0.44, accent, 1, 0.9, 1);
  // Mandibles.
  b.cone(0.05, 0.22, -0.10, 0.20, 0.60, accent, Math.PI / 2, 0, 0.3);
  b.cone(0.05, 0.22, 0.10, 0.20, 0.60, accent, Math.PI / 2, 0, -0.3);
  return {
    body: b.build(),
    limb: new PartBuilder().cylinder(0.035, 0.03, 0.26, 0, -0.13, 0, accent, 0, 0, 0.4).build(),
    eyes: eyePair(0.28, 0.52, 0.09, 0.04),
    limbOffset: new THREE.Vector3(0.26, 0.14, 0.10),
    flapping: false,
    height: 0.7,
  };
}

function buildTroll(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  b.sphere(0.36, 0, 0.66, 0, color, 1.15, 1.2, 0.95);
  // Heavy shoulders, small sunken head.
  b.sphere(0.20, -0.34, 0.94, 0, color);
  b.sphere(0.20, 0.34, 0.94, 0, color);
  b.sphere(0.19, 0, 1.02, 0.08, accent);
  b.cone(0.07, 0.18, -0.09, 1.16, 0.04, accent);
  b.cone(0.07, 0.18, 0.09, 1.16, 0.04, accent);
  // Long dangling arms.
  b.cylinder(0.09, 0.11, 0.62, -0.40, 0.62, 0.02, color, 0.15);
  b.cylinder(0.09, 0.11, 0.62, 0.40, 0.62, 0.02, color, 0.15);
  return {
    body: b.build(),
    limb: new PartBuilder().cylinder(0.10, 0.09, 0.38, 0, -0.19, 0, accent).build(),
    eyes: eyePair(1.05, 0.24, 0.08, 0.05),
    limbOffset: new THREE.Vector3(0.17, 0.38, 0),
    flapping: false,
    height: 1.45,
  };
}

function buildDemonSpawn(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  b.sphere(0.26, 0, 0.60, 0, color, 1, 1.25, 0.9);
  b.sphere(0.20, 0, 0.94, 0.04, color);
  // Swept-back horns.
  b.cone(0.06, 0.32, -0.14, 1.08, -0.06, accent, -0.5, 0, 0.5);
  b.cone(0.06, 0.32, 0.14, 1.08, -0.06, accent, -0.5, 0, -0.5);
  b.cone(0.09, 0.20, 0, 0.90, 0.22, accent, Math.PI / 2, 0, 0);
  // Whip tail.
  b.cone(0.07, 0.52, 0, 0.48, -0.34, accent, -1.1, 0, 0);
  return {
    body: b.build(),
    limb: new PartBuilder().cylinder(0.07, 0.06, 0.42, 0, -0.21, 0, accent).build(),
    eyes: eyePair(0.98, 0.18, 0.08, 0.045),
    limbOffset: new THREE.Vector3(0.14, 0.36, 0),
    flapping: false,
    height: 1.25,
  };
}

function buildWarlock(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  // Robe as a broad cone: the silhouette does all the work.
  b.cone(0.34, 0.86, 0, 0.43, 0, color);
  b.sphere(0.17, 0, 0.92, 0.02, color);
  // Hood peak and shoulder mantle.
  b.cone(0.19, 0.26, 0, 1.06, -0.03, accent);
  b.sphere(0.24, 0, 0.82, 0, accent, 1.2, 0.35, 1.2);
  // Staff with a glowing head.
  b.cylinder(0.025, 0.025, 1.05, 0.30, 0.52, 0.05, 0x4a3a28);
  b.sphere(0.075, 0.30, 1.08, 0.05, accent);
  return {
    body: b.build(),
    // Robed feet barely show; a small hem block keeps the gait subtle.
    limb: new PartBuilder().box(0.10, 0.10, 0.16, 0, -0.05, 0, accent).build(),
    eyes: eyePair(0.94, 0.16, 0.06, 0.04),
    limbOffset: new THREE.Vector3(0.09, 0.06, 0),
    flapping: false,
    height: 1.25,
  };
}

function buildBileDemon(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  // Almost entirely belly.
  b.sphere(0.52, 0, 0.56, 0, color, 1.1, 1.0, 1.05);
  b.sphere(0.22, 0, 1.02, 0.10, color);
  // Upward tusks and tiny arms.
  b.cone(0.07, 0.24, -0.13, 1.06, 0.20, accent, -2.4, 0, 0);
  b.cone(0.07, 0.24, 0.13, 1.06, 0.20, accent, -2.4, 0, 0);
  b.cylinder(0.08, 0.07, 0.34, -0.50, 0.68, 0.04, color, 0.4);
  b.cylinder(0.08, 0.07, 0.34, 0.50, 0.68, 0.04, color, 0.4);
  return {
    body: b.build(),
    limb: new PartBuilder().cylinder(0.12, 0.11, 0.26, 0, -0.13, 0, accent).build(),
    eyes: eyePair(1.06, 0.24, 0.09, 0.05),
    limbOffset: new THREE.Vector3(0.22, 0.26, 0),
    flapping: false,
    height: 1.5,
  };
}

function buildDragon(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  b.sphere(0.34, 0, 0.62, 0, color, 1.0, 0.9, 1.5);
  // Neck, head, snout.
  b.cylinder(0.14, 0.18, 0.44, 0, 0.86, 0.34, color, 0.7);
  b.sphere(0.17, 0, 1.02, 0.56, color, 1, 0.9, 1.2);
  b.cone(0.10, 0.26, 0, 0.98, 0.76, accent, Math.PI / 2, 0, 0);
  // Horns and a long tail.
  b.cone(0.05, 0.22, -0.10, 1.14, 0.46, accent, -0.6, 0, 0.3);
  b.cone(0.05, 0.22, 0.10, 1.14, 0.46, accent, -0.6, 0, -0.3);
  b.cone(0.13, 0.86, 0, 0.56, -0.62, color, -1.35, 0, 0);
  // Dorsal ridge.
  b.cone(0.05, 0.16, 0, 0.92, -0.06, accent);
  b.cone(0.05, 0.14, 0, 0.86, -0.30, accent);
  return {
    body: b.build(),
    limb: new PartBuilder()
      .box(0.04, 0.5, 0.70, 0, -0.05, -0.24, accent)
      .cone(0.06, 0.30, 0, 0.22, 0.06, accent, 1.2, 0, 0)
      .build(),
    eyes: eyePair(1.06, 0.66, 0.09, 0.045),
    limbOffset: new THREE.Vector3(0.26, 0.78, -0.06),
    flapping: true,
    height: 1.5,
  };
}

function buildDwarf(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  b.sphere(0.26, 0, 0.44, 0, accent, 1.1, 1.0, 0.9);
  b.sphere(0.18, 0, 0.74, 0.02, color);
  // Beard and helmet — the whole read at a glance.
  b.cone(0.16, 0.30, 0, 0.62, 0.14, 0xe8e0d0, Math.PI, 0, 0);
  b.sphere(0.19, 0, 0.82, 0, 0x8a8f9a, 1, 0.6, 1);
  b.cylinder(0.03, 0.03, 0.52, 0.28, 0.52, 0.10, 0x5a4a3a, 0.3);
  b.box(0.16, 0.16, 0.05, 0.30, 0.80, 0.14, 0x9aa0aa, 0.3);
  return {
    body: b.build(),
    limb: new PartBuilder().cylinder(0.07, 0.06, 0.26, 0, -0.13, 0, accent).build(),
    eyes: eyePair(0.78, 0.16, 0.07, 0.035),
    limbOffset: new THREE.Vector3(0.12, 0.20, 0),
    flapping: false,
    height: 1.0,
  };
}

function buildArcher(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  b.sphere(0.22, 0, 0.62, 0, color, 0.9, 1.2, 0.8);
  b.sphere(0.16, 0, 0.94, 0.02, accent);
  // Hood, quiver and bow.
  b.cone(0.18, 0.24, 0, 1.06, -0.02, color);
  b.cylinder(0.06, 0.06, 0.34, -0.18, 0.72, -0.14, 0x6a5a3a, 0.4);
  b.cylinder(0.015, 0.015, 0.62, 0.26, 0.72, 0.06, 0x7a5a2a, 0, 0, 0.15);
  return {
    body: b.build(),
    limb: new PartBuilder().cylinder(0.055, 0.05, 0.36, 0, -0.18, 0, color).build(),
    eyes: eyePair(0.96, 0.14, 0.06, 0.035),
    limbOffset: new THREE.Vector3(0.11, 0.34, 0),
    flapping: false,
    height: 1.25,
  };
}

function buildKnight(color: number, accent: number): CreatureModel {
  const b = new PartBuilder();
  b.sphere(0.28, 0, 0.66, 0, color, 1.05, 1.25, 0.85);
  b.sphere(0.20, -0.30, 0.92, 0, color);
  b.sphere(0.20, 0.30, 0.92, 0, color);
  // Great helm with a visor slit and a plume.
  b.cylinder(0.17, 0.17, 0.26, 0, 1.08, 0.02, color);
  b.box(0.24, 0.05, 0.04, 0, 1.08, 0.16, 0x101010);
  b.cone(0.07, 0.24, 0, 1.30, -0.02, accent);
  // Sword and shield.
  b.box(0.06, 0.72, 0.03, 0.40, 0.86, 0.08, 0xd8dce4, 0, 0, -0.25);
  b.box(0.34, 0.44, 0.05, -0.38, 0.72, 0.10, accent, 0, 0.3, 0);
  return {
    body: b.build(),
    limb: new PartBuilder().cylinder(0.09, 0.08, 0.34, 0, -0.17, 0, color).build(),
    eyes: eyePair(1.08, 0.16, 0.05, 0.03),
    limbOffset: new THREE.Vector3(0.14, 0.36, 0),
    flapping: false,
    height: 1.55,
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
