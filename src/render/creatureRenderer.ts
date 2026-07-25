import * as THREE from 'three';
import { OWNER_COLORS, Owner } from '../core/constants';
import {
  CREATURE_SPECS,
  Creature,
  CreatureState,
  CreatureType,
  maxHpOf,
} from '../core/creatures';
import { getCreatureModel, limbCountFor } from './creatureModels';
import { makeGlowTexture } from './textures';

/**
 * Renders every creature in the dungeon.
 *
 * One set of instanced meshes per species, rebuilt each frame from whichever
 * creatures are alive. Animation is entirely procedural — a bob, a lean and a
 * limb swing driven by the creature's state — which is enough to make a
 * dungeon full of workers read as busy without a single keyframe.
 */

const MAX_PER_TYPE = 220;

interface TypeBatch {
  body: THREE.InstancedMesh;
  limb: THREE.InstancedMesh;
  eyes: THREE.InstancedMesh;
  ring: THREE.InstancedMesh;
  shadow: THREE.InstancedMesh;
  limbsPer: number;
  flapping: boolean;
  limbOffset: THREE.Vector3;
  height: number;
}

export class CreatureRenderer {
  readonly group = new THREE.Group();

  private readonly batches = new Map<CreatureType, TypeBatch>();
  private readonly bodyMaterial: THREE.MeshStandardMaterial;
  private readonly eyeMaterial: THREE.MeshBasicMaterial;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly shadowMaterial: THREE.MeshBasicMaterial;

  private readonly dummy = new THREE.Object3D();
  private readonly limbDummy = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private readonly tmpColor = new THREE.Color();

  /** Maps a body instance back to a creature, for click picking. */
  private readonly pickTable = new Map<THREE.InstancedMesh, Creature[]>();

