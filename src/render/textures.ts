import * as THREE from 'three';

/**
 * Every surface in the game is generated here at load time.
 *
 * Nothing is shipped as image data: the dungeon's look is code, which keeps the
 * download tiny, lets materials scale to any resolution, and sidesteps any
 * question of whose art it is. Each material gets a colour map, a normal map
 * derived from the same height field, and a roughness map, so the modern
 * lighting has something to actually bite on.
 */

/** One cell of a material atlas. */
export interface AtlasSlot {
  readonly index: number;
  readonly name: string;
}

const TILE_PX = 256;

type HeightFn = (x: number, y: number, rnd: (n: number) => number) => number;
type ColorFn = (h: number, x: number, y: number, rnd: (n: number) => number) => [number, number, number];

interface MaterialRecipe {
  name: string;
  height: HeightFn;
  color: ColorFn;
  /** 0 = mirror, 1 = chalk. Modulated per-pixel by the height field. */
  roughness: (h: number) => number;
  /** Optional glow, for lava and gem seams. */
  emissive?: (h: number, x: number, y: number) => [number, number, number];
}

/* --------------------------------------------------------------- noise --- */

/** Deterministic hash noise, so a texture is identical on every machine. */
function makeRandom(seed: number): (n: number) => number {
  return (n: number) => {
    let t = (n + seed * 374761393) >>> 0;
    t = Math.imul(t ^ (t >>> 13), 1274126177);
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
}

/** Tiling value noise — wraps at `period` so textures repeat seamlessly. */
function tilingNoise(x: number, y: number, period: number, rnd: (n: number) => number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const at = (ix: number, iy: number) => {
    const wx = ((ix % period) + period) % period;
    const wy = ((iy % period) + period) % period;
    return rnd(wy * 1013 + wx * 7919);
  };
  const a = at(xi, yi), b = at(xi + 1, yi);
  const c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
}

/** Several octaves of tiling noise. */
function fbm(x: number, y: number, octaves: number, period: number, rnd: (n: number) => number): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += tilingNoise(x * freq, y * freq, period * freq, rnd) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Worley/cellular noise, wrapped — the basis for rock and brickwork. */
function cellular(x: number, y: number, period: number, rnd: (n: number) => number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 10;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = ((cx % period) + period) % period;
      const wy = ((cy % period) + period) % period;
      const px = cx + rnd(wy * 733 + wx * 251);
      const py = cy + rnd(wy * 947 + wx * 419 + 17);
      const d = Math.hypot(px - x, py - y);
      if (d < best) best = d;
    }
  }
  return Math.min(1, best);
}

/* ------------------------------------------------------------ recipes ---- */

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Rough hewn rock: the default cavern floor and unclaimed walls. */
const ROCK: MaterialRecipe = {
  name: 'rock',
  height: (x, y, rnd) => {
    const cells = cellular(x * 4, y * 4, 4, rnd);
    return clamp01(cells * 0.65 + fbm(x * 8, y * 8, 4, 8, rnd) * 0.45);
  },
  color: (h, x, y, rnd) => {
    const grit = fbm(x * 26, y * 26, 3, 26, rnd);
    const v = lerp(0.20, 0.46, h) * lerp(0.82, 1.12, grit);
    return [v * 1.0, v * 0.94, v * 0.86];
  },
  roughness: (h) => lerp(0.98, 0.72, h),
};

/** Packed earth: what imps dig through. Warmer and softer than rock. */
const EARTH: MaterialRecipe = {
  name: 'earth',
  height: (x, y, rnd) => clamp01(
    fbm(x * 6, y * 6, 4, 6, rnd) * 0.7 + cellular(x * 7, y * 7, 7, rnd) * 0.35,
  ),
  color: (h, x, y, rnd) => {
    const grit = fbm(x * 30, y * 30, 2, 30, rnd);
    const v = lerp(0.16, 0.40, h) * lerp(0.85, 1.10, grit);
    // Occasional pale pebbles catching the torchlight.
    const pebble = cellular(x * 18, y * 18, 18, rnd) < 0.12 ? 1.5 : 1;
    return [v * 1.16 * pebble, v * 0.86 * pebble, v * 0.60 * pebble];
  },
  roughness: () => 0.96,
};

