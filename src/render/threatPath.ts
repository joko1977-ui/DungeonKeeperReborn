import * as THREE from 'three';
import { Owner, RoomType, isDiggable, isWalkable } from '../core/constants';
import { PathFinder } from '../core/pathfinding';
import { RoomIndex, heartTile } from '../core/rooms';
import { FLAG_REVEALED, TileMap } from '../core/tilemap';
import { PartBuilder } from './creatureModels';

/**
 * The road the heroes will walk, drawn on the floor.
 *
 * This game has a tower-defence half and until now it was invisible. Everything
 * needed for it was already in the simulation — a hero gate, parties that march on
 * your heart, traps and doors you can build and a workshop that manufactures them
 * — and none of it added up to a decision the player could make, because the one
 * fact the whole layer turns on was hidden: *which way are they coming*.
 *
 * Without it you cannot site a trap. A corridor might be the front door or a
 * dead end and the game gave you no way to tell, so traps went down at random,
 * heroes walked round them, and the entire defensive half of the game read as
 * decoration. Tower defence is not about having traps; it is about knowing where
 * the lane is.
 *
 * So the lane is drawn. Chevrons along the exact route a hero takes from the gate
 * to your heart — the same path, from the same pathfinder, that the AI will
 * actually follow — pointing the way they will come. Dig a new corridor and the
 * route re-plans and the arrows move; wall one off and they swing round to the
 * next way in. It turns "where do I put this" into something you can answer by
 * looking, and it makes a door you have just hung visibly *matter*.
 */

/** Cap on drawn markers: a long route is still only so useful to see. */
const MAX_MARKERS = 260;

/** Only mark every other tile — a solid line of arrows reads as a wall. */
const MARKER_STRIDE = 2;

/** A flat chevron lying on the floor, pointing along +Z. */
function buildChevron(): THREE.BufferGeometry {
  const b = new PartBuilder();
  const warn = 0xff5a3a;
  const core = 0xffb070;
  // Two arms meeting at a point, plus a brighter inner pair so the marker has an
  // edge and a core rather than being one flat lozenge.
  // Sized to be read at playing distance, which is a good deal larger than it
  // feels while building one: at half this size the lane was two orange specks
  // beside the heart and answered nobody's question.
  for (const s of [-1, 1]) {
    b.box(0.52, 0.03, 0.15, s * 0.15, 0.012, -0.04, warn, 0, s * 0.62, 0);
    b.box(0.34, 0.03, 0.075, s * 0.125, 0.02, 0.0, core, 0, s * 0.62, 0);
  }
  return b.build();
}

export class ThreatPath {
  readonly group = new THREE.Group();

  private readonly map: TileMap;
  private readonly rooms: RoomIndex;
  private readonly finder: PathFinder;
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly dummy = new THREE.Object3D();
  private lastVersion = -1;
  private count = 0;

