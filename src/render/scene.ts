import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

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
    uSaturation: { value: 1.22 },
    uContrast: { value: 1.26 },
    // Teal shadows, warm highlights: the oldest trick there is, and the one the
    // all-warm pass threw away. Lift is cool, gain is warm, so the two ends of
    // the range pull apart instead of agreeing.
    uLift: { value: new THREE.Vector3(0.004, 0.013, 0.020) },
    uGain: { value: new THREE.Vector3(1.10, 1.0, 0.90) },
    uVignette: { value: 0.44 },
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

      // Lift and gain: cool the shadows, warm the highlights.
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

/**
 * Ink lines, from a Sobel on scene depth.
 *
 * The single biggest thing separating low-poly that reads as *chosen* from
 * low-poly that reads as unfinished. Our creatures are merged spheres and boxes
 * and no amount of shading was going to hide that; an outline stops trying to
 * hide it and makes the simplicity look deliberate.
 *
 * Depth rather than normals: it needs one buffer we already have, it catches
 * silhouettes and object-against-object edges, and it deliberately does *not*
 * draw a line down every crease in a wall, which would turn a dungeon of stone
 * blocks into graph paper.
 *
 * It runs in linear space, before tone mapping, because of where the depth
 * lives — see `InkPass` for why that is not negotiable.
 */
