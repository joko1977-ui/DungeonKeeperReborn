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
import {
  Rank, WORN_RANKS, auraStrength, buildRankRegalia, eyeGlowFor, rankOf, rankScale, rigFor,
} from './creatureRank';
import { makeGlowTexture } from './textures';
import { PartBuilder } from './creatureModels';

/** A bulging sack with coins spilling over the tie. */
function buildGoldSack(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.sphere(0.145, 0.20, 0.22, 0.10, 0x8a6a3a, 1.0, 1.15, 0.95, 8);
  b.sphere(0.10, 0.20, 0.33, 0.10, 0x6e5230, 1.0, 0.7, 0.95, 7);
  // The neck, and the coins showing through it.
  b.cylinder(0.045, 0.06, 0.06, 0.20, 0.38, 0.10, 0x4e3a22, 0, 0, 0, 6);
  b.sphere(0.05, 0.20, 0.41, 0.10, 0xffd700, 1, 0.7, 1, 7);
  b.cylinder(0.03, 0.03, 0.012, 0.17, 0.43, 0.12, 0xffec8b, 0.3, 0, 0.2, 6);
  return b.build();
}

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
  /**
   * Rank kit, one mesh per worn rank. A creature is drawn into whichever one
   * matches its rank, so the armour a veteran wears is real geometry rather
   * than a tint, and it costs one draw call per rank per species.
   */
  regalia: Map<Rank, THREE.InstancedMesh>;
  /** Champions only: a slow ring of light at the feet. */
  aura: THREE.InstancedMesh;
  /**
   * A sack of gold, drawn only while a creature is carrying one.
   *
   * Imps spend most of a level hauling, and in the reference art that is what
   * tells you at a glance that the dungeon is *working* — a floor of little red
   * figures each lugging a bag. Ours carried gold as a number nobody could see.
   */
  sack: THREE.InstancedMesh;
  limbsPer: number;
  flapping: boolean;
  limbOffset: THREE.Vector3;
  height: number;
}

export class CreatureRenderer {
  readonly group = new THREE.Group();

  private readonly batches = new Map<CreatureType, TypeBatch>();
  private readonly bodyMaterial: THREE.MeshStandardMaterial;
  private readonly regaliaMaterial: THREE.MeshStandardMaterial;
  private readonly eyeMaterial: THREE.MeshBasicMaterial;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private readonly auraMaterial: THREE.MeshBasicMaterial;
  private readonly sackMaterial: THREE.MeshStandardMaterial;

  private readonly dummy = new THREE.Object3D();
  private readonly limbDummy = new THREE.Object3D();
  /** Scratch for copying a body matrix onto its rank kit. */
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private readonly tmpColor = new THREE.Color();

  /** Maps a body instance back to a creature, for click picking. */
  private readonly pickTable = new Map<THREE.InstancedMesh, Creature[]>();

