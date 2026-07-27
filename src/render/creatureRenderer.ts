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
import { BADGE_COLS, BADGE_NONE, BADGE_ROWS, badgeAtlas, badgeFor } from './badges';
import { addRimLight, celRamp } from './celRamp';
import { Gait, angleDelta, gaitFor, strike } from './gait';

/**
 * How open a creature's eyes are, in [0,1].
 *
 * Blinks are rare, fast and irregular. A steady sine would be a creature slowly
 * winking at you forever; what a blink actually is, is a long open interval and
 * then a shut lasting a tenth of a second. The seed spreads the phase so a
 * roomful never blinks together, and staggers the interval so they never fall
 * into step either.
 */
export function blinkScale(time: number, seed: number, state: CreatureState): number {
  // Asleep the eyes are simply shut, and a corpse does not blink.
  if (state === CreatureState.Sleeping) return 0.06;
  if (state === CreatureState.Dying) return 1;
  const period = 3.4 + seed * 2.8;
  const t = (time + seed * 17) % period;
  const shut = 0.13;
  if (t > shut) return 1;
  // Down and back up inside the shut window, easing at neither end: a blink is
  // a snap, not a fade.
  return Math.abs(t / shut - 0.5) * 2 * 0.94 + 0.06;
}

/**
 * Where an idle creature is looking.
 *
 * Standing still, they stared dead ahead forever. Real attention does not work
 * like that and neither does animated attention: a head snaps to something,
 * holds on it for a second or two, then snaps somewhere else. A smooth sine
 * would have produced a creature slowly scanning the horizon like a lighthouse,
 * which is a different and worse kind of wrong.
 *
 * So: a deterministic target per interval, crossed to quickly and then held.
 * Returns a yaw offset in radians, roughly plus or minus half a radian.
 */
export function glanceOffset(time: number, seed: number): number {
  const period = 2.8 + seed * 2.2;
  const phase = time / period + seed * 13;
  const k = Math.floor(phase);
  const pick = (n: number): number => {
    const r = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return (r - Math.floor(r) - 0.5) * 1.1;
  };
  // Across in the first fifth of the interval, then still for the rest of it.
  const t = Math.min(1, (phase - k) / 0.2);
  const ease = t * t * (3 - 2 * t);
  return pick(k - 1) + (pick(k) - pick(k - 1)) * ease;
}

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

/** Badges drawn at once, across every species. */
const MAX_BADGES = 260;

/** How far above a creature's own height its badge floats. */
const BADGE_LIFT = 0.34;

/** World size of a badge. Big enough to read from the default camera. */
const BADGE_SIZE = 0.46;

/**
 * Point a badge quad at its own cell of the sheet.
 *
 * The same per-instance atlas trick the terrain uses: one texture, one draw
 * call, and the instance decides which glyph it is wearing.
 */
