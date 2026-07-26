import * as THREE from 'three';
import { OWNER_COLORS, Owner, Terrain, isSolid } from '../core/constants';
import { GameEffect } from '../core/game';
import { FLAG_REVEALED, TileMap } from '../core/tilemap';
import { WALL_HEIGHT } from './terrain';
import { celRamp } from './celRamp';
import { makeGlowTexture, makePuffTexture } from './textures';

/**
 * Torchlight and particles.
 *
 * Every reinforced wall bordering a keeper's floor gets a torch, which is what
 * turns a claimed corridor into somewhere that visibly belongs to you. Drawing
 * a real light for each one would be hopeless, so torches are drawn as glowing
 * points and only the handful nearest the camera are promoted to actual
 * PointLights — the rest are convincing at a distance because a dungeon is dark
 * and the eye is looking at the bright thing anyway.
 *
 * Lava is not in here any more. It used to get a glow sprite on every molten
 * tile, which was a grid of hard-edged pale discs laid over the lake — and once
 * the surface shader started cutting real molten veins into it, the discs were
 * covering up the only thing worth looking at. Lava lights itself now: the veins
 * are emissive, so they bloom, and LavaGlow gives each *lake* a point light.
 */

/**
 * How many torches get a real, shadow-free dynamic light.
 *
 * Shared budget: the dungeon heart and portal each claim their own point
 * lights on top of these, and a forward renderer pays for every one of them in
 * every lit fragment. Seven leaves room for those without the total climbing
 * to somewhere a tablet would feel.
 */
const LIVE_LIGHTS = 7;

/** Scratch colour for tinting flames toward a keeper's banner. */
const TORCH_TINT = new THREE.Color();

/** Ceiling on drawn flames. Two instanced draws whatever the dungeon's size. */
const MAX_FLAMES = 700;

/** How tall a flame stands, in world units. Shared by geometry and shader. */
const FLAME_HEIGHT = 0.44;

/*
 * An actual flame, rather than a bright dot where a flame ought to be.
 *
 * A torch was a glow sprite and a point light — a corridor lit by nothing
 * visible, the light arriving from a smudge. It is the same failure as a still
 * lava lake: the thing the eye goes to has no shape in it. So every torch gets a
 * real tongue of fire, leaning and guttering on its own clock, with the sconce
 * it burns in underneath.
 *
 * Everything is done in the shader off a per-instance phase: the flame is a cone
 * whose upper half is pushed sideways, so it bends rather than sliding, and
 * whose height breathes. Which means one uniform a frame animates the lot,
 * however many hundred there are.
 */
const FLAME_VERTEX = /* glsl */`
  attribute float aPhase;
  attribute vec3 aTint;
  uniform float uTime;
  varying float vT;
  varying vec3 vTint;

  void main() {
    vT = clamp( position.y / ${FLAME_HEIGHT.toFixed(3)}, 0.0, 1.0 );
    vTint = aTint;

    vec3 p = position;
    // Squared falloff, so the base stays planted in the sconce and only the tip
    // whips about. A flame that swayed from its root would read as a flag.
    float bend = vT * vT;
    p.x += ( sin( uTime * 6.5 + aPhase ) * 0.5 + sin( uTime * 13.0 + aPhase * 2.3 ) * 0.25 ) * 0.09 * bend;
    p.z += ( cos( uTime * 5.3 + aPhase * 1.7 ) * 0.5 + cos( uTime * 11.1 + aPhase ) * 0.22 ) * 0.09 * bend;
    p.y *= 0.80 + 0.34 * ( 0.5 + 0.5 * sin( uTime * 9.1 + aPhase * 3.1 ) );

    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( p, 1.0 );
  }
`;

