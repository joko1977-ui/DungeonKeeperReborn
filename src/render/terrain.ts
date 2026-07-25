import * as THREE from 'three';
import {
  OWNER_COLORS,
  Owner,
  RoomType,
  Terrain,
  isSolid,
} from '../core/constants';
import { FLAG_REVEALED, TileMap } from '../core/tilemap';
import { GeneratedAtlas, getFloorAtlas, getWallAtlas } from './textures';

/**
 * Draws the whole dungeon in two instanced draw calls.
 *
 * Every floor tile is one instance of a quad and every wall one instance of a
 * box; which material each instance wears is a per-instance atlas index read by
 * a small patch to the standard shader. That keeps the entire map — walls,
 * floors, rooms, water, lava — at two draw calls regardless of size, so the
 * frame budget goes to lighting and creatures instead.
 */

/** Atlas slot indices, matching the order in textures.ts. */
const WALL_EARTH = 0, WALL_GOLD = 1, WALL_GEMS = 2, WALL_BEDROCK = 3, WALL_REINFORCED = 4;
const FLOOR_ROCK = 0, FLOOR_FLAGSTONE = 1, FLOOR_TREASURY = 2, FLOOR_LAIR = 3,
  FLOOR_HATCHERY = 4, FLOOR_TRAINING = 5, FLOOR_LIBRARY = 6, FLOOR_BRIDGE = 7,
  FLOOR_WATER = 8, FLOOR_LAVA = 9;

export const WALL_HEIGHT = 1.15;

/** Which floor atlas slot a tile should use. */
function floorSlotFor(map: TileMap, i: number): number {
  const t = map.terrain[i] as Terrain;
  if (t === Terrain.Water) return FLOOR_WATER;
  if (t === Terrain.Lava) return FLOOR_LAVA;
  const room = map.room[i] as RoomType;
  switch (room) {
    case RoomType.Treasury: return FLOOR_TREASURY;
    case RoomType.Lair: return FLOOR_LAIR;
    case RoomType.Hatchery: return FLOOR_HATCHERY;
    case RoomType.TrainingRoom: return FLOOR_TRAINING;
    case RoomType.Library: return FLOOR_LIBRARY;
    case RoomType.Bridge: return FLOOR_BRIDGE;
    case RoomType.DungeonHeart: return FLOOR_TRAINING;
    case RoomType.Portal: return FLOOR_LIBRARY;
    default: break;
  }
  return t === Terrain.Claimed ? FLOOR_FLAGSTONE : FLOOR_ROCK;
}

/** Which wall atlas slot a solid tile should use. */
function wallSlotFor(map: TileMap, i: number): number {
  switch (map.terrain[i] as Terrain) {
    case Terrain.Gold: return WALL_GOLD;
    case Terrain.Gems: return WALL_GEMS;
    case Terrain.Rock: return WALL_BEDROCK;
    case Terrain.Wall: return WALL_REINFORCED;
    default: return WALL_EARTH;
  }
}

/**
 * Patch a MeshStandardMaterial so each instance samples its own atlas cell.
 *
 * The standard shader builds all its UV varyings inside `<uv_vertex>`, so we
 * append there and rewrite them in one go. Everything downstream — normal
 * mapping, roughness, emissive — then reads the right cell for free.
 */
function applyAtlasShader(material: THREE.MeshStandardMaterial, atlas: GeneratedAtlas): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAtlasCols = { value: atlas.cols };
    shader.uniforms.uAtlasRows = { value: atlas.rows };
    // Inset by a couple of texels so mip levels never bleed between cells.
    shader.uniforms.uAtlasPad = { value: 2.5 / 256 };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aTile;
         uniform float uAtlasCols;
         uniform float uAtlasRows;
         uniform float uAtlasPad;`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
         {
           vec2 cell = vec2( mod( aTile, uAtlasCols ), floor( aTile / uAtlasCols ) );
           vec2 inv = vec2( 1.0 / uAtlasCols, 1.0 / uAtlasRows );
           vec2 atlasUv = ( uv * ( 1.0 - 2.0 * uAtlasPad ) + uAtlasPad + cell ) * inv;
           #ifdef USE_MAP
             vMapUv = atlasUv;
           #endif
           #ifdef USE_NORMALMAP
             vNormalMapUv = atlasUv;
           #endif
           #ifdef USE_ROUGHNESSMAP
             vRoughnessMapUv = atlasUv;
           #endif
           #ifdef USE_METALNESSMAP
             vMetalnessMapUv = atlasUv;
           #endif
           #ifdef USE_EMISSIVEMAP
             vEmissiveMapUv = atlasUv;
           #endif
         }`,
      );
  };
  // Force a recompile if the material is reused across atlases.
  material.customProgramCacheKey = () => `atlas-${atlas.cols}x${atlas.rows}`;
}

