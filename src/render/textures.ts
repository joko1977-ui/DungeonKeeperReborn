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

/**
 * A hard-edged band of lines crossing the tile — a seam, a crack, a mortar joint.
 *
 * The counterpart to the noise above, and what most of these recipes needed all
 * along. Fractal noise erodes a surface, which is how nature makes rock and how a
 * renderer likes to describe it; a comic *draws* rock, as a few decided lines with
 * flat fill between them. Noise cannot produce a decided line at any amplitude —
 * turned up it is chaos and turned down it is grain — so the lines have to be
 * their own primitive.
 *
 * `ax`/`ay` must be whole numbers and `count` too: the band direction is then
 * commensurate with the tile and the pattern wraps seamlessly, which noise gets
 * for free and a straight line does not.
 *
 * Returns 1 at the centre of a line, falling to 0 at its edge.
 */
function bands(
  x: number, y: number, rnd: (n: number) => number,
  ax: number, ay: number, count: number, width: number, wobble = 0,
): number {
  let t = (x * ax + y * ay) * count;
  if (wobble > 0) t += fbm(x * 3, y * 3, 2, 3, rnd) * wobble;
  const frac = t - Math.floor(t);
  const d = Math.abs(frac - 0.5) * 2;
  return d < width ? 1 - d / width : 0;
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
    // Basalt, and cool.
    //
    // This was warm-dark brown, on the principle that clean medieval grey stone
    // is off the table. It still is — but brown rock under orange firelight with
    // a warm grade over the top gave every surface in the game the same hue, and
    // an image with one hue in it has no depth however carefully it is lit. Real
    // basalt is blue-grey; warm light falling on it reads *as warm light*, and the
    // faces the fire misses fall cool. That contrast is the whole look.
    const grit = fbm(x * 12, y * 12, 2, 12, rnd);
    const t = clamp01(h * lerp(0.92, 1.10, grit));
    let r = lerp(0.101, 0.192, t);
    let g = lerp(0.110, 0.206, t);
    let b = lerp(0.128, 0.231, t);
    // Two drawn fissures, at an angle to each other so the wall has a grain.
    const crack = Math.max(
      bands(x, y, rnd, 1, -2, 1, 0.05, 0.45),
      bands(x, y, rnd, 2, 1, 1, 0.035, 0.5) * 0.7,
    );
    if (crack > 0) {
      const k = 1 - crack * 0.55;
      r *= k; g *= k; b *= k;
    }
    return [r, g, b];
  },
  roughness: (h) => lerp(0.90, 0.75, h),
};

/** Packed earth: what imps dig through. Warmer and softer than rock. */
const EARTH: MaterialRecipe = {
  name: 'earth',
  height: (x, y, rnd) => clamp01(
    fbm(x * 6, y * 6, 4, 6, rnd) * 0.7 + cellular(x * 7, y * 7, 7, rnd) * 0.35,
  ),
  color: (h, x, y, rnd) => {
    // Plain basalt.
    //
    // This carried fleshy organic veins for a while, per the art direction, and
    // they did not survive the resolution: at one tile across a screen the vein
    // noise reads as orange speckle rather than as tissue, and repeated over
    // every wall on the map it was the single noisiest thing in the frame.
    // A texture effect you cannot see at playing distance is not detail, it is
    // dirt on the lens.
    const grit = fbm(x * 30, y * 30, 2, 30, rnd);
    const t = clamp01(h * lerp(0.85, 1.12, grit));
    // Packed soil keeps a little more warmth than the rock around it — that
    // difference is how a dug face reads as freshly dug.
    return [
      lerp(0.140, 0.243, t),
      lerp(0.126, 0.213, t),
      lerp(0.116, 0.190, t),
    ];
  },
  roughness: () => 0.9,
};