/** Gold seam: dark rock threaded with bright metal. */
const GOLD: MaterialRecipe = {
  name: 'gold',
  height: (x, y, rnd) => clamp01(
    fbm(x * 5, y * 5, 4, 5, rnd) * 0.6 + cellular(x * 6, y * 6, 6, rnd) * 0.4,
  ),
  color: (h, x, y, rnd) => {
    const vein = fbm(x * 9 + 3.1, y * 9, 3, 9, rnd);
    const isVein = vein > 0.56;
    if (isVein) {
      const t = clamp01((vein - 0.56) * 5);
      return [lerp(0.45, 1.00, t), lerp(0.32, 0.78, t), lerp(0.08, 0.22, t)];
    }
    const v = lerp(0.14, 0.32, h);
    return [v * 1.05, v * 0.92, v * 0.74];
  },
  roughness: (h) => lerp(0.9, 0.35, h),
};

/** Gem seam: cool crystalline facets that glow faintly. */
const GEMS: MaterialRecipe = {
  name: 'gems',
  height: (x, y, rnd) => clamp01(1 - cellular(x * 7, y * 7, 7, rnd) * 1.2),
  color: (h) => [lerp(0.05, 0.30, h), lerp(0.22, 0.85, h), lerp(0.30, 0.95, h)],
  roughness: (h) => lerp(0.55, 0.08, h),
  emissive: (h) => {
    const g = Math.pow(h, 3) * 0.55;
    return [g * 0.15, g * 0.75, g];
  },
};

/** Impenetrable bedrock: near-black, almost featureless, deliberately grim. */
const BEDROCK: MaterialRecipe = {
  name: 'bedrock',
  height: (x, y, rnd) => clamp01(cellular(x * 3, y * 3, 3, rnd) * 0.8 + fbm(x * 10, y * 10, 3, 10, rnd) * 0.3),
  color: (h) => {
    const v = lerp(0.05, 0.16, h);
    return [v, v * 0.98, v * 1.05];
  },
  roughness: () => 0.99,
};

/** A keeper-reinforced wall: dressed stone blocks with mortar lines. */
const REINFORCED: MaterialRecipe = {
  name: 'reinforced',
  height: (x, y, rnd) => {
    // Running bond brickwork: offset every other course.
    const rows = 4, cols = 4;
    const ry = y * rows;
    const course = Math.floor(ry);
    const offset = (course % 2) * 0.5;
    const rx = x * cols + offset;
    const fx = rx - Math.floor(rx), fy = ry - course;
    const mortar = 0.08;
    const edge = Math.min(
      Math.min(fx, 1 - fx) / mortar,
      Math.min(fy, 1 - fy) / mortar,
    );
    const block = clamp01(edge);
    const grain = fbm(x * 20, y * 20, 3, 20, rnd) * 0.25;
    return clamp01(block * 0.8 + grain);
  },
  color: (h, x, y, rnd) => {
    const grit = fbm(x * 24, y * 24, 3, 24, rnd);
    const v = lerp(0.10, 0.42, h) * lerp(0.88, 1.10, grit);
    return [v * 1.02, v * 0.99, v * 0.94];
  },
  roughness: (h) => lerp(0.99, 0.78, h),
};

/** Claimed floor: flagstones with a faint sigil pattern in the centre. */
const FLAGSTONE: MaterialRecipe = {
  name: 'flagstone',
  height: (x, y, rnd) => {
    const cols = 3;
    const rx = x * cols, ry = y * cols;
    const fx = rx - Math.floor(rx), fy = ry - Math.floor(ry);
    const m = 0.07;
    const edge = clamp01(Math.min(Math.min(fx, 1 - fx), Math.min(fy, 1 - fy)) / m);
    return clamp01(edge * 0.75 + fbm(x * 16, y * 16, 3, 16, rnd) * 0.3);
  },
  color: (h, x, y, rnd) => {
    const grit = fbm(x * 22, y * 22, 3, 22, rnd);
    const v = lerp(0.09, 0.38, h) * lerp(0.86, 1.12, grit);
    return [v, v * 0.97, v * 0.92];
  },
  roughness: (h) => lerp(0.97, 0.70, h),
};

