import { Owner, RoomType } from './constants';

export enum CreatureType {
  Imp = 0,
  Fly = 1,
  Beetle = 2,
  Troll = 3,
  DemonSpawn = 4,
  Warlock = 5,
  BileDemon = 6,
  Dragon = 7,
  // The good guys, who arrive uninvited.
  Dwarf = 8,
  Archer = 9,
  Knight = 10,
}

export interface CreatureSpec {
  readonly type: CreatureType;
  readonly name: string;
  readonly maxHp: number;
  readonly strength: number;
  readonly defense: number;
  /** Tiles per second at level 1. */
  readonly speed: number;
  /** Gold demanded each payday. */
  readonly wage: number;
  /** Ignores water, lava and unclaimed gaps. */
  readonly flying: boolean;
  /** Imps only: does chores instead of holding a job. */
  readonly worker: boolean;
  /** Rooms this creature will voluntarily use for its job. */
  readonly jobs: readonly RoomType[];
  /** Ticks of work before hunger climbs one point. */
  readonly appetite: number;
  /** Body scale relative to an imp. Drives the procedural model. */
  readonly scale: number;
  /** Primary skin colour of the generated model. */
  readonly color: number;
  /** Secondary colour: horns, wings, armour trim. */
  readonly accent: number;
  /** Which portal-spawn pool this belongs to. */
  readonly attractedBy: RoomType | null;
}

const S = (spec: CreatureSpec) => spec;

export const CREATURE_SPECS: Record<CreatureType, CreatureSpec> = {
  [CreatureType.Imp]: S({
    type: CreatureType.Imp, name: 'Imp', maxHp: 60, strength: 4, defense: 2,
    speed: 3.4, wage: 0, flying: false, worker: true, jobs: [],
    appetite: 900, scale: 0.62, color: 0xc4553a, accent: 0x8f2f1c, attractedBy: null,
  }),
  [CreatureType.Fly]: S({
    type: CreatureType.Fly, name: 'Fly', maxHp: 50, strength: 6, defense: 2,
    speed: 4.2, wage: 25, flying: true, worker: false, jobs: [],
    appetite: 700, scale: 0.5, color: 0x6f7f4a, accent: 0xc8d8a0, attractedBy: RoomType.Hatchery,
  }),
  [CreatureType.Beetle]: S({
    type: CreatureType.Beetle, name: 'Beetle', maxHp: 90, strength: 9, defense: 6,
    speed: 2.4, wage: 40, flying: false, worker: false, jobs: [RoomType.TrainingRoom],
    appetite: 620, scale: 0.7, color: 0x4a3b2a, accent: 0x9a7b3a, attractedBy: RoomType.Lair,
  }),
  [CreatureType.Troll]: S({
    type: CreatureType.Troll, name: 'Troll', maxHp: 140, strength: 14, defense: 8,
    speed: 2.6, wage: 75, flying: false, worker: false,
    jobs: [RoomType.TrainingRoom],
    appetite: 520, scale: 0.95, color: 0x5c7a4a, accent: 0x8fae6a, attractedBy: RoomType.TrainingRoom,
  }),
  [CreatureType.DemonSpawn]: S({
    type: CreatureType.DemonSpawn, name: 'Demon Spawn', maxHp: 120, strength: 12, defense: 7,
    speed: 3.0, wage: 60, flying: false, worker: false, jobs: [RoomType.TrainingRoom],
    appetite: 560, scale: 0.8, color: 0xa03a2a, accent: 0xe07a3a, attractedBy: RoomType.TrainingRoom,
  }),
  [CreatureType.Warlock]: S({
    type: CreatureType.Warlock, name: 'Warlock', maxHp: 110, strength: 10, defense: 5,
    speed: 2.8, wage: 90, flying: false, worker: false,
    jobs: [RoomType.Library, RoomType.TrainingRoom],
    appetite: 600, scale: 0.85, color: 0x3f3a6a, accent: 0x8a7ad0, attractedBy: RoomType.Library,
  }),
  [CreatureType.BileDemon]: S({
    type: CreatureType.BileDemon, name: 'Bile Demon', maxHp: 220, strength: 18, defense: 12,
    speed: 1.8, wage: 130, flying: false, worker: false, jobs: [RoomType.TrainingRoom],
    appetite: 320, scale: 1.25, color: 0x7a8f3a, accent: 0xb8c85a, attractedBy: RoomType.Hatchery,
  }),
  [CreatureType.Dragon]: S({
    type: CreatureType.Dragon, name: 'Dragon', maxHp: 260, strength: 24, defense: 14,
    speed: 3.2, wage: 180, flying: true, worker: false,
    jobs: [RoomType.TrainingRoom, RoomType.Library],
    appetite: 400, scale: 1.35, color: 0xa8342a, accent: 0xf0a03a, attractedBy: RoomType.TrainingRoom,
  }),
  [CreatureType.Dwarf]: S({
    type: CreatureType.Dwarf, name: 'Dwarf', maxHp: 90, strength: 10, defense: 6,
    speed: 2.8, wage: 0, flying: false, worker: true, jobs: [],
    appetite: 900, scale: 0.7, color: 0xb08a5a, accent: 0x8a5a2a, attractedBy: null,
  }),
  [CreatureType.Archer]: S({
    type: CreatureType.Archer, name: 'Archer', maxHp: 100, strength: 13, defense: 5,
    speed: 3.2, wage: 0, flying: false, worker: false, jobs: [],
    appetite: 900, scale: 0.82, color: 0x3a6a4a, accent: 0xd8c88a, attractedBy: null,
  }),
  [CreatureType.Knight]: S({
    type: CreatureType.Knight, name: 'Knight', maxHp: 240, strength: 22, defense: 16,
    speed: 2.6, wage: 0, flying: false, worker: false, jobs: [],
    appetite: 900, scale: 1.0, color: 0xc0c6d0, accent: 0x2a4a8a, attractedBy: null,
  }),
};

