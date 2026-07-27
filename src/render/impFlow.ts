import * as THREE from 'three';
import { CREATURE_SPECS, Creature, CreatureState } from '../core/creatures';
import { Owner } from '../core/constants';
import { TileMap } from '../core/tilemap';
import { PartBuilder } from './creatureModels';

/**
 * Where the workforce is going, drawn as traffic.
 *
 * The dig plan says which walls are worth cutting through and the badges say
 * what each creature is doing, and between them there was still no answer to the
 * question a player actually asks after tagging a slab: *are they on their way?*
 * An imp is a small shape a long way off. Watching one long enough to work out
 * whether it is heading for your new order or wandering to a heap in the far
 * corner is not something anyone should have to do.
 *
 * So the routes themselves are drawn. Every imp already has a path — the same
 * one the simulation is walking it down — and this puts arrows on the remaining
 * part of it, sliding along toward wherever it is going. Several imps converging
 * on one wall then reads instantly as a work gang, and a dungeon whose arrows
 * all point somewhere you did not ask for is telling you your order was
 * unreachable before you have waited two minutes to find out.
 *
 * The arrows *move*, which is the whole reason this reads as flow rather than as
 * a second set of route markers: they are placed by arc length along the path and
 * that length scrolls with the clock, so they travel the way the imp does.
 */

/** Cap on arrows. A dungeon's whole workforce is well inside this. */
const MAX_ARROWS = 320;

/** World units between arrows along a route. */
const SPACING = 1.35;

/** How fast the arrows slide along, in tiles a second. */
const FLOW_SPEED = 2.6;

/** Height above the floor. Low: this is traffic, not signage. */
const FLOW_Y = 0.05;

/** An arrowhead pointing along +Z, built white so instances can tint it. */
function buildArrow(): THREE.BufferGeometry {
  const b = new PartBuilder();
  for (const s of [-1, 1]) {
    b.box(0.30, 0.035, 0.10, s * 0.085, 0, -0.02, 0x9fdcb4, 0, s * 0.66, 0);
    b.box(0.19, 0.035, 0.05, s * 0.072, 0.010, 0.0, 0xffffff, 0, s * 0.66, 0);
  }
  return b.build();
}

export class ImpFlow {
  readonly group = new THREE.Group();

  private readonly map: TileMap;
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly dummy = new THREE.Object3D();
  private readonly colour = new THREE.Color();
  /** Scratch for one creature's remaining route, reused every frame. */
  private readonly px: number[] = [];
  private readonly pz: number[] = [];

  constructor(map: TileMap) {
    this.map = map;
    // Unlit and additive, like the other lane markers: this is drawn on the
    // world rather than lit by it, and has to stay legible on a floor that runs
    // from firelit to nearly black.
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(buildArrow(), this.material, MAX_ARROWS);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 3;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(MAX_ARROWS * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.mesh);
  }

  setEnabled(on: boolean): void {
    this.group.visible = on;
  }

  update(creatures: readonly Creature[], time: number): void {
    if (!this.group.visible) return;
    const { map, dummy, colour } = this;
    let n = 0;

    for (const c of creatures) {
      if (n >= MAX_ARROWS) break;
      if (c.owner !== Owner.Player || c.inHand) continue;
      // Workers only. Every creature has a path, but the question this answers
      // is about the dig, and arrows over a troll strolling to its lair would
      // bury the ones that matter.
      if (!CREATURE_SPECS[c.type].worker) continue;
      if (!c.path || c.pathIndex >= c.path.length) continue;
      if (c.state === CreatureState.Dying || c.state === CreatureState.Fleeing) continue;

      // The route it has left, starting from where it actually is rather than
      // from the tile it last stood on.
      const { px, pz } = this;
      px.length = 0;
      pz.length = 0;
      px.push(c.x);
      pz.push(c.y);
      for (let k = c.pathIndex; k < c.path.length; k++) {
        px.push(map.xOf(c.path[k]));
        pz.push(map.yOf(c.path[k]));
      }
      if (px.length < 2) continue;

      let total = 0;
      for (let k = 1; k < px.length; k++) total += Math.hypot(px[k] - px[k - 1], pz[k] - pz[k - 1]);
      if (total < 0.4) continue;

      /*
       * Hauling reads warm, digging reads cool.
       *
       * The two errands an imp runs are opposites — one is bringing money home
       * and one is going out to cut rock — and a single colour for both throws
       * away the only interesting thing about a busy dungeon, which is how much
       * of the traffic is going each way.
       */
      const carrying = c.goldHeld > 0;
      colour.setHex(carrying ? 0xffcf6a : 0x7fe3a8);

      // Arrows are laid out by distance along the route and that distance
      // scrolls, so they travel rather than sit.
      const drift = (time * FLOW_SPEED) % SPACING;
      let seg = 1;
      let walked = Math.hypot(px[1] - px[0], pz[1] - pz[0]);
      for (let s = drift; s < total && n < MAX_ARROWS; s += SPACING) {
        while (walked < s && seg < px.length - 1) {
          seg++;
          walked += Math.hypot(px[seg] - px[seg - 1], pz[seg] - pz[seg - 1]);
        }
        const segLen = Math.hypot(px[seg] - px[seg - 1], pz[seg] - pz[seg - 1]) || 1;
        const t = 1 - (walked - s) / segLen;
        const ax = px[seg - 1] + (px[seg] - px[seg - 1]) * t;
        const az = pz[seg - 1] + (pz[seg] - pz[seg - 1]) * t;

        // Fade in at the imp's back and out at the far end, so arrows arrive and
        // depart instead of popping into and out of existence.
        const edge = Math.min(1, Math.min(s, total - s) / SPACING);
        dummy.position.set(ax, FLOW_Y, az);
        dummy.rotation.set(0, Math.atan2(px[seg] - px[seg - 1], pz[seg] - pz[seg - 1]), 0);
        dummy.scale.setScalar(0.55 + edge * 0.45);
        dummy.updateMatrix();
        this.mesh.setMatrixAt(n, dummy.matrix);
        this.mesh.setColorAt(n, colour);
        n++;
      }
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