/** Treasury floor: flagstone under a scatter of coins. */
const TREASURY: MaterialRecipe = {
  name: 'treasury',
  height: (x, y, rnd) => {
    const coins = 1 - cellular(x * 11, y * 11, 11, rnd);
    return clamp01(Math.pow(coins, 2) * 0.9 + fbm(x * 14, y * 14, 2, 14, rnd) * 0.2);
  },
  color: (h) => {
    if (h > 0.45) {
      const t = clamp01((h - 0.45) * 2.2);
      return [lerp(0.42, 1.0, t), lerp(0.30, 0.80, t), lerp(0.10, 0.24, t)];
    }
    const v = lerp(0.10, 0.26, h);
    return [v * 1.05, v * 0.96, v * 0.84];
  },
  roughness: (h) => (h > 0.45 ? 0.24 : 0.9),
};

/** Lair floor: trampled straw and fur over stone. */
const LAIR: MaterialRecipe = {
  name: 'lair',
  height: (x, y, rnd) => {
    // Directional streaks read as strewn straw.
    const streak = fbm(x * 3 + y * 14, y * 5, 3, 14, rnd);
    return clamp01(streak * 0.8 + fbm(x * 18, y * 18, 2, 18, rnd) * 0.3);
  },
  color: (h, x, y, rnd) => {
    const grit = fbm(x * 25, y * 25, 2, 25, rnd);
    const v = lerp(0.14, 0.46, h) * lerp(0.85, 1.1, grit);
    return [v * 1.22, v * 0.92, v * 0.52];
  },
  roughness: () => 0.97,
};

/** Hatchery floor: damp mossy earth. */
const HATCHERY: MaterialRecipe = {
  name: 'hatchery',
  height: (x, y, rnd) => clamp01(cellular(x * 9, y * 9, 9, rnd) * 0.7 + fbm(x * 20, y * 20, 3, 20, rnd) * 0.4),
  color: (h, x, y, rnd) => {
    const patch = fbm(x * 6, y * 6, 3, 6, rnd);
    const mossy = clamp01((patch - 0.42) * 3);
    const v = lerp(0.12, 0.38, h);
    return [
      lerp(v * 1.1, v * 0.62, mossy),
      lerp(v * 0.98, v * 1.35, mossy),
      lerp(v * 0.70, v * 0.50, mossy),
    ];
  },
  roughness: () => 0.95,
};

/** Training room floor: scuffed iron plate with rivets. */
const TRAINING: MaterialRecipe = {
  name: 'training',
  height: (x, y, rnd) => {
    const cols = 2;
    const rx = x * cols, ry = y * cols;
    const fx = rx - Math.floor(rx), fy = ry - Math.floor(ry);
    const plate = clamp01(Math.min(Math.min(fx, 1 - fx), Math.min(fy, 1 - fy)) / 0.06);
    // Rivets in each plate corner.
    const rd = Math.hypot(fx - 0.5, fy - 0.5);
    const rivet = rd < 0.08 ? 1 : 0;
    return clamp01(plate * 0.7 + rivet * 0.5 + fbm(x * 22, y * 22, 2, 22, rnd) * 0.18);
  },
  color: (h, x, y, rnd) => {
    const rust = fbm(x * 7, y * 7, 3, 7, rnd);
    const v = lerp(0.14, 0.52, h);
    const r = clamp01((rust - 0.5) * 3);
    return [lerp(v, v * 1.5, r), lerp(v * 1.02, v * 0.82, r), lerp(v * 1.10, v * 0.58, r)];
  },
  roughness: (h) => lerp(0.85, 0.32, h),
};

/** Library floor: dark polished slate with pale inlaid script. */
const LIBRARY: MaterialRecipe = {
  name: 'library',
  height: (x, y, rnd) => {
    const lines = Math.abs(Math.sin((y * 18 + fbm(x * 4, y * 4, 2, 4, rnd) * 2) * Math.PI));
    const glyph = lines > 0.93 && fbm(x * 30, y * 8, 2, 30, rnd) > 0.45 ? 1 : 0;
    return clamp01(0.35 + glyph * 0.6 + fbm(x * 15, y * 15, 3, 15, rnd) * 0.25);
  },
  color: (h) => {
    if (h > 0.8) return [0.55, 0.62, 0.85];
    const v = lerp(0.06, 0.22, h);
    return [v * 0.82, v * 0.90, v * 1.30];
  },
  roughness: (h) => (h > 0.8 ? 0.3 : lerp(0.7, 0.45, h)),
  emissive: (h) => (h > 0.8 ? [0.06, 0.09, 0.20] : [0, 0, 0]),
};

