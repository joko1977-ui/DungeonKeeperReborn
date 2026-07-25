import { OWNER_COLORS, Owner, RoomType, Terrain } from '../core/constants';
import { CREATURE_SPECS } from '../core/creatures';
import { Game } from '../core/game';
import { FLAG_REVEALED } from '../core/tilemap';

/**
 * The panel minimap.
 *
 * Terrain is painted into an offscreen buffer that only gets redrawn when the
 * map actually changes; creatures and the view cone are drawn over the top
 * every frame. Clicking or dragging anywhere on it moves the camera, which is
 * how you get across a big dungeon in a hurry.
 */
export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly game: Game;

  /** Terrain layer, redrawn only when the dungeon changes. */
  private readonly terrainCanvas: HTMLCanvasElement;
  private readonly terrainCtx: CanvasRenderingContext2D;
  private lastVersion = -1;

  private onNavigate: ((x: number, y: number) => void) | null = null;
  private dragging = false;

  constructor(canvas: HTMLCanvasElement, game: Game) {
    this.canvas = canvas;
    this.game = game;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('minimap needs a 2D context');
    this.ctx = ctx;

    canvas.width = game.map.width;
    canvas.height = game.map.height;

    this.terrainCanvas = document.createElement('canvas');
    this.terrainCanvas.width = game.map.width;
    this.terrainCanvas.height = game.map.height;
    const tctx = this.terrainCanvas.getContext('2d');
    if (!tctx) throw new Error('minimap needs a 2D context');
    this.terrainCtx = tctx;

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
  }

  setNavigateHandler(fn: (x: number, y: number) => void): void {
    this.onNavigate = fn;
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.navigateFrom(e);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.dragging) this.navigateFrom(e);
  };

  private onPointerUp = (): void => {
    this.dragging = false;
  };

  private navigateFrom(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.game.map.width;
    const y = ((e.clientY - rect.top) / rect.height) * this.game.map.height;
    this.onNavigate?.(x, y);
  }

  /** Colour for one tile on the terrain layer. */
  private tileColor(i: number): string | null {
    const map = this.game.map;
    if ((map.flags[i] & FLAG_REVEALED) === 0) return null;

    const terrain = map.terrain[i] as Terrain;
    const owner = map.owner[i] as Owner;
    const room = map.room[i] as RoomType;

    switch (terrain) {
      case Terrain.Rock: return '#0a0a0c';
      case Terrain.Earth: return '#3a2a1c';
      case Terrain.Gold: return '#8a6a20';
      case Terrain.Gems: return '#1f7a8a';
      case Terrain.Water: return '#123244';
      case Terrain.Lava: return '#8a2a10';
      case Terrain.Wall: {
        const c = OWNER_COLORS[owner];
        return `#${(darken(c, 0.45)).toString(16).padStart(6, '0')}`;
      }
      case Terrain.Path: return '#584736';
      case Terrain.Claimed: {
        // Rooms show brighter than plain claimed floor so you can read your
        // dungeon's layout at a glance.
        const base = OWNER_COLORS[owner];
        return `#${(room === RoomType.None ? darken(base, 0.62) : base)
          .toString(16).padStart(6, '0')}`;
      }
      default: return '#000000';
    }
  }

  private redrawTerrain(): void {
    const map = this.game.map;
    const img = this.terrainCtx.createImageData(map.width, map.height);
    for (let i = 0; i < map.terrain.length; i++) {
      const hex = this.tileColor(i);
      const o = i * 4;
      if (hex === null) {
        img.data[o] = 4; img.data[o + 1] = 3; img.data[o + 2] = 8; img.data[o + 3] = 255;
        continue;
      }
      const v = parseInt(hex.slice(1), 16);
      img.data[o] = (v >> 16) & 255;
      img.data[o + 1] = (v >> 8) & 255;
      img.data[o + 2] = v & 255;
      img.data[o + 3] = 255;
    }
    this.terrainCtx.putImageData(img, 0, 0);
  }

  /** Redraw the minimap. `focus` and `yaw` place the view marker. */
  draw(focusX: number, focusY: number, yaw: number, distance: number): void {
    const map = this.game.map;
    if (map.version !== this.lastVersion) {
      this.lastVersion = map.version;
      this.redrawTerrain();
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, map.width, map.height);
    ctx.drawImage(this.terrainCanvas, 0, 0);

    // Creatures as single bright pixels in their keeper's colour.
    for (const c of this.game.creatures) {
      if (c.inHand) continue;
      const x = Math.round(c.x), y = Math.round(c.y);
      if (!map.inBounds(x, y)) continue;
      if ((map.flags[map.idx(x, y)] & FLAG_REVEALED) === 0) continue;
      const colour = OWNER_COLORS[c.owner as Owner];
      ctx.fillStyle = `#${lighten(colour, 0.35).toString(16).padStart(6, '0')}`;
      // Bigger creatures get a fatter dot, so a dragon reads differently to a fly.
      const size = CREATURE_SPECS[c.type].scale > 1 ? 2 : 1;
      ctx.fillRect(x, y, size, size);
    }

    // Landmarks. A minimap of coloured pixels tells you where your territory is
    // and nothing about what is on it — you cannot find your own training room
    // on it, let alone the rival's heart. These are the four things worth
    // finding, marked so they read at this size.
    this.drawLandmarks();

    // The camera's footprint: a wedge showing where you're looking.
    ctx.save();
    ctx.translate(focusX, focusY);
    ctx.rotate(-yaw);
    const reach = Math.max(3, distance * 0.42);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, reach, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    ctx.closePath();
    ctx.fillStyle = 'rgba(232, 180, 76, 0.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(232, 180, 76, 0.7)';
    ctx.lineWidth = 0.7;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Mark hearts and portals.
   *
   * Deliberately only these: marking every room turns the minimap into a
   * pincushion at 72 pixels across, and the rooms you hunt for are the ones that
   * decide the level.
   */
  private drawLandmarks(): void {
    const map = this.game.map;
    const ctx = this.ctx;
    const seen = new Set<string>();

    for (let i = 0; i < map.room.length; i++) {
      const room = map.room[i] as RoomType;
      if (room !== RoomType.DungeonHeart && room !== RoomType.Portal) continue;
      if ((map.flags[i] & FLAG_REVEALED) === 0) continue;
      const owner = map.owner[i] as Owner;
      // One mark per room, not per tile: a 3x3 heart is one landmark.
      const key = `${room}:${owner}:${Math.round(map.xOf(i) / 4)}:${Math.round(map.yOf(i) / 4)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const x = map.xOf(i), y = map.yOf(i);
      const colour = OWNER_COLORS[owner];
      ctx.save();
      ctx.translate(x, y);
      ctx.strokeStyle = `#${lighten(colour, 0.55).toString(16).padStart(6, '0')}`;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      if (room === RoomType.DungeonHeart) {
        // A diamond for a heart — the thing you must protect or destroy.
        ctx.moveTo(0, -3);
        ctx.lineTo(3, 0);
        ctx.lineTo(0, 3);
        ctx.lineTo(-3, 0);
        ctx.closePath();
        ctx.fillStyle = `rgba(255, 255, 255, 0.28)`;
        ctx.fill();
      } else {
        // A ring for a portal, hero gate included.
        ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
  }
}

function darken(hex: number, amount: number): number {
  const r = Math.round(((hex >> 16) & 255) * (1 - amount));
  const g = Math.round(((hex >> 8) & 255) * (1 - amount));
  const b = Math.round((hex & 255) * (1 - amount));
  return (r << 16) | (g << 8) | b;
}

function lighten(hex: number, amount: number): number {
  const r = Math.round(((hex >> 16) & 255) + (255 - ((hex >> 16) & 255)) * amount);
  const g = Math.round(((hex >> 8) & 255) + (255 - ((hex >> 8) & 255)) * amount);
  const b = Math.round((hex & 255) + (255 - (hex & 255)) * amount);
  return (r << 16) | (g << 8) | b;
}
