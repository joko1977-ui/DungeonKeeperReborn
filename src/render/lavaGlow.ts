import * as THREE from 'three';
import { Terrain } from '../core/constants';
import { TileMap } from '../core/tilemap';

/**
 * Lava as a light source.
 *
 * In the reference art the molten rock is not scenery, it is the lamp: every
 * wall around a lava lake is rimmed orange from below, the stone above it glows,
 * and the shadows fall upward. Ours had lava that was merely a bright *texture* —
 * it emitted into the bloom pass and lit nothing, so a lake sat next to a wall
 * without touching it, which is the single biggest thing separating a real
 * volcanic cavern from a picture of one.
 *
 * So the largest bodies of lava near the camera get actual point lights, placed
 * low and warm. Same trick the torches use, and the same hard limit: a forward
 * renderer pays for every light in every lit fragment, so only a handful are
 * live at once and they are chosen by distance to what you are looking at.
 */

/** Live lights. Shared budget with the torches, so this stays small. */
const MAX_LAVA_LIGHTS = 3;

/** Below this many tiles, a puddle is not worth a light of its own. */
const MIN_POOL_TILES = 3;

interface Pool {
  x: number;
  y: number;
  /** Tiles in the pool: bigger lakes burn brighter and reach further. */
  size: number;
}

export class LavaGlow {
  readonly group = new THREE.Group();

  private readonly map: TileMap;
  private readonly lights: THREE.PointLight[] = [];
  private pools: Pool[] = [];
  private lastVersion = -1;

  constructor(map: TileMap) {
    this.map = map;
    for (let i = 0; i < MAX_LAVA_LIGHTS; i++) {
      // Sat just above the surface, and warm — around 1900 K, per the palette.
      const light = new THREE.PointLight(0xff5a12, 0, 14, 1.7);
      light.visible = false;
      this.lights.push(light);
      this.group.add(light);
    }
  }

  /** Re-find the lakes when the dungeon changes. */
  syncIfDirty(): boolean {
    if (this.map.version === this.lastVersion) return false;
    this.lastVersion = this.map.version;
    this.pools = this.findPools();
    return true;
  }

  /**
   * Flood-fill the lava into connected bodies.
   *
   * One light per *lake*, not per tile: a twenty-tile lake with twenty lights
   * would eat the entire lighting budget and look no different from one light in
   * the middle of it.
   */
  private findPools(): Pool[] {
    const map = this.map;
    const seen = new Uint8Array(map.terrain.length);
    const pools: Pool[] = [];
    const stack: number[] = [];

    for (let start = 0; start < map.terrain.length; start++) {
      if (seen[start] || map.terrain[start] !== Terrain.Lava) continue;
      seen[start] = 1;
      stack.length = 0;
      stack.push(start);
      let sx = 0, sy = 0, n = 0;

      while (stack.length > 0) {
        const i = stack.pop()!;
        const x = map.xOf(i), y = map.yOf(i);
        sx += x; sy += y; n++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (!map.inBounds(nx, ny)) continue;
          const ni = map.idx(nx, ny);
          if (seen[ni] || map.terrain[ni] !== Terrain.Lava) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
      if (n >= MIN_POOL_TILES) pools.push({ x: sx / n, y: sy / n, size: n });
    }
    return pools;
  }

  /** Hand the nearest lakes to the real lights, and let them breathe. */
  update(time: number, focus: THREE.Vector3): void {
    if (this.pools.length === 0) {
      for (const l of this.lights) { l.visible = false; l.intensity = 0; }
      return;
    }

    const ranked = [...this.pools].sort((a, b) =>
      (a.x - focus.x) ** 2 + (a.y - focus.z) ** 2
      - ((b.x - focus.x) ** 2 + (b.y - focus.z) ** 2));

    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i];
      const pool = ranked[i];
      if (!pool) { light.visible = false; light.intensity = 0; continue; }

      const d = Math.hypot(pool.x - focus.x, pool.y - focus.z);
      // Fade with distance so a light swapping in does not pop into existence.
      const reach = Math.max(0, 1 - d / 34);
      if (reach <= 0.01) { light.visible = false; light.intensity = 0; continue; }

      light.visible = true;
      light.position.set(pool.x, 0.35, pool.y);
      light.distance = 9 + Math.min(9, pool.size * 0.5);
      // Molten rock churns; the light should never sit perfectly still.
      const churn = 0.86
        + 0.1 * Math.sin(time * 0.9 + i * 2.1)
        + 0.06 * Math.sin(time * 2.3 + i);
      light.intensity = (6 + Math.min(10, pool.size * 0.55)) * reach * churn;
    }
  }

  /** Drop the light budget when the frame rate is struggling. */
  setBudget(lights: number): void {
    for (let i = 0; i < this.lights.length; i++) {
      if (i >= lights) { this.lights[i].visible = false; this.lights[i].intensity = 0; }
    }
  }

  dispose(): void {
    for (const l of this.lights) this.group.remove(l);
  }
}