const FLAME_FRAGMENT = /* glsl */`
  varying float vT;
  varying vec3 vTint;

  void main() {
    // Three flat bands, hard-edged, like everything else in the picture: a pale
    // core, the body of the flame, and a dull red at the tip where it is dying.
    vec3 c = vT < 0.30 ? vec3( 1.00, 0.93, 0.68 )
           : vT < 0.62 ? vec3( 1.00, 0.58, 0.13 )
                       : vec3( 0.88, 0.20, 0.04 );
    gl_FragColor = vec4( c * vTint, 1.0 - smoothstep( 0.55, 1.0, vT ) );
  }
`;

interface TorchSite {
  x: number;
  y: number;
  z: number;
  color: number;
  /** Phase offset so flames don't flicker in lockstep. */
  phase: number;
}

export class TorchSystem {
  readonly group = new THREE.Group();

  private readonly map: TileMap;
  private sites: TorchSite[] = [];
  private lastVersion = -1;

  private readonly points: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;
  private readonly lights: THREE.PointLight[] = [];

  /** The visible fire, and the iron cup it burns in. */
  private readonly flameMesh: THREE.InstancedMesh;
  private readonly flameMaterial: THREE.ShaderMaterial;
  private readonly phaseAttr: THREE.InstancedBufferAttribute;
  private readonly tintAttr: THREE.InstancedBufferAttribute;
  private readonly sconceMesh: THREE.InstancedMesh;
  private readonly sconceMaterial: THREE.MeshToonMaterial;
  private readonly clock: THREE.IUniform<number> = { value: 0 };
  private readonly dummy = new THREE.Object3D();

  private positions = new Float32Array(0);
  private colors = new Float32Array(0);
  private sizes = new Float32Array(0);