export class TerrainRenderer {
  readonly group = new THREE.Group();

  private readonly map: TileMap;
  private readonly floorMesh: THREE.InstancedMesh;
  private readonly wallMesh: THREE.InstancedMesh;
  private readonly floorTileAttr: THREE.InstancedBufferAttribute;
  private readonly wallTileAttr: THREE.InstancedBufferAttribute;

  /** Glowing tags on walls the keeper has marked for excavation. */
  private readonly markMesh: THREE.InstancedMesh;

  private readonly floorMaterial: THREE.MeshStandardMaterial;
  private readonly wallMaterial: THREE.MeshStandardMaterial;
  private readonly markMaterial: THREE.MeshBasicMaterial;

  private lastVersion = -1;
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();

  /** Tile index -> wall instance slot, so we can look up what a ray hit. */
  private wallInstanceTile: Int32Array;
  private floorInstanceTile: Int32Array;
  private wallCount = 0;
  private floorCount = 0;

  constructor(map: TileMap) {
    this.map = map;
    const capacity = map.width * map.height;

    const wallAtlas = getWallAtlas();
    const floorAtlas = getFloorAtlas();

    /* ---- floors ---- */
    const floorGeo = new THREE.PlaneGeometry(1, 1);
    floorGeo.rotateX(-Math.PI / 2);
    this.floorMaterial = new THREE.MeshStandardMaterial({
      map: floorAtlas.map,
      normalMap: floorAtlas.normalMap,
      roughnessMap: floorAtlas.roughnessMap,
      metalnessMap: floorAtlas.roughnessMap,
      emissiveMap: floorAtlas.emissiveMap,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 1.0,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(1.1, 1.1),
    });
    applyAtlasShader(this.floorMaterial, floorAtlas);

    this.floorMesh = new THREE.InstancedMesh(floorGeo, this.floorMaterial, capacity);
    this.floorMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.floorMesh.receiveShadow = true;
    this.floorMesh.castShadow = false;
    this.floorMesh.frustumCulled = false;
    this.floorTileAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.floorTileAttr.setUsage(THREE.DynamicDrawUsage);
    floorGeo.setAttribute('aTile', this.floorTileAttr);
    this.floorMesh.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.floorMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    /* ---- walls ---- */
    const wallGeo = new THREE.BoxGeometry(1, WALL_HEIGHT, 1);
    wallGeo.translate(0, WALL_HEIGHT / 2, 0);
    this.wallMaterial = new THREE.MeshStandardMaterial({
      map: wallAtlas.map,
      normalMap: wallAtlas.normalMap,
      roughnessMap: wallAtlas.roughnessMap,
      metalnessMap: wallAtlas.roughnessMap,
      emissiveMap: wallAtlas.emissiveMap,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 1.0,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(1.35, 1.35),
    });
    applyAtlasShader(this.wallMaterial, wallAtlas);

    this.wallMesh = new THREE.InstancedMesh(wallGeo, this.wallMaterial, capacity);
    this.wallMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wallMesh.castShadow = true;
    this.wallMesh.receiveShadow = true;
    this.wallMesh.frustumCulled = false;
    this.wallTileAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.wallTileAttr.setUsage(THREE.DynamicDrawUsage);
    wallGeo.setAttribute('aTile', this.wallTileAttr);
    this.wallMesh.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.wallMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    /* ---- excavation tags ---- */
    // A flat diamond that sits just proud of the wall face and pulses.
    const markGeo = new THREE.PlaneGeometry(0.42, 0.42);
    markGeo.rotateZ(Math.PI / 4);
    markGeo.rotateX(-Math.PI / 2);
    this.markMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd24a,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.markMesh = new THREE.InstancedMesh(markGeo, this.markMaterial, capacity);
    this.markMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.markMesh.frustumCulled = false;
    this.markMesh.renderOrder = 2;

    this.wallInstanceTile = new Int32Array(capacity).fill(-1);
    this.floorInstanceTile = new Int32Array(capacity).fill(-1);

    this.group.add(this.floorMesh, this.wallMesh, this.markMesh);
  }

  /** Rebuild instance buffers if the map changed since the last frame. */
  syncIfDirty(): boolean {
    if (this.map.version === this.lastVersion) return false;
    this.lastVersion = this.map.version;
    this.rebuild();
    return true;
  }