/** What a creature is doing right now. Drives both the sim and the animation. */
export enum CreatureState {
  Idle = 0,
  Walking = 1,
  Digging = 2,
  Claiming = 3,
  /** Carrying gold back to a treasury tile. */
  Hauling = 4,
  Sleeping = 5,
  Eating = 6,
  Training = 7,
  Researching = 8,
  Fighting = 9,
  Fleeing = 10,
  /** Picked up by the Hand of Evil. */
  InHand = 11,
  /** Just dropped: briefly stunned before it picks a new job. */
  Stunned = 12,
  /** Walking to the portal to quit in disgust. */
  LeavingDungeon = 13,
  Dying = 14,
}

export const STATE_NAMES: Record<CreatureState, string> = {
  [CreatureState.Idle]: 'Idle',
  [CreatureState.Walking]: 'Moving',
  [CreatureState.Digging]: 'Digging',
  [CreatureState.Claiming]: 'Claiming',
  [CreatureState.Hauling]: 'Hauling gold',
  [CreatureState.Sleeping]: 'Sleeping',
  [CreatureState.Eating]: 'Eating',
  [CreatureState.Training]: 'Training',
  [CreatureState.Researching]: 'Researching',
  [CreatureState.Fighting]: 'Fighting',
  [CreatureState.Fleeing]: 'Fleeing',
  [CreatureState.InHand]: 'In your hand',
  [CreatureState.Stunned]: 'Dazed',
  [CreatureState.LeavingDungeon]: 'Leaving!',
  [CreatureState.Dying]: 'Dying',
};

export interface Creature {
  id: number;
  type: CreatureType;
  owner: Owner;

  /** Position in tile units. Whole numbers sit at tile centres. */
  x: number;
  y: number;
  /** Render height above the floor — flyers hover, everyone bobs. */
  z: number;
  facing: number;

  state: CreatureState;
  /** Ticks spent in the current state. */
  stateTimer: number;

  hp: number;
  level: number;
  experience: number;

  /** 0 = content, 100 = desperate. */
  hunger: number;
  tiredness: number;
  anger: number;

  /** Gold being carried back to the treasury. */
  goldHeld: number;
  /** Tile index of this creature's nest, or -1. */
  lairTile: number;

  /** Current path and how far along it we are. */
  path: Int32Array | null;
  pathIndex: number;
  /** Tile this creature is working on (dig target, room tile, enemy). */
  targetTile: number;
  targetCreature: number;

  /** Ticks until the AI re-evaluates. Staggered so they don't all think at once. */
  thinkCooldown: number;
  /** Ticks left on a temporary Speed spell. */
  hasteTicks: number;
  /** Set while the player is holding this creature. */
  inHand: boolean;

  /** Animation phase, advanced by the renderer. */
  animPhase: number;
  /** Cosmetic per-creature variation so a crowd doesn't look cloned. */
  seed: number;
}

let nextCreatureId = 1;

export function createCreature(
  type: CreatureType,
  owner: Owner,
  x: number,
  y: number,
): Creature {
  const spec = CREATURE_SPECS[type];
  return {
    id: nextCreatureId++,
    type,
    owner,
    x, y, z: spec.flying ? 0.55 : 0,
    facing: Math.random() * Math.PI * 2,
    state: CreatureState.Idle,
    stateTimer: 0,
    hp: spec.maxHp,
    level: 1,
    experience: 0,
    hunger: 0,
    tiredness: 0,
    anger: 0,
    goldHeld: 0,
    lairTile: -1,
    path: null,
    pathIndex: 0,
    targetTile: -1,
    targetCreature: -1,
    thinkCooldown: (Math.random() * 20) | 0,
    hasteTicks: 0,
    inHand: false,
    animPhase: Math.random() * Math.PI * 2,
    seed: Math.random(),
  };
}

/** Max HP after level scaling. Each level adds 15% of the base. */
export function maxHpOf(c: Creature): number {
  return CREATURE_SPECS[c.type].maxHp * (1 + 0.15 * (c.level - 1));
}

export function strengthOf(c: Creature): number {
  return CREATURE_SPECS[c.type].strength * (1 + 0.2 * (c.level - 1));
}

export function speedOf(c: Creature): number {
  const base = CREATURE_SPECS[c.type].speed * (1 + 0.03 * (c.level - 1));
  return c.hasteTicks > 0 ? base * 1.9 : base;
}

/** Gold owed at payday, scaled by level like the original's wage table. */
export function wageOf(c: Creature): number {
  return Math.round(CREATURE_SPECS[c.type].wage * (1 + 0.35 * (c.level - 1)));
}

export function isHostileTo(a: Creature, b: Creature): boolean {
  if (a.owner === b.owner) return false;
  if (a.owner === Owner.None || b.owner === Owner.None) return false;
  return true;
}

/** Experience needed to reach the next level. */
export function xpForNextLevel(level: number): number {
  return Math.round(200 * Math.pow(1.35, level - 1));
}