  constructor() {
    this.bodyMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      // Hide and scale, not stone: a little sheen so a creature turning in
      // torchlight has a rolling highlight along its back.
      roughness: 0.62,
      metalness: 0.14,
      // Creatures are what the eye goes to, and a dungeon lit only by distant
      // torches left them as silhouettes. The baked environment carries a warm
      // floor bounce; leaning on it here lifts the creatures without flattening
      // the walls, which keep their own much lower intensity.
      envMapIntensity: 1.15,
    });
    // Armour is metal and must behave like metal: high metalness, low
    // roughness, and it picks up the environment. Sharing the body material
    // would have made a steel pauldron look like painted hide.
    // Metalness deliberately short of 1. A fully metallic surface has no
    // diffuse term at all — it is *only* what it reflects — and what it has to
    // reflect down here is a dark cave, so armour came out as a black blob with
    // one blue highlight. Half-metal keeps the steel colour visible and still
    // catches the torches.
    this.regaliaMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.3,
      metalness: 0.52,
      envMapIntensity: 1.8,
    });
    this.eyeMaterial = new THREE.MeshBasicMaterial({
      // Yellow-orange and lit from inside, per the art direction.
      color: 0xffb020,
      // Explicit, even though the eye geometry's own colours are plain white:
      // three only feeds instanceColor through to the fragment stage when
      // USE_COLOR is defined, and that comes from this flag.
      vertexColors: true,
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
    // Coin gold, so a hauled sack catches the light the way the heaps do.
    this.sackMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.32,
      metalness: 0.85,
      envMapIntensity: 2.0,
    });
    this.auraMaterial = new THREE.MeshBasicMaterial({
      map: makeGlowTexture(96, 'rgba(255,214,140,0.9)'),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
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
    eyes.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_TYPE * 3).fill(1), 3);
    eyes.instanceColor.setUsage(THREE.DynamicDrawUsage);

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

    // Measure the body once, so its kit is placed against the shape it actually
    // has rather than against an assumed one.
    const rig = rigFor(model.body);
    const regalia = new Map<Rank, THREE.InstancedMesh>();
    for (const rank of WORN_RANKS) {
      const mesh = new THREE.InstancedMesh(
        buildRankRegalia(type, rank, rig), this.regaliaMaterial, MAX_PER_TYPE);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      regalia.set(rank, mesh);
      this.group.add(mesh);
    }

    const sack = new THREE.InstancedMesh(buildGoldSack(), this.sackMaterial, MAX_PER_TYPE);
    sack.castShadow = true;
    sack.frustumCulled = false;
    sack.count = 0;
    sack.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(sack);

    const auraGeo = new THREE.PlaneGeometry(1, 1);
    auraGeo.rotateX(-Math.PI / 2);
    const aura = new THREE.InstancedMesh(auraGeo, this.auraMaterial, MAX_PER_TYPE);
    aura.frustumCulled = false;
    aura.renderOrder = 2;
    aura.count = 0;
    aura.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    aura.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_TYPE * 3), 3);
    aura.instanceColor.setUsage(THREE.DynamicDrawUsage);

    batch = {
      body, limb, eyes, ring, shadow, regalia, aura, sack, limbsPer,
      flapping: model.flapping,
      limbOffset: model.limbOffset,
      height: model.height,
    };
    this.batches.set(type, batch);
    this.group.add(shadow, ring, aura, body, limb, eyes);
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
        for (const mesh of batch.regalia.values()) mesh.count = 0;
        batch.aura.count = 0;
        batch.sack.count = 0;
        this.pickTable.get(batch.body)?.splice(0);
      }
    }

    for (const [type, list] of byType) {
      const batch = this.batchFor(type);
      const picks = this.pickTable.get(batch.body)!;
      picks.length = 0;

      // Rank kit fills its own meshes, so each rank's counter is tracked here.
      const rankN = new Map<Rank, number>();
      for (const rank of WORN_RANKS) rankN.set(rank, 0);
      let auraN = 0;

      let sackN = 0;
      let limbN = 0;
      for (let n = 0; n < list.length; n++) {
        const c = list[n];
        picks.push(c);
        this.placeCreature(batch, c, n, time, dt);
        limbN = this.placeLimbs(batch, c, limbN, time);

        // The body matrix was just written; reuse it so kit tracks the body's
        // bob, lean and roll exactly rather than being animated a second time.
        const rank = rankOf(c.level);
        if (rank > 0 && c.state !== CreatureState.Dying) {
          const mesh = batch.regalia.get(rank);
          if (mesh) {
            const at = rankN.get(rank) ?? 0;
            batch.body.getMatrixAt(n, this.matrix);
            mesh.setMatrixAt(at, this.matrix);
            rankN.set(rank, at + 1);
          }
        }
        // Hauling: a bag slung at the hip, riding the body's own matrix so it
        // bobs and leans with the walk.
        if (c.goldHeld > 0 && c.state !== CreatureState.Dying) {
          batch.body.getMatrixAt(n, this.matrix);
          batch.sack.setMatrixAt(sackN++, this.matrix);
        }

        const glow = auraStrength(c, time);
        if (glow > 0 && c.state !== CreatureState.Dying) {
          const size = CREATURE_SPECS[c.type].scale * rankScale(c.level) * 2.3;
          this.dummy.position.set(c.x, 0.02, c.y);
          this.dummy.rotation.set(0, time * 0.5, 0);
          this.dummy.scale.set(size, 1, size);
          this.dummy.updateMatrix();
          batch.aura.setMatrixAt(auraN, this.dummy.matrix);
          this.color.setRGB(glow, glow * 0.82, glow * 0.5);
          batch.aura.setColorAt(auraN, this.color);
          auraN++;
        }
      }

      for (const rank of WORN_RANKS) {
        const mesh = batch.regalia.get(rank);
        if (!mesh) continue;
        mesh.count = rankN.get(rank) ?? 0;
        mesh.instanceMatrix.needsUpdate = true;
      }
      batch.sack.count = sackN;
      if (sackN > 0) batch.sack.instanceMatrix.needsUpdate = true;
      batch.aura.count = auraN;
      if (auraN > 0) {
        batch.aura.instanceMatrix.needsUpdate = true;
        if (batch.aura.instanceColor) batch.aura.instanceColor.needsUpdate = true;
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
      if (batch.eyes.instanceColor) batch.eyes.instanceColor.needsUpdate = true;
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

    const scale = spec.scale * rankScale(c.level);
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

    // A veteran's eyes are lit from inside — the cheapest read on rank there is,
    // and the one that still works when the creature is a silhouette.
    const glow = eyeGlowFor(c.level) * (c.state === CreatureState.Sleeping ? 0.35 : 1);
    this.color.setRGB(glow, glow * 0.94, glow * 0.86);
    batch.eyes.setColorAt(n, this.color);

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
    const scale = spec.scale * rankScale(c.level);
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
      b.aura.geometry.dispose();
      b.sack.geometry.dispose();
      for (const mesh of b.regalia.values()) mesh.geometry.dispose();
    }
    this.bodyMaterial.dispose();
    this.regaliaMaterial.dispose();
    this.eyeMaterial.dispose();
    this.ringMaterial.dispose();
    this.shadowMaterial.dispose();
    this.auraMaterial.dispose();
    this.sackMaterial.dispose();
  }
}