  constructor(map: TileMap, rooms: RoomIndex) {
    this.map = map;
    this.rooms = rooms;
    // Its own pathfinder rather than the simulation's: this runs on the render
    // side and must never perturb the state the AI is using mid-tick.
    this.finder = new PathFinder(map);

    // Unlit and additive. A warning marker is a thing drawn *on* the world rather
    // than a thing in it, so it should not take the dungeon's lighting — and it
    // has to stay legible on a floor that ranges from near-black to firelit.
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(buildChevron(), this.material, MAX_MARKERS);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.mesh);
  }

  /** Re-plan when the dungeon changes shape. */
  syncIfDirty(): boolean {
    if (this.map.version === this.lastVersion) return false;
    this.lastVersion = this.map.version;
    this.rebuild();
    return true;
  }

  private rebuild(): void {
    const { map, dummy } = this;
    this.count = 0;

    const heart = heartTile(map, this.rooms, Owner.Player);
    // One route per hero gate, not per gate *tile*: a three-by-three gate is one
    // door, and nine overlapping copies of the same lane is just a brighter lane.
    const gates = this.clusterGates(this.rooms.tilesOf(map, Owner.Heroes, RoomType.Portal));
    if (heart < 0 || gates.length === 0) {
      this.mesh.count = 0;
      return;
    }

    for (const gate of gates) {
      if (this.count >= MAX_MARKERS) break;
      /*
       * Walk if you can, tunnel if you must — and in that order.
       *
       * At the start of a level there is no walkable route at all: your dungeon is
       * sealed inside the rock and the hero gate is somewhere on the far side of
       * it, which is why the first version of this drew nothing for the entire
       * opening. But heroes bring sappers and dig through, so "no path" is not the
       * answer to the question the player is asking. The answer is the line they
       * will come along, whether that is a corridor or a hole they make.
       *
       * Two attempts in priority order, because the difference between them is the
       * whole point. While the rock holds, the lane shows the shortest way *in* —
       * dig near it at your peril. The moment you cut a corridor that reaches the
       * hero side, the walkable route exists, the lane snaps onto it, and you can
       * see you have just opened your own front door.
       */
      const path = this.finder.find(
        map.xOf(gate), map.yOf(gate), map.xOf(heart), map.yOf(heart),
        (x, y) => isWalkable(map.terrainAt(x, y)),
      ) ?? this.finder.find(
        map.xOf(gate), map.yOf(gate), map.xOf(heart), map.yOf(heart),
        (x, y) => isWalkable(map.terrainAt(x, y)) || isDiggable(map.terrainAt(x, y)),
      );
      if (!path) continue;

      for (let i = 0; i < path.length - 1; i += MARKER_STRIDE) {
        if (this.count >= MAX_MARKERS) break;
        const tile = path[i];
        // Only on ground you have seen. Tracing a route through undiscovered rock
        // would hand you the map, which is the one thing exploring is for.
        if ((map.flags[tile] & FLAG_REVEALED) === 0) continue;

        const next = path[Math.min(i + 1, path.length - 1)];
        const x = map.xOf(tile), y = map.yOf(tile);
        const heading = Math.atan2(map.xOf(next) - x, map.yOf(next) - y);

        dummy.position.set(x, 0.03, y);
        dummy.rotation.set(0, heading, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        this.mesh.setMatrixAt(this.count++, dummy.matrix);
      }
    }

    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
  }

  /** Collapse touching gate tiles into one representative tile each. */
  private clusterGates(tiles: number[]): number[] {
    const map = this.map;
    const seen = new Set<number>();
    const heads: number[] = [];
    for (const tile of tiles) {
      if (seen.has(tile)) continue;
      const stack = [tile];
      seen.add(tile);
      let sx = 0, sy = 0, n = 0, best = tile, bestD = Infinity;
      while (stack.length > 0) {
        const t = stack.pop()!;
        const x = map.xOf(t), y = map.yOf(t);
        sx += x; sy += y; n++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (!map.inBounds(nx, ny)) continue;
          const ni = map.idx(nx, ny);
          if (seen.has(ni) || !tiles.includes(ni)) continue;
          seen.add(ni);
          stack.push(ni);
        }
      }
      // The tile nearest the cluster's middle, so the lane starts at the doorway.
      const cx = sx / n, cy = sy / n;
      for (const t of tiles) {
        if (!seen.has(t)) continue;
        const d = (map.xOf(t) - cx) ** 2 + (map.yOf(t) - cy) ** 2;
        if (d < bestD) { bestD = d; best = t; }
      }
      heads.push(best);
    }
    return heads;
  }

  /**
   * Breathe, and brighten as a wave gets close.
   *
   * The lane is a standing feature of the map, so most of the time it sits at the
   * edge of noticeable. It has to become urgent on its own when the raid is due,
   * because that is the moment the player needs to look at it — and the moment
   * they still have time to do something about it.
   */
  update(time: number, waveImminence: number): void {
    if (this.count === 0) return;
    const urgency = Math.max(0, Math.min(1, waveImminence));
    const pulse = 0.5 + 0.5 * Math.sin(time * (1.4 + urgency * 4));
    this.material.opacity = 0.42 + urgency * 0.34 + pulse * (0.10 + urgency * 0.2);
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
