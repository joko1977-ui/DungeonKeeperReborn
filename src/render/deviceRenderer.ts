import * as THREE from 'three';
import { Terrain } from '../core/constants';
import { DOOR_SPECS, DoorType, TRAP_SPECS, TrapType } from '../core/devices';
import { FLAG_REVEALED, TileMap } from '../core/tilemap';
import { PartBuilder } from './creatureModels';
import { WALL_HEIGHT } from './terrain';

/**
 * Traps, doors and the gas they leave behind.
 *
 * These have to be legible from the game's usual overhead-ish camera and at a
 * glance, because the whole point of a trap is knowing where your own ones are
 * before an intruder finds them. So each trap type gets a distinct silhouette
 * plus a flat coloured rune ring in its own colour, pulsing while it is armed
 * and dark once it is spent. Doors are read the same way: the panel darkens and
 * splinters as its integrity drops, so you can see which one is about to go.
 *
 * Geometry is built once per type and drawn as one InstancedMesh each, the same
 * arrangement as the room furniture. Placement is rebuilt from the tilemap
 * version; damage tint and the armed pulse are per-frame, because they change
 * without the map changing.
 */

/** Plenty for any dungeon, and cheap: nine instanced meshes of this size. */
const MAX_DEVICES = 220;

/** Overlapping puffs per gas cloud, and the ceiling on clouds drawn at once. */
const PUFFS_PER_CLOUD = 5;
const MAX_CLOUDS = 24;

/* ------------------------------------------------------------- geometry -- */

/** The armed indicator: a flat ring, coloured per instance. */
function buildRuneRing(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.torus(0.38, 0.030, 0, 0.014, 0, 0xffffff);
  b.torus(0.22, 0.018, 0, 0.014, 0, 0xffffff);
  // Four ticks on the ring, so it reads as machined rather than painted on.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.box(0.10, 0.008, 0.03, Math.cos(a) * 0.30, 0.014, Math.sin(a) * 0.30,
      0xffffff, 0, -a, 0);
  }
  return b.build();
}

/** Brass pressure plate under a bell on a post. */
function buildAlarmTrap(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.cylinder(0.32, 0.35, 0.055, 0, 0.027, 0, 0xd0a94e, 0, 0, 0, 12);
  b.cylinder(0.26, 0.28, 0.035, 0, 0.070, 0, 0xecc86a, 0, 0, 0, 12);
  b.cylinder(0.022, 0.030, 0.34, 0, 0.24, 0, 0x9ea2ae);
  // Bell: a squashed dome with a lip and a clapper hanging under it.
  b.sphere(0.13, 0, 0.44, 0, 0xf2cc63, 1, 0.78, 1, 12);
  b.torus(0.125, 0.022, 0, 0.395, 0, 0xffe08c);
  b.sphere(0.035, 0, 0.375, 0, 0x8e8e98, 1, 1, 1, 7);
  return b.build();
}

/** A grated vent ringed by three nozzles. */
function buildGasTrap(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.cylinder(0.30, 0.33, 0.06, 0, 0.030, 0, 0x86977e, 0, 0, 0, 12);
  // Grate bars over the vent mouth.
  for (let i = 0; i < 4; i++) {
    b.box(0.50, 0.022, 0.045, 0, 0.070, -0.15 + i * 0.10, 0x64735f);
  }
  // Nozzles leaning outward, with a bead of residue at each tip.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const nx = Math.cos(a) * 0.24, nz = Math.sin(a) * 0.24;
    b.cylinder(0.035, 0.055, 0.20, nx, 0.13, nz, 0xa2b48c,
      Math.cos(a) * 0.35, 0, -Math.sin(a) * 0.35);
    b.sphere(0.038, nx * 1.35, 0.23, nz * 1.35, 0xa8e05e, 1, 0.8, 1, 7);
  }
  // A rust ring where it has already leaked.
  b.torus(0.36, 0.012, 0, 0.010, 0, 0x94a865);
  return b.build();
}