  constructor(map: TileMap) {
    this.map = map;

    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.PointsMaterial({
      map: makeGlowTexture(96, 'rgba(255,244,220,1)'),
      size: 0.9,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.group.add(this.points);

    // A teardrop, not a cone: the widest point is a third of the way up, which
    // is where a flame actually is widest, and a plain cone reads as a hat.
    const flameGeo = new THREE.LatheGeometry(
      [
        new THREE.Vector2(0.001, 0),
        new THREE.Vector2(0.088, FLAME_HEIGHT * 0.16),
        new THREE.Vector2(0.108, FLAME_HEIGHT * 0.36),
        new THREE.Vector2(0.078, FLAME_HEIGHT * 0.66),
        new THREE.Vector2(0.033, FLAME_HEIGHT * 0.88),
        new THREE.Vector2(0.001, FLAME_HEIGHT),
      ],
      7,
    );
    this.phaseAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FLAMES), 1);
    this.tintAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FLAMES * 3), 3);
    flameGeo.setAttribute('aPhase', this.phaseAttr);
    flameGeo.setAttribute('aTint', this.tintAttr);
    this.flameMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: this.clock },
      vertexShader: FLAME_VERTEX,
      fragmentShader: FLAME_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.flameMesh = new THREE.InstancedMesh(flameGeo, this.flameMaterial, MAX_FLAMES);
    this.flameMesh.count = 0;
    this.flameMesh.frustumCulled = false;
    this.flameMesh.renderOrder = 3;
    this.group.add(this.flameMesh);

    // The sconce. Small, dark, and lit like the rest of the dungeon rather than
    // glowing — it is the one part of a torch that is not on fire.
    const sconceGeo = new THREE.CylinderGeometry(0.075, 0.042, 0.10, 6);
    sconceGeo.translate(0, -0.05, 0);
    this.sconceMaterial = new THREE.MeshToonMaterial({
      color: 0x2c2724,
      gradientMap: celRamp(),
    });
    this.sconceMesh = new THREE.InstancedMesh(sconceGeo, this.sconceMaterial, MAX_FLAMES);
    this.sconceMesh.count = 0;
    this.sconceMesh.frustumCulled = false;
    this.group.add(this.sconceMesh);

    for (let i = 0; i < LIVE_LIGHTS; i++) {
      const light = new THREE.PointLight(0xffb066, 0, 10.5, 1.5);
      light.castShadow = false;
      this.lights.push(light);
      this.group.add(light);
    }
  }

  /** Recompute torch placement when the dungeon changes shape. */
  syncIfDirty(): void {
    if (this.map.version === this.lastVersion) return;
    this.lastVersion = this.map.version;
    this.rebuild();
  }

  private rebuild(): void {
    const map = this.map;
    const sites: TorchSite[] = [];

    for (let y = 1; y < map.height - 1; y++) {
      for (let x = 1; x < map.width - 1; x++) {
        const i = map.idx(x, y);
        if ((map.flags[i] & FLAG_REVEALED) === 0) continue;
        const terrain = map.terrain[i] as Terrain;

        // A torch hangs on any wall facing floor a keeper has claimed. It is
        // the claim that lights the corridor, not the masonry — which is why
        // your starting dungeon glows before a single wall is reinforced.
        if (!isSolid(terrain)) continue;

        // Space them out so corridors get a rhythm rather than a wall of fire.
        if (((x * 3 + y * 5) % 4) !== 0) continue;

        const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
        for (const [dx, dy] of dirs) {
          const nx = x + dx, ny = y + dy;
          if (!map.inBounds(nx, ny)) continue;
          const j = map.idx(nx, ny);
          if (map.terrain[j] !== Terrain.Claimed) continue;
          const owner = map.owner[j] as Owner;
          if (owner === Owner.None) continue;
          sites.push({
            x: x + dx * 0.52,
            y: y + dy * 0.52,
            z: WALL_HEIGHT * 0.72,
            color: OWNER_COLORS[owner],
            phase: (x * 7 + y * 13) % 10,
          });
          break;
        }
      }
    }

    this.sites = sites;
    const n = sites.length;
    this.positions = new Float32Array(n * 3);
    this.colors = new Float32Array(n * 3);
    this.sizes = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.positions[i * 3] = sites[i].x;
      this.positions[i * 3 + 1] = sites[i].z;
      this.positions[i * 3 + 2] = sites[i].y;
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.computeBoundingSphere();

    // Place the fire and its sconce. Both are static once placed; only the
    // shader and the per-instance tint move afterwards.
    const drawn = Math.min(n, MAX_FLAMES);
    for (let i = 0; i < drawn; i++) {
      const s = sites[i];
      this.dummy.position.set(s.x, s.z, s.y);
      this.dummy.rotation.set(0, (i * 2.39996) % (Math.PI * 2), 0);
      // A row of identically sized flames is a fence. Vary them a little.
      const scale = 0.85 + ((i * 37) % 11) / 33;
      this.dummy.scale.set(scale, scale * (0.9 + ((i * 53) % 7) / 20), scale);
      this.dummy.updateMatrix();
      this.flameMesh.setMatrixAt(i, this.dummy.matrix);
      this.sconceMesh.setMatrixAt(i, this.dummy.matrix);
      this.phaseAttr.setX(i, s.phase * 1.7 + i * 0.61);
    }
    this.flameMesh.count = drawn;
    this.sconceMesh.count = drawn;
    this.flameMesh.instanceMatrix.needsUpdate = true;
    this.sconceMesh.instanceMatrix.needsUpdate = true;
    this.phaseAttr.needsUpdate = true;
  }

  /**
   * Flicker every torch, and hand the nearest ones to the real lights.
   * `focus` is where the camera is looking.
   */
  update(time: number, focus: THREE.Vector3): void {
    const n = this.sites.length;
    if (n === 0) {
      for (const l of this.lights) l.intensity = 0;
      return;
    }

    const colorAttr = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color();

    for (let i = 0; i < n; i++) {
      const s = this.sites[i];
      // Two out-of-phase sines plus a fast tremor: reads as a live flame.
      const f = 0.68 + 0.22 * Math.sin(time * 6.1 + s.phase)
        + 0.12 * Math.sin(time * 17.3 + s.phase * 3);
      // Fire is fire: start from a warm flame and let the keeper's banner
      // colour only tint it. Driving straight off the banner hue made every
      // corridor blood red rather than firelit.
      c.setHex(0xffb45a)
        .lerp(TORCH_TINT.setHex(s.color), 0.22)
        .multiplyScalar(f * 1.35);
      this.colors[i * 3] = c.r;
      this.colors[i * 3 + 1] = c.g;
      this.colors[i * 3 + 2] = c.b;
      // The flame wears the same colour as the halo around it, at a fraction of
      // the strength: the shader supplies the shape, this only tints it.
      if (i < MAX_FLAMES) {
        this.tintAttr.setXYZ(i, 0.55 + c.r * 0.30, 0.55 + c.g * 0.30, 0.55 + c.b * 0.30);
      }
    }
    colorAttr.needsUpdate = true;
    this.tintAttr.needsUpdate = true;
    this.clock.value = time;

    // Promote the closest torches to real lights.
    const scored: Array<{ i: number; d: number }> = [];
    for (let i = 0; i < n; i++) {
      const s = this.sites[i];
      const dx = s.x - focus.x, dz = s.y - focus.z;
      scored.push({ i, d: dx * dx + dz * dz });
    }
    scored.sort((a, b) => a.d - b.d);

    for (let k = 0; k < this.lights.length; k++) {
      const light = this.lights[k];
      const entry = scored[k];
      if (!entry) { light.intensity = 0; continue; }
      const s = this.sites[entry.i];
      light.position.set(s.x, s.z, s.y);
      light.color.setRGB(
        this.colors[entry.i * 3],
        this.colors[entry.i * 3 + 1],
        this.colors[entry.i * 3 + 2],
      );
      // Fade out with distance so lights swapping in and out doesn't pop.
      const fade = THREE.MathUtils.clamp(1 - entry.d / 420, 0, 1);
      light.intensity = 15 * fade;
      light.distance = 10.5;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.flameMesh.geometry.dispose();
    this.flameMaterial.dispose();
    this.sconceMesh.geometry.dispose();
    this.sconceMaterial.dispose();
  }
}