/** Gold seam: dark rock threaded with bright metal. */
const GOLD: MaterialRecipe = {
  name: 'gold',
  height: (x, y, rnd) => clamp01(
    fbm(x * 5, y * 5, 4, 5, rnd) * 0.6 + cellular(x * 6, y * 6, 6, rnd) * 0.4,
  ),
  color: (h, x, y, rnd) => {
    /*
     * Two drawn seams running through cool rock.
     *
     * This was fractal noise thresholded into veins, which under flat shading
     * stopped reading as ore at all: the blobs scattered across every face like
     * orange commas, dozens of walls of them, and the eye had nothing to settle
     * on. A seam is a *line* — that is what the word means — so it is drawn as
     * one, wide with a bright core, wandering just enough not to look ruled.
     */
    const seam = Math.max(
      bands(x, y, rnd, 1, 1, 1, 0.17, 0.30),
      bands(x, y, rnd, 1, -2, 1, 0.10, 0.35) * 0.8,
    );
    const v = lerp(0.11, 0.26, h);
    const rock: [number, number, number] = [v * 0.88, v * 0.95, v * 1.08];
    if (seam <= 0) return rock;
    // Core bright, shoulders dull, so a seam has a shape across its width.
    const core = clamp01((seam - 0.35) / 0.65);
    // Gold, not fire. Bright enough to be the thing you look for on a wall and
    // no brighter: at a near-yellow core these chained across tile edges into
    // continuous glowing zigzags and outshone the lava.
    // Yellow rather than orange. At an orange core these read as cracks with fire
    // behind them — which is a thing this dungeon also has, three tiles away, and
    // the two must not look alike. Metal is yellow: green close behind red.
    return [
      lerp(rock[0], lerp(0.27, 0.54, core), Math.min(1, seam * 2)),
      lerp(rock[1], lerp(0.22, 0.46, core), Math.min(1, seam * 2)),
      lerp(rock[2], lerp(0.06, 0.14, core), Math.min(1, seam * 2)),
    ];
  },
  roughness: (h) => lerp(0.9, 0.35, h),
};

/** Gem seam: cool crystalline facets that glow faintly. */
const GEMS: MaterialRecipe = {
  name: 'gems',
  // Four big facets rather than a field of small ones. Posterised, the old
  // seven-cell pattern came out as flat blobs the size of a fist scattered over
  // every face — a cow hide, not a crystal. A crystal reads by having few, large,
  // clearly-bounded planes at different angles, and the ink pass on the height
  // step draws the edges between them.
  height: (x, y, rnd) => clamp01(1 - cellular(x * 3, y * 3, 3, rnd) * 1.05),
  color: (h) => {
    // Crystal only in the top of the range; the rest is the rock it grew in. A
    // ramp across the whole range gave every face an even split of pale and dark
    // that posterised into camouflage.
    if (h < 0.70) {
      const v = lerp(0.07, 0.13, h / 0.70);
      return [v * 0.8, v * 0.95, v * 1.2];
    }
    const t = (h - 0.70) / 0.30;
    return [lerp(0.10, 0.30, t), lerp(0.34, 0.74, t), lerp(0.44, 0.88, t)];
  },
  roughness: (h) => lerp(0.55, 0.08, h),
  emissive: (h) => {
    // Only the brightest facet glows, so a seam has a highlight rather than a haze.
    const g = Math.pow(clamp01((h - 0.70) / 0.30), 2) * 0.5;
    return [g * 0.15, g * 0.75, g];
  },
};

