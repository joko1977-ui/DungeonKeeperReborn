import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  OWNER_COLORS,
  Owner,
  RoomType,
  Terrain,
  isSolid,
} from '../core/constants';
import { FLAG_REVEALED, TileMap } from '../core/tilemap';
import { GeneratedAtlas, getFloorAtlas, getWallAtlas } from './textures';
import { celRamp } from './celRamp';

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

/** Deterministic per-tile noise in [0,1), for shape and shade variation. */
function tileNoise(tile: number, salt: number): number {
  let t = (tile * 374761393) ^ (salt * 668265263);
  t = Math.imul(t ^ (t >>> 13), 1274126177);
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

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
 * Patch a material so each instance samples its own atlas cell.
 *
 * Three's shaders build all their UV varyings inside `<uv_vertex>`, so we append
 * there and rewrite them in one go. Everything downstream — normal mapping,
 * emissive — then reads the right cell for free. The roughness and metalness
 * blocks are guarded by their own defines, so they simply drop out on a toon
 * material, which has neither.
 */
function applyAtlasShader(
  material: THREE.Material, atlas: GeneratedAtlas, contactShading = false,
): void {
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

    if (!contactShading) return;

    /*
     * Contact shading: the dark the artist puts where a floor meets a wall.
     *
     * The single biggest thing still missing. Every object in the dungeon sat on
     * the floor without touching it — no occlusion, no darkening in the corners,
     * so a room read as a flat plane with blocks placed on top rather than as a
     * space cut out of rock. It is the same observation as the rim light from the
     * other end: an illustrator draws a heavy line and a wash of shadow along the
     * base of a wall, and without it geometry floats.
     *
     * Done from the tile's own neighbours rather than in screen space. A real
     * ambient-occlusion pass needs a normal buffer, a blur and a good deal of
     * frame time, and would deliver a soft grey haze — where what this wants is a
     * hard-edged wash in exactly the places the map already knows about: the eight
     * neighbours of a tile, packed into one byte per instance.
     */
    shader.uniforms.uOcclusion = { value: 0.55 };
    shader.uniforms.uOccReach = { value: 0.46 };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aOcc;
         varying float vOcc;
         varying vec2 vTileUv;`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
         vOcc = aOcc;
         vTileUv = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uOcclusion;
         uniform float uOccReach;
         varying float vOcc;
         varying vec2 vTileUv;

         float occBit( float mask, float bit ) {
           return mod( floor( mask / pow( 2.0, bit ) ), 2.0 );
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         {
           // Bits run round the tile: edges at 0-3 and corners at 4-7, both
           // anticlockwise from -u, so a tile's random quarter-turn is applied by
           // rotating the byte rather than by anything the shader has to know.
           float k = uOccReach;
           float du0 = vTileUv.x, du1 = 1.0 - vTileUv.x;
           float dv0 = vTileUv.y, dv1 = 1.0 - vTileUv.y;
           float occ = 0.0;
           occ = max( occ, occBit( vOcc, 0.0 ) * smoothstep( k, 0.0, du0 ) );
           occ = max( occ, occBit( vOcc, 1.0 ) * smoothstep( k, 0.0, dv1 ) );
           occ = max( occ, occBit( vOcc, 2.0 ) * smoothstep( k, 0.0, du1 ) );
           occ = max( occ, occBit( vOcc, 3.0 ) * smoothstep( k, 0.0, dv0 ) );
           occ = max( occ, occBit( vOcc, 4.0 ) * smoothstep( k, 0.0, length( vec2( du0, dv1 ) ) ) );
           occ = max( occ, occBit( vOcc, 5.0 ) * smoothstep( k, 0.0, length( vec2( du1, dv1 ) ) ) );
           occ = max( occ, occBit( vOcc, 6.0 ) * smoothstep( k, 0.0, length( vec2( du1, dv0 ) ) ) );
           occ = max( occ, occBit( vOcc, 7.0 ) * smoothstep( k, 0.0, length( vec2( du0, dv0 ) ) ) );
           diffuseColor.rgb *= 1.0 - occ * uOcclusion;
         }`,
      );
  };
  // Force a recompile if the material is reused across atlases.
  material.customProgramCacheKey = () => `atlas-${atlas.cols}x${atlas.rows}-${contactShading}`;
}