/* ------------------------------------------------------------ particles -- */

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  maxLife: number;
  size: number;
  r: number; g: number; b: number;
  gravity: number;
}

const MAX_PARTICLES = 1400;

/** How each game event looks when it happens. */
const EFFECT_STYLES: Record<string, {
  count: number; color: [number, number, number]; speed: number;
  size: number; life: number; gravity: number; rise: number;
}> = {
  dig: { count: 5, color: [0.55, 0.40, 0.26], speed: 1.6, size: 0.16, life: 0.5, gravity: -5, rise: 0.4 },
  claim: { count: 10, color: [1.0, 0.42, 0.28], speed: 1.2, size: 0.22, life: 0.9, gravity: 1.2, rise: 0.2 },
  gold: { count: 14, color: [1.3, 0.95, 0.30], speed: 2.0, size: 0.20, life: 0.8, gravity: -4, rise: 0.5 },
  poof: { count: 20, color: [0.7, 0.55, 0.85], speed: 2.2, size: 0.30, life: 1.0, gravity: 0.6, rise: 0.3 },
  hit: { count: 8, color: [1.4, 0.22, 0.16], speed: 2.4, size: 0.16, life: 0.45, gravity: -3, rise: 0.6 },
  slap: { count: 10, color: [1.5, 1.1, 0.5], speed: 2.6, size: 0.16, life: 0.4, gravity: -2, rise: 0.7 },
  heal: { count: 16, color: [0.35, 1.4, 0.55], speed: 1.0, size: 0.24, life: 1.2, gravity: 1.8, rise: 0.2 },
  lightning: { count: 40, color: [0.7, 0.9, 1.6], speed: 4.0, size: 0.26, life: 0.7, gravity: -1, rise: 1.2 },
  haste: { count: 12, color: [1.5, 1.25, 0.35], speed: 1.6, size: 0.18, life: 0.7, gravity: 1.0, rise: 0.4 },
  rally: { count: 30, color: [1.5, 0.65, 0.2], speed: 2.4, size: 0.28, life: 1.1, gravity: 1.4, rise: 0.3 },
  levelup: { count: 22, color: [1.4, 1.2, 0.5], speed: 1.4, size: 0.24, life: 1.3, gravity: 2.0, rise: 0.1 },
  build: { count: 16, color: [0.8, 0.75, 0.65], speed: 1.6, size: 0.24, life: 0.8, gravity: -2, rise: 0.4 },
  drop: { count: 12, color: [0.6, 0.5, 0.4], speed: 1.8, size: 0.20, life: 0.5, gravity: -4, rise: 0.2 },
  grab: { count: 10, color: [1.2, 0.5, 1.2], speed: 1.4, size: 0.20, life: 0.5, gravity: 1.5, rise: 0.4 },
  eat: { count: 6, color: [1.0, 0.85, 0.55], speed: 1.2, size: 0.14, life: 0.5, gravity: -3, rise: 0.5 },
  sleep: { count: 3, color: [0.5, 0.6, 1.0], speed: 0.4, size: 0.18, life: 1.8, gravity: 0.9, rise: 0.6 },
  train: { count: 8, color: [1.2, 1.0, 0.9], speed: 1.8, size: 0.16, life: 0.4, gravity: -3, rise: 0.6 },
  research: { count: 8, color: [0.5, 0.7, 1.5], speed: 0.8, size: 0.22, life: 1.4, gravity: 1.2, rise: 0.5 },
};

