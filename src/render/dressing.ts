import * as THREE from 'three';
import { Owner, RoomType, Terrain, isSolid } from '../core/constants';
import { FLAG_REVEALED, TileMap } from '../core/tilemap';
import { PartBuilder } from './creatureModels';
import { celRamp } from './celRamp';
import { WALL_HEIGHT } from './terrain';

/**
 * The things that are in a cave besides the cave.
 *
 * Every surface in the dungeon had been redrawn by this point and it still read
 * as sparse, for a reason no amount of shading was going to fix: the *geometry*
 * was a grid of identical boxes on a flat plane. A tiled floor and a wall of cubes
 * is the silhouette of a 1980s dungeon crawler however beautifully it is lit,
 * because the thing a modern scene has and that one does not is stuff — rock that
 * has fallen, rock that has grown, and the debris of whatever lived there.
 *
 * So: rubble heaped where walls meet floor, crests of rock along the tops of the
 * walls you can actually see, stalagmites, cave mushrooms and the odd skull. None
 * of it is interactive and none of it is in the simulation; it exists to break
 * straight lines and give the eye something to travel over.
 *
 * ## Kept affordable by only dressing what shows
 *
 * The naive version — richer geometry on the wall mesh itself — costs the extra
 * vertices on every wall in the map, and most walls are buried inside a slab where
 * nothing can see them. Crests go only on walls with a floor tile beside them,
 * which is a fifth of them; clutter goes only on revealed floor, thinned by a hash
 * so it scatters rather than tiles. Each category is one instanced draw with a
 * hard cap, and the whole system rebuilds only when the map changes.
 */