/** Two conductor rods over an iron plate, with a coil between them. */
function buildLightningTrap(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.cylinder(0.31, 0.34, 0.06, 0, 0.030, 0, 0x828da0, 0, 0, 0, 12);
  b.box(0.46, 0.04, 0.46, 0, 0.075, 0, 0x9aa4b6);
  for (const side of [-1, 1]) {
    b.cylinder(0.028, 0.040, 0.44, side * 0.20, 0.29, 0, 0xbcc6d6);
    b.sphere(0.062, side * 0.20, 0.53, 0, 0xe4f0ff, 1, 1, 1, 10);
  }
  // Copper windings, and an insulator block at the base of each rod.
  for (let i = 0; i < 3; i++) {
    b.torus(0.055, 0.014, -0.20, 0.16 + i * 0.055, 0, 0xe09454);
    b.torus(0.055, 0.014, 0.20, 0.16 + i * 0.055, 0, 0xe09454);
  }
  b.box(0.30, 0.05, 0.09, 0, 0.12, 0, 0x5a6068);
  return b.build();
}

/** A boulder resting in a kerbed alcove behind a release catch. */
function buildBoulderTrap(): THREE.BufferGeometry {
  const b = new PartBuilder();
  // The kerb it sits in, open at the front.
  b.torus(0.40, 0.055, 0, 0.045, 0, 0xa39a8c, -Math.PI / 2, 0, 0, Math.PI * 1.45);
  b.cylinder(0.38, 0.40, 0.035, 0, 0.017, 0, 0x8b8577, 0, 0, 0, 12);
  // The boulder: a lumpy sphere, not a billiard ball.
  b.sphere(0.30, 0, 0.34, 0, 0xbdb2a2, 1, 0.96, 1.02, 12);
  b.sphere(0.11, 0.20, 0.44, 0.10, 0xcbc0ae, 1, 1, 1, 7);
  b.sphere(0.09, -0.16, 0.28, -0.18, 0xb0a596, 1, 1, 1, 7);
  b.sphere(0.08, 0.04, 0.56, -0.14, 0xd0c5b2, 1, 1, 1, 7);
  // Release catch and its chain anchor.
  b.box(0.06, 0.24, 0.06, -0.36, 0.14, 0.30, 0x878d96);
  b.cylinder(0.014, 0.014, 0.20, -0.30, 0.24, 0.30, 0xbfc4cc, 0, 0, 1.1);
  return b.build();
}

/** A carved rune slab: the Word of Power, waiting to be spoken. */
function buildWordTrap(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.cylinder(0.40, 0.42, 0.05, 0, 0.025, 0, 0x877a9c, 0, 0, 0, 14);
  b.cylinder(0.30, 0.32, 0.03, 0, 0.060, 0, 0x9d8cb8, 0, 0, 0, 14);
  // Six standing glyph stones around the rim.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const h = 0.13 + (i % 2) * 0.06;
    b.box(0.08, h, 0.05, Math.cos(a) * 0.36, 0.05 + h / 2, Math.sin(a) * 0.36,
      0xb9a0dc, 0, -a, 0);
  }
  // A raised sigil in the middle.
  b.box(0.20, 0.03, 0.05, 0, 0.085, 0, 0xd0b8f0, 0, 0.4, 0);
  b.box(0.20, 0.03, 0.05, 0, 0.085, 0, 0xd0b8f0, 0, -0.4, 0);
  b.torus(0.10, 0.020, 0, 0.085, 0, 0xe8d8ff);
  return b.build();
}

/**
 * A door in its frame, built spanning the X axis: the panel blocks travel
 * along Z, and the renderer turns it a quarter for the other orientation.
 */
