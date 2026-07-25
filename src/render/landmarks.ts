import * as THREE from 'three';
import { OWNER_COLORS, Owner, ROOM_SPECS, RoomType } from '../core/constants';
import { FLAG_REVEALED, TileMap } from '../core/tilemap';

/**
 * Labels over rooms, and light over the places that matter.
 *
 * A dungeon you have dug yourself is legible while you are digging it and
 * becomes a maze twenty minutes later. Furniture tells you what a room *is* once
 * you are looking straight at it, but it does not tell you where the training
 * room went, and nothing at all told you where the rival keeper's heart was or
 * which hole in the wall the heroes come out of.
 *
 * Two things fix that, and both are deliberately quiet:
 *
 *   - **Room labels.** One per room — per *room*, not per tile, so two separate
 *     treasuries get a label each rather than one floating between them. They
 *     fade out when the camera comes close, because at that distance the
 *     furniture is doing the job and the text is in the way.
 *   - **Landmark beacons.** A slow shaft of light over the things a level is
 *     about: your heart and portal, a rival's heart, the hero gate. Coloured by
 *     whose it is, and only over ground you have actually seen.
 */

/** Tiles a room must have before it is worth labelling. */
const MIN_ROOM_TILES = 2;

/** Camera distances between which labels fade in. */
const LABEL_NEAR = 13;
const LABEL_FAR = 20;

/** Landmarks that get a shaft of light. */
const BEACON_ROOMS: readonly RoomType[] = [RoomType.DungeonHeart, RoomType.Portal];

interface RoomCluster {
  room: RoomType;
  owner: Owner;
  x: number;
  y: number;
  tiles: number;
}