/** Per-tile deterministic randomness, so a dungeon dresses itself the same twice. */
function tileRandom(tile: number, salt: number): number {
  let t = (tile * 2654435761) ^ (salt * 1597334677);
  t = Math.imul(t ^ (t >>> 13), 1274126177);
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

/*
 * Budgets. Generous enough to fill a dungeon, small enough that the worst case is
 * bounded — a fully-excavated 72x72 map must not be able to spawn forty thousand
 * pebbles.
 */
const MAX_CREST = 1400;
const MAX_RUBBLE = 900;
const MAX_SPIRE = 260;
const MAX_FLORA = 320;
const MAX_BONES = 120;

/*
 * Stone, light enough to be stone.
 *
 * First cut used the basalt values from the wall *texture* — around 0x2a2f3a —
 * on the reasoning that a rock is made of the same thing the wall is. On screen
 * they came out as black blobs stuck to the wall tops, because the wall you are
 * comparing them against is not its albedo: it is that albedo lit by firelight
 * and posterised up into the pale end of the ramp. A prop has to be keyed to the
 * *rendered* value of what it sits on, not to the material it is cut from.
 */
const ROCK_DARK = 0x6a6a66;
const ROCK_MID = 0x83817a;
const ROCK_LIT = 0x9c9990;

/**
 * A cluster of angular rocks, sized to sit on top of a wall block.
 *
 * The most valuable of these by a distance, because of where the camera is: it
 * looks down, so the top of a wall is the largest surface in the frame, and until
 * now every one of them was a flat square. Three lumps at different sizes and
 * angles is enough to break the grid — the eye reads a rocky ridge rather than a
 * row of tiles.
 *
 * Built from tilted boxes rather than spheres, for two reasons. Broken stone has
 * flat faces and hard arrises, which is what a box is and what a sphere is not.
 * And it is a twentieth of the vertices: the resolution floor that keeps creature
 * geometry smooth would have given each of these a few hundred, times fourteen
 * hundred instances, for a rock the size of a thumbnail.
 */
function buildCrest(): THREE.BufferGeometry {
  const b = new PartBuilder();
  /*
   * Broad slabs, not boulders.
   *
   * The first version was three thumb-sized rocks standing on the block, which
   * from a camera looking almost straight down is exactly what it sounds like:
   * litter on a table. What breaks a grid of squares seen from above is not
   * objects placed on the squares, it is the squares no longer being square — so
   * these are wide, low and turned off-axis, overhanging the edges enough to spoil
   * the outline, and they read as the wall's own broken crest.
   */
  const slabs: Array<[number, number, number, number, number, number, number, number]> = [
    // x, y, z, w, h, d, yaw, colour
    [0.02, 0.05, -0.03, 0.86, 0.11, 0.72, 0.22, ROCK_MID],
    [-0.14, 0.11, 0.12, 0.54, 0.10, 0.58, -0.45, ROCK_LIT],
    [0.20, 0.09, -0.18, 0.44, 0.09, 0.40, 0.75, ROCK_DARK],
  ];
  for (const [x, y, z, w, h, d, yaw, colour] of slabs) {
    b.box(w, h, d, x, y, z, colour, 0.04, yaw, 0.03);
  }
  return b.build();
}

/** A heap of small stones and grit, for the foot of a wall. */
function buildRubble(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.box(0.30, 0.09, 0.22, 0, 0.04, 0, ROCK_DARK, 0.1, 0.3, 0.05);
  b.box(0.15, 0.11, 0.13, -0.09, 0.07, 0.04, ROCK_MID, -0.2, 1.1, 0.25);
  b.box(0.11, 0.09, 0.10, 0.10, 0.06, -0.04, ROCK_MID, 0.3, 2.0, -0.2);
  b.box(0.07, 0.06, 0.07, 0.02, 0.10, 0.07, ROCK_LIT, 0.5, 0.7, 0.4);
  return b.build();
}

/** A stalagmite, and the drip that made it. */
function buildSpire(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.cone(0.11, 0.36, 0, 0.18, 0, ROCK_MID, 0, 0.4, 0.06, 5);
  b.cone(0.055, 0.20, 0.055, 0.31, 0.03, ROCK_LIT, 0, 0, -0.22, 5);
  b.box(0.28, 0.07, 0.24, 0, 0.03, 0, ROCK_DARK, 0, 0.6, 0);
  return b.build();
}

/** Cave mushrooms: a cluster of caps on pale stalks, faintly luminous. */
function buildFlora(): THREE.BufferGeometry {
  const b = new PartBuilder();
  const stalk = 0x9aa88c;
  const cap = 0x7fd4a8;
  const caps: Array<[number, number, number]> = [
    [0, 0.16, 0.075], [-0.09, 0.11, 0.055], [0.08, 0.09, 0.045],
  ];
  for (const [x, h, r] of caps) {
    b.cylinder(r * 0.34, r * 0.42, h, x, h * 0.5, 0, stalk, 0, 0, 0, 6);
    b.sphere(r, x, h, 0, cap, 1.25, 0.7, 1.25, 7);
    b.sphere(r * 0.55, x, h + r * 0.28, 0, 0xbdf0d4, 1.1, 0.4, 1.1, 6);
  }
  return b.build();
}

/** A skull and a couple of ribs. Somebody else got here first. */
function buildBones(): THREE.BufferGeometry {
  const b = new PartBuilder();
  const bone = 0xcfc7ae;
  b.sphere(0.075, 0, 0.06, 0, bone, 1.0, 0.9, 1.1, 7);
  b.sphere(0.05, 0, 0.04, 0.07, bone, 1.1, 0.7, 0.9, 6);
  // Eye sockets, which is the whole reason a skull reads as a skull.
  b.sphere(0.022, -0.03, 0.075, 0.075, 0x14100c, 1, 1, 1, 5);
  b.sphere(0.022, 0.03, 0.075, 0.075, 0x14100c, 1, 1, 1, 5);
  for (let i = 0; i < 3; i++) {
    b.capsule(0.012, 0.10, -0.14 - i * 0.05, 0.015, 0.02 * i, bone, 0, 0.4 + i * 0.3, 1.4, 5);
  }
  return b.build();
}

interface Batch {
  mesh: THREE.InstancedMesh;
  max: number;
}

export class DungeonDressing {
  readonly group = new THREE.Group();

  private readonly map: TileMap;
  private readonly material: THREE.MeshToonMaterial;
  private readonly floraMaterial: THREE.MeshToonMaterial;
  private readonly crest: Batch;
  private readonly rubble: Batch;
  private readonly spire: Batch;
  private readonly flora: Batch;
  private readonly bones: Batch;
  private readonly dummy = new THREE.Object3D();
  private lastVersion = -1;

  constructor(map: TileMap) {
    this.map = map;
    this.material = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: celRamp(),
    });
    // Mushrooms are the one cool light in a dungeon lit entirely by fire, which
    // is exactly why they are worth having: a small patch of green-blue is what
    // makes the surrounding orange read as orange.
    this.floraMaterial = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: celRamp(),
      emissive: new THREE.Color(0x2f7a55),
      emissiveIntensity: 0.7,
    });

    this.crest = this.batch(buildCrest(), MAX_CREST, this.material);
    this.rubble = this.batch(buildRubble(), MAX_RUBBLE, this.material);
    this.spire = this.batch(buildSpire(), MAX_SPIRE, this.material);
    this.flora = this.batch(buildFlora(), MAX_FLORA, this.floraMaterial);
    this.bones = this.batch(buildBones(), MAX_BONES, this.material);
  }

  private batch(
    geometry: THREE.BufferGeometry, max: number, material: THREE.Material,
  ): Batch {
    const mesh = new THREE.InstancedMesh(geometry, material, max);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(mesh);
    return { mesh, max };
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
    let crestN = 0, rubbleN = 0, spireN = 0, floraN = 0, bonesN = 0;

    for (let i = 0; i < map.terrain.length; i++) {
      if ((map.flags[i] & FLAG_REVEALED) === 0) continue;
      const terrain = map.terrain[i] as Terrain;
      const x = map.xOf(i), y = map.yOf(i);

      if (isSolid(terrain)) {
        // Crests only on walls something can see: a block buried in the middle of
        // a slab is paying for geometry nobody will ever look at.
        if (terrain === Terrain.Rock) continue;
        if (crestN >= this.crest.max) continue;
        if (!this.hasFloorNeighbour(x, y)) continue;
        if (tileRandom(i, 1) > 0.62) continue;

        const h = map.terrain[i] === Terrain.Wall ? 1 : 0.92 + tileRandom(i, 2) * 0.16;
        dummy.position.set(
          x + (tileRandom(i, 3) - 0.5) * 0.13,
          WALL_HEIGHT * h - 0.07,
          y + (tileRandom(i, 4) - 0.5) * 0.13,
        );
        dummy.rotation.set(0, tileRandom(i, 5) * Math.PI * 2, 0);
        const s = 0.86 + tileRandom(i, 6) * 0.3;
        dummy.scale.set(s, 0.7 + tileRandom(i, 7) * 0.8, s);
        dummy.updateMatrix();
        this.crest.mesh.setMatrixAt(crestN++, dummy.matrix);
        continue;
      }

      // Floors. Nothing is dressed inside a built room — furniture lives there,
      // and a skull in the middle of somebody's treasury reads as a bug.
      if (map.room[i] !== RoomType.None) continue;
      const wallSide = this.wallDirection(x, y);
      const claimed = map.owner[i] !== Owner.None;

      if (wallSide && rubbleN < this.rubble.max && tileRandom(i, 8) > 0.45) {
        // Pushed toward the wall it fell from, not centred on the tile.
        dummy.position.set(
          x + wallSide[0] * (0.30 + tileRandom(i, 9) * 0.10),
          0,
          y + wallSide[1] * (0.30 + tileRandom(i, 10) * 0.10),
        );
        dummy.rotation.set(0, tileRandom(i, 11) * Math.PI * 2, 0);
        const s = 0.7 + tileRandom(i, 12) * 0.6;
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        this.rubble.mesh.setMatrixAt(rubbleN++, dummy.matrix);
      }

      // The rest is cave, and a keeper's polished floor should not have any of it.
      if (claimed) continue;

      if (spireN < this.spire.max && tileRandom(i, 13) > 0.88) {
        dummy.position.set(x + (tileRandom(i, 14) - 0.5) * 0.5, 0,
          y + (tileRandom(i, 15) - 0.5) * 0.5);
        dummy.rotation.set(0, tileRandom(i, 16) * Math.PI * 2, 0);
        const s = 0.7 + tileRandom(i, 17) * 0.75;
        dummy.scale.set(s, s * (0.8 + tileRandom(i, 18) * 0.9), s);
        dummy.updateMatrix();
        this.spire.mesh.setMatrixAt(spireN++, dummy.matrix);
      } else if (floraN < this.flora.max && wallSide && tileRandom(i, 19) > 0.86) {
        // Mushrooms grow against something, the way they do.
        dummy.position.set(x + wallSide[0] * 0.28, 0, y + wallSide[1] * 0.28);
        dummy.rotation.set(0, tileRandom(i, 20) * Math.PI * 2, 0);
        const s = 0.75 + tileRandom(i, 21) * 0.5;
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        this.flora.mesh.setMatrixAt(floraN++, dummy.matrix);
      } else if (bonesN < this.bones.max && tileRandom(i, 22) > 0.965) {
        dummy.position.set(x + (tileRandom(i, 23) - 0.5) * 0.4, 0,
          y + (tileRandom(i, 24) - 0.5) * 0.4);
        dummy.rotation.set(0, tileRandom(i, 25) * Math.PI * 2, 0);
        dummy.scale.setScalar(0.9 + tileRandom(i, 26) * 0.4);
        dummy.updateMatrix();
        this.bones.mesh.setMatrixAt(bonesN++, dummy.matrix);
      }
    }

    for (const [batch, n] of [
      [this.crest, crestN], [this.rubble, rubbleN], [this.spire, spireN],
      [this.flora, floraN], [this.bones, bonesN],
    ] as Array<[Batch, number]>) {
      batch.mesh.count = n;
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.mesh.computeBoundingSphere();
    }
  }

  private hasFloorNeighbour(x: number, y: number): boolean {
    return !this.map.isSolidAt(x - 1, y) || !this.map.isSolidAt(x + 1, y)
      || !this.map.isSolidAt(x, y - 1) || !this.map.isSolidAt(x, y + 1);
  }

  /** Unit direction toward an adjacent wall, or null if the tile is open. */
  private wallDirection(x: number, y: number): [number, number] | null {
    const map = this.map;
    if (map.isSolidAt(x - 1, y)) return [-1, 0];
    if (map.isSolidAt(x + 1, y)) return [1, 0];
    if (map.isSolidAt(x, y - 1)) return [0, -1];
    if (map.isSolidAt(x, y + 1)) return [0, 1];
    return null;
  }

  /** Thin the dressing out when the frame budget is tight. */
  setDensity(fraction: number): void {
    const f = Math.max(0, Math.min(1, fraction));
    this.spire.mesh.visible = f > 0.3;
    this.rubble.mesh.visible = f > 0.5;
    this.flora.mesh.visible = f > 0.6;
    this.bones.mesh.visible = f > 0.75;
    // Crests stay longest: they are what stops the walls being cubes.
    this.crest.mesh.visible = f > 0.15;
  }

  dispose(): void {
    for (const b of [this.crest, this.rubble, this.spire, this.flora, this.bones]) {
      b.mesh.geometry.dispose();
    }
    this.material.dispose();
    this.floraMaterial.dispose();
  }
}
