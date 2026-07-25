import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export interface QualitySettings {
  /** Bloom makes torches and lava read as light rather than paint. */
  bloom: boolean;
  shadows: boolean;
  /** Upper bound on device pixel ratio. */
  maxPixelRatio: number;
}

/** Pick sensible defaults from what the device tells us about itself. */
export function detectQuality(): QualitySettings {
  const dpr = window.devicePixelRatio || 1;
  const cores = navigator.hardwareConcurrency ?? 4;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  // Phones and tablets get the cheaper rig; they're also the ones with the
  // highest pixel ratios, so capping resolution matters more than effects.
  const lowPower = coarse || cores <= 4;
  return {
    bloom: !lowPower,
    shadows: !lowPower,
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
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;

  readonly sun: THREE.DirectionalLight;
  private readonly bloomPass: UnrealBloomPass | null;
  private quality: QualitySettings;

  constructor(canvas: HTMLCanvasElement, quality = detectQuality()) {
    this.quality = quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !quality.bloom, // bloom pass does its own resolve; MSAA is wasted
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(0x05040a);
    // Exponential fog swallows the far side of the map — you only ever see
    // your own lit corner, which is exactly how the original reads.
    this.scene.fog = new THREE.FogExp2(0x07050c, 0.030);

    this.camera = new THREE.PerspectiveCamera(
      52, window.innerWidth / window.innerHeight, 0.35, 220,
    );
    this.camera.position.set(0, 18, 18);

    /* ---- lighting ---- */
    const ambient = new THREE.AmbientLight(0x2a2740, 1.15);
    this.scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0x3c3a58, 0x2a1a10, 0.85);
    this.scene.add(hemi);

    // A cold key light from above: enough to read silhouettes and cast shadows,
    // never enough to make the place feel outdoors.
    this.sun = new THREE.DirectionalLight(0x93a4d8, 0.95);
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
        0.62, // strength
        0.55, // radius
        0.62, // threshold — only genuinely bright things bloom
      );
      this.composer.addPass(this.bloomPass);
    } else {
      this.bloomPass = null;
    }
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', this.onResize);
  }

  private onResize = (): void => {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.maxPixelRatio));
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloomPass?.setSize(w, h);
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
  }

  getQuality(): QualitySettings {
    return this.quality;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.composer.dispose();
    this.renderer.dispose();
  }
}