function buildDoor(type: DoorType): THREE.BufferGeometry {
  const b = new PartBuilder();
  const spec = DOOR_SPECS[type];
  const h = WALL_HEIGHT;
  // The spec colour is picked to read on a lit HUD button. A dungeon is lit by
  // torches, and that same colour goes to mud down here, so lift it first.
  const wood = mix(spec.color, 0xffffff, 0.28);

  // Jambs and lintel, so the door reads as fitted rather than floating.
  for (const side of [-1, 1]) {
    b.box(0.10, h, 0.26, side * 0.45, h / 2, 0, 0x968c7c);
  }
  b.box(1.02, 0.12, 0.28, 0, h - 0.06, 0, 0xa39784);
  // Threshold.
  b.box(1.00, 0.035, 0.30, 0, 0.017, 0, 0x847a6c);

  // The panel itself: vertical planks, slightly inset.
  const planks = 5;
  for (let i = 0; i < planks; i++) {
    const px = -0.32 + i * 0.16;
    const shade = i % 2 === 0 ? wood : mix(wood, 0x000000, 0.12);
    b.box(0.145, h - 0.16, 0.11, px, (h - 0.16) / 2 + 0.03, 0, shade);
  }

  switch (type) {
    case DoorType.Wooden:
      // Two nailed battens and a ring handle.
      b.box(0.76, 0.08, 0.135, 0, 0.32, 0, mix(wood, 0x000000, 0.25));
      b.box(0.76, 0.08, 0.135, 0, h - 0.34, 0, mix(wood, 0x000000, 0.25));
      b.torus(0.055, 0.016, 0.26, 0.60, 0.075, 0xa39a8c, 0, 0, 0);
      break;

    case DoorType.Braced:
      // Iron banding, a diagonal brace and visible bolt heads.
      b.box(0.86, 0.075, 0.145, 0, 0.28, 0, 0x6e737e);
      b.box(0.86, 0.075, 0.145, 0, h - 0.30, 0, 0x6e737e);
      b.box(0.98, 0.065, 0.14, 0, h / 2, 0, 0x7a808c, 0, 0, 0.62);
      for (let i = 0; i < 4; i++) {
        b.sphere(0.025, -0.33 + i * 0.22, 0.28, 0.078, 0x9aa0ac, 1, 1, 0.6, 6);
        b.sphere(0.025, -0.33 + i * 0.22, h - 0.30, 0.078, 0x9aa0ac, 1, 1, 0.6, 6);
      }
      b.torus(0.06, 0.018, 0.28, 0.62, 0.085, 0x8a8f9a, 0, 0, 0);
      break;

    case DoorType.Iron: {
      // A slab of plate with a riveted border and a barred viewing slot.
      b.box(0.86, h - 0.24, 0.13, 0, (h - 0.24) / 2 + 0.06, 0.03, 0x9aa0b0);
      for (let i = 0; i < 6; i++) {
        const rx = -0.38 + i * 0.152;
        b.sphere(0.024, rx, 0.14, 0.095, 0xc0c6d4, 1, 1, 0.6, 6);
        b.sphere(0.024, rx, h - 0.16, 0.095, 0xc0c6d4, 1, 1, 0.6, 6);
      }
      b.box(0.34, 0.13, 0.06, 0, h - 0.40, 0.075, 0x2c3038);
      for (let i = 0; i < 4; i++) {
        b.box(0.022, 0.13, 0.05, -0.12 + i * 0.08, h - 0.40, 0.095, 0x767c88);
      }
      b.torus(0.065, 0.020, 0.28, 0.58, 0.10, 0xb0b6c4, 0, 0, 0);
      break;
    }

    case DoorType.Magic: {
      // Warded: a ring of sigils over the panel and a stone at the centre.
      b.box(0.88, h - 0.26, 0.12, 0, (h - 0.26) / 2 + 0.07, 0.02, 0x584070);
      b.torus(0.26, 0.030, 0, h / 2, 0.085, 0xc8a0ff, 0, 0, 0);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        b.box(0.055, 0.055, 0.03,
          Math.cos(a) * 0.26, h / 2 + Math.sin(a) * 0.26, 0.10,
          0xe0c8ff, 0, 0, a);
      }
      b.sphere(0.075, 0, h / 2, 0.11, 0xf0e0ff, 1, 1, 0.7, 10);
      break;
    }

    default:
      break;
  }
  return b.build();
}

