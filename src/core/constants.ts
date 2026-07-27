/**
 * Shared vocabulary for the simulation.
 *
 * The original game ran on a 85x85 grid of "big tiles", each subdivided into
 * 3x3 subtiles for pathing. We keep one tile = one world unit and do pathing at
 * tile resolution, which is plenty for the creature counts we deal with and
 * keeps the map data small enough to send over a wire.
 */

/** What a tile is made of. Order matters: everything <= Gems is solid. */
export enum Terrain {
  /** Impenetrable bedrock. Marks the map border and unbreakable veins. */
  Rock = 0,
  /** Plain diggable dirt. */
  Earth = 1,
  /** Diggable, drops gold into the keeper's treasury. */
  Gold = 2,
  /** Diggable, never depletes. The economic prize of every map. */
  Gems = 3,
  /** Dug out but unowned. Creatures walk it; you cannot build on it. */
  Path = 4,
  /** Floor claimed by a keeper. Rooms go here. */
  Claimed = 5,
  /** Earth reinforced by a keeper's imps. Diggable, but much slower going. */
  Wall = 6,
  /** Impassable to walkers, crossable by fliers. */
  Water = 7,
  /** Impassable and lethal to walkers, crossable by fliers. */
  Lava = 8,
}

/** Highest terrain value that blocks movement by being solid. */
export const LAST_SOLID = Terrain.Wall;

export function isSolid(t: Terrain): boolean {
  return t <= Terrain.Gems || t === Terrain.Wall;
}

/**
 * Can an imp chew through this? Gems can be mined forever; rock never.
 *
 * Reinforced Wall belongs here. Leaving it out meant imps sealed their own
 * dungeon in: they reinforce every earth wall touching claimed floor as a matter
 * of routine, and each one they finished became permanently impassable to
 * everybody — so a tagged slab behind it could never be reached and excavation
 * quietly stopped for the rest of the level. DIG_HEALTH has always carried an
 * entry for Wall, which is what it was for: tougher, not eternal.
 */
export function isDiggable(t: Terrain): boolean {
  return t === Terrain.Earth || t === Terrain.Gold || t === Terrain.Gems
    || t === Terrain.Wall;
}

/** Solid tiles a keeper can reinforce into a Wall. */
export function isReinforceable(t: Terrain): boolean {
  return t === Terrain.Earth;
}

/** Floor a walking creature can stand on. */
export function isWalkable(t: Terrain): boolean {
  return t === Terrain.Path || t === Terrain.Claimed;
}

/** Floor a flying creature can cross (adds the liquids). */
export function isFlyable(t: Terrain): boolean {
  return !isSolid(t);
}

/** Owner slots. 0 is unowned; 4 is the hero/"good" faction. */
export enum Owner {
  None = 0,
  Player = 1,
  KeeperBlue = 2,
  KeeperGreen = 3,
  Heroes = 4,
}

/** Keeper banner colours, used for torches, floor tint and the minimap. */
export const OWNER_COLORS: Record<Owner, number> = {
  [Owner.None]: 0x6b6257,
  [Owner.Player]: 0xd8362a,
  [Owner.KeeperBlue]: 0x3a7bd5,
  [Owner.KeeperGreen]: 0x46a04a,
  [Owner.Heroes]: 0xe0d7a8,
};

/** Rooms buildable on claimed floor. */
/**
 * How much punishment a Dungeon Heart takes before it stops.
 *
 * Sized so that breaking one is a siege rather than a mugging. The first figure
 * here was a quarter of this, and it meant three raiders left alone finished a
 * heart in under a minute — long before a player could cross the map, let alone
 * do anything about it. Losing a level should be the result of losing a war, not
 * of looking away.
 *
 * It also sets the length of the endgame: this is what you have to chew through
 * to win, and a rival's heart falling in thirty seconds made the climax of a
 * level an anticlimax.
 */
export const HEART_HP = 18000;

export enum RoomType {
  None = 0,
  /** The keeper's soul. Lose it and you lose the level. */
  DungeonHeart = 1,
  /** Stores gold. Without it, mined gold has nowhere to go. */
  Treasury = 2,
  /** Creatures sleep here. No lair, no loyalty. */
  Lair = 3,
  /** Chickens spawn here. Creatures eat them. */
  Hatchery = 4,
  /** Creatures gain experience for gold. */
  TrainingRoom = 5,
  /** Warlocks research new spells and rooms. */
  Library = 6,
  /** Creatures relax; also where they gamble and brawl. */
  Bridge = 7,
  /** Creatures dumped here become miserable, then leave. */
  Portal = 8,
  /** Creatures build traps and doors here. */
  Workshop = 9,
}

