import * as THREE from 'three';
import { Terrain, isSolid } from '../core/constants';
import { Survey } from '../core/survey';
import { FLAG_REVEALED, TileMap } from '../core/tilemap';
import { PartBuilder } from './creatureModels';
import { wallTopAt } from './terrain';

/**
 * The dig plan, drawn on the walls.
 *
 * The survey works out what is worth reaching and which blocks reach it; this
 * puts that on the blocks themselves, because the question the player is asking
 * is asked *while looking at a wall*, and any answer that lives in a panel is an
 * answer they have to translate back onto the wall themselves.
 *
 * Two things are drawn, and only two, because a plan that covers the map in
 * markers is the same as no plan:
 *
 *   - Wedges along the blocks to dig, sitting on top of them, in the colour of
 *     whatever they lead to — the same colours the compass uses at the screen
 *     edge, so "follow the cyan" is one instruction and not two.
 *   - A bigger arrow at the frontier, where the plan runs out of ground you have
 *     seen, pointing at the next step. That is the whole "keep heading that way"
 *     and it is deliberately the only thing said about the unexplored map.
 *
 * Seams get a slowly turning marker over them, gold or gem-coloured. A seam is
 * marked once no matter how many tiles it spans: a fourteen-tile vein with
 * fourteen markers on it reads as a hazard, not a prize.
 */

/** Cap on route wedges. A plan longer than this is not a plan, it is a map. */
const MAX_MARKS = 240;

/** Cap on seam markers, richest first. */
const MAX_SEAMS = 14;

/** How far past the frontier the onward arrow floats. */
const ONWARD_REACH = 0.55;

/** A wedge pointing along +Z, built white so instance colour can tint it. */
function buildWedge(): THREE.BufferGeometry {
  const b = new PartBuilder();
  const edge = 0x8899aa;
  const core = 0xffffff;
  for (const s of [-1, 1]) {
    b.box(0.66, 0.07, 0.20, s * 0.19, 0, -0.05, edge, 0, s * 0.62, 0);
    b.box(0.44, 0.07, 0.10, s * 0.16, 0.02, 0.0, core, 0, s * 0.62, 0);
  }
  return b.build();
}

/** A fatter, taller version of the same shape, for the frontier. */
function buildOnward(): THREE.BufferGeometry {
  const b = new PartBuilder();
  const edge = 0x8899aa;
  const core = 0xffffff;
  for (const s of [-1, 1]) {
    b.box(0.96, 0.09, 0.30, s * 0.28, 0, -0.07, edge, 0, s * 0.62, 0);
    b.box(0.64, 0.09, 0.15, s * 0.24, 0.03, 0.0, core, 0, s * 0.62, 0);
  }
  return b.build();
}

/**
 * A seam marker: a plate set into the top of the block, not a thing above it.
 *
 * It used to be a fat crystal on a stem, floating half a tile over the rock and
 * bobbing. That is a lamp, not a label — eight of them hanging in the air around
 * the starting dungeon, bright enough to pull the eye off everything, and each
 * one occluding the very rock it was supposed to be telling you about. An
 * overlay that hides the thing it annotates has got the job exactly backwards.
 *
 * Flat, low and lying on the stone, it reads as a surveyor's mark chalked on the
 * block: still unmistakable from directly above, which is the only angle this
 * camera has, and it covers a fifth of what it did.
 */
function buildSeamMark(): THREE.BufferGeometry {
  const b = new PartBuilder();
  // A diamond plate with a rim, and a small faceted stone set in the middle.
  b.box(0.34, 0.020, 0.34, 0, 0.010, 0, 0x7d8590, 0, Math.PI / 4, 0);
  b.box(0.22, 0.026, 0.22, 0, 0.026, 0, 0xffffff, 0, Math.PI / 4, 0);
  b.sphere(0.070, 0, 0.048, 0, 0xffffff, 1, 0.62, 1, 5);
  return b.build();
}

export class SurveyView {
  readonly group = new THREE.Group();

  private readonly map: TileMap;
  private readonly marks: THREE.InstancedMesh;
  private readonly onward: THREE.InstancedMesh;
  private readonly seamMarks: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly dummy = new THREE.Object3D();
  private readonly colour = new THREE.Color();

  private markCount = 0;
  private onwardCount = 0;
  private seamCount = 0;
  /** Where each frontier arrow sits and which way it points, for the pulse. */
  private onwardAt: Array<{ x: number; y: number; z: number; yaw: number }> = [];
  private seamAt: Array<{ x: number; y: number; z: number }> = [];
  private lastVersion = -1;