/** Bridge planking over water and lava. */
const BRIDGE: MaterialRecipe = {
  name: 'bridge',
  height: (x, y, rnd) => {
    const planks = 5;
    const ry = y * planks;
    const fy = ry - Math.floor(ry);
    const gap = clamp01(Math.min(fy, 1 - fy) / 0.09);
    const grain = fbm(x * 30, y * 4, 3, 30, rnd);
    return clamp01(gap * 0.75 + grain * 0.3);
  },
  color: (h, x, y, rnd) => {
    const grain = fbm(x * 26, y * 3, 3, 26, rnd);
    const v = lerp(0.10, 0.34, h) * lerp(0.85, 1.15, grain);
    return [v * 1.30, v * 0.92, v * 0.56];
  },
  roughness: () => 0.93,
};

/** Still, black subterranean water. */
const WATER: MaterialRecipe = {
  name: 'water',
  height: (x, y, rnd) => clamp01(0.4 + fbm(x * 5, y * 5, 3, 5, rnd) * 0.6),
  color: (h) => [0.02 * h, 0.10 + 0.10 * h, 0.16 + 0.16 * h],
  roughness: () => 0.06,
  emissive: (h) => [0, 0.02 * h, 0.04 * h],
};

/** Molten rock: dark crust cracked open over glowing veins. */
const LAVA: MaterialRecipe = {
  name: 'lava',
  height: (x, y, rnd) => clamp01(cellular(x * 5, y * 5, 5, rnd) * 1.3),
  color: (h) => {
    if (h < 0.22) {
      const t = clamp01(h / 0.22);
      return [lerp(1.0, 0.85, t), lerp(0.75, 0.25, t), lerp(0.18, 0.05, t)];
    }
    const v = lerp(0.16, 0.05, clamp01((h - 0.22) / 0.78));
    return [v * 1.4, v * 0.9, v * 0.75];
  },
  roughness: (h) => lerp(0.4, 0.95, h),
  emissive: (h) => {
    if (h > 0.28) return [0.02, 0.004, 0];
    const t = 1 - clamp01(h / 0.28);
    return [t * 2.6, t * 0.85, t * 0.12];
  },
};

/* ------------------------------------------------------------- atlases --- */

/** Wall materials, in atlas order. Index is what the shader receives. */
export const WALL_SLOTS = ['earth', 'gold', 'gems', 'bedrock', 'reinforced'] as const;
const WALL_RECIPES: MaterialRecipe[] = [EARTH, GOLD, GEMS, BEDROCK, REINFORCED];

/** Floor materials, in atlas order. */
export const FLOOR_SLOTS = [
  'rock', 'flagstone', 'treasury', 'lair', 'hatchery', 'training', 'library', 'bridge',
  'water', 'lava',
] as const;
const FLOOR_RECIPES: MaterialRecipe[] = [
  ROCK, FLAGSTONE, TREASURY, LAIR, HATCHERY, TRAINING, LIBRARY, BRIDGE, WATER, LAVA,
];

export interface GeneratedAtlas {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  /** Green = roughness, blue = metalness — the glTF packing three understands. */
  roughnessMap: THREE.Texture;
  emissiveMap: THREE.Texture;
  /** Atlas grid dimensions, needed by the shader to compute UV offsets. */
  cols: number;
  rows: number;
  count: number;
}