export interface RoomSpec {
  readonly type: RoomType;
  readonly name: string;
  /** Gold per tile to build. */
  readonly cost: number;
  /** Short blurb shown in the panel tooltip. */
  readonly blurb: string;
  /** Base colour of the room floor. */
  readonly color: number;
  /** Can the player place this from the Rooms tab? */
  readonly buildable: boolean;
}

export const ROOM_SPECS: Record<RoomType, RoomSpec> = {
  [RoomType.None]: {
    type: RoomType.None, name: 'None', cost: 0, blurb: '', color: 0x000000, buildable: false,
  },
  [RoomType.DungeonHeart]: {
    type: RoomType.DungeonHeart, name: 'Dungeon Heart', cost: 0,
    blurb: 'Your soul made stone. Defend it or perish.',
    color: 0x8a1f16, buildable: false,
  },
  [RoomType.Treasury]: {
    type: RoomType.Treasury, name: 'Treasury', cost: 50,
    blurb: 'Holds your gold. Imps carry mined ore here.',
    color: 0xb08a2e, buildable: true,
  },
  [RoomType.Lair]: {
    type: RoomType.Lair, name: 'Lair', cost: 100,
    blurb: 'Creatures claim a nest here and sleep off their wounds.',
    color: 0x6b4a2f, buildable: true,
  },
  [RoomType.Hatchery]: {
    type: RoomType.Hatchery, name: 'Hatchery', cost: 125,
    blurb: 'Grows chickens. Hungry creatures feed here.',
    color: 0x7d9b46, buildable: true,
  },
  [RoomType.TrainingRoom]: {
    type: RoomType.TrainingRoom, name: 'Training Room', cost: 150,
    blurb: 'Creatures spend your gold to gain experience.',
    color: 0x8a8f9a, buildable: true,
  },
  [RoomType.Library]: {
    type: RoomType.Library, name: 'Library', cost: 200,
    blurb: 'Warlocks research new spells and rooms here.',
    color: 0x3f5f8a, buildable: true,
  },
  [RoomType.Bridge]: {
    type: RoomType.Bridge, name: 'Bridge', cost: 30,
    blurb: 'Spans water and lava so your walkers can cross.',
    color: 0x5a4632, buildable: true,
  },
  [RoomType.Portal]: {
    type: RoomType.Portal, name: 'Portal', cost: 0,
    blurb: 'Creatures enter your dungeon through here.',
    color: 0x6a3f8f, buildable: false,
  },
  [RoomType.Workshop]: {
    type: RoomType.Workshop, name: 'Workshop', cost: 175,
    blurb: 'Creatures build traps and doors here. Nothing is placed that was not made.',
    color: 0x7a6a4a, buildable: true,
  },
};

/** Order the room buttons appear in the panel, matching the original's layout. */
export const ROOM_BUTTON_ORDER: RoomType[] = [
  RoomType.Treasury,
  RoomType.Lair,
  RoomType.Hatchery,
  RoomType.TrainingRoom,
  RoomType.Library,
  RoomType.Workshop,
  RoomType.Bridge,
];

/** Keeper spells cast from the Spells tab. */
export enum SpellType {
  None = 0,
  CreateImp = 1,
  Heal = 2,
  Lightning = 3,
  Speed = 4,
  CallToArms = 5,
  Possess = 6,
}

export interface SpellSpec {
  readonly type: SpellType;
  readonly name: string;
  /** Mana cost. CreateImp scales with imp count; this is the base. */
  readonly cost: number;
  readonly blurb: string;
  /** Does casting require picking a target tile? */
  readonly targeted: boolean;
  readonly color: number;
}