/** One label texture per room type, drawn once and shared by every instance. */
function makeLabelTexture(text: string): THREE.Texture {
  const pad = 14;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('label needs a 2D context');

  const font = '600 40px Georgia, "Times New Roman", serif';
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.width = width;
  canvas.height = 64;

  // Re-set after the resize: changing canvas dimensions clears the context.
  const c = canvas.getContext('2d');
  if (!c) throw new Error('label needs a 2D context');
  c.font = font;
  c.textAlign = 'center';
  c.textBaseline = 'middle';

  // A dark plate behind the text, so it stays readable over a lit floor as
  // well as over black rock.
  c.fillStyle = 'rgba(8, 6, 5, 0.55)';
  c.beginPath();
  c.roundRect(0, 8, width, 48, 8);
  c.fill();

  c.lineWidth = 6;
  c.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  c.strokeText(text, width / 2, 33);
  c.fillStyle = '#f0d9a8';
  c.fillText(text, width / 2, 33);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

export class LandmarkRenderer {
  readonly group = new THREE.Group();

  private readonly map: TileMap;
  private readonly labelTextures = new Map<RoomType, THREE.Texture>();
  private readonly labelPool: THREE.Sprite[] = [];
  private readonly beaconPool: THREE.Mesh[] = [];
  private readonly beaconMaterial: THREE.MeshBasicMaterial;
  private readonly beaconGeometry: THREE.CylinderGeometry;

  private clusters: RoomCluster[] = [];
  private lastVersion = -1;
  private readonly color = new THREE.Color();

  constructor(map: TileMap) {
    this.map = map;

    // A tall, soft cone of light. Rendered from inside as well as outside so
    // the camera can pass through one without it vanishing.
    this.beaconGeometry = new THREE.CylinderGeometry(0.30, 0.62, 7, 12, 1, true);
    this.beaconGeometry.translate(0, 3.5, 0);
    this.beaconMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    // Fade the shaft out toward the top, so it reads as light rather than as a
    // plastic tube standing in the room.
    this.fadeBeaconVertically();
  }

  /** Bake a top-to-bottom alpha ramp into the beacon's vertex colours. */
  private fadeBeaconVertically(): void {
    const pos = this.beaconGeometry.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, Math.min(1, pos.getY(i) / 7));
      const a = Math.pow(1 - t, 1.8);
      colors[i * 3] = a;
      colors[i * 3 + 1] = a;
      colors[i * 3 + 2] = a;
    }
    this.beaconGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  /** Rebuild the room clustering when the dungeon changes. */
  syncIfDirty(): boolean {
    if (this.map.version === this.lastVersion) return false;
    this.lastVersion = this.map.version;
    this.clusters = this.findClusters();
    this.layout();
    return true;
  }

  /**
   * Find each contiguous run of same-type, same-owner room tiles.
   *
   * Averaging every tile of a room type together was the obvious approach and
   * the wrong one: build two treasuries at opposite ends of the dungeon and the
   * single label lands in the rock between them, pointing at nothing.
   */
  private findClusters(): RoomCluster[] {
    const map = this.map;
    const seen = new Uint8Array(map.room.length);
    const clusters: RoomCluster[] = [];
    const stack: number[] = [];

    for (let start = 0; start < map.room.length; start++) {
      if (seen[start]) continue;
      const room = map.room[start] as RoomType;
      if (room === RoomType.None) continue;
      if ((map.flags[start] & FLAG_REVEALED) === 0) continue;
      const owner = map.owner[start] as Owner;

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
          if (seen[ni]) continue;
          if (map.room[ni] !== room || map.owner[ni] !== owner) continue;
          if ((map.flags[ni] & FLAG_REVEALED) === 0) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
      if (n >= MIN_ROOM_TILES) {
        clusters.push({ room, owner, x: sx / n, y: sy / n, tiles: n });
      }
    }
    return clusters;
  }

  /** Place a sprite over every cluster and a shaft over every landmark. */
  private layout(): void {
    let labelN = 0;
    let beaconN = 0;

    for (const cluster of this.clusters) {
      const sprite = this.labelAt(labelN++);
      const spec = ROOM_SPECS[cluster.room];
      let tex = this.labelTextures.get(cluster.room);
      if (!tex) {
        tex = makeLabelTexture(spec.name);
        this.labelTextures.set(cluster.room, tex);
      }
      const mat = sprite.material as THREE.SpriteMaterial;
      if (mat.map !== tex) {
        mat.map = tex;
        mat.needsUpdate = true;
      }
      // Sized in screen space, not world space. A label that shrinks with
      // distance is unreadable at exactly the zoom where you need it — when you
      // are looking at the whole dungeon trying to find a room.
      const image = tex.image as HTMLCanvasElement;
      const h = 0.034;
      sprite.scale.set((image.width / image.height) * h, h, 1);
      sprite.position.set(cluster.x, 1.9, cluster.y);
      // Enemy rooms are named in their keeper's colour, so a discovered rival
      // dungeon reads as theirs at a glance.
      this.color.setHex(OWNER_COLORS[cluster.owner]);
      mat.color.copy(cluster.owner === Owner.Player
        ? this.color.setHex(0xffffff) : this.color);
      sprite.visible = true;

      if (BEACON_ROOMS.includes(cluster.room)) {
        const beacon = this.beaconAt(beaconN++);
        beacon.position.set(cluster.x, 0, cluster.y);
        this.color.setHex(OWNER_COLORS[cluster.owner]).convertSRGBToLinear();
        (beacon.material as THREE.MeshBasicMaterial).color.copy(this.color);
        beacon.visible = true;
      }
    }

    for (let i = labelN; i < this.labelPool.length; i++) this.labelPool[i].visible = false;
    for (let i = beaconN; i < this.beaconPool.length; i++) this.beaconPool[i].visible = false;
  }

  private labelAt(i: number): THREE.Sprite {
    let sprite = this.labelPool[i];
    if (!sprite) {
      sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: false,
        sizeAttenuation: false,
      }));
      sprite.renderOrder = 20;
      this.labelPool[i] = sprite;
      this.group.add(sprite);
    }
    return sprite;
  }

  private beaconAt(i: number): THREE.Mesh {
    let mesh = this.beaconPool[i];
    if (!mesh) {
      // Each beacon needs its own material instance: they are different colours,
      // and a shared material would make every landmark the same keeper's.
      mesh = new THREE.Mesh(this.beaconGeometry, this.beaconMaterial.clone());
      mesh.renderOrder = 4;
      this.beaconPool[i] = mesh;
      this.group.add(mesh);
    }
    return mesh;
  }

  /**
   * Per-frame: fade the labels by camera distance and breathe the beacons.
   *
   * Labels are off entirely when the camera is close. Text floating over a room
   * you are standing in is clutter, and the furniture already says what it is.
   */
  update(time: number, cameraDistance: number): void {
    const fade = Math.max(0, Math.min(1,
      (cameraDistance - LABEL_NEAR) / (LABEL_FAR - LABEL_NEAR)));
    for (const sprite of this.labelPool) {
      if (!sprite.visible) continue;
      const mat = sprite.material as THREE.SpriteMaterial;
      mat.opacity = fade * 0.92;
      sprite.visible = fade > 0.02;
    }
    // Restore visibility for the ones the fade switched off, next time it rises.
    if (fade > 0.02) {
      for (let i = 0; i < this.labelPool.length; i++) {
        const sprite = this.labelPool[i];
        if (i < this.clusters.length) sprite.visible = true;
      }
    }

    for (let i = 0; i < this.beaconPool.length; i++) {
      const beacon = this.beaconPool[i];
      if (!beacon.visible) continue;
      const mat = beacon.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.12 + 0.07 * Math.sin(time * 1.1 + i * 1.7);
      beacon.rotation.y = time * 0.15 + i;
    }
  }

  dispose(): void {
    for (const tex of this.labelTextures.values()) tex.dispose();
    for (const sprite of this.labelPool) (sprite.material as THREE.SpriteMaterial).dispose();
    for (const beacon of this.beaconPool) (beacon.material as THREE.Material).dispose();
    this.beaconGeometry.dispose();
    this.beaconMaterial.dispose();
  }
}
