import * as THREE from 'three';
import { makeGlowTexture } from './textures';

/**
 * The air of the place: embers, ash, and shafts of light.
 *
 * A dungeon lit by molten rock is never still. Fire throws sparks upward,
 * everything that burns leaves ash coming back down, and light through smoke
 * arrives as shafts rather than as an even wash. Without any of that the scene
 * reads as a diorama — correctly lit, and dead.
 *
 * All of it is drawn near the camera rather than across the map: a fixed volume
 * that follows the focus point and wraps particles around its edges. Filling a
 * whole 72x72 realm with motes would cost a fortune to render and you would see
 * the same handful of them regardless, because everything past the fog is black.
 */

/** Rising sparks. Bright, short-lived, warm. */
const EMBER_COUNT = 320;
/** Falling ash. Dim, slow, and there are more of them than you notice. */
const ASH_COUNT = 260;
/** Dust caught in the light shafts. */
const MOTE_COUNT = 220;

/** Half-extent of the volume particles live in, in tiles. */
const VOLUME = 17;
const CEILING = 7;

interface Drift {
  positions: Float32Array;
  velocities: Float32Array;
  points: THREE.Points;
  material: THREE.PointsMaterial;
}

export class Atmosphere {
  readonly group = new THREE.Group();

  private readonly embers: Drift;
  private readonly ash: Drift;
  private readonly motes: Drift;
  private readonly shafts: THREE.Mesh;
  private readonly shaftMaterial: THREE.MeshBasicMaterial;
  private readonly centre = new THREE.Vector3();

  constructor() {
    this.embers = this.makeDrift(EMBER_COUNT, {
      colour: 0xff6b00,
      size: 0.13,
      opacity: 0.95,
      rise: [0.5, 1.5],
      spread: 0.35,
    });
    this.ash = this.makeDrift(ASH_COUNT, {
      colour: 0x5a4a40,
      size: 0.10,
      opacity: 0.4,
      rise: [-0.45, -0.16],
      spread: 0.18,
    });
    this.motes = this.makeDrift(MOTE_COUNT, {
      colour: 0xffb060,
      size: 0.055,
      opacity: 0.32,
      rise: [-0.06, 0.06],
      spread: 0.1,
    });

    // God rays. Slanted slabs of light rather than a real volumetric solve:
    // the honest version needs a depth-aware scattering pass, and at this scale
    // and frame budget a handful of soft additive planes reads the same and
    // costs nothing worth measuring.
    const shaftGeo = new THREE.BufferGeometry();
    const quads: number[] = [];
    const alphas: number[] = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.7;
      const r = 5 + (i % 3) * 3.5;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      const w = 1.6 + (i % 2) * 0.9;
      const lean = 2.4;
      // Two triangles: wide and faint at the floor, narrow and bright above.
      const top = [cx, CEILING, cz];
      const l = [cx - w + lean, 0, cz - w * 0.5];
      const rr = [cx + w + lean, 0, cz + w * 0.5];
      quads.push(...top, ...l, ...rr);
      alphas.push(1, 0, 0);
    }
    shaftGeo.setAttribute('position', new THREE.Float32BufferAttribute(quads, 3));
    shaftGeo.setAttribute('alpha', new THREE.Float32BufferAttribute(alphas, 1));

    this.shaftMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xff8c00),
      transparent: true,
      opacity: 0.055,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    // Fade each shaft along its length using the per-vertex alpha above.
    this.shaftMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float alpha;\nvarying float vAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = alpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
        .replace('#include <dithering_fragment>',
          '#include <dithering_fragment>\ngl_FragColor.a *= vAlpha;');
    };

    this.shafts = new THREE.Mesh(shaftGeo, this.shaftMaterial);
    this.shafts.frustumCulled = false;
    this.shafts.renderOrder = 6;
    this.group.add(this.shafts);
  }

  private makeDrift(count: number, opts: {
    colour: number; size: number; opacity: number;
    rise: [number, number]; spread: number;
  }): Drift {
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * VOLUME * 2;
      positions[i * 3 + 1] = Math.random() * CEILING;
      positions[i * 3 + 2] = (Math.random() - 0.5) * VOLUME * 2;
      velocities[i * 3] = (Math.random() - 0.5) * opts.spread;
      velocities[i * 3 + 1] = opts.rise[0] + Math.random() * (opts.rise[1] - opts.rise[0]);
      velocities[i * 3 + 2] = (Math.random() - 0.5) * opts.spread;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      map: makeGlowTexture(32, 'rgba(255,255,255,0.95)'),
      color: opts.colour,
      size: opts.size,
      transparent: true,
      opacity: opts.opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    points.renderOrder = 5;
    this.group.add(points);
    return { positions, velocities, points, material };
  }

  /**
   * Drift everything, and wrap it around the volume centred on the camera.
   *
   * Wrapping rather than respawning keeps the density even: particles that ran
   * off the top come back at the floor, so the air never thins out at one end
   * of the box.
   */
  update(dt: number, focus: THREE.Vector3, time: number): void {
    this.centre.set(Math.round(focus.x), 0, Math.round(focus.z));
    this.group.position.copy(this.centre);
    this.shafts.rotation.y = time * 0.02;
    this.shaftMaterial.opacity = 0.045 + 0.018 * Math.sin(time * 0.5);

    for (const drift of [this.embers, this.ash, this.motes]) {
      const { positions, velocities } = drift;
      for (let i = 0; i < positions.length; i += 3) {
        // A slow horizontal swirl, so nothing rises in a straight line.
        const swirl = Math.sin(time * 0.6 + positions[i] * 0.35) * 0.12;
        positions[i] += (velocities[i] + swirl) * dt;
        positions[i + 1] += velocities[i + 1] * dt;
        positions[i + 2] += velocities[i + 2] * dt;

        if (positions[i + 1] > CEILING) positions[i + 1] = 0;
        else if (positions[i + 1] < 0) positions[i + 1] = CEILING;
        if (positions[i] > VOLUME) positions[i] -= VOLUME * 2;
        else if (positions[i] < -VOLUME) positions[i] += VOLUME * 2;
        if (positions[i + 2] > VOLUME) positions[i + 2] -= VOLUME * 2;
        else if (positions[i + 2] < -VOLUME) positions[i + 2] += VOLUME * 2;
      }
      drift.points.geometry.attributes.position.needsUpdate = true;
    }
  }

  /** Thin the air out when the frame budget is tight. */
  setDensity(fraction: number): void {
    const f = Math.max(0, Math.min(1, fraction));
    this.embers.points.visible = f > 0.05;
    this.ash.points.visible = f > 0.4;
    this.motes.points.visible = f > 0.7;
    this.shafts.visible = f > 0.4;
  }

  dispose(): void {
    for (const drift of [this.embers, this.ash, this.motes]) {
      drift.points.geometry.dispose();
      drift.material.map?.dispose();
      drift.material.dispose();
    }
    this.shafts.geometry.dispose();
    this.shaftMaterial.dispose();
  }
}
