/**
 * Traps and doors, and the workshop that makes them.
 *
 * The loop is the original's: build a workshop, put creatures in it, pick
 * something to manufacture, wait, then place what came out. Nothing can be
 * placed that has not been built first, which is what makes a workshop worth
 * the floor space and makes losing one hurt.
 */

export enum TrapType {
  None = 0,
  /** Rolls down the corridor it was triggered in, crushing what it meets. */
  Boulder = 1,
  /** Harmless, but calls every creature you own to the spot. */
  Alarm = 2,
  /** A lingering cloud that keeps hurting whatever stands in it. */
  PoisonGas = 3,
  /** A single hard strike on whatever stepped on it. */
  Lightning = 4,
  /** A slow shockwave that damages everything around it. */
  WordOfPower = 5,
}

export enum DoorType {
  None = 0,
  Wooden = 1,
  Braced = 2,
  Iron = 3,
  Magic = 4,
}

export interface TrapSpec {
  readonly type: TrapType;
  readonly name: string;
  /** Manufacture points needed to build one. */
  readonly build: number;
  /** Gold consumed when the workshop completes one. */
  readonly cost: number;
  /** How many times it fires before it is spent. */
  readonly charges: number;
  /** Tiles from the trap that count as standing on it. */
  readonly radius: number;
  readonly damage: number;
  readonly blurb: string;
  readonly color: number;
}

export const TRAP_SPECS: Record<TrapType, TrapSpec> = {
  [TrapType.None]: {
    type: TrapType.None, name: 'None', build: 0, cost: 0, charges: 0,
    radius: 0, damage: 0, blurb: '', color: 0,
  },
  [TrapType.Alarm]: {
    type: TrapType.Alarm, name: 'Alarm Trap', build: 300, cost: 75, charges: 4,
    radius: 0.8, damage: 0,
    blurb: 'Screams when trodden on, and every creature you own comes running.',
    color: 0xd8c040,
  },
  [TrapType.PoisonGas]: {
    type: TrapType.PoisonGas, name: 'Poison Gas Trap', build: 700, cost: 150, charges: 3,
    radius: 2.2, damage: 9,
    blurb: 'Fills the corridor with gas that keeps burning lungs for a while.',
    color: 0x76c04a,
  },
  [TrapType.Lightning]: {
    type: TrapType.Lightning, name: 'Lightning Trap', build: 900, cost: 220, charges: 5,
    radius: 2.6, damage: 55,
    blurb: 'Strikes whatever crosses it. Reliable, and never subtle.',
    color: 0x8fd0ff,
  },
  [TrapType.Boulder]: {
    type: TrapType.Boulder, name: 'Boulder Trap', build: 1200, cost: 300, charges: 1,
    radius: 0.8, damage: 130,
    blurb: 'Releases a boulder down the corridor. Spectacular, and single use.',
    color: 0x9a8a76,
  },
  [TrapType.WordOfPower]: {
    type: TrapType.WordOfPower, name: 'Word of Power', build: 1600, cost: 420, charges: 3,
    radius: 3.2, damage: 80,
    blurb: 'A shockwave that hurts everything nearby and knocks it back.',
    color: 0xd070ff,
  },
};

export interface DoorSpec {
  readonly type: DoorType;
  readonly name: string;
  readonly build: number;
  readonly cost: number;
  /** How much punishment it takes before it is broken down. */
  readonly hp: number;
  readonly blurb: string;
  readonly color: number;
}

export const DOOR_SPECS: Record<DoorType, DoorSpec> = {
  [DoorType.None]: {
    type: DoorType.None, name: 'None', build: 0, cost: 0, hp: 0, blurb: '', color: 0,
  },
  [DoorType.Wooden]: {
    type: DoorType.Wooden, name: 'Wooden Door', build: 250, cost: 50, hp: 220,
    blurb: 'Slows intruders down. Briefly.',
    color: 0x8a5f30,
  },
  [DoorType.Braced]: {
    type: DoorType.Braced, name: 'Braced Door', build: 500, cost: 120, hp: 480,
    blurb: 'Timber with iron banding. Buys real time.',
    color: 0x9a7a44,
  },
  [DoorType.Iron]: {
    type: DoorType.Iron, name: 'Iron Door', build: 900, cost: 250, hp: 950,
    blurb: 'Heroes will be at this one for a while.',
    color: 0xa8aec0,
  },
  [DoorType.Magic]: {
    type: DoorType.Magic, name: 'Magic Door', build: 1500, cost: 480, hp: 1600,
    blurb: 'Sealed with a ward. Only sustained violence gets through.',
    color: 0x9a6ae0,
  },
};

/** What the workshop is currently building, if anything. */
export type ManufactureTarget =
  | { kind: 'trap'; type: TrapType }
  | { kind: 'door'; type: DoorType }
  | null;

export const TRAP_BUTTON_ORDER: TrapType[] = [
  TrapType.Alarm,
  TrapType.PoisonGas,
  TrapType.Lightning,
  TrapType.Boulder,
  TrapType.WordOfPower,
];

export const DOOR_BUTTON_ORDER: DoorType[] = [
  DoorType.Wooden,
  DoorType.Braced,
  DoorType.Iron,
  DoorType.Magic,
];

/** Manufacture points a single worker contributes per tick. */
export const MANUFACTURE_RATE = 0.55;

/** Ticks a poison cloud lingers after the trap fires. */
export const GAS_DURATION = 120;