/** Impenetrable bedrock: near-black, almost featureless, deliberately grim. */
const BEDROCK: MaterialRecipe = {
  name: 'bedrock',
  /*
   * The one wall you cannot dig, and it has to say so without a word.
   *
   * It used to be "the same rock but darker", which is not a signal — the dungeon
   * is full of dark rock and half of it is diggable. So bedrock is now a different
   * *material*: near-black, blue rather than warm, and banded with hard horizontal
   * strata that nothing else on the map has. Between the colour, the strata and
   * the extra height the wall mesh gives it, a player learns in one glance which
   * walls are worth tagging, and never has to learn it again from a failed order.
   */
  height: (x, y, rnd) => {
    const strata = Math.abs(((y * 5 + fbm(x * 4, y * 4, 2, 4, rnd) * 0.6) % 1) - 0.5) * 2;
    return clamp01(strata * 0.7 + cellular(x * 3, y * 3, 3, rnd) * 0.35);
  },
  color: (h) => {
    const v = lerp(0.030, 0.115, h);
    return [v * 0.78, v * 0.88, v * 1.30];
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
    const m = 0.045;
    const edge = clamp01(Math.min(Math.min(fx, 1 - fx), Math.min(fy, 1 - fy)) / m);
    // Keep the joints shallow: 0.45 floor rather than 0, so a mortar line is a
    // crease in stone instead of a black gap.
    return clamp01(0.45 + edge * 0.4 + fbm(x * 16, y * 16, 3, 16, rnd) * 0.28);
  },
  color: (h, x, y, rnd) => {
    const grit = fbm(x * 22, y * 22, 3, 22, rnd);
    const t = clamp01(h * lerp(0.86, 1.12, grit));
    // Cool flags, so the torchlight crossing them has somewhere to land. This is
    // the most common surface in the game and it was setting the scene's hue.
    const stone: [number, number, number] = [
      lerp(0.094, 0.200, t), lerp(0.102, 0.214, t), lerp(0.118, 0.239, t),
    ];
    // Molten rock showing through the cracks between the flags.
    const glow = crackGlow(x, y, rnd);
    if (glow <= 0) return stone;
    // Warm, not white. Posterised, a crack running to pure white came out as
    // hard bright dots scattered over the floor of every room.
    return [
      lerp(stone[0], 0.62, glow),
      lerp(stone[1], 0.24, glow),
      lerp(stone[2], 0.03, glow),
    ];
  },
  roughness: (h) => lerp(0.90, 0.72, h),
  emissive: (_h, x, y) => {
    // Cracks with something molten behind them, not a lit floor.
    //
    // At 1.5 this was the brightest thing in the frame and there is more claimed
    // floor than anything else, so it bloomed into a flat orange wash over the
    // whole dungeon: the creatures standing on it lost their own colour, and the
    // rooms lost the furniture that tells them apart. A floor is where the light
    // lands, not where it comes from.
    const glow = crackGlow(x, y, makeRandom(FLAGSTONE_SEED));
    return [glow * 0.55, glow * 0.17, glow * 0.015];
  },
};

/** Seed the flagstone recipe uses, shared between its colour and glow passes. */
const FLAGSTONE_SEED = 8;

/**
 * How molten a point on the floor is.
 *
 * The brief asks for cracked black stone with glowing cracks revealing molten
 * rock underneath. This picks out the thin ridge lines of a cellular field —
 * the cell *borders*, not the cells — so the glow runs along fractures rather
 * than pooling in blobs.
 */
function crackGlow(x: number, y: number, rnd: (n: number) => number): number {
  const c = cellular(x * 3.5, y * 3.5, 4, rnd);
  // Narrow, and rare. The first pass lit a third of every tile and the floor
  // came out as a rash of orange dots that flooded the whole frame with one
  // hue — which is exactly what was killing the colour in this scene. A crack
  // is a thin line on an otherwise dark floor, and most tiles have none.
  const ridge = clamp01((0.05 - c) / 0.05);
  const patchy = clamp01((fbm(x * 2.5 + 5.7, y * 2.5, 3, 3, rnd) - 0.66) / 0.16);
  return ridge * patchy;
}

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

/*
 * The two liquids are drawn almost plain, on purpose.
 *
 * They used to carry all their character in the texture — cellular plates for
 * lava, mottled fbm for water — and it was baked in, so a lake was a photograph
 * of a lake: the same frozen blobs in the same places for the whole game, and
 * the tile repeat visible across every one of them. Now the surface shader
 * animates both from a world-space wave, which means anything the texture also
 * draws is a second, contradictory pattern sitting still underneath a moving
 * one. So the texture's job here is reduced to the bed — dark basalt, dark
 * water — and every bright thing on top of it is the shader's.
 */