  constructor(map: TileMap) {
    this.map = map;
    // Unlit: a plan is drawn *on* the world, not lit by it, and it has to stay
    // readable over rock that ranges from firelit to nearly black.
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });

    this.marks = this.makeMesh(buildWedge(), MAX_MARKS);
    this.onward = this.makeMesh(buildOnward(), 8);
    this.seamMarks = this.makeMesh(buildSeamMark(), MAX_SEAMS);
    this.group.add(this.marks, this.onward, this.seamMarks);
  }

  private makeMesh(geometry: THREE.BufferGeometry, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }

  setEnabled(on: boolean): void {
    this.group.visible = on;
  }

  get enabled(): boolean {
    return this.group.visible;
  }

  /** Re-plan when the dungeon changes shape. */
  syncIfDirty(survey: Survey): boolean {
    if (survey.version === this.lastVersion) return false;
    this.lastVersion = survey.version;
    this.rebuild(survey);
    return true;
  }

  /**
   * A marker's height: on this block's own top, or just off the floor.
   *
   * Every block is a slightly different height, so a fixed number put half the
   * markers inside the rock and left the other half hovering. Asking the terrain
   * is the only way these stay put, and it means the dig tag — which sits higher
   * again — reliably clears them.
   */
  private heightAt(tile: number): number {
    const terrain = this.map.terrain[tile] as Terrain;
    if (!isSolid(terrain)) return 0.06;
    return wallTopAt(this.map, tile) + 0.02;
  }

  private rebuild(survey: Survey): void {
    const { map, dummy, colour } = this;
    this.markCount = 0;
    this.onwardCount = 0;
    this.onwardAt = [];

    for (const route of survey.routes) {
      const { path, known } = route;
      colour.setHex(route.colour);

      /*
       * Start at the first block that actually has to be dug.
       *
       * The route begins on ground the keeper already holds, and wedges laid
       * along a corridor you have walked a hundred times answer nothing while
       * competing with the hero lane drawn on the same floor. What is wanted is
       * the point where the plan meets rock, and everything from there on.
       */
      let start = 0;
      while (start < path.length && !isSolid(map.terrain[path[start]] as Terrain)) start++;
      if (start >= path.length) continue;
      // One tile of run-up, so the first wedge reads as leading into the wall
      // rather than as a marker stuck on it.
      start = Math.max(0, start - 1);

      /*
       * Every revealed tile of the route, not just the unbroken run of them.
       *
       * Stopping at the first unseen tile threw away everything past it, and a
       * route dips in and out of explored ground constantly — so a plan that
       * crossed a corridor you had already dug went dark the moment it clipped
       * one unseen corner, which is when it was most useful. Skipping the unseen
       * ones instead reveals nothing extra and draws far more of the plan.
       */
      for (let i = start; i < path.length - 1; i++) {
        if (this.markCount >= MAX_MARKS) break;
        const tile = path[i], next = path[i + 1];
        if ((map.flags[tile] & FLAG_REVEALED) === 0) continue;
        const x = map.xOf(tile), y = map.yOf(tile);
        dummy.position.set(x, this.heightAt(tile), y);
        dummy.rotation.set(0, Math.atan2(map.xOf(next) - x, map.yOf(next) - y), 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        this.marks.setMatrixAt(this.markCount, dummy.matrix);
        this.marks.setColorAt(this.markCount, colour);
        this.markCount++;
      }

      /*
       * The frontier arrow: the one thing said about ground you have not seen.
       *
       * It sits on the last tile you *have* seen, pointing at the next step of a
       * route planned through rock you have not. That is a bearing and nothing
       * more — no layout, no distance, no idea what is between here and there —
       * and it is the difference between digging with a plan and digging at
       * random, which is the whole reason any of this exists.
       */
      if (known > 0 && known < path.length && this.onwardCount < 8) {
        const here = path[known - 1], beyond = path[known];
        const x = map.xOf(here), y = map.yOf(here);
        const yaw = Math.atan2(map.xOf(beyond) - x, map.yOf(beyond) - y);
        this.onwardAt.push({
          x: x + Math.sin(yaw) * ONWARD_REACH,
          y: y + Math.cos(yaw) * ONWARD_REACH,
          z: this.heightAt(here) + 0.12,
          yaw,
        });
        this.onward.setColorAt(this.onwardCount, colour);
        this.onwardCount++;
      }
    }

    this.seamCount = 0;
    this.seamAt = [];
    for (const seam of survey.seams) {
      if (this.seamCount >= MAX_SEAMS) break;
      const tile = seam.tile;
      // Pulled back from the old near-white gold: a mark, not a beacon.
      colour.setHex(seam.gems ? 0x63c6dd : 0xd8a232);
      this.seamAt.push({
        // Just clear of the block's own top face, so it sits on the stone.
        x: map.xOf(tile), y: map.yOf(tile), z: this.heightAt(tile),
      });
      this.seamMarks.setColorAt(this.seamCount, colour);
      this.seamCount++;
    }

    this.marks.count = this.markCount;
    this.onward.count = this.onwardCount;
    this.seamMarks.count = this.seamCount;
    for (const mesh of [this.marks, this.onward, this.seamMarks]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Breathe the frontier arrows and turn the seam markers. */
  update(time: number): void {
    if (!this.group.visible) return;
    const { dummy } = this;

    for (let i = 0; i < this.onwardCount; i++) {
      const at = this.onwardAt[i];
      // Nudged along its own heading as it pulses, so it reads as pointing
      // somewhere rather than as sitting there getting bigger.
      const beat = 0.5 + 0.5 * Math.sin(time * 2.4 + i);
      dummy.position.set(
        at.x + Math.sin(at.yaw) * beat * 0.16,
        at.z + beat * 0.05,
        at.y + Math.cos(at.yaw) * beat * 0.16,
      );
      dummy.rotation.set(0, at.yaw, 0);
      dummy.scale.setScalar(1 + beat * 0.14);
      dummy.updateMatrix();
      this.onward.setMatrixAt(i, dummy.matrix);
    }
    if (this.onwardCount > 0) this.onward.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < this.seamCount; i++) {
      const at = this.seamAt[i];
      // No bob. A mark on a rock does not hover, and the movement was half of
      // why these were distracting rather than informative.
      dummy.position.set(at.x, at.z, at.y);
      dummy.rotation.set(0, time * 0.35 + i, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      this.seamMarks.setMatrixAt(i, dummy.matrix);
    }
    if (this.seamCount > 0) this.seamMarks.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.marks.geometry.dispose();
    this.onward.geometry.dispose();
    this.seamMarks.geometry.dispose();
    this.material.dispose();
  }
}