/**
 * Pack a floor tile's solid neighbours into one byte, in the tile's own frame.
 *
 * Bits 0-3 are the edges and 4-7 the corners, both running anticlockwise from the
 * -u side. Floor quads are given a random quarter-turn to stop the texture reading
 * as a repeat, so the byte is rotated by the same amount here: the shader then
 * needs to know nothing about which way a particular tile happens to be facing.
 */
function neighbourMask(map: TileMap, x: number, y: number, quarter: number): number {
  // Anticlockwise from -u with the quad unrotated: west, north, east, south.
  const edges = [
    map.isSolidAt(x - 1, y), map.isSolidAt(x, y - 1),
    map.isSolidAt(x + 1, y), map.isSolidAt(x, y + 1),
  ];
  const corners = [
    map.isSolidAt(x - 1, y - 1), map.isSolidAt(x + 1, y - 1),
    map.isSolidAt(x + 1, y + 1), map.isSolidAt(x - 1, y + 1),
  ];
  let mask = 0;
  for (let k = 0; k < 4; k++) {
    if (edges[k]) mask |= 1 << ((k + quarter) & 3);
    if (corners[k]) mask |= 1 << (4 + ((k + quarter) & 3));
  }
  return mask;
}

export class TerrainRenderer {
  readonly group = new THREE.Group();

  private readonly map: TileMap;
  private readonly floorMesh: THREE.InstancedMesh;
  private readonly wallMesh: THREE.InstancedMesh;
  private readonly floorTileAttr: THREE.InstancedBufferAttribute;
  /** Which of a floor tile's eight neighbours are solid, packed per instance. */
  private readonly floorOccAttr: THREE.InstancedBufferAttribute;
  private readonly wallTileAttr: THREE.InstancedBufferAttribute;

  /** Glowing tags on walls the keeper has marked for excavation. */
  private readonly markMesh: THREE.InstancedMesh;

  private readonly floorMaterial: THREE.MeshToonMaterial;
  private readonly wallMaterial: THREE.MeshToonMaterial;
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
    /*
     * Toon, like everything else in the frame.
     *
     * A physically-based floor spreads torchlight across itself as a smooth
     * gradient, which is a photograph of a floor. The creatures standing on it are
     * shaded in three flat steps with hard edges between them, and the mismatch was
     * the loudest thing about the look: they read as stickers on a rendered scene
     * rather than as figures in a drawing. Same ramp, same hard steps, one picture.
     *
     * Toon has no roughness or metalness, which is a feature here. Those maps were
     * what put a mirror sparkle on every flagstone.
     */
    this.floorMaterial = new THREE.MeshToonMaterial({
      map: floorAtlas.map,
      gradientMap: celRamp(),
      normalMap: floorAtlas.normalMap,
      emissiveMap: floorAtlas.emissiveMap,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 1.0,
      // A fraction of what it was. A strong normal map is a continuous shading
      // gradient by another name, and the flat bands are baked into the colour
      // now; this is left only so a surface is not perfectly dead.
      normalScale: new THREE.Vector2(0.32, 0.32),
    });
    applyAtlasShader(this.floorMaterial, floorAtlas, true);