const EDGE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 800) },
    // Applied to linear radiance, not to display values: a line has to be a big
    // multiplicative cut here to survive tone mapping as a visible dark line.
    uStrength: { value: 0.92 },
    uThreshold: { value: 0.055 },
    uNear: { value: 1 },
    uFar: { value: 200 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uTexel;
    uniform float uStrength;
    uniform float uThreshold;
    uniform float uNear;
    uniform float uFar;
    varying vec2 vUv;

    float viewDepth( vec2 uv ) {
      float d = texture2D( tDepth, uv ).x;
      // Perspective depth is heavily non-linear; comparing raw buffer values
      // would put every outline in the first metre of the scene and none
      // anywhere else.
      return perspectiveDepthToViewZ( d, uNear, uFar );
    }

    void main() {
      vec4 base = texture2D( tDiffuse, vUv );
      float c = viewDepth( vUv );
      float l = viewDepth( vUv - vec2( uTexel.x, 0.0 ) );
      float r = viewDepth( vUv + vec2( uTexel.x, 0.0 ) );
      float u = viewDepth( vUv + vec2( 0.0, uTexel.y ) );
      float d = viewDepth( vUv - vec2( 0.0, uTexel.y ) );

      float edge = max( max( abs( c - l ), abs( c - r ) ),
                        max( abs( c - u ), abs( c - d ) ) );
      // Scaled by depth so a distant silhouette gets the same weight of line as
      // a near one; without this the far half of the dungeon has no outlines.
      edge /= max( 1.0, abs( c ) * 0.08 );

      float ink = smoothstep( uThreshold, uThreshold * 3.5, edge );
      gl_FragColor = vec4( base.rgb * ( 1.0 - ink * uStrength ), base.a );
    }`,
};

/**
 * The ink pass, wired so it cannot read the buffer it is writing.
 *
 * This is the whole reason the outlines were invisible on desktop and turned the
 * screen *black* on iOS, which is worth writing down because nothing about it is
 * obvious from the outside.
 *
 * `EffectComposer` ping-pongs between two targets: it takes the one you hand it
 * and clones it for the second. Two things follow from that, and together they
 * are fatal.
 *
 * `RenderPass` renders the scene into the composer's *read* buffer, which is the
 * clone — not the target we constructed and pointed the shader's `tDepth` at. So
 * the depth we sampled belonged to a buffer the scene was never drawn into.
 *
 * And the clone's depth texture is not a second texture. `Texture.clone()` copies
 * the `Source`, and three keys the GL texture off the source, so both targets were
 * attached to the *same* depth buffer. Sampling it therefore meant sampling
 * whatever framebuffer this pass was drawing into: a feedback loop, undefined
 * behaviour, and the driver decides what you get. Chromium drops the draw
 * (`GL_INVALID_OPERATION: Feedback loop formed between Framebuffer and active
 * Texture`), so the write target keeps whatever it held and every pass after it —
 * the SMAA resolve, and so the screen — comes out black.
 *
 * Two halves to the fix, and neither works alone. The constructor gives the second
 * target a depth texture of its own, so the two are genuinely separate and the
 * scene's depth is somewhere readable. This class then takes `tDepth` from
 * `readBuffer` at render time: that is the buffer the previous pass drew into, it
 * is never the buffer being written, and it tracks the ping-pong for free — which
 * matters, because the number of swapping passes changes with the quality
 * settings, so the parity is not fixed.
 *
 * The cost is position: the read buffer only holds the *scene* while this pass
 * sits directly after `RenderPass`. So the ink now lands in linear radiance,
 * before tone mapping, which gives up the "bloom cannot bleed over the lines"
 * property the old late placement bought, and is why `uStrength` is a much deeper
 * cut than display-space values would need.
 */
class InkPass extends ShaderPass {
  constructor() {
    super(EDGE_SHADER);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    // Late-bound on purpose. Which of the composer's two targets is the read
    // buffer depends on how many swapping passes ran before this one, which
    // depends on the quality settings, which change at runtime.
    this.material.uniforms.tDepth.value = readBuffer.depthTexture ?? null;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}

export interface QualitySettings {
  /** Bloom makes torches and lava read as light rather than paint. */
  bloom: boolean;
  shadows: boolean;
  /** Edge anti-aliasing. Cheap, and the single biggest tidiness win. */
  smaa: boolean;
  /** Ink outlines. What makes the stylisation read as a style. */
  outlines: boolean;
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
  const up = new THREE.Color(0x16323e).convertSRGBToLinear();
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
      bloom: high, shadows: high, smaa: high, outlines: true,
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
    // Likewise. This is the art direction, not a garnish — without it the game
    // is low-poly pretending not to be.
    outlines: true,
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
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;

  readonly sun: THREE.DirectionalLight;
  /** The baked dungeon reflection, applied to every standard material. */
  readonly environment: THREE.Texture;
  private readonly bloomPass: UnrealBloomPass | null;
  private readonly smaaPass: SMAAPass;
  private readonly edgePass: InkPass;
  private readonly gradePass: ShaderPass;
  private readonly canvas: HTMLCanvasElement;
  private quality: QualitySettings;

  /**
   * The size to render at, taken from the canvas rather than from `window`.
   *
   * `window.innerHeight` and the height the canvas actually occupies are not the
   * same number on a phone. iOS Safari's toolbars come and go, and `innerHeight`
   * reports the large viewport while a `position: fixed` element is laid out
   * against the small one — so sizing the drawing buffer from `window` renders a
   * frame that is taller than the box it is being shown in, and the browser
   * scales the difference away. The canvas's own client box is the truth.
   */
  private viewportSize(): { width: number; height: number } {
    // Before layout has run the client box is 0, and a zero-sized drawing buffer
    // is not something the rest of this survives. Fall back to the window then.
    return {
      width: this.canvas.clientWidth || window.innerWidth,
      height: this.canvas.clientHeight || window.innerHeight,
    };
  }

  constructor(canvas: HTMLCanvasElement, quality = detectQuality()) {
    this.quality = quality;
    this.canvas = canvas;
    const { width, height } = this.viewportSize();

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
    this.renderer.setSize(width, height, false);
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
    // Held down on purpose. A strong environment term is what makes a surface
    // look photographed; the stylisation wants flat blocks of colour with the
    // light doing the shaping.
    this.scene.environmentIntensity = 0.42;

    this.scene.background = new THREE.Color(0x070d11);
    // Exponential fog swallows the far side of the map — you only ever see your
    // own lit corner. Tinted cool, so distance reads as cold depth against the
    // warm firelight in the foreground rather than as an absence of geometry.
    this.scene.fog = new THREE.FogExp2(0x0e1a20, 0.026);

    this.camera = new THREE.PerspectiveCamera(52, width / height, 0.35, 220);
    this.camera.position.set(0, 18, 18);

    /* ---- lighting ---- */
    //
    // The scene lives or dies on warm/cool separation. Fill is cool and dim so
    // unlit stone reads as blue shadow rather than brown mud; everything warm
    // comes from fire. Flat neutral fill was what made this look muddy.
    // Warm key against cool shadow. The brief said warm light only, and taken
    // literally that produced a monochrome orange scene with no colour depth at
    // all: with nothing cool to push against, every surface sat at the same hue
    // and the image went flat. The fire stays warm — it is still the only light
    // anything is *lit by* — but the shadows it does not reach fall cool, which
    // is what gives a fire-lit room its depth.
    const ambient = new THREE.AmbientLight(0x24404c, 1.35);
    this.scene.add(ambient);

    // Cool from above, warm bounce from the molten floor.
    const hemi = new THREE.HemisphereLight(0x3a6c7e, 0x8a3a10, 1.6);
    this.scene.add(hemi);

    // The key is firelight from high up, around 2000 K. It exists to read
    // silhouettes and cast shadows; it must never suggest a sky.
    this.sun = new THREE.DirectionalLight(0xff9040, 1.15);
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
    // The composer needs a target carrying a depth texture, because the ink pass
    // reads scene depth and the default target does not keep it.
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(size.x, size.y),
    });
    this.composer = new EffectComposer(this.renderer, target);
    // Both halves of the ping-pong need a depth attachment, and they must not be
    // the same one.
    //
    // Both, because which target the scene is rendered into alternates from frame
    // to frame: the chain's swapping passes come to an odd number whenever SMAA is
    // off, so the buffers do not come back around to where they started.
    //
    // Not the same one, because the composer built the second target by cloning
    // the first, and a cloned texture keeps the original's `Source` — which is
    // what three keys the GL texture off. So the "two" depth textures were one,
    // attached to both targets at once, and the ink pass could not sample depth
    // without sampling its own framebuffer. See `InkPass`.
    this.composer.renderTarget2.depthTexture?.dispose();
    this.composer.renderTarget2.depthTexture = new THREE.DepthTexture(size.x, size.y);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // Directly after the scene, and nowhere else: this is the only position in
    // the chain where the buffer being read is the one the depth belongs to.
    this.edgePass = new InkPass();
    this.edgePass.enabled = quality.outlines;
    this.edgePass.material.uniforms.uNear.value = this.camera.near;
    this.edgePass.material.uniforms.uFar.value = this.camera.far;
    this.edgePass.material.uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
    this.composer.addPass(this.edgePass);

    if (quality.bloom) {
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        0.48, // strength — a glow around fire, not a haze over everything
        0.55, // radius
        0.78, // threshold: only genuinely hot things bloom
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
    this.smaaPass = new SMAAPass(width, height);
    this.smaaPass.enabled = quality.smaa;
    this.composer.addPass(this.smaaPass);

    window.addEventListener('resize', this.onResize);
    // A phone changes the size of the view without ever firing `resize`: rotating
    // it does, but scrolling the address bar away only moves the visual viewport.
    window.visualViewport?.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
  }

  private onResize = (): void => {
    const { width: w, height: h } = this.viewportSize();
    if (w <= 0 || h <= 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.maxPixelRatio));
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloomPass?.setSize(w, h);
    this.gradePass.setSize(w, h);
    this.edgePass.setSize(w, h);
    this.smaaPass.setSize(w, h);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.edgePass.material.uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
  };

  /** Keep the shadow frustum tracking whatever the camera is looking at. */
  followTarget(target: THREE.Vector3): void {
    this.sun.position.set(target.x + 14, 30, target.z + 10);
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
  }

  render(): void {
    if (this.bypassPost) {
      // Straight to the canvas. Tone mapping and the sRGB conversion come back
      // automatically here, because three applies both when the render target is
      // the screen — it is the composer that needs `OutputPass` to do it.
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.composer.render();
  }

  /** Set when the post chain has been abandoned as unusable on this device. */
  private bypassPost = false;
  private selfCheckFrames = 0;
  /** Late enough that the terrain, props and torches have all been built. */
  private static readonly SELF_CHECK_AT = 30;

  /**
   * Look at what actually reached the screen, once, and bail out of the post
   * chain if the answer is nothing.
   *
   * The insurance policy for a bug I cannot see. A multi-pass chain has a dozen
   * ways to come out black that depend entirely on the driver — the depth-texture
   * feedback loop above did exactly that, and the report that found it was "on
   * iPhone I can't see anything", from a device I have no way to run. There is no
   * error to catch and nothing in the logs; the frame is simply empty.
   *
   * So rather than trust the chain, read the middle of the canvas a few frames in.
   * The view opens on the Dungeon Heart, which is a lit room with a glowing
   * artefact in it, so black there is never correct and never ambiguous. If it is
   * black, drop the whole chain and render the scene directly: no grade, no ink,
   * no bloom, but a game you can see and play.
   *
   * Read straight after the render and inside the same task, while the back
   * buffer is still there to read — the browser discards it once it composites.
   */
  selfCheck(): string | null {
    if (this.bypassPost || this.selfCheckFrames > SceneRig.SELF_CHECK_AT) return null;
    if (++this.selfCheckFrames !== SceneRig.SELF_CHECK_AT) return null;

    const gl = this.renderer.getContext();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.min(32, size.x), h = Math.min(32, size.y);
    if (w <= 0 || h <= 0) return null;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(
      Math.floor((size.x - w) / 2), Math.floor((size.y - h) / 2), w, h,
      gl.RGBA, gl.UNSIGNED_BYTE, pixels,
    );

    let brightest = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      brightest = Math.max(brightest, pixels[i], pixels[i + 1], pixels[i + 2]);
    }
    // Not zero: a driver may dither, and one stray unit is still black.
    if (brightest > 3) return null;

    this.bypassPost = true;
    return 'The display effects came out blank on this device, so they have been'
      + ' switched off. The game itself is unaffected.';
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.sun.castShadow = quality.shadows;
    if (this.bloomPass) this.bloomPass.enabled = quality.bloom;
    this.smaaPass.enabled = quality.smaa;
    this.edgePass.enabled = quality.outlines;
    // Through the resize path, not `setPixelRatio` alone: that resizes the
    // canvas's drawing buffer but leaves the composer's targets at their old
    // size, so the last adaptive step-down bought nothing at all — every pass
    // still ran at full resolution and only the final blit shrank.
    this.onResize();
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
    window.visualViewport?.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    this.composer.dispose();
    this.environment.dispose();
    this.renderer.dispose();
  }
}