/** A soft puff of gas. Deliberately low-poly: it is drawn many times. */
function buildGasPuff(): THREE.BufferGeometry {
  return new THREE.SphereGeometry(0.42, 8, 6);
}

/** Blend two packed sRGB colours. */
function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/* --------------------------------------------------------------- render -- */

interface TrapInstance {
  tile: number;
  x: number;
  y: number;
  /** Charges left, so a spent trap can go dark without a map rebuild. */
  charges: number;
}

interface DoorInstance {
  tile: number;
  x: number;
  y: number;
  type: DoorType;
  /** Quarter turn when the doorway runs the other way. */
  yaw: number;
}

export class DeviceRenderer {
  readonly group = new THREE.Group();

  private readonly map: TileMap;
  private readonly body: THREE.MeshStandardMaterial;
  private readonly runeMaterial: THREE.MeshBasicMaterial;
  private readonly gasMaterial: THREE.MeshBasicMaterial;

  private readonly trapMeshes = new Map<TrapType, THREE.InstancedMesh>();
  private readonly doorMeshes = new Map<DoorType, THREE.InstancedMesh>();
  private readonly runes: THREE.InstancedMesh;
  private readonly gas: THREE.InstancedMesh;

  private readonly trapsByType = new Map<TrapType, TrapInstance[]>();
  private readonly doorsByType = new Map<DoorType, DoorInstance[]>();
  /** Every trap in placement order — the rune ring batch matches this. */
  private allTraps: TrapInstance[] = [];

  private lastVersion = -1;
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();