export class ParticleSystem {
  readonly points: THREE.Points;

  private readonly particles: Particle[] = [];
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;
  private readonly positions = new Float32Array(MAX_PARTICLES * 3);
  private readonly colors = new Float32Array(MAX_PARTICLES * 3);
  private consumed = 0;
  private highestSeen = 0;

  constructor() {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.PointsMaterial({
      map: makePuffTexture(64),
      size: 0.28,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      opacity: 0.95,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  /** Turn queued game events into particles, then step the simulation. */
  update(effects: readonly GameEffect[], dt: number): void {
    // Effects carry a monotonic id because the game splices finished ones out
    // of the middle of the list — tracking a position into the array would
    // silently skip events every time it shrank.
    for (const e of effects) {
      if (e.seq <= this.consumed) continue;
      this.spawn(e.kind, e.x, e.y);
      if (e.seq > this.highestSeen) this.highestSeen = e.seq;
    }
    this.consumed = this.highestSeen;

    let write = 0;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.03) { p.y = 0.03; p.vy = Math.abs(p.vy) * 0.25; }
    }

    for (const p of this.particles) {
      if (write >= MAX_PARTICLES) break;
      const fade = Math.min(1, p.life / p.maxLife);
      this.positions[write * 3] = p.x;
      this.positions[write * 3 + 1] = p.y;
      this.positions[write * 3 + 2] = p.z;
      this.colors[write * 3] = p.r * fade;
      this.colors[write * 3 + 1] = p.g * fade;
      this.colors[write * 3 + 2] = p.b * fade;
      write++;
    }
    this.geometry.setDrawRange(0, write);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Reset the event cursor — call when starting a fresh level. */
  resetCursor(): void {
    this.consumed = 0;
    this.highestSeen = 0;
  }

  spawn(kind: string, x: number, y: number): void {
    const style = EFFECT_STYLES[kind] ?? EFFECT_STYLES.poof;
    for (let i = 0; i < style.count; i++) {
      if (this.particles.length >= MAX_PARTICLES) return;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * style.speed;
      this.particles.push({
        x: x + (Math.random() - 0.5) * 0.4,
        y: 0.25 + Math.random() * 0.4,
        z: y + (Math.random() - 0.5) * 0.4,
        vx: Math.cos(a) * r,
        vy: style.rise * style.speed * (0.5 + Math.random()),
        vz: Math.sin(a) * r,
        life: style.life * (0.7 + Math.random() * 0.6),
        maxLife: style.life,
        size: style.size,
        r: style.color[0], g: style.color[1], b: style.color[2],
        gravity: style.gravity,
      });
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
