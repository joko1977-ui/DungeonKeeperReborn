import { Owner, ROOM_SPECS, RoomType, TICKS_PER_SECOND } from './constants';
import { CREATURE_SPECS, Creature } from './creatures';
import { Rng } from './rng';

/**
 * What you are actually trying to do.
 *
 * The original never left you wondering. Every level opened with a briefing
 * that named the goal, and the goal was nearly always the same shape: build up,
 * get raided, and eventually the Lord of the Land comes down with an army and
 * you kill him. Some levels added a rival keeper's heart to break. Sub-goals
 * gated the script, so reaching one made the next thing happen — which is what
 * turned a sandbox into a level with a beginning, a middle and an end.
 *
 * A generated realm needs the same skeleton or it is just a hole to dig in. So
 * every level here carries an objective set: primary objectives that must all
 * be met to win, optional ones worth doing anyway, and the standing condition
 * that losing your Dungeon Heart loses the level.
 *
 * Objectives read the world through `ObjectiveWorld` rather than importing the
 * Game, for the same reason the AI does: this module stays testable and the
 * dependency runs one way.
 */

export type ObjectiveKind =
  /** Break a rival keeper's Dungeon Heart. */
  | 'destroy-keeper'
  /** Kill the Lord of the Land. The classic finale. */
  | 'defeat-lord'
  /** Turn back a number of hero waves. */
  | 'repel-waves'
  /** Hold a quantity of gold at one time. */
  | 'hoard-gold'
  /** Control a number of tiles. */
  | 'claim-territory'
  /** Field a number of monsters at or above a level. */
  | 'raise-army'
  /** Build at least one tile of each listed room. */
  | 'build-rooms'
  /** Still be here after a length of time. */
  | 'survive';

export interface Objective {
  readonly id: string;
  readonly kind: ObjectiveKind;
  /** One line, written as an instruction. Shown in the briefing and the panel. */
  readonly text: string;
  /** Every primary objective must be met to win. Bonus ones are for pride. */
  readonly primary: boolean;
  /** How many of whatever this objective counts. */
  readonly target: number;
  /** Which rival, for 'destroy-keeper'. */
  readonly owner?: Owner;
  /** Which rooms, for 'build-rooms'. */
  readonly rooms?: readonly RoomType[];
  /** Minimum creature level, for 'raise-army'. */
  readonly minLevel?: number;

  /* --- mutable state --- */
  /** Where it stands now, in the same units as `target`. */
  current: number;
  done: boolean;
  /** Tick it was completed on, for the summary. */
  doneTick: number;
}

/** What an objective needs to be able to see. Game implements this. */
export interface ObjectiveWorld {
  readonly tickCount: number;
  readonly creatures: readonly Creature[];
  goldOf(owner: Owner): number;
  /** Tiles owned, by owner. */
  territoryOf(owner: Owner): number;
  /** Whether this keeper still has a Dungeon Heart standing. */
  keeperAlive(owner: Owner): boolean;
  /** Tiles of a room type the player has built. */
  roomTileCount(room: RoomType): number;
  /** Hero waves turned back so far. */
  wavesRepelled(): number;
  /** True once a Lord of the Land has been killed. */
  lordDefeated(): boolean;
}

/* ------------------------------------------------------------ evaluation -- */

/**
 * Bring one objective up to date. Returns true if it completed on this call,
 * so the caller can announce it exactly once.
 */
export function evaluateObjective(obj: Objective, world: ObjectiveWorld): boolean {
  if (obj.done) return false;

  switch (obj.kind) {
    case 'destroy-keeper':
      obj.current = obj.owner !== undefined && !world.keeperAlive(obj.owner) ? 1 : 0;
      break;

    case 'defeat-lord':
      obj.current = world.lordDefeated() ? 1 : 0;
      break;

    case 'repel-waves':
      obj.current = world.wavesRepelled();
      break;

    case 'hoard-gold':
      // Reaching the figure once is enough; spending it afterwards is allowed.
      obj.current = Math.max(obj.current, world.goldOf(Owner.Player));
      break;

    case 'claim-territory':
      obj.current = Math.max(obj.current, world.territoryOf(Owner.Player));
      break;

    case 'raise-army': {
      const min = obj.minLevel ?? 1;
      let n = 0;
      for (const c of world.creatures) {
        if (c.owner !== Owner.Player) continue;
        if (c.level >= min && !CREATURE_SPECS[c.type].worker) n++;
      }
      obj.current = Math.max(obj.current, n);
      break;
    }

    case 'build-rooms': {
      let built = 0;
      for (const room of obj.rooms ?? []) {
        if (world.roomTileCount(room) > 0) built++;
      }
      obj.current = Math.max(obj.current, built);
      break;
    }

    case 'survive':
      obj.current = Math.min(obj.target, world.tickCount);
      break;
  }

  if (obj.current >= obj.target) {
    obj.done = true;
    obj.doneTick = world.tickCount;
    return true;
  }
  return false;
}