  constructor(map: TileMap) {
    this.map = map;

    this.body = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.72,
      metalness: 0.22,
    });
    // Flat and bright rather than emissive: an emissive material with its own
    // colour fights the per-instance colour and every trap ends up the same
    // shade. Unlit vertex colour keeps each trap's own hue and still blooms.
    this.runeMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    this.gasMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x63b845).convertSRGBToLinear(),
      transparent: true,
      // Five puffs overlap per tile, so each one has to be very faint or the
      // cloud stacks up into a solid lump.
      opacity: 0.10,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const trapGeometry: Array<[TrapType, THREE.BufferGeometry]> = [
      [TrapType.Alarm, buildAlarmTrap()],
      [TrapType.PoisonGas, buildGasTrap()],
      [TrapType.Lightning, buildLightningTrap()],
      [TrapType.Boulder, buildBoulderTrap()],
      [TrapType.WordOfPower, buildWordTrap()],
    ];
    for (const [type, geo] of trapGeometry) {
      const mesh = new THREE.InstancedMesh(geo, this.body, MAX_DEVICES);
      this.prepare(mesh);
      // A trap sits flush with the floor, and geometry that flat casting into
      // the shadow map lands the shadow straight back on itself: the trap
      // renders as a black hole. Walls still shade it, it just casts nothing.
      mesh.castShadow = false;
      this.trapMeshes.set(type, mesh);
      this.trapsByType.set(type, []);
    }

    for (const type of [DoorType.Wooden, DoorType.Braced, DoorType.Iron, DoorType.Magic]) {
      const mesh = new THREE.InstancedMesh(buildDoor(type), this.body, MAX_DEVICES);
      this.prepare(mesh);
      // Doors darken and lean as they are broken down, which needs per-instance
      // colour on top of the vertex colours baked into the panel.
      mesh.instanceColor =
        new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEVICES * 3).fill(1), 3);
      this.doorMeshes.set(type, mesh);
      this.doorsByType.set(type, []);
    }

    this.runes = new THREE.InstancedMesh(buildRuneRing(), this.runeMaterial, MAX_DEVICES);
    this.prepare(this.runes);
    this.runes.castShadow = false;
    this.runes.receiveShadow = false;
    this.runes.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEVICES * 3).fill(1), 3);

    this.gas = new THREE.InstancedMesh(
      buildGasPuff(), this.gasMaterial, MAX_CLOUDS * PUFFS_PER_CLOUD);
    this.prepare(this.gas);
    this.gas.castShadow = false;
    this.gas.receiveShadow = false;
  }

  private prepare(mesh: THREE.InstancedMesh): void {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(mesh);
  }

  /** Rebuild placement when the dungeon changes. */
  syncIfDirty(): boolean {
    if (this.map.version === this.lastVersion) return false;
    this.lastVersion = this.map.version;
    this.rebuild();
    return true;
  }

  private rebuild(): void {
    const map = this.map;
    const { dummy } = this;

    for (const list of this.trapsByType.values()) list.length = 0;
    for (const list of this.doorsByType.values()) list.length = 0;
    this.allTraps = [];

    for (let i = 0; i < map.trap.length; i++) {
      const trap = map.trap[i] as TrapType;
      const door = map.door[i] as DoorType;
      if (trap === TrapType.None && door === DoorType.None) continue;
      // A device you have never seen has no business being drawn.
      if ((map.flags[i] & FLAG_REVEALED) === 0) continue;
      const x = map.xOf(i), y = map.yOf(i);

      if (trap !== TrapType.None) {
        const list = this.trapsByType.get(trap);
        if (list && list.length < MAX_DEVICES && this.allTraps.length < MAX_DEVICES) {
          const inst: TrapInstance = { tile: i, x, y, charges: map.trapCharges[i] };
          list.push(inst);
          this.allTraps.push(inst);
        }
      }
      if (door !== DoorType.None) {
        const list = this.doorsByType.get(door);
        if (list && list.length < MAX_DEVICES) {
          // The panel must block the corridor, so it spans whichever axis has
          // solid ground on both sides. Walls east and west means the corridor
          // runs north-south and the door faces along it.
          const eastWest = map.isSolidAt(x - 1, y) && map.isSolidAt(x + 1, y);
          list.push({ tile: i, x, y, type: door, yaw: eastWest ? 0 : Math.PI / 2 });
        }
      }
    }

    for (const [type, list] of this.trapsByType) {
      const mesh = this.trapMeshes.get(type);
      if (!mesh) continue;
      list.forEach((inst, n) => {
        dummy.position.set(inst.x, 0, inst.y);
        // A dropped trap does not land square, and traps are hand-made.
        dummy.rotation.set(0, hashAngle(inst.tile), 0);
        dummy.scale.setScalar(0.94 + hashUnit(inst.tile, 5) * 0.10);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }

    for (const [type, list] of this.doorsByType) {
      const mesh = this.doorMeshes.get(type);
      if (!mesh) continue;
      list.forEach((inst, n) => {
        dummy.position.set(inst.x, 0, inst.y);
        dummy.rotation.set(0, inst.yaw, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }

    // Rune rings sit under every trap, coloured by trap type.
    this.allTraps.forEach((inst, n) => {
      const trap = this.map.trap[inst.tile] as TrapType;
      this.color.setHex(TRAP_SPECS[trap]?.color ?? 0xffffff).convertSRGBToLinear();
      this.runes.setColorAt(n, this.color);
    });
    this.runes.count = this.allTraps.length;
    if (this.runes.instanceColor) this.runes.instanceColor.needsUpdate = true;
  }

  /**
   * Per-frame work: the armed pulse, door damage, and the gas clouds.
   *
   * `gasTiles` comes from the simulation each frame rather than being cached,
   * because clouds appear and expire between map versions.
   */
  update(time: number, gasTiles: Iterable<number>): void {
    const { dummy } = this;
    const map = this.map;

    // Armed traps breathe; a spent one is dark, which is worth seeing.
    if (this.runes.count > 0) {
      this.allTraps.forEach((inst, n) => {
        const charges = map.trapCharges[inst.tile];
        const phase = time * 2.1 + inst.tile * 0.7;
        const pulse = charges > 0 ? 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(phase)) : 0.12;
        dummy.position.set(inst.x, 0.012, inst.y);
        dummy.rotation.set(0, time * 0.35 + inst.tile, 0);
        const s = charges > 0 ? 1 + 0.05 * Math.sin(phase) : 0.9;
        dummy.scale.set(s, 1, s);
        dummy.updateMatrix();
        this.runes.setMatrixAt(n, dummy.matrix);

        const trap = map.trap[inst.tile] as TrapType;
        this.color.setHex(TRAP_SPECS[trap]?.color ?? 0xffffff).convertSRGBToLinear();
        this.color.multiplyScalar(pulse);
        this.runes.setColorAt(n, this.color);
      });
      this.runes.instanceMatrix.needsUpdate = true;
      if (this.runes.instanceColor) this.runes.instanceColor.needsUpdate = true;
    }

    // A door being broken down darkens, sags off its hinges and shudders.
    for (const [type, list] of this.doorsByType) {
      const mesh = this.doorMeshes.get(type);
      if (!mesh || list.length === 0) continue;
      const full = DOOR_SPECS[type].hp;
      let dirty = false;
      list.forEach((inst, n) => {
        const hp = full > 0 ? Math.max(0, map.doorHp[inst.tile]) / full : 1;
        if (hp >= 0.999) return;
        dirty = true;
        const hurt = 1 - hp;
        // Leans a little further the worse it gets, and shakes while it is
        // actually under attack — the lean alone reads as damage from above.
        const lean = hurt * 0.10 + Math.sin(time * 22 + inst.tile) * hurt * 0.012;
        dummy.position.set(inst.x, 0, inst.y);
        dummy.rotation.set(0, inst.yaw, lean);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
        const shade = 0.45 + hp * 0.55;
        this.color.setRGB(shade, shade * 0.94, shade * 0.9);
        mesh.setColorAt(n, this.color);
      });
      if (dirty) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }

    // Gas: a handful of puffs per cloud, drifting up and swirling.
    let n = 0;
    for (const tile of gasTiles) {
      if (n >= MAX_CLOUDS * PUFFS_PER_CLOUD) break;
      if (map.terrain[tile] === Terrain.Rock) continue;
      const gx = map.xOf(tile), gy = map.yOf(tile);
      for (let p = 0; p < PUFFS_PER_CLOUD; p++) {
        const seed = tile * 7 + p;
        const a = time * (0.35 + hashUnit(seed, 1) * 0.4) + p * 1.7;
        // Kept inside the tile: a puff that drifts further ends up in the wall.
        const r = 0.20 + hashUnit(seed, 2) * 0.34;
        const bob = 0.30 + Math.sin(time * 0.9 + p * 1.3) * 0.16 + hashUnit(seed, 3) * 0.3;
        const s = 0.75 + Math.sin(time * 1.4 + seed) * 0.18 + hashUnit(seed, 4) * 0.4;
        dummy.position.set(gx + Math.cos(a) * r, bob, gy + Math.sin(a) * r);
        dummy.rotation.set(0, a, 0);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        this.gas.setMatrixAt(n++, dummy.matrix);
      }
    }
    this.gas.count = n;
    if (n > 0) this.gas.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const m of this.trapMeshes.values()) m.geometry.dispose();
    for (const m of this.doorMeshes.values()) m.geometry.dispose();
    this.runes.geometry.dispose();
    this.gas.geometry.dispose();
    this.body.dispose();
    this.runeMaterial.dispose();
    this.gasMaterial.dispose();
  }
}

/** Deterministic pseudo-random in [0,1) from a tile index and a salt. */
function hashUnit(tile: number, salt: number): number {
  let t = (tile * 374761393) ^ (salt * 668265263);
  t = Math.imul(t ^ (t >>> 13), 1274126177);
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

/** A small, deterministic yaw so identical devices are not stamped. */
function hashAngle(tile: number): number {
  return (hashUnit(tile, 9) - 0.5) * 0.5;
}