/** Still, black subterranean water. The shader supplies the swell. */
const WATER: MaterialRecipe = {
  name: 'water',
  height: (x, y, rnd) => clamp01(0.42 + fbm(x * 3.4, y * 3.4, 3, 5, rnd) * 0.46),
  color: (h) => [0.020 + 0.018 * h, 0.082 + 0.080 * h, 0.132 + 0.118 * h],
  roughness: () => 0.06,
  emissive: () => [0, 0.012, 0.024],
};

/** Molten rock. The crust only; the veins are cut live in the surface shader. */
const LAVA: MaterialRecipe = {
  name: 'lava',
  height: (x, y, rnd) => clamp01(0.34 + fbm(x * 3.2, y * 3.2, 4, 7, rnd) * 0.62),
  // Basalt, so lava reads as the same rock the walls are made of, having melted.
  color: (h) => [0.086 + 0.062 * h, 0.058 + 0.042 * h, 0.054 + 0.036 * h],
  roughness: (h) => lerp(0.62, 0.9, h),
  // A trace of heat left in the deepest hollows, which the wave then lights.
  emissive: (h) => [0.09 * (1 - h), 0.022 * (1 - h), 0],
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

/** How many flat steps a surface's value is collapsed into. */
const POSTER_STEPS = 5;

/** Height gradient above which a step counts as an edge worth inking. */
const INK_THRESHOLD = 0.055;
const INK_DEPTH = 0.62;

/** Magnitude of the local height change, 0..1-ish. */
function gradientAt(
  at: (x: number, y: number) => number, x: number, y: number,
): number {
  const dx = at(x + 1, y) - at(x - 1, y);
  const dy = at(x, y + 1) - at(x, y - 1);
  return Math.hypot(dx, dy);
}

/**
 * Collapse a colour into flat bands and darken it where the surface steps.
 *
 * Posterising in luminance rather than per channel: quantising each channel on its
 * own shifts hue as the steps land on different boundaries, so a brown stone drifts
 * green in its mid-tones. Scaling all three by the ratio between the quantised and
 * original luminance keeps the hue exactly and moves only the value, which is what
 * a flat fill is.
 */
function inkAndPosterise(
  r: number, g: number, b: number, gradient: number,
): [number, number, number] {
  const luma = 0.3 * r + 0.6 * g + 0.1 * b;
  if (luma > 0.001) {
    const stepped = Math.round(luma * POSTER_STEPS) / POSTER_STEPS;
    const scale = stepped / luma;
    r *= scale; g *= scale; b *= scale;
  }
  if (gradient > INK_THRESHOLD) {
    // Hard-edged, not a gradient: a line has one weight or it is shading.
    const ink = 1 - INK_DEPTH;
    r *= ink; g *= ink; b *= ink;
  }
  return [clamp01(r), clamp01(g), clamp01(b)];
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

  // Sobel over the height field gives us a normal map with real relief, and the
  // same gradient tells us where to draw the ink.
  const at = (x: number, y: number) => heights[((y + size) % size) * size + ((x + size) % size)];
  const strength = 2.6;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const h = heights[y * size + x];

      const [r0, g0, b0] = recipe.color(h, x / size, y / size, rnd);
      // Flat bands, then a line where the surface steps.
      //
      // The recipes describe surfaces the way a photograph does: continuous noise,
      // every pixel a slightly different value. That is the wrong description for
      // this style twice over — it fights the flat cel shading over the top of it,
      // and at one tile across a screen it resolves to grain rather than to
      // anything. Posterising collapses it into a few flat areas with hard borders,
      // which is how a drawing describes stone; inking the height steps draws the
      // line a comic would draw around them. Together they turn every material in
      // the game from rendered rock into drawn rock, and it is one rule applied
      // everywhere rather than eleven hand-redrawn recipes.
      const [r, g, b] = inkAndPosterise(r0, g0, b0, gradientAt(at, x, y));
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