function applyBadgeAtlas(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
         attribute float aBadge;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
         #ifdef USE_MAP
           // The sheet is a canvas and three flips canvases on upload, so the
           // row index counts from the bottom of the texture, not the top.
           vec2 badgeCell = vec2(
             mod( aBadge, ${BADGE_COLS}.0 ),
             ${BADGE_ROWS}.0 - 1.0 - floor( aBadge / ${BADGE_COLS}.0 )
           );
           vMapUv = ( uv + badgeCell ) / vec2( ${BADGE_COLS}.0, ${BADGE_ROWS}.0 );
         #endif`);
  };
  material.customProgramCacheKey = () => 'badge-atlas';
}

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
  /** Height of the eyes in model space, so a blink pivots on them. */
  eyeY: number;
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
  private readonly bodyMaterial: THREE.MeshToonMaterial;
  private readonly regaliaMaterial: THREE.MeshToonMaterial;
  private readonly celRamp: THREE.DataTexture;
  private readonly eyeMaterial: THREE.MeshBasicMaterial;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private readonly auraMaterial: THREE.MeshBasicMaterial;
  private readonly sackMaterial: THREE.MeshToonMaterial;

  private readonly dummy = new THREE.Object3D();
  /**
   * Rendered facing per creature, chasing the simulated one.
   *
   * The simulation sets `facing` the instant a path bends, so a creature rounding
   * a corner snapped through ninety degrees in a single frame — the one motion
   * artefact you cannot unsee once you have noticed it. Render-side only: the AI
   * must keep its exact heading, because pathing and attack ranges are computed
   * from it, and a creature that shot at where it was *turning* would be a bug.
   */
  private readonly renderYaw = new Map<number, number>();
  private readonly limbDummy = new THREE.Object3D();
  /** Scratch for copying a body matrix onto its rank kit. */
  private readonly matrix = new THREE.Matrix4();
  private readonly eyeLid = new THREE.Matrix4();
  private readonly eyeScale = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly tmpColor = new THREE.Color();

  /** Maps a body instance back to a creature, for click picking. */
  private readonly pickTable = new Map<THREE.InstancedMesh, Creature[]>();

  /**
   * Job badges, for the whole roster in one mesh rather than one per species.
   *
   * They are the same quad wearing a different cell of the same sheet whatever
   * is underneath them, so splitting them by species would buy nothing and cost
   * a draw call each.
   */
  private readonly badgeMesh: THREE.InstancedMesh;
  private readonly badgeMaterial: THREE.MeshBasicMaterial;
  private readonly badgeSlotAttr: THREE.InstancedBufferAttribute;
  /** Camera orientation, so badges face the viewer. */
  private readonly billboard = new THREE.Quaternion();

  constructor() {
    this.celRamp = celRamp();
    // Toon, not standard. A physically-based material spreads light smoothly
    // across a curved surface, and smooth is the opposite of what this style
    // wants: manga shades a limb as one flat colour with one flat shadow and a
    // hard edge between them. Nothing else here was ever going to get that,
    // however the roughness was tuned.
    this.bodyMaterial = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: this.celRamp,
    });
    // A warm edge, because a creature has to be findable. The dungeon is dark red
    // rock lit by fire and most of the roster is dark and warm too; a troll in the
    // corner of a lair was a green shape inside a brown shape. The rim draws the
    // line that tells them apart, and it is the single cheapest thing that makes a
    // stylised scene look lit by someone rather than by a renderer.
    addRimLight(this.bodyMaterial, 0xffc98a, 0.5);
    // Armour is metal and must behave like metal: high metalness, low
    // roughness, and it picks up the environment. Sharing the body material
    // would have made a steel pauldron look like painted hide.
    // Armour shades the same way the skin does, or a champion looks like a
    // photograph wearing a cartoon. Metal reads as metal through its colour
    // and its highlight step, not through a reflection.
    this.regaliaMaterial = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: this.celRamp,
    });
    // Opaque and unlit. Additive blending was erasing everything inside the
    // eye — a pupil that adds light is not a pupil — so eyes were a pair of
    // bright dots however carefully they were modelled. Unlit keeps them
    // readable in a dark dungeon without washing out the shapes.
    this.eyeMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      toneMapped: false,
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
    this.sackMaterial = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: this.celRamp,
    });
    this.auraMaterial = new THREE.MeshBasicMaterial({
      map: makeGlowTexture(96, 'rgba(255,214,140,0.9)'),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    /*
     * The badge quad.
     *
     * Depth-tested, so a badge is hidden by the rock in front of it rather than
     * floating through a wall and reporting on a creature you cannot see — the
     * fog of war is a rule, and an overlay that quietly breaks it is worse than
     * no overlay. Unlit and un-tonemapped, because it is a label.
     */
    this.badgeMaterial = new THREE.MeshBasicMaterial({
      map: badgeAtlas(),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const badgeGeo = new THREE.PlaneGeometry(1, 1);
    this.badgeSlotAttr =
      new THREE.InstancedBufferAttribute(new Float32Array(MAX_BADGES), 1);
    this.badgeSlotAttr.setUsage(THREE.DynamicDrawUsage);
    badgeGeo.setAttribute('aBadge', this.badgeSlotAttr);
    applyBadgeAtlas(this.badgeMaterial);
    this.badgeMesh = new THREE.InstancedMesh(badgeGeo, this.badgeMaterial, MAX_BADGES);
    this.badgeMesh.frustumCulled = false;
    this.badgeMesh.count = 0;
    this.badgeMesh.renderOrder = 6;
    this.badgeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.badgeMesh);
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

    // Where the eyes actually sit on this species, so the blink closes about
    // them instead of dragging the whole head down toward the feet.
    model.eyes.computeBoundingBox();
    const eyeBox = model.eyes.boundingBox;
    const eyeY = eyeBox ? (eyeBox.min.y + eyeBox.max.y) / 2 : model.height * 0.8;

    batch = {
      body, limb, eyes, ring, shadow, regalia, aura, sack, limbsPer, eyeY,
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
  update(
    creatures: readonly Creature[], time: number, dt: number, camera?: THREE.Camera,
  ): void {
    if (camera) camera.getWorldQuaternion(this.billboard);
    let badgeN = 0;
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

        /*
         * The badge, if this one has anything to say.
         *
         * Only the player's own creatures. Doubling the count to report on the
         * enemy's intentions as well would halve the legibility of the question
         * actually being asked, which is "what are *mine* doing" — and the enemy
         * telling you his plans is a different feature with different rules.
         */
        if (c.owner === Owner.Player && badgeN < MAX_BADGES
          && c.state !== CreatureState.Dying) {
          const slot = badgeFor(c);
          if (slot !== BADGE_NONE) {
            const lift = batch.height * CREATURE_SPECS[c.type].scale * rankScale(c.level);
            this.dummy.position.set(
              c.x,
              c.z + lift + BADGE_LIFT + Math.sin(time * 2.1 + c.seed * 9) * 0.03,
              c.y,
            );
            this.dummy.quaternion.copy(this.billboard);
            this.dummy.scale.setScalar(BADGE_SIZE);
            this.dummy.updateMatrix();
            this.badgeMesh.setMatrixAt(badgeN, this.dummy.matrix);
            this.badgeSlotAttr.setX(badgeN, slot);
            badgeN++;
          }
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

      // Creature ids are unique for the life of a level, so the yaw table would
      // otherwise accumulate an entry for every creature that ever existed.
      if (this.renderYaw.size > 512) {
        const live = new Set<number>();
        for (const b of this.batches.values()) {
          for (const c of this.pickTable.get(b.body) ?? []) live.add(c.id);
        }
        for (const id of this.renderYaw.keys()) {
          if (!live.has(id)) this.renderYaw.delete(id);
        }
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

    this.badgeMesh.count = badgeN;
    if (badgeN > 0) {
      this.badgeMesh.instanceMatrix.needsUpdate = true;
      this.badgeSlotAttr.needsUpdate = true;
    }
  }

  /** Position, orient and animate one creature's body, eyes and marker ring. */
  private placeCreature(
    batch: TypeBatch, c: Creature, n: number, time: number, dt: number,
  ): void {
    const spec = CREATURE_SPECS[c.type];
    const { dummy } = this;

    const gait = gaitFor(c.type);

    // Gait phase advances with actual movement, so walkers don't moonwalk, and at
    // the species' own cadence rather than one shared number — a troll taking imp
    // steps was most of why the roster moved alike.
    const moving = c.state === CreatureState.Walking
      || c.state === CreatureState.Hauling
      || c.state === CreatureState.LeavingDungeon
      || (c.state === CreatureState.Fighting && c.path !== null);
    c.animPhase += dt * (moving ? spec.speed * gait.cadence : 1.6);

    /*
     * No two of them the same size.
     *
     * A dozen imps at identical scale in identical colour read as one imp drawn
     * a dozen times, which is most of why the roster looked like objects rather
     * than like a workforce. The variation is deterministic in the creature's
     * own seed, so an imp is the same imp for its whole life — it is a trait, not
     * a flicker — and it is small enough that nobody thinks the species is
     * inconsistent, only that these are different individuals of it.
     */
    const build = 0.90 + c.seed * 0.20;
    const scale = spec.scale * rankScale(c.level) * build;
    let y = c.z;
    let lean = 0;
    let roll = 0;
    let squash = 1;

    switch (c.state) {
      case CreatureState.Walking:
      case CreatureState.Hauling:
      case CreatureState.LeavingDungeon: {
        /*
         * Squash and stretch, which is the difference between a body walking and
         * a model being slid along the floor.
         *
         * The rise and fall was here already; what was missing is that a mass
         * moving under gravity does not keep its shape. It flattens as it lands
         * and draws out as it leaves, and — this is the part that matters — its
         * volume is conserved, so it widens exactly as much as it shortens.
         * Without the widening a creature just gets smaller on the beat, which
         * reads as a distance change rather than as weight.
         */
        const rise = Math.abs(Math.sin(c.animPhase));
        y += rise * gait.bob;
        lean = gait.lean;
        roll = Math.sin(c.animPhase) * gait.roll;
        squash = 1 + (rise - 0.5) * 2 * gait.squash;
        break;
      }
      case CreatureState.Digging:
        // A swing at the rock: fast out, slow back, not a gentle oscillation.
        lean = 0.12 + strike(c.animPhase * 0.8) * 0.62;
        y += strike(c.animPhase * 0.8) * 0.05;
        squash = 1 - strike(c.animPhase * 0.8) * 0.08;
        break;
      case CreatureState.Claiming:
        lean = 0.22 + Math.sin(c.animPhase * 3) * 0.12;
        break;
      case CreatureState.Fighting:
        lean = 0.10 + strike(c.animPhase * 1.1) * 0.55;
        squash = 1 - strike(c.animPhase * 1.1) * 0.10;
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
        // Idle: a slow breath plus an occasional glance around. The breath
        // squashes as well as lifts, so a standing creature is never quite still.
        y += Math.sin(time * 1.8 + c.seed * 7) * gait.breath;
        squash = 1 + Math.sin(time * 1.8 + c.seed * 7) * gait.breath * 0.9;
        roll = Math.sin(time * 0.7 + c.seed * 3) * 0.04;
        break;
    }

    if (spec.flying) y += 0.10 + Math.sin(time * 3.1 + c.seed * 4) * 0.05;

    const yaw = this.smoothYaw(c, gait, dt);
    dummy.position.set(c.x, y, c.y);
    dummy.rotation.set(lean, yaw, roll, 'YXZ');
    // Volume-preserving: what it loses in height it gains around the middle.
    const widen = 1 / Math.sqrt(squash);
    dummy.scale.set(scale * widen, scale * squash, scale * widen);
    dummy.updateMatrix();
    batch.body.setMatrixAt(n, dummy.matrix);

    /*
     * The eyes lead the turn.
     *
     * A head arriving before the body is how animation shows intent — you look
     * where you are going first and then follow. The eyes are already their own
     * instanced mesh, so this costs one extra matrix and nothing else, and it is
     * the small thing that stops a creature reading as a rigid puppet.
     */
    const anticipate = angleDelta(yaw, Math.PI / 2 - c.facing) * 0.45;
    // Standing about, it looks around; working, it looks at the work.
    const looking = c.state === CreatureState.Idle ? glanceOffset(time, c.seed) : 0;
    dummy.rotation.set(lean, yaw + anticipate + looking, roll, 'YXZ');
    dummy.updateMatrix();

    /*
     * Blinking.
     *
     * The cheapest signal of life there is, and its absence is the loudest: a
     * face whose eyes never close is a mask, and every creature in the dungeon
     * was wearing one. Each blinks on its own clock, seeded so a crowd never
     * does it in unison, and the lids shut about the eyes themselves rather than
     * the eyes scaling toward the floor — done the wrong way it reads as the
     * head shrinking, which is worse than not blinking at all.
     */
    const blink = blinkScale(time, c.seed, c.state);
    if (blink < 1) {
      this.eyeLid.makeTranslation(0, batch.eyeY, 0);
      this.eyeLid.scale(this.eyeScale.set(1, blink, 1));
      this.eyeLid.multiply(this.matrix.makeTranslation(0, -batch.eyeY, 0));
      dummy.matrix.multiply(this.eyeLid);
    }
    batch.eyes.setMatrixAt(n, dummy.matrix);

    // Wounded creatures darken toward red; haste tints them hot.
    const hpFrac = Math.max(0, Math.min(1, c.hp / maxHpOf(c)));
    // A complexion of its own, on the same seed as its build: some run darker,
    // some warmer. Small enough to read as individual variation rather than as
    // the species being badly specified.
    const tone = 0.93 + c.seed * 0.14;
    this.color.setRGB(tone, tone * (0.98 + c.seed * 0.05), tone * (1.04 - c.seed * 0.08));
    if (hpFrac < 1) this.color.lerp(this.tmpColor.setRGB(1.25, 0.5, 0.42), (1 - hpFrac) * 0.65);
    if (c.hasteTicks > 0) this.color.lerp(this.tmpColor.setRGB(1.4, 1.25, 0.7), 0.35);
    batch.body.setColorAt(n, this.color);

    // A veteran's eyes are lit from inside — the cheapest read on rank there is,
    // and the one that still works when the creature is a silhouette.
    // Rank brightens the eyes rather than replacing them: a champion's stare
    // is hotter, but it is still a stare with a pupil in it.
    const glow = Math.min(1.6, eyeGlowFor(c.level))
      * (c.state === CreatureState.Sleeping ? 0.3 : 1);
    this.color.setRGB(glow, glow * 0.97, glow * 0.92);
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

  /**
   * Chase the simulated heading at the species' own turn rate.
   *
   * Kept in a map keyed by creature id rather than on the creature, because the
   * creature belongs to the simulation and this is a rendering detail — one that
   * must not exist on a headless run and must not be part of a saved game.
   */
  private smoothYaw(c: Creature, gait: Gait, dt: number): number {
    const target = Math.PI / 2 - c.facing;
    const current = this.renderYaw.get(c.id);
    if (current === undefined) {
      this.renderYaw.set(c.id, target);
      return target;
    }
    const delta = angleDelta(current, target);
    // Framerate-independent chase: the same fraction of the gap per second
    // however often this runs, so a 144Hz display does not turn faster.
    const step = 1 - Math.exp(-gait.turn * dt);
    const next = current + delta * step;
    this.renderYaw.set(c.id, next);
    return next;
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
    this.badgeMesh.geometry.dispose();
    this.badgeMaterial.dispose();
    this.celRamp.dispose();
  }
}