/** Render one recipe's height field, then derive colour/normal/roughness from it. */
function bakeRecipe(
  recipe: MaterialRecipe,
  size: number,
  seed: number,
): { color: Uint8ClampedArray; normal: Uint8ClampedArray; rough: Uint8ClampedArray; emissive: Uint8ClampedArray } {
  const rnd = makeRandom(seed);
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      heights[y * size + x] = clamp01(recipe.height(x / size, y / size, rnd));
    }
  }

  const color = new Uint8ClampedArray(size * size * 4);
  const normal = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);
  const emissive = new Uint8ClampedArray(size * size * 4);

  // Sobel over the height field gives us a normal map with real relief.
  const at = (x: number, y: number) => heights[((y + size) % size) * size + ((x + size) % size)];
  const strength = 2.6;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const h = heights[y * size + x];

      const [r, g, b] = recipe.color(h, x / size, y / size, rnd);
      color[i] = r * 255; color[i + 1] = g * 255; color[i + 2] = b * 255; color[i + 3] = 255;

      const dx =
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1)) -
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const dy =
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1)) -
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
      const nx = dx * strength, ny = dy * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      normal[i] = ((nx / len) * 0.5 + 0.5) * 255;
      normal[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      normal[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      normal[i + 3] = 255;

      // glTF packing: R unused, G roughness, B metalness.
      const rg = clamp01(recipe.roughness(h));
      rough[i] = 255;
      rough[i + 1] = rg * 255;
      rough[i + 2] = (recipe === GOLD || recipe === TREASURY || recipe === TRAINING)
        ? clamp01(1 - rg) * 255
        : 0;
      rough[i + 3] = 255;

      if (recipe.emissive) {
        const [er, eg, eb] = recipe.emissive(h, x / size, y / size);
        emissive[i] = clamp01(er) * 255;
        emissive[i + 1] = clamp01(eg) * 255;
        emissive[i + 2] = clamp01(eb) * 255;
      }
      emissive[i + 3] = 255;
    }
  }
  return { color, normal, rough, emissive };
}

/** Compose a set of recipes into one atlas of four textures. */
function buildAtlas(recipes: MaterialRecipe[], tilePx: number): GeneratedAtlas {
  const count = recipes.length;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const w = cols * tilePx, h = rows * tilePx;

  const layers = ['color', 'normal', 'rough', 'emissive'] as const;
  const canvases: Record<string, HTMLCanvasElement> = {};
  const contexts: Record<string, CanvasRenderingContext2D> = {};
  for (const l of layers) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    canvases[l] = c;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable — cannot generate textures');
    contexts[l] = ctx;
  }

  recipes.forEach((recipe, i) => {
    const baked = bakeRecipe(recipe, tilePx, i * 977 + 13);
    const cx = (i % cols) * tilePx;
    const cy = Math.floor(i / cols) * tilePx;
    for (const l of layers) {
      const data = baked[l];
      // Allocate through the context rather than `new ImageData(...)`: it keeps
      // the backing buffer concrete and sidesteps the SharedArrayBuffer overload.
      const img = contexts[l].createImageData(tilePx, tilePx);
      img.data.set(data);
      contexts[l].putImageData(img, cx, cy);
    }
  });

  const make = (name: string, srgb: boolean): THREE.Texture => {
    const tex = new THREE.CanvasTexture(canvases[name]);
    // Canvas rows run top-down while UV rows run bottom-up. Left flipped, cell
    // row 0 would land at the bottom of the atlas and every material would
    // sample its vertical mirror image — flagstone comes out as lava.
    tex.flipY = false;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  };

  return {
    map: make('color', true),
    normalMap: make('normal', false),
    roughnessMap: make('rough', false),
    emissiveMap: make('emissive', true),
    cols, rows, count,
  };
}

let wallAtlas: GeneratedAtlas | null = null;
let floorAtlas: GeneratedAtlas | null = null;

export function getWallAtlas(): GeneratedAtlas {
  if (!wallAtlas) wallAtlas = buildAtlas(WALL_RECIPES, TILE_PX);
  return wallAtlas;
}

export function getFloorAtlas(): GeneratedAtlas {
  if (!floorAtlas) floorAtlas = buildAtlas(FLOOR_RECIPES, TILE_PX);
  return floorAtlas;
}

/* -------------------------------------------------- one-off textures ----- */

/** A soft radial glow, used for torch halos, spell flashes and particles. */
export function makeGlowTexture(size = 128, inner = '#ffffff'): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, 'rgba(255,255,255,0.42)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A small puff sprite for dust, smoke and magic motes. */
export function makePuffTexture(size = 64): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const img = ctx.createImageData(size, size);
  const rnd = makeRandom(4242);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x - size / 2, y - size / 2) / (size / 2);
      const n = fbm(x / size * 4, y / size * 4, 3, 4, rnd);
      const a = clamp01((1 - d) * 1.4) * clamp01(n * 1.6);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Tiny 1x1 white texture, handy as a neutral fallback. */
export function makeWhiteTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 1, 1);
  return new THREE.CanvasTexture(c);
}