  private rebuild(): void {
    const map = this.map;
    const { dummy, color } = this;
    let floorN = 0, wallN = 0, markN = 0;

    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = map.idx(x, y);

        // Fog of war: anything never seen simply isn't drawn.
        if ((map.flags[i] & FLAG_REVEALED) === 0) continue;

        const terrain = map.terrain[i] as Terrain;
        const owner = map.owner[i] as Owner;

        if (isSolid(terrain)) {
          // Skip walls fully buried behind other walls — they can't be seen and
          // they're the bulk of an unexcavated map.
          if (this.isFullyEnclosed(x, y)) continue;

          dummy.position.set(x, 0, y);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          this.wallMesh.setMatrixAt(wallN, dummy.matrix);
          this.wallTileAttr.setX(wallN, wallSlotFor(map, i));

          // Reinforced walls wear their keeper's colour.
          if (terrain === Terrain.Wall && owner !== Owner.None) {
            color.setHex(OWNER_COLORS[owner]).lerp(new THREE.Color(0xffffff), 0.45);
          } else {
            color.setRGB(1, 1, 1);
          }
          this.wallMesh.setColorAt(wallN, color);
          this.wallInstanceTile[wallN] = i;
          wallN++;

          // Excavation tag, floating just above the block.
          if ((map.flags[i] & 1) !== 0) {
            dummy.position.set(x, WALL_HEIGHT + 0.02, y);
            dummy.updateMatrix();
            this.markMesh.setMatrixAt(markN, dummy.matrix);
            markN++;
          }
        } else {
          dummy.position.set(x, terrain === Terrain.Water || terrain === Terrain.Lava ? -0.18 : 0, y);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          this.floorMesh.setMatrixAt(floorN, dummy.matrix);
          this.floorTileAttr.setX(floorN, floorSlotFor(map, i));

          if (terrain === Terrain.Claimed && owner !== Owner.None) {
            color.setHex(OWNER_COLORS[owner]).lerp(new THREE.Color(0xffffff), 0.62);
          } else {
            color.setRGB(1, 1, 1);
          }
          this.floorMesh.setColorAt(floorN, color);
          this.floorInstanceTile[floorN] = i;
          floorN++;
        }
      }
    }

    this.floorCount = floorN;
    this.wallCount = wallN;
    this.floorMesh.count = floorN;
    this.wallMesh.count = wallN;
    this.markMesh.count = markN;

    this.floorMesh.instanceMatrix.needsUpdate = true;
    this.wallMesh.instanceMatrix.needsUpdate = true;
    this.markMesh.instanceMatrix.needsUpdate = true;
    this.floorTileAttr.needsUpdate = true;
    this.wallTileAttr.needsUpdate = true;
    if (this.floorMesh.instanceColor) this.floorMesh.instanceColor.needsUpdate = true;
    if (this.wallMesh.instanceColor) this.wallMesh.instanceColor.needsUpdate = true;

    this.floorMesh.computeBoundingSphere();
    this.wallMesh.computeBoundingSphere();
  }

  /** True when all four neighbours are solid, so this block is invisible. */
  private isFullyEnclosed(x: number, y: number): boolean {
    return (
      this.map.isSolidAt(x - 1, y) &&
      this.map.isSolidAt(x + 1, y) &&
      this.map.isSolidAt(x, y - 1) &&
      this.map.isSolidAt(x, y + 1)
    );
  }

  /** Per-frame animation: tag pulse and a slow flicker across emissive surfaces. */
  update(time: number): void {
    const pulse = 0.55 + 0.45 * Math.sin(time * 4.5);
    this.markMaterial.opacity = 0.35 + pulse * 0.55;
    // Lava and gems breathe, which sells them as light sources rather than paint.
    const flicker = 0.85 + 0.15 * Math.sin(time * 2.3) + 0.06 * Math.sin(time * 11.7);
    this.floorMaterial.emissiveIntensity = flicker;
    this.wallMaterial.emissiveIntensity = flicker * 0.9;
  }

  /** Meshes a raycaster should test against. */
  pickTargets(): THREE.Object3D[] {
    return [this.floorMesh, this.wallMesh];
  }

  /**
   * Turn a raycast hit back into a tile index.
   * Returns -1 when the hit wasn't on terrain.
   */
  tileFromIntersection(hit: THREE.Intersection): number {
    const id = hit.instanceId;
    if (id === undefined) return -1;
    if (hit.object === this.wallMesh) {
      return id < this.wallCount ? this.wallInstanceTile[id] : -1;
    }
    if (hit.object === this.floorMesh) {
      return id < this.floorCount ? this.floorInstanceTile[id] : -1;
    }
    return -1;
  }

  dispose(): void {
    this.floorMesh.geometry.dispose();
    this.wallMesh.geometry.dispose();
    this.markMesh.geometry.dispose();
    this.floorMaterial.dispose();
    this.wallMaterial.dispose();
    this.markMaterial.dispose();
  }
}
