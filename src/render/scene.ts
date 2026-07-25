import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ISO_STANDOFF } from '../input/cameraController';

/**
 * Final colour grade.
 *
 * Runs after tone mapping and the sRGB conversion, so it operates on display
 * values. Three jobs: lift the blacks slightly toward blue so shadow areas read
 * as dark *space* rather than as holes in the frame, push saturation and
 * contrast — ACES leaves everything tastefully desaturated, which on a dim
 * dungeon reads as grey mud — and close the frame with a vignette.
 */
const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSaturation: { value: 1.16 },
    uContrast: { value: 1.18 },
    // Lift is warm. It used to be blue, which put a cold cast into every shadow
    // in the dungeon — the exact thing the art direction forbids.
    uLift: { value: new THREE.Vector3(0.016, 0.007, 0.003) },
    uGain: { value: new THREE.Vector3(1.06, 0.99, 0.94) },
    uVignette: { value: 0.5 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uSaturation;
    uniform float uContrast;
    uniform vec3 uLift;
    uniform vec3 uGain;
    uniform float uVignette;
    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D( tDiffuse, vUv );
      vec3 c = texel.rgb;

      // Lift and gain: warm the shadows toward ember, cool nothing.
      c = c * uGain + uLift * ( 1.0 - c );

      // Contrast about mid grey.
      c = ( c - 0.5 ) * uContrast + 0.5;

      // Saturation about luminance.
      float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
      c = mix( vec3( l ), c, uSaturation );

      // Vignette, to keep the eye in the middle of the dungeon.
      float d = distance( vUv, vec2( 0.5 ) );
      c *= 1.0 - uVignette * smoothstep( 0.32, 0.92, d );

      gl_FragColor = vec4( clamp( c, 0.0, 1.0 ), texel.a );
    }`,
};

export interface QualitySettings {
  /** Bloom makes torches and lava read as light rather than paint. */
  bloom: boolean;
  shadows: boolean;
  /** Edge anti-aliasing. Cheap, and the single biggest tidiness win. */
  smaa: boolean;
  /** Upper bound on device pixel ratio. */
  maxPixelRatio: number;
}

/**
 * A little environment to reflect.
 *
 * Metal without an environment map is not metal — it is a flat grey surface
 * with a highlight, which is why the gold heaps and iron doors read as painted
 * cardboard however carefully their roughness is set. There is no sky down here
 * to sample, so this bakes a plausible one: a warm floor bounce from all the
 * torchlight and lava, cool near-black overhead, and a hot band at the horizon
 * where the fires are. Rendered once into a PMREM and never touched again.
 */
function buildDungeonEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();

  // A large inward-facing sphere carrying the gradient, as vertex colours so no
  // shader or texture is needed.
  const geo = new THREE.SphereGeometry(10, 24, 16);
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const pos = geo.attributes.position;
  const up = new THREE.Color(0x14061c).convertSRGBToLinear();
  const horizon = new THREE.Color(0xff6b00).convertSRGBToLinear();
  const down = new THREE.Color(0x7a2c08).convertSRGBToLinear();
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const y = pos.getY(i) / 10;
    if (y >= 0) {
      // Above the horizon: fade quickly to a cold ceiling.
      c.copy(horizon).lerp(up, Math.min(1, Math.pow(y, 0.55)));
    } else {
      // Below: the floor bounce, warm and dimmer than the fires themselves.
      c.copy(horizon).lerp(down, Math.min(1, Math.pow(-y, 0.7)));
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
  })));

  // Three bright patches standing in for nearby torches, so a curved metal
  // surface gets moving highlights instead of one flat wash.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const flame = new THREE.Mesh(
      new THREE.SphereGeometry(1.5, 10, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff8c00).convertSRGBToLinear() }),
    );
    flame.position.set(Math.cos(a) * 7, -0.6, Math.sin(a) * 7);
    scene.add(flame);
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromScene(scene, 0.04);
  pmrem.dispose();
  geo.dispose();
  return target.texture;
}

/**
 * Pick sensible defaults from what the device tells us about itself.
 *
 * A touch screen alone is a poor signal: a current iPad will out-render plenty
 * of laptops, and treating it as a phone throws away the lighting for nothing.
 * Core count plus physical screen size separates the two reasonably well, and
 * anything the guess gets wrong is caught by the adaptive step-down below.
 */
export function detectQuality(): QualitySettings {
  const dpr = window.devicePixelRatio || 1;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const shortEdge = Math.min(window.screen.width, window.screen.height);

  // `?quality=high` / `?quality=low` forces the issue, which is the only
  // reliable way to check what a specific device can really do.
  const forced = new URLSearchParams(location.search).get('quality');
  if (forced === 'high' || forced === 'low') {
    const high = forced === 'high';
    return {
      bloom: high, shadows: high, smaa: high,
      maxPixelRatio: high ? Math.min(dpr, 2) : 1,
    };
  }

  // Deliberately *not* `?? 4`: a browser that doesn't report core count would
  // then be treated as weak and never get the lighting, and the adaptive
  // step-down below only ever goes one way. Unknown is assumed capable, and
  // measured frame rate corrects it within seconds if that was wrong.
  const cores = navigator.hardwareConcurrency;
  const fewCores = cores !== undefined && cores <= 4;
  const phoneSized = coarse && shortEdge < 500;
  const lowPower = fewCores || phoneSized;

  return {
    bloom: !lowPower,
    shadows: !lowPower,
    // Worth it even on weak hardware: one full-screen pass buys more apparent
    // quality than anything else here, and the alternative is jagged edges on
    // every wall in the dungeon.
    smaa: true,
    // Tablets and phones run at 2x or 3x; rendering every one of those pixels
    // is where the frame budget actually goes.
    maxPixelRatio: lowPower ? Math.min(dpr, 1.5) : Math.min(dpr, 2),
  };
}

/**
 * The rendering rig: a dark, torchlit stage.
 *
 * Ambient light is kept deliberately near-black. Almost everything you see is
 * lit by torches, lava and the keeper's own spells, which is what gives the
 * original its claustrophobic, underground feel — turn the ambient up and it
 * immediately stops looking like a dungeon.
 */
export class SceneRig {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;

  readonly sun: THREE.DirectionalLight;
  /** The baked dungeon reflection, applied to every standard material. */
  readonly environment: THREE.Texture;
  private readonly bloomPass: UnrealBloomPass | null;
  private readonly smaaPass: SMAAPass;
  private readonly gradePass: ShaderPass;
  private quality: QualitySettings;

  constructor(canvas: HTMLCanvasElement, quality = detectQuality()) {
    this.quality = quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // MSAA never applied here: the composer renders to its own target, so the
      // canvas's own multisampling does nothing at all. Edges are handled by an
      // SMAA pass at the end of the chain instead, which does work.
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.7;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Everything metal in the dungeon reflects this: gold heaps, iron doors,
    // anvils, and the armour a veteran creature earns. Set on the scene so it
    // applies to every standard material without touching each one.
    this.environment = buildDungeonEnvironment(this.renderer);
    this.scene.environment = this.environment;
    // Carries most of the light on creatures, which are the thing you actually
    // look at. Terrain materials pull their own intensity down so the walls do
    // not wash out with it.
    this.scene.environmentIntensity = 0.85;

    this.scene.background = new THREE.Color(0x080402);
    // Linear fog, banded around where the dungeon actually sits in view depth.
    //
    // Exponential fog is wrong under an orthographic camera: density is measured
    // from the eye, and the eye is parked eighty units back regardless of zoom,
    // so every tile came out at 99% fog and the screen went black. Linear fog
    // anchored to the standoff fogs by *scene* depth, which is the thing worth
    // cueing. Tinted with the lava, so distance reads as smoke lit from below.
    this.scene.fog = new THREE.Fog(0x1a0a04, ISO_STANDOFF - 14, ISO_STANDOFF + 30);

    // Orthographic, because the brief is a strictly isometric game and a
    // perspective camera is not one: parallel walls converge, a tile at the top
    // of the screen is smaller than a tile at the bottom, and the tile grid
    // stops being a grid. The frustum is sized in `onResize` and scaled by the
    // camera controller's zoom.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, ISO_STANDOFF + 90);
    this.camera.position.set(0, 18, 18);
    this.sizeCamera(window.innerWidth, window.innerHeight);

    /* ---- lighting ---- */
    //
    // The scene lives or dies on warm/cool separation. Fill is cool and dim so
    // unlit stone reads as blue shadow rather than brown mud; everything warm
    // comes from fire. Flat neutral fill was what made this look muddy.
    // Every light in this dungeon is fire or magic. The fill used to be a cool
    // blue, which is the one thing the art direction rules out outright: cool
    // daylight makes a cave read as an overcast quarry. Ambient is near-black,
    // and what little of it there is comes from the lava.
    const ambient = new THREE.AmbientLight(0x3d1e10, 0.5);
    this.scene.add(ambient);

    // Warm from below — bounce off molten rock — and a faint magical wash from
    // above rather than a sky.
    const hemi = new THREE.HemisphereLight(0x3a1a44, 0x7a3410, 0.9);
    this.scene.add(hemi);

    // The key is firelight from high up, around 2000 K. It exists to read
    // silhouettes and cast shadows; it must never suggest a sky.
    this.sun = new THREE.DirectionalLight(0xff8c3a, 0.85);
    this.sun.position.set(14, 30, 10);
    this.sun.castShadow = quality.shadows;
    if (quality.shadows) {
      this.sun.shadow.mapSize.set(2048, 2048);
      this.sun.shadow.camera.near = 1;
      this.sun.shadow.camera.far = 90;
      const extent = 26;
      this.sun.shadow.camera.left = -extent;
      this.sun.shadow.camera.right = extent;
      this.sun.shadow.camera.top = extent;
      this.sun.shadow.camera.bottom = -extent;
      this.sun.shadow.bias = -0.0009;
      this.sun.shadow.normalBias = 0.03;
    }
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    /* ---- post-processing ---- */
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    if (quality.bloom) {
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.85, // strength — torches should visibly bleed into the dark
        0.70, // radius
        0.50, // threshold
      );
      this.composer.addPass(this.bloomPass);
    } else {
      this.bloomPass = null;
    }
    this.composer.addPass(new OutputPass());

    // Final grade, after tone mapping and the sRGB conversion, so it works in
    // display space where the numbers mean what they look like.
    this.gradePass = new ShaderPass(GRADE_SHADER);
    this.composer.addPass(this.gradePass);

    // Anti-aliasing last, on the graded image, so it smooths what is actually
    // on screen rather than something the grade then re-sharpens.
    this.smaaPass = new SMAAPass(window.innerWidth, window.innerHeight);
    this.smaaPass.enabled = quality.smaa;
    this.composer.addPass(this.smaaPass);

    window.addEventListener('resize', this.onResize);
  }

  /** Frustum bounds for the current viewport. Zoom does the rest. */
  private sizeCamera(w: number, h: number): void {
    const half = 1;
    const aspect = w / Math.max(1, h);
    this.camera.left = -half * aspect;
    this.camera.right = half * aspect;
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
  }

  private onResize = (): void => {
    const w = window.innerWidth, h = window.innerHeight;
    this.sizeCamera(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.maxPixelRatio));
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloomPass?.setSize(w, h);
    this.gradePass.setSize(w, h);
    this.smaaPass.setSize(w, h);
  };

  /** Keep the shadow frustum tracking whatever the camera is looking at. */
  followTarget(target: THREE.Vector3): void {
    this.sun.position.set(target.x + 14, 30, target.z + 10);
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
  }

  render(): void {
    this.composer.render();
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.sun.castShadow = quality.shadows;
    if (this.bloomPass) this.bloomPass.enabled = quality.bloom;
    this.smaaPass.enabled = quality.smaa;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
  }

  getQuality(): QualitySettings {
    return this.quality;
  }

  /** How many times quality has already been stepped down. */
  private downgrades = 0;
  private lastDowngradeAt = 0;
  /** Seconds to wait after a step-down before judging the result. */
  private static readonly DOWNGRADE_COOLDOWN = 6;

  /**
   * Adaptive fallback: if the device cannot hold a playable frame rate, shed
   * the expensive things in order of cost. Guessing hardware from feature
   * detection is unreliable, so this measures instead — and it only ever steps
   * down, so it cannot oscillate.
   *
   * Returns a short description when something changed, for the message log.
   */
  considerPerformance(fps: number): string | null {
    if (this.downgrades >= 4 || fps <= 0 || fps > 38) return null;

    // Give each change time to actually take effect. Without this the check
    // fires again on the next sample and burns through every downgrade in
    // about a second, which is both wrong and visibly noisy in the log.
    const now = performance.now() / 1000;
    if (now - this.lastDowngradeAt < SceneRig.DOWNGRADE_COOLDOWN) return null;
    this.lastDowngradeAt = now;

    this.downgrades++;
    const next = { ...this.quality };
    let what: string;

    if (next.bloom) {
      next.bloom = false;
      what = 'bloom';
    } else if (next.smaa) {
      next.smaa = false;
      what = 'edge smoothing';
    } else if (next.shadows) {
      next.shadows = false;
      what = 'shadows';
    } else {
      next.maxPixelRatio = Math.max(1, next.maxPixelRatio * 0.75);
      what = 'resolution';
    }

    this.setQuality(next);
    return `Frame rate was low, so ${what} has been turned down.`;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.composer.dispose();
    this.environment.dispose();
    this.renderer.dispose();
  }
}