export const SPELL_SPECS: Record<SpellType, SpellSpec> = {
  [SpellType.None]: {
    type: SpellType.None, name: 'None', cost: 0, blurb: '', targeted: false, color: 0,
  },
  [SpellType.CreateImp]: {
    type: SpellType.CreateImp, name: 'Create Imp', cost: 200,
    blurb: 'Summons an imp. Each imp you own makes the next one dearer.',
    targeted: true, color: 0xc4482c,
  },
  [SpellType.Heal]: {
    type: SpellType.Heal, name: 'Heal', cost: 400,
    blurb: 'Mends every creature of yours near the target.',
    targeted: true, color: 0x54c46a,
  },
  [SpellType.Lightning]: {
    type: SpellType.Lightning, name: 'Lightning', cost: 600,
    blurb: 'Strikes intruders standing near the target.',
    targeted: true, color: 0x8fd0ff,
  },
  [SpellType.Speed]: {
    type: SpellType.Speed, name: 'Speed', cost: 500,
    blurb: 'Doubles the pace of your creatures for a while.',
    targeted: true, color: 0xf0d24a,
  },
  [SpellType.CallToArms]: {
    type: SpellType.CallToArms, name: 'Call to Arms', cost: 800,
    blurb: 'Rallies your creatures to the chosen spot.',
    targeted: true, color: 0xe06a2c,
  },
  [SpellType.Possess]: {
    type: SpellType.Possess, name: 'Possess Creature', cost: 300,
    blurb: 'See through a creature’s eyes and fight yourself.',
    targeted: true, color: 0xa05ad0,
  },
};

export const SPELL_BUTTON_ORDER: SpellType[] = [
  SpellType.CreateImp,
  SpellType.Heal,
  SpellType.Speed,
  SpellType.Lightning,
  SpellType.CallToArms,
  SpellType.Possess,
];

/* ---------------------------------------------------------------- balance -- */

/** Simulation steps per second. Fixed so the sim is deterministic. */
export const TICKS_PER_SECOND = 20;
export const TICK_MS = 1000 / TICKS_PER_SECOND;

/** Integrity of a solid tile, in "dig points". */
export const DIG_HEALTH: Record<number, number> = {
  [Terrain.Earth]: 100,
  [Terrain.Gold]: 220,
  [Terrain.Gems]: 400,
  [Terrain.Wall]: 260,
};

/** Dig points an imp lands per tick. */
export const IMP_DIG_RATE = 3.2;
/** Claim points an imp lands per tick when converting floor. */
export const IMP_CLAIM_RATE = 2.6;
/** Points needed to convert one floor tile. */
export const CLAIM_HEALTH = 60;
/** Gold released by one gold tile. */
export const GOLD_PER_SEAM = 750;
/** Gold a single treasury tile can hold. */
export const TREASURY_TILE_CAPACITY = 1000;

/**
 * How many creatures the Hand of Evil can carry at once.
 *
 * Enough to move a fighting group in one trip, few enough that it is still a
 * hand rather than a transport. Eight is about a warband.
 */
export const HAND_CAPACITY = 8;
/**
 * How much gold an imp hauls in one trip: exactly one seam.
 *
 * These two numbers have to be related, and they were not. At 250 against a
 * 750-gold seam an imp pocketed a third of every wall it brought down and the
 * rest was deleted on the spot — measured over a run, 4500 of 6750 gold mined
 * simply stopped existing, which is what "the imps don't bring the gold they dug
 * to the treasury" looks like from the player's side of the screen.
 *
 * Nothing is destroyed now whatever these are set to; a surplus goes on the floor
 * as a heap for someone to fetch. But making one seam one load is what keeps the
 * common case simple and quick: tag a seam, an imp mines it, an imp carries all of
 * it home. Three trips per seam instead measurably starved everything else the
 * workforce has to do — tagged digging visibly stalled, and the rooms behind it
 * with them.
 */
export const IMP_CARRY_CAPACITY = GOLD_PER_SEAM;

/**
 * Paydays of wages a keeper must have banked before a new creature will join.
 *
 * The brake on recruitment. Above 1 so a keeper needs the next payday covered
 * *and* something spare, because a portal that fills every lair the moment the
 * lairs exist is a bankruptcy with extra steps.
 */
export const PAYROLL_HEADROOM = 1.6;

/** Ticks between paydays. Creatures unpaid go unhappy and eventually leave. */
export const PAYDAY_INTERVAL = TICKS_PER_SECOND * 100;

/** Mana regenerated per tick per claimed tile. */
export const MANA_PER_CLAIMED_TILE = 0.006;
export const MANA_BASE_REGEN = 0.2;
export const MANA_MAX = 30000;

/** A portal releases a creature this often, if there is room in the lairs. */
export const PORTAL_INTERVAL = TICKS_PER_SECOND * 14;