/** 0..1, for a progress bar. */
export function objectiveProgress(obj: Objective): number {
  if (obj.target <= 0) return obj.done ? 1 : 0;
  return Math.min(1, obj.current / obj.target);
}

/** "3 / 8", or nothing at all for a plain yes-or-no goal. */
export function objectiveDetail(obj: Objective): string {
  if (obj.target <= 1) return '';
  if (obj.kind === 'survive') {
    const left = Math.max(0, obj.target - obj.current) / TICKS_PER_SECOND;
    const m = Math.floor(left / 60), s = Math.floor(left % 60);
    return `${m}:${String(s).padStart(2, '0')} left`;
  }
  return `${Math.min(obj.current, obj.target)} / ${obj.target}`;
}

/* ------------------------------------------------------------ generation -- */

export interface ObjectiveSetOptions {
  /** Rival keepers present on this map. */
  readonly rivals: readonly Owner[];
  /** 0 = gentle, 1 = ordinary, 2 = nasty. Scales the numbers, not the goals. */
  readonly difficulty?: number;
}

/**
 * Build a coherent objective set for a generated realm.
 *
 * The shape is deliberately fixed even though the numbers are seeded: killing
 * the Lord of the Land is always the headline, breaking any rival keeper is
 * always required, and one or two bonus goals give a reason to keep playing
 * well rather than merely surviving. A level whose goals were entirely random
 * would read as a chore list; this reads as a level.
 */
export function generateObjectives(rng: Rng, opts: ObjectiveSetOptions): Objective[] {
  const difficulty = opts.difficulty ?? 1;
  const scale = 0.7 + difficulty * 0.35;
  const list: Objective[] = [];

  const make = (
    o: Omit<Objective, 'current' | 'done' | 'doneTick'>,
  ): Objective => ({ ...o, current: 0, done: false, doneTick: -1 });

  // --- primary: the rivals, then the Lord ---------------------------------
  for (const rival of opts.rivals) {
    list.push(make({
      id: `keeper-${rival}`,
      kind: 'destroy-keeper',
      text: `Destroy the rival keeper's Dungeon Heart`,
      primary: true,
      target: 1,
      owner: rival,
    }));
  }

  list.push(make({
    id: 'lord',
    kind: 'defeat-lord',
    text: 'Kill the Lord of the Land',
    primary: true,
    target: 1,
  }));

  // --- bonus: two of the four, seeded -------------------------------------
  const bonusPool: Array<() => Objective> = [
    () => make({
      id: 'gold',
      kind: 'hoard-gold',
      text: 'Hoard gold',
      primary: false,
      target: Math.round((3800 + rng.int(0, 4) * 700) * scale / 100) * 100,
    }),
    () => make({
      id: 'territory',
      kind: 'claim-territory',
      text: 'Claim territory',
      primary: false,
      target: Math.round((260 + rng.int(0, 6) * 20) * scale / 10) * 10,
    }),
    () => {
      const minLevel = rng.int(3, 5);
      return make({
        id: 'army',
        kind: 'raise-army',
        text: `Raise an army of creatures at level ${minLevel} or better`,
        primary: false,
        target: Math.max(3, Math.round((5 + rng.int(0, 3)) * scale)),
        minLevel,
      });
    },
    () => make({
      id: 'rooms',
      kind: 'build-rooms',
      text: 'Furnish a proper dungeon',
      primary: false,
      target: 5,
      rooms: [
        RoomType.Treasury, RoomType.Lair, RoomType.Hatchery,
        RoomType.TrainingRoom, RoomType.Workshop,
      ],
    }),
    () => make({
      id: 'waves',
      kind: 'repel-waves',
      text: 'Turn back hero raids',
      primary: false,
      target: 2 + rng.int(0, 2),
    }),
  ];

  // Shuffle and take two, so two seeds rarely read the same.
  for (let i = bonusPool.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [bonusPool[i], bonusPool[j]] = [bonusPool[j], bonusPool[i]];
  }
  list.push(bonusPool[0](), bonusPool[1]());

  return list;
}

/** A one-line description of a bonus objective's requirement, for the briefing. */
export function objectiveBriefing(obj: Objective): string {
  switch (obj.kind) {
    case 'hoard-gold':
      return `Hold ${obj.target} gold at once`;
    case 'claim-territory':
      return `Control ${obj.target} tiles of dungeon`;
    case 'raise-army':
      return `Field ${obj.target} creatures at level ${obj.minLevel} or above`;
    case 'build-rooms':
      return `Build all of: ${(obj.rooms ?? []).map((r) => ROOM_SPECS[r].name).join(', ')}`;
    case 'repel-waves':
      return `Wipe out ${obj.target} hero raiding parties`;
    case 'survive':
      return `Hold your dungeon for ${Math.round(obj.target / TICKS_PER_SECOND / 60)} minutes`;
    case 'destroy-keeper':
      return 'Break the rival keeper\'s heart. Dig to it and kill everything in the way';
    case 'defeat-lord':
      return 'He comes when your dungeon is worth the trip. Be ready';
  }
}