    this.floorMesh = new THREE.InstancedMesh(floorGeo, this.floorMaterial, capacity);
    this.floorMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.floorMesh.receiveShadow = true;
    this.floorMesh.castShadow = false;
    this.floorMesh.frustumCulled = false;
    this.floorTileAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.floorTileAttr.setUsage(THREE.DynamicDrawUsage);
    floorGeo.setAttribute('aTile', this.floorTileAttr);
    this.floorOccAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.floorOccAttr.setUsage(THREE.DynamicDrawUsage);
    floorGeo.setAttribute('aOcc', this.floorOccAttr);
    this.floorMesh.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.floorMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    /* ---- walls ---- */
    // A plain cube per tile made the map look like a spreadsheet. This is a
    // body with an inset, chamfered cap: the bevel gives every block a lit top
    // edge and a shadowed under-edge, which is what stops a field of them
    // reading as one flat mass.
    const wallGeo = (() => {
      const cap = 0.13;
      const inset = 0.11;
      const body = new THREE.BoxGeometry(1, WALL_HEIGHT - cap, 1);
      body.translate(0, (WALL_HEIGHT - cap) / 2, 0);
      // A frustum: wider at the bottom, narrower on top, giving the chamfer.
      const top = new THREE.CylinderGeometry(
        (1 - inset) * 0.5 * Math.SQRT2, 0.5 * Math.SQRT2, cap, 4, 1,
      );
      top.rotateY(Math.PI / 4);
      top.translate(0, WALL_HEIGHT - cap / 2, 0);
      const merged = mergeGeometries([body, top], false);
      body.dispose();
      top.dispose();
      if (!merged) throw new Error('failed to build wall geometry');
      merged.computeVertexNormals();
      return merged;
    })();
    this.wallMaterial = new THREE.MeshToonMaterial({
      map: wallAtlas.map,
      gradientMap: celRamp(),
      normalMap: wallAtlas.normalMap,
      emissiveMap: wallAtlas.emissiveMap,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 1.0,
      normalScale: new THREE.Vector2(0.38, 0.38),
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
          // Every revealed solid tile is drawn, including ones buried behind
          // other rock. Culling them looked like a free win — they are hidden
          // from the side, after all — but it made the map a set of floating
          // islands instead of a solid mass with corridors cut through it, and
          // worse, a tile with no geometry cannot be hit by a raycast. That
          // silently limited excavation tagging to the single exposed face,
          // which makes digging a slab miserable. They are one instanced draw
          // call either way.
          // Natural rock gets a little height and yaw variation; masonry a
          // keeper has reinforced stays square, because it was cut square.
          const dressed = terrain === Terrain.Wall;
          const h = dressed ? 1 : 0.92 + tileNoise(i, 1) * 0.16;
          const spin = dressed ? 0 : (Math.floor(tileNoise(i, 2) * 4) * Math.PI) / 2;
          dummy.position.set(x, 0, y);
          dummy.rotation.set(0, spin, 0);
          dummy.scale.set(1, h, 1);
          dummy.updateMatrix();
          this.wallMesh.setMatrixAt(wallN, dummy.matrix);
          this.wallTileAttr.setX(wallN, wallSlotFor(map, i));

          // Reinforced walls wear their keeper's colour.
          if (dressed && owner !== Owner.None) {
            color.setHex(OWNER_COLORS[owner]).lerp(new THREE.Color(0xffffff), 0.45);
          } else {
            // Break up the mass: identical instances of one texture still read
            // as a repeat, and a few percent of brightness scatter hides it.
            const v = 0.82 + tileNoise(i, 3) * 0.36;
            color.setRGB(v, v * (0.97 + tileNoise(i, 4) * 0.06), v * 0.95);
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
          const quarter = Math.floor(tileNoise(i, 6) * 4);
          dummy.rotation.set(0, (quarter * Math.PI) / 2, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          this.floorMesh.setMatrixAt(floorN, dummy.matrix);
          this.floorTileAttr.setX(floorN, floorSlotFor(map, i));
          this.floorOccAttr.setX(floorN, neighbourMask(map, x, y, quarter));

          const fv = 0.86 + tileNoise(i, 5) * 0.28;
          if (terrain === Terrain.Claimed && owner !== Owner.None) {
            color.setHex(OWNER_COLORS[owner])
              .lerp(new THREE.Color(0xffffff), 0.62)
              .multiplyScalar(fv);
          } else {
            color.setRGB(fv, fv * 0.99, fv * 0.97);
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
    this.floorOccAttr.needsUpdate = true;
    if (this.floorMesh.instanceColor) this.floorMesh.instanceColor.needsUpdate = true;
    if (this.wallMesh.instanceColor) this.wallMesh.instanceColor.needsUpdate = true;

    this.floorMesh.computeBoundingSphere();
    this.wallMesh.computeBoundingSphere();
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