  constructor() {
    this.bodyMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.78,
      metalness: 0.06,
    });
    this.eyeMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd08a,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.ringMaterial = new THREE.MeshBasicMaterial({
      map: makeGlowTexture(64, 'rgba(255,255,255,0.85)'),
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    // A soft dark blob under each creature. The owner ring is additive, so on
    // its own it lit the floor and made everything look like it was hovering
    // over its own lamp; this is the contact shadow that puts them on the
    // ground. Multiply blending so it darkens whatever it lands on.
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      map: makeGlowTexture(64, 'rgba(255,255,255,1)'),
      transparent: true,
      opacity: 0.55,
      color: 0x000000,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
  }

  private batchFor(type: CreatureType): TypeBatch {
    let batch = this.batches.get(type);
    if (batch) return batch;

    const spec = CREATURE_SPECS[type];
    const model = getCreatureModel(type, spec.color, spec.accent);
    const limbsPer = limbCountFor(type);

    const body = new THREE.InstancedMesh(model.body, this.bodyMaterial, MAX_PER_TYPE);
    body.castShadow = true;
    body.receiveShadow = true;
    body.frustumCulled = false;
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    body.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_TYPE * 3), 3);
    body.instanceColor.setUsage(THREE.DynamicDrawUsage);

    const limb = new THREE.InstancedMesh(model.limb, this.bodyMaterial, MAX_PER_TYPE * limbsPer);
    limb.castShadow = true;
    limb.frustumCulled = false;
    limb.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const eyes = new THREE.InstancedMesh(model.eyes, this.eyeMaterial, MAX_PER_TYPE);
    eyes.frustumCulled = false;
    eyes.renderOrder = 3;
    eyes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const ringGeo = new THREE.PlaneGeometry(1, 1);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.InstancedMesh(ringGeo, this.ringMaterial, MAX_PER_TYPE);
    ring.frustumCulled = false;
    ring.renderOrder = 1;
    ring.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    ring.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_TYPE * 3), 3);
    ring.instanceColor.setUsage(THREE.DynamicDrawUsage);

    const shadowGeo = new THREE.PlaneGeometry(1, 1);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadow = new THREE.InstancedMesh(shadowGeo, this.shadowMaterial, MAX_PER_TYPE);
    shadow.frustumCulled = false;
    shadow.renderOrder = 0;
    shadow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    batch = {
      body, limb, eyes, ring, shadow, limbsPer,
      flapping: model.flapping,
      limbOffset: model.limbOffset,
      height: model.height,
    };
    this.batches.set(type, batch);
    this.group.add(shadow, ring, body, limb, eyes);
    this.pickTable.set(body, []);
    return batch;
  }

  /**
   * Rebuild every instance from the live creature list.
   * `time` drives idle motion; `dt` advances each creature's own gait phase.
   */
  update(creatures: readonly Creature[], time: number, dt: number): void {
    // Bucket by species so each batch fills contiguously.
    const byType = new Map<CreatureType, Creature[]>();
    for (const c of creatures) {
      if (c.inHand) continue;
      let list = byType.get(c.type);
      if (!list) byType.set(c.type, (list = []));
      if (list.length < MAX_PER_TYPE) list.push(c);
    }

    // Empty any batch whose species has left the map.
    for (const [type, batch] of this.batches) {
      if (!byType.has(type)) {
        batch.body.count = 0;
        batch.limb.count = 0;
        batch.eyes.count = 0;
        batch.ring.count = 0;
        batch.shadow.count = 0;
        this.pickTable.get(batch.body)?.splice(0);
      }
    }

    for (const [type, list] of byType) {
      const batch = this.batchFor(type);
      const picks = this.pickTable.get(batch.body)!;
      picks.length = 0;

      let limbN = 0;
      for (let n = 0; n < list.length; n++) {
        const c = list[n];
        picks.push(c);
        this.placeCreature(batch, c, n, time, dt);
        limbN = this.placeLimbs(batch, c, limbN, time);
      }

      batch.body.count = list.length;
      batch.eyes.count = list.length;
      batch.ring.count = list.length;
      batch.shadow.count = list.length;
      batch.limb.count = limbN;

      batch.body.instanceMatrix.needsUpdate = true;
      batch.limb.instanceMatrix.needsUpdate = true;
      batch.eyes.instanceMatrix.needsUpdate = true;
      batch.ring.instanceMatrix.needsUpdate = true;
      batch.shadow.instanceMatrix.needsUpdate = true;
      if (batch.body.instanceColor) batch.body.instanceColor.needsUpdate = true;
      if (batch.ring.instanceColor) batch.ring.instanceColor.needsUpdate = true;
    }
  }

  /** Position, orient and animate one creature's body, eyes and marker ring. */
  private placeCreature(
    batch: TypeBatch, c: Creature, n: number, time: number, dt: number,
  ): void {
    const spec = CREATURE_SPECS[c.type];
    const { dummy } = this;

    // Gait phase advances with actual movement, so walkers don't moonwalk.
    const moving = c.state === CreatureState.Walking
      || c.state === CreatureState.Hauling
      || c.state === CreatureState.LeavingDungeon
      || (c.state === CreatureState.Fighting && c.path !== null);
    c.animPhase += dt * (moving ? spec.speed * 3.4 : 1.6);

    const scale = spec.scale * (1 + 0.035 * (c.level - 1));
    let y = c.z;
    let lean = 0;
    let roll = 0;
    let squash = 1;

    switch (c.state) {
      case CreatureState.Walking:
      case CreatureState.Hauling:
      case CreatureState.LeavingDungeon:
        y += Math.abs(Math.sin(c.animPhase)) * 0.055;
        lean = 0.13;
        roll = Math.sin(c.animPhase) * 0.06;
        break;
      case CreatureState.Digging:
        // Rhythmic lunge into the rock face.
        lean = 0.35 + Math.sin(c.animPhase * 5) * 0.28;
        y += Math.abs(Math.sin(c.animPhase * 5)) * 0.03;
        break;
      case CreatureState.Claiming:
        lean = 0.22 + Math.sin(c.animPhase * 3) * 0.12;
        break;
      case CreatureState.Fighting:
        lean = 0.18 + Math.sin(c.animPhase * 7) * 0.30;
        break;
      case CreatureState.Sleeping:
        // Curled up and breathing.
        y -= 0.14 * spec.scale;
        squash = 0.72 + Math.sin(time * 1.4 + c.seed * 6) * 0.03;
        lean = 0.9;
        break;
      case CreatureState.Eating:
        lean = 0.42 + Math.sin(c.animPhase * 4) * 0.14;
        break;
      case CreatureState.Training:
        lean = Math.sin(c.animPhase * 6) * 0.34;
        y += Math.abs(Math.sin(c.animPhase * 6)) * 0.07;
        break;
      case CreatureState.Researching:
        y += Math.sin(time * 1.1 + c.seed * 5) * 0.02;
        lean = 0.26;
        break;
      case CreatureState.Stunned:
        roll = Math.sin(time * 18 + c.seed * 9) * 0.16;
        y += 0.02;
        break;
      case CreatureState.Dying:
        // Topple over and sink.
        lean = Math.min(Math.PI / 2, c.stateTimer * 0.13);
        y -= c.stateTimer * 0.012;
        break;
      default:
        // Idle: a slow breath plus an occasional glance around.
        y += Math.sin(time * 1.8 + c.seed * 7) * 0.012;
        roll = Math.sin(time * 0.7 + c.seed * 3) * 0.04;
        break;
    }

    if (spec.flying) y += 0.10 + Math.sin(time * 3.1 + c.seed * 4) * 0.05;

    dummy.position.set(c.x, y, c.y);
    dummy.rotation.set(lean, Math.PI / 2 - c.facing, roll, 'YXZ');
    dummy.scale.set(scale, scale * squash, scale);
    dummy.updateMatrix();
    batch.body.setMatrixAt(n, dummy.matrix);
    batch.eyes.setMatrixAt(n, dummy.matrix);

    // Wounded creatures darken toward red; haste tints them hot.
    const hpFrac = Math.max(0, Math.min(1, c.hp / maxHpOf(c)));
    this.color.setRGB(1, 1, 1);
    if (hpFrac < 1) this.color.lerp(this.tmpColor.setRGB(1.25, 0.5, 0.42), (1 - hpFrac) * 0.65);
    if (c.hasteTicks > 0) this.color.lerp(this.tmpColor.setRGB(1.4, 1.25, 0.7), 0.35);
    batch.body.setColorAt(n, this.color);

    // Owner ring on the floor: how you tell yours from theirs at a glance.
    const { dummy: d2 } = this;
    const ringScale = scale * 1.5;
    d2.position.set(c.x, 0.012, c.y);
    d2.rotation.set(0, 0, 0);
    d2.scale.set(ringScale, 1, ringScale);
    d2.updateMatrix();
    batch.ring.setMatrixAt(n, d2.matrix);
    this.color.setHex(OWNER_COLORS[c.owner as Owner]);
    if (c.state === CreatureState.Dying) this.color.multiplyScalar(0.3);
    batch.ring.setColorAt(n, this.color);

    // Contact shadow: tighter than the ring, and it shrinks as a flyer climbs.
    const lift = Math.max(0, y - c.z) + (spec.flying ? c.z : 0);
    const shadowScale = scale * 1.15 * Math.max(0.45, 1 - lift * 0.9);
    d2.position.set(c.x, 0.008, c.y);
    d2.scale.set(shadowScale, 1, shadowScale);
    d2.updateMatrix();
    batch.shadow.setMatrixAt(n, d2.matrix);
  }

  /** Lay out one creature's limbs. Returns the next free limb instance slot. */
  private placeLimbs(
    batch: TypeBatch, c: Creature, limbN: number, time: number,
  ): number {
    const spec = CREATURE_SPECS[c.type];
    const scale = spec.scale * (1 + 0.035 * (c.level - 1));
    const { limbDummy } = this;
    const pairs = batch.limbsPer / 2;

    const moving = c.state === CreatureState.Walking
      || c.state === CreatureState.Hauling
      || c.state === CreatureState.LeavingDungeon;

    // Sleeping creatures tuck their limbs away entirely.
    if (c.state === CreatureState.Sleeping || c.state === CreatureState.Dying) {
      return limbN;
    }

    const bodyY = c.z + (spec.flying ? 0.10 + Math.sin(time * 3.1 + c.seed * 4) * 0.05 : 0);
    const yaw = Math.PI / 2 - c.facing;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);

    for (let p = 0; p < pairs; p++) {
      for (const side of [-1, 1]) {
        if (limbN >= batch.limb.count + 1 && limbN >= MAX_PER_TYPE * batch.limbsPer) break;

        // Stagger multi-pair walkers (beetles) front to back.
        const zSpread = pairs > 1 ? (p - (pairs - 1) / 2) * batch.limbOffset.z * 2.4 : 0;
        const lx = batch.limbOffset.x * side;
        const ly = batch.limbOffset.y;
        const lz = zSpread;

        let swing: number;
        if (batch.flapping) {
          // Wings beat fast and out of phase with the body bob.
          swing = Math.sin(c.animPhase * 9 + p) * 0.9 * side;
        } else if (moving) {
          swing = Math.sin(c.animPhase * 2 + p * 2.1 + (side > 0 ? Math.PI : 0)) * 0.62;
        } else if (c.state === CreatureState.Digging) {
          swing = Math.sin(c.animPhase * 5 + (side > 0 ? Math.PI : 0)) * 0.5;
        } else {
          swing = Math.sin(time * 1.2 + c.seed * 4 + p) * 0.06;
        }

        // Rotate the local offset into world space by the creature's yaw.
        const wx = (lx * cos + lz * sin) * scale;
        const wz = (-lx * sin + lz * cos) * scale;

        limbDummy.position.set(c.x + wx, bodyY + ly * scale, c.y + wz);
        if (batch.flapping) {
          limbDummy.rotation.set(0, yaw, swing, 'YXZ');
        } else {
          limbDummy.rotation.set(swing, yaw, 0, 'YXZ');
        }
        limbDummy.scale.set(scale, scale, scale);
        limbDummy.updateMatrix();
        batch.limb.setMatrixAt(limbN++, limbDummy.matrix);
      }
    }
    return limbN;
  }

  /** Meshes a raycaster should test for creature picking. */
  pickTargets(): THREE.Object3D[] {
    return [...this.batches.values()].map((b) => b.body);
  }

  /** Resolve a raycast hit back to the creature it belongs to. */
  creatureFromIntersection(hit: THREE.Intersection): Creature | null {
    const list = this.pickTable.get(hit.object as THREE.InstancedMesh);
    if (!list || hit.instanceId === undefined) return null;
    return list[hit.instanceId] ?? null;
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      b.body.geometry.dispose();
      b.limb.geometry.dispose();
      b.eyes.geometry.dispose();
      b.ring.geometry.dispose();
      b.shadow.geometry.dispose();
    }
    this.bodyMaterial.dispose();
    this.eyeMaterial.dispose();
    this.ringMaterial.dispose();
    this.shadowMaterial.dispose();
  }
}
