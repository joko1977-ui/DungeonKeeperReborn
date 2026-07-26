import * as THREE from 'three';
import { makeGlowTexture } from './textures';

/**
 * The air of the place: embers, ash, and drifting motes.
 *
 * A dungeon lit by molten rock is never still. Fire throws sparks upward and
 * everything that burns leaves ash coming back down. Without any of that the
 * scene reads as a diorama — correctly lit, and dead.
 *
 * There were god rays here too — seven slanted additive planes, meant to read as
 * light through smoke. They were built for a camera at eye level and this camera
 * looks almost straight down, where a slanted plane has no edge to hide behind:
 * it presents its full face and reads as exactly what it is, a flat orange
 * triangle. Worse, the whole system follows the focus point so the air stays
 * dense wherever you look, which meant seven triangles pinned to the screen that
 * no amount of panning would shift. A volumetric effect that needs a camera angle
 * the game does not have is not an effect, it is a decal.
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
/** Dust turning slowly in the warm air. */
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
  }

  dispose(): void {
    for (const drift of [this.embers, this.ash, this.motes]) {
      drift.points.geometry.dispose();
      drift.material.map?.dispose();
      drift.material.dispose();
    }
  }
}
