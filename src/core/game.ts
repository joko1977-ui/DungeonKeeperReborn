import {
  MANA_BASE_REGEN,
  MANA_MAX,
  MANA_PER_CLAIMED_TILE,
  Owner,
  PAYDAY_INTERVAL,
  PORTAL_INTERVAL,
  ROOM_SPECS,
  RoomType,
  SPELL_SPECS,
  SpellType,
  TICKS_PER_SECOND,
  Terrain,
  isWalkable,
} from './constants';
import {
  AIWorld,
  damageCreature,
  healCreature,
  impCost,
  slapCreature,
  updateCreature,
} from './ai';
import {
  CREATURE_SPECS,
  Creature,
  CreatureState,
  CreatureType,
  createCreature,
  maxHpOf,
  wageOf,
} from './creatures';
import {
  DOOR_SPECS,
  DoorType,
  GAS_DURATION,
  MANUFACTURE_RATE,
  ManufactureTarget,
  TRAP_SPECS,
  TrapType,
} from './devices';
import { PathFinder } from './pathfinding';
import { RoomIndex, buildRoom, heartTile, nearestRoomTile, sellRoom, treasuryCapacity } from './rooms';
import { TileMap } from './tilemap';

/** A transient event the renderer turns into particles and the mixer into sound. */
export interface GameEffect {
  kind: string;
  x: number;
  y: number;
  age: number;
  /**
   * Monotonic id. Consumers remember the last one they handled, which is the
   * only reliable way to read this list: the game splices finished effects out
   * from the middle, so array positions shift underneath anyone watching.
   */
  seq: number;
}

/** Narrator cue keys. The audio layer maps these to spoken lines. */
export type NarrationCue =
  | 'level-start' | 'creature-joined' | 'creature-left' | 'creature-died'
  | 'creature-levelled' | 'payday' | 'payday-broke' | 'treasury-full'
  | 'heroes' | 'victory' | 'defeat' | 'no-mana' | 'bad-placement'
  | 'manufactured' | 'trap-fired' | 'door-broken';

/** A line in the message log, shown in the panel like the original's ticker. */
export interface GameMessage {
  text: string;
  tick: number;
  /** What the narrator should say about it, if anything. */
  cue?: NarrationCue;
}

interface Keeper {
  owner: Owner;
  gold: number;
  mana: number;
  research: number;
  /** Chickens currently pecking about the hatchery. */
  food: number;
  alive: boolean;
}

export type GameStatus = 'playing' | 'won' | 'lost';

export class Game implements AIWorld {
  readonly map: TileMap;
  readonly rooms = new RoomIndex();
  readonly finder: PathFinder;
  readonly creatures: Creature[] = [];

  tickCount = 0;
  status: GameStatus = 'playing';

  readonly effects: GameEffect[] = [];
  readonly messages: GameMessage[] = [];

  private readonly keepers = new Map<Owner, Keeper>();
  /** lair tile index -> creature id */
  private readonly lairClaims = new Map<number, number>();

  private nextPayday = PAYDAY_INTERVAL;
  private nextPortalSpawn = PORTAL_INTERVAL;
  private nextHeroWave = TICKS_PER_SECOND * 240;
  private heroWaveNumber = 0;

  /** Set when the player is holding something. */
  handCreature: Creature | null = null;
  handGold = 0;

  /* ---- workshop ---- */
  /** What the workshop is currently building. */
  manufactureTarget: ManufactureTarget = null;
  /** Points accumulated toward the current target. */
  manufacturePoints = 0;
  /** Finished items waiting to be placed. */
  readonly trapStock = new Map<TrapType, number>();
  readonly doorStock = new Map<DoorType, number>();
  /** Lingering poison clouds: tile index -> ticks remaining. */
  private readonly gasClouds = new Map<number, number>();

  constructor(map: TileMap) {
    this.map = map;
    this.finder = new PathFinder(map);
    for (const o of [Owner.Player, Owner.KeeperBlue, Owner.KeeperGreen, Owner.Heroes]) {
      this.keepers.set(o, {
        owner: o, gold: 0, mana: 1000, research: 0, food: 0, alive: true,
      });
    }
  }

  keeper(owner: Owner): Keeper {
    const k = this.keepers.get(owner);
    if (!k) throw new Error(`unknown keeper ${owner}`);
    return k;
  }

  /* ------------------------------------------------------ AIWorld API --- */

  goldOf(owner: Owner): number {
    return this.keeper(owner).gold;
  }

  manaOf(owner: Owner): number {
    return this.keeper(owner).mana;
  }

  depositGold(owner: Owner, amount: number): number {
    const k = this.keeper(owner);
    const cap = treasuryCapacity(this.map, this.rooms, owner);
    const room = Math.max(0, cap - k.gold);
    const stored = Math.min(amount, room);
    k.gold += stored;
    if (stored < amount && owner === Owner.Player) {
      this.notifyThrottled(
        'Your treasury is full. Build more treasure rooms!', 'treasury-full', 'treasury-full');
    }
    return stored;
  }

  withdrawGold(owner: Owner, amount: number): number {
    const k = this.keeper(owner);
    const taken = Math.min(amount, k.gold);
    k.gold -= taken;
    return taken;
  }

  foodOf(owner: Owner): number {
    return Math.floor(this.keeper(owner).food);
  }

  consumeFood(owner: Owner): boolean {
    const k = this.keeper(owner);
    if (k.food < 1) return false;
    k.food -= 1;
    return true;
  }

  claimLair(creature: Creature, tile: number): void {
    this.releaseLair(creature);
    this.lairClaims.set(tile, creature.id);
    creature.lairTile = tile;
  }

  releaseLair(creature: Creature): void {
    if (creature.lairTile >= 0) {
      if (this.lairClaims.get(creature.lairTile) === creature.id) {
        this.lairClaims.delete(creature.lairTile);
      }
      creature.lairTile = -1;
    }
  }

  isLairFree(tile: number): boolean {
    return !this.lairClaims.has(tile);
  }

  addResearch(owner: Owner, points: number): void {
    this.keeper(owner).research += points;
  }

  notify(message: string, cue?: NarrationCue): void {
    this.messages.push({ text: message, tick: this.tickCount, cue });
    if (this.messages.length > 60) this.messages.shift();
  }

  private lastNotified = new Map<string, number>();
  /** Notify at most once every 15 seconds per key, so nags don't spam the log. */
  private notifyThrottled(message: string, key: string, cue?: NarrationCue): void {
    const last = this.lastNotified.get(key) ?? -Infinity;
    if (this.tickCount - last < TICKS_PER_SECOND * 15) return;
    this.lastNotified.set(key, this.tickCount);
    this.notify(message, cue);
  }

  private effectSeq = 0;

  effect(kind: string, x: number, y: number): void {
    if (this.effects.length > 400) return;
    this.effects.push({ kind, x, y, age: 0, seq: ++this.effectSeq });
  }

  onCreatureDied(creature: Creature): void {
    this.releaseLair(creature);
    const i = this.creatures.indexOf(creature);
    if (i >= 0) this.creatures.splice(i, 1);
    this.effect('poof', creature.x, creature.y);
    if (creature.owner === Owner.Player) {
      this.notify(`Your ${CREATURE_SPECS[creature.type].name} has died.`, 'creature-died');
    }
  }

  /* ---------------------------------------------------------- main tick - */

  tick(): void {
    if (this.status !== 'playing') return;
    this.tickCount++;
    const dt = 1 / TICKS_PER_SECOND;

    this.rooms.refresh(this.map);

    for (let i = this.creatures.length - 1; i >= 0; i--) {
      const c = this.creatures[i];
      if (!c) continue;
      updateCreature(this, c, dt);
    }

    this.updateResources();
    this.updateVision();
    this.updateWorkshop();
    this.updateTraps();
    this.updateGas();

    if (this.tickCount >= this.nextPayday) {
      this.nextPayday = this.tickCount + PAYDAY_INTERVAL;
      this.runPayday(Owner.Player);
    }
    if (this.tickCount >= this.nextPortalSpawn) {
      this.nextPortalSpawn = this.tickCount + PORTAL_INTERVAL;
      this.trySpawnFromPortal(Owner.Player);
    }
    if (this.tickCount >= this.nextHeroWave) {
      this.nextHeroWave = this.tickCount + TICKS_PER_SECOND * 200;
      this.spawnHeroWave();
    }

    // Age out finished effects.
    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (++this.effects[i].age > 40) this.effects.splice(i, 1);
    }

    this.checkVictory();
  }

  private updateResources(): void {
    const k = this.keeper(Owner.Player);
    const claimed = this.map.countOwned(Owner.Player);
    k.mana = Math.min(MANA_MAX, k.mana + MANA_BASE_REGEN + claimed * MANA_PER_CLAIMED_TILE);

    // Chickens regrow up to one per hatchery tile. The rate has to outpace
    // what the creatures eat, or a hatchery that looks big enough still
    // starves them: a creature works through roughly three birds per hunger
    // cycle, so a tile needs to produce well ahead of a tile's worth of mouths.
    const hatchery = this.rooms.count(this.map, Owner.Player, RoomType.Hatchery);
    if (k.food < hatchery) k.food = Math.min(hatchery, k.food + hatchery * 0.01);
  }

  /** Reveal the map around everything the player owns or controls. */
  private updateVision(): void {
    if (this.tickCount % 5 !== 0) return;
    for (const c of this.creatures) {
      if (c.owner !== Owner.Player) continue;
      this.map.revealRadius(Math.round(c.x), Math.round(c.y), 8);
    }
    if (this.tickCount % 40 === 0) {
      for (const i of this.map.tilesOwnedBy(Owner.Player)) {
        this.map.revealRadius(this.map.xOf(i), this.map.yOf(i), 6);
      }
    }
  }

  /* ------------------------------------------------------- the workshop -- */

  /** Workers in a workshop push the current build order along. */
  private updateWorkshop(): void {
    if (!this.manufactureTarget) return;
    const workshopTiles = this.rooms.count(this.map, Owner.Player, RoomType.Workshop);
    if (workshopTiles === 0) return;

    // Only creatures actually standing in the workshop contribute.
    let workers = 0;
    for (const c of this.creatures) {
      if (c.owner !== Owner.Player || c.inHand) continue;
      if (CREATURE_SPECS[c.type].worker) continue;
      const x = Math.round(c.x), y = Math.round(c.y);
      if (this.map.roomAt(x, y) === RoomType.Workshop
        && this.map.ownerAt(x, y) === Owner.Player) workers++;
    }
    if (workers === 0) return;

    this.manufacturePoints += workers * MANUFACTURE_RATE;

    const target = this.manufactureTarget;
    const spec = target.kind === 'trap'
      ? TRAP_SPECS[target.type] : DOOR_SPECS[target.type];
    if (this.manufacturePoints < spec.build) return;

    // Finished — but it still has to be paid for.
    if (this.withdrawGold(Owner.Player, spec.cost) < spec.cost) {
      this.notifyThrottled(
        `You cannot afford to finish the ${spec.name}.`, 'manufacture-gold');
      return;
    }
    this.manufacturePoints -= spec.build;
    if (target.kind === 'trap') {
      this.trapStock.set(target.type, (this.trapStock.get(target.type) ?? 0) + 1);
    } else {
      this.doorStock.set(target.type, (this.doorStock.get(target.type) ?? 0) + 1);
    }
    this.notify(`Your workshop has finished a ${spec.name}.`, 'manufactured');
  }

  /** Choose what the workshop builds next. Progress carries over. */
  setManufactureTarget(target: ManufactureTarget): void {
    this.manufactureTarget = target;
  }

  /** How far along the current build order is, 0..1. */
  manufactureProgress(): number {
    const t = this.manufactureTarget;
    if (!t) return 0;
    const spec = t.kind === 'trap' ? TRAP_SPECS[t.type] : DOOR_SPECS[t.type];
    return spec.build > 0 ? Math.min(1, this.manufacturePoints / spec.build) : 0;
  }

  stockOfTrap(type: TrapType): number {
    return this.trapStock.get(type) ?? 0;
  }

  stockOfDoor(type: DoorType): number {
    return this.doorStock.get(type) ?? 0;
  }

  /**
   * Place a manufactured trap. It must go on your own bare floor — not in a
   * room, and not on top of another device.
   */
  placeTrap(type: TrapType, x: number, y: number): boolean {
    if (this.stockOfTrap(type) <= 0) return false;
    if (!this.canPlaceDevice(x, y)) {
      this.notifyThrottled('Traps go on your own empty floor.', 'trap-place', 'bad-placement');
      return false;
    }
    const i = this.map.idx(x, y);
    this.map.trap[i] = type;
    this.map.trapCharges[i] = TRAP_SPECS[type].charges;
    this.map.version++;
    this.trapStock.set(type, this.stockOfTrap(type) - 1);
    this.effect('build', x, y);
    return true;
  }

  /** Place a manufactured door. Doors want a corridor, not open floor. */
  placeDoor(type: DoorType, x: number, y: number): boolean {
    if (this.stockOfDoor(type) <= 0) return false;
    if (!this.canPlaceDevice(x, y)) {
      this.notifyThrottled('Doors go on your own empty floor.', 'door-place', 'bad-placement');
      return false;
    }
    // A door needs something to hang off: solid ground on opposite sides.
    const eastWest = this.map.isSolidAt(x - 1, y) && this.map.isSolidAt(x + 1, y);
    const northSouth = this.map.isSolidAt(x, y - 1) && this.map.isSolidAt(x, y + 1);
    if (!eastWest && !northSouth) {
      this.notifyThrottled(
        'A door needs a doorway — walls on both sides.', 'door-frame', 'bad-placement');
      return false;
    }
    const i = this.map.idx(x, y);
    this.map.door[i] = type;
    this.map.doorHp[i] = DOOR_SPECS[type].hp;
    this.map.version++;
    this.doorStock.set(type, this.stockOfDoor(type) - 1);
    this.effect('build', x, y);
    return true;
  }

  private canPlaceDevice(x: number, y: number): boolean {
    if (!this.map.inBounds(x, y)) return false;
    const i = this.map.idx(x, y);
    return this.map.terrain[i] === Terrain.Claimed
      && this.map.owner[i] === Owner.Player
      && this.map.room[i] === RoomType.None
      && this.map.trap[i] === 0
      && this.map.door[i] === 0;
  }

  /** Damage a door. Returns true when it comes off its hinges. */
  damageDoor(x: number, y: number, amount: number): boolean {
    const i = this.map.idx(x, y);
    if (this.map.door[i] === 0) return false;
    this.map.doorHp[i] -= amount;
    this.effect('hit', x, y);
    if (this.map.doorHp[i] > 0) return false;
    const wasMine = this.map.owner[i] === Owner.Player;
    this.map.door[i] = 0;
    this.map.doorHp[i] = 0;
    this.map.version++;
    this.effect('poof', x, y);
    if (wasMine) this.notify('One of your doors has been broken down!', 'door-broken');
    return true;
  }

  /** Fire any trap an intruder has walked onto. */
  private updateTraps(): void {
    if (this.tickCount % 3 !== 0) return;
    const map = this.map;

    for (const c of this.creatures) {
      if (c.inHand || c.state === CreatureState.Dying) continue;
      // Only intruders set off a keeper's traps.
      if (c.owner === Owner.Player || c.owner === Owner.None) continue;
      const x = Math.round(c.x), y = Math.round(c.y);
      if (!map.inBounds(x, y)) continue;
      const i = map.idx(x, y);
      const type = map.trap[i] as TrapType;
      if (type === TrapType.None || map.trapCharges[i] <= 0) continue;
      if (map.owner[i] !== Owner.Player) continue;
      this.fireTrap(type, i, x, y);
    }
  }

  private fireTrap(type: TrapType, tile: number, x: number, y: number): void {
    const spec = TRAP_SPECS[type];
    this.map.trapCharges[tile]--;
    if (this.map.trapCharges[tile] <= 0) {
      this.map.trap[tile] = 0;
      this.map.version++;
    }

    switch (type) {
      case TrapType.Alarm:
        // Everything you own drops what it is doing and comes here.
        for (const c of this.creatures) {
          if (c.owner !== Owner.Player || CREATURE_SPECS[c.type].worker) continue;
          if (Math.hypot(c.x - x, c.y - y) > 30) continue;
          const path = this.finder.find(
            Math.round(c.x), Math.round(c.y), x, y,
            (px, py) => isWalkable(this.map.terrainAt(px, py)),
          );
          if (path) { c.path = path; c.pathIndex = 0; c.state = CreatureState.Walking; }
        }
        this.effect('rally', x, y);
        this.notify('An alarm trap has been triggered!', 'trap-fired');
        break;

      case TrapType.PoisonGas:
        this.gasClouds.set(tile, GAS_DURATION);
        this.effect('heal', x, y);
        break;

      default: {
        // Boulder, lightning and word of power all resolve as a burst.
        for (const other of this.creatures) {
          if (other.owner === Owner.Player || other.owner === Owner.None) continue;
          if (other.state === CreatureState.Dying) continue;
          if (Math.hypot(other.x - x, other.y - y) > spec.radius) continue;
          damageCreature(this, other, spec.damage);
        }
        this.effect(type === TrapType.Lightning ? 'lightning' : 'build', x, y);
        break;
      }
    }
    if (type !== TrapType.Alarm) {
      this.notifyThrottled(`A ${spec.name} has fired.`, 'trap-fired', 'trap-fired');
    }
  }

  /** Poison clouds keep working on whatever stands in them. */
  private updateGas(): void {
    if (this.gasClouds.size === 0) return;
    const spec = TRAP_SPECS[TrapType.PoisonGas];
    for (const [tile, ticks] of [...this.gasClouds]) {
      if (ticks <= 0) { this.gasClouds.delete(tile); continue; }
      this.gasClouds.set(tile, ticks - 1);
      const gx = this.map.xOf(tile), gy = this.map.yOf(tile);
      if (this.tickCount % 10 !== 0) continue;
      this.effect('heal', gx, gy);
      for (const c of this.creatures) {
        if (c.owner === Owner.Player || c.owner === Owner.None) continue;
        if (c.state === CreatureState.Dying) continue;
        if (Math.hypot(c.x - gx, c.y - gy) > spec.radius) continue;
        damageCreature(this, c, spec.damage);
      }
    }
  }

  /** Tiles currently holding gas, for the renderer. */
  gasTiles(): Iterable<number> {
    return this.gasClouds.keys();
  }

  private runPayday(owner: Owner): void {
    const k = this.keeper(owner);
    let owed = 0;
    const mine = this.creatures.filter((c) => c.owner === owner && !CREATURE_SPECS[c.type].worker);
    for (const c of mine) owed += wageOf(c);
    if (owed === 0) return;

    if (k.gold >= owed) {
      k.gold -= owed;
      if (owner === Owner.Player) this.notify(`Payday! You paid ${owed} gold in wages.`, 'payday');
      for (const c of mine) c.anger = Math.max(0, c.anger - 10);
    } else {
      k.gold = 0;
      if (owner === Owner.Player) {
        this.notify('You cannot afford to pay your creatures! They are furious.', 'payday-broke');
      }
      for (const c of mine) c.anger = Math.min(100, c.anger + 35);
    }
  }

  /**
   * Portals pull in creatures, but only ones your dungeon can actually keep:
   * empty lairs and a stocked hatchery are the gate, exactly as in the original.
   */
  private trySpawnFromPortal(owner: Owner): void {
    const map = this.map;
    const portal = this.rooms.tilesOf(map, owner, RoomType.Portal)[0];
    if (portal === undefined) return;

    const lairs = this.rooms.count(map, owner, RoomType.Lair);
    const nonWorkers = this.creatures.filter(
      (c) => c.owner === owner && !CREATURE_SPECS[c.type].worker,
    ).length;
    if (nonWorkers >= lairs) return;
    if (this.rooms.count(map, owner, RoomType.Hatchery) === 0) return;

    // Which creatures show up depends on which rooms you've built.
    const pool: CreatureType[] = [];
    for (const type of [
      CreatureType.Fly, CreatureType.Beetle, CreatureType.Troll,
      CreatureType.DemonSpawn, CreatureType.Warlock, CreatureType.BileDemon,
      CreatureType.Dragon,
    ]) {
      const attractor = CREATURE_SPECS[type].attractedBy;
      if (attractor === null) continue;
      const tiles = this.rooms.count(map, owner, attractor);
      if (tiles <= 0) continue;
      // Bigger rooms mean better odds, and rarer creatures need more of them.
      const weight = Math.floor(tiles / (1 + CREATURE_SPECS[type].scale * 4));
      for (let i = 0; i <= weight; i++) pool.push(type);
    }
    if (pool.length === 0) return;

    const type = pool[(Math.random() * pool.length) | 0];
    const c = createCreature(type, owner, map.xOf(portal), map.yOf(portal));
    this.creatures.push(c);
    this.effect('poof', c.x, c.y);
    if (owner === Owner.Player) {
      this.notify(`A ${CREATURE_SPECS[type].name} has entered your dungeon.`, 'creature-joined');
    }
  }

  /** Heroes arrive in escalating waves from any hero gate on the map. */
  private spawnHeroWave(): void {
    const gates = this.rooms.tilesOf(this.map, Owner.Heroes, RoomType.Portal);
    if (gates.length === 0) return;
    this.heroWaveNumber++;
    const gate = gates[(Math.random() * gates.length) | 0];
    const gx = this.map.xOf(gate), gy = this.map.yOf(gate);

    const size = Math.min(6, 1 + Math.floor(this.heroWaveNumber / 2));
    const roster: CreatureType[] = [CreatureType.Dwarf, CreatureType.Archer];
    if (this.heroWaveNumber >= 3) roster.push(CreatureType.Knight);

    for (let i = 0; i < size; i++) {
      const type = roster[(Math.random() * roster.length) | 0];
      const c = createCreature(type, Owner.Heroes, gx, gy);
      c.level = Math.min(8, 1 + Math.floor(this.heroWaveNumber / 2));
      c.hp = maxHpOf(c);
      this.creatures.push(c);
    }
    this.notify(`Heroes have entered the realm! Wave ${this.heroWaveNumber}.`, 'heroes');
    this.effect('poof', gx, gy);
  }

  private checkVictory(): void {
    if (this.tickCount % 20 !== 0) return;
    const playerHeart = heartTile(this.map, this.rooms, Owner.Player);
    if (playerHeart < 0) {
      this.status = 'lost';
      this.notify('Your Dungeon Heart has been destroyed. You have failed.', 'defeat');
      return;
    }
    const heroesLeft = this.creatures.some((c) => c.owner === Owner.Heroes);
    const heroGates = this.rooms.count(this.map, Owner.Heroes, RoomType.Portal);
    if (!heroesLeft && heroGates === 0 && this.heroWaveNumber > 0) {
      this.status = 'won';
      this.notify('The realm is yours. The heroes are broken.', 'victory');
    }
  }

  /* -------------------------------------------------------- player acts - */

  /** Tag or untag a tile for excavation. Returns true if anything changed. */
  markTile(x: number, y: number, on: boolean): boolean {
    return this.map.mark(x, y, on);
  }

  /** Build a room across a dragged rectangle. */
  build(type: RoomType, x0: number, y0: number, x1: number, y1: number): boolean {
    const k = this.keeper(Owner.Player);
    const result = buildRoom(this.map, Owner.Player, type, x0, y0, x1, y1, k.gold);
    if (result.placed > 0) {
      k.gold -= result.spent;
      this.effect('build', (x0 + x1) / 2, (y0 + y1) / 2);
      return true;
    }
    if (result.reason) this.notifyThrottled(result.reason, `build-${result.reason}`);
    return false;
  }

  /** Sell the room on a tile, refunding half. */
  sell(x: number, y: number): boolean {
    const { refund, type } = sellRoom(this.map, Owner.Player, x, y);
    if (type === RoomType.None) return false;
    this.depositGold(Owner.Player, refund);
    this.effect('build', x, y);
    return true;
  }

  /* ----------------------------------------------------- hand of evil --- */

  /** Pick up a creature. Only your own, and only if your hand is empty. */
  pickUpCreature(c: Creature): boolean {
    if (this.handCreature || this.handGold > 0) return false;
    if (c.owner !== Owner.Player) return false;
    if (c.state === CreatureState.Dying) return false;
    c.inHand = true;
    c.path = null;
    c.state = CreatureState.InHand;
    this.releaseLair(c);
    this.handCreature = c;
    this.effect('grab', c.x, c.y);
    return true;
  }

  /** Drop whatever is in the hand onto a tile. Returns false if it can't land. */
  dropAt(x: number, y: number): boolean {
    const c = this.handCreature;
    if (!c) return false;
    if (!this.map.inBounds(x, y)) return false;
    // You may only drop onto floor you control — the original's core constraint.
    const t = this.map.terrainAt(x, y);
    if (!isWalkable(t)) return false;
    if (this.map.ownerAt(x, y) !== Owner.Player) return false;

    c.x = x; c.y = y;
    c.inHand = false;
    c.state = CreatureState.Stunned;
    c.stateTimer = 0;
    c.thinkCooldown = 0;
    c.targetTile = -1;
    this.handCreature = null;
    this.effect('drop', x, y);
    return true;
  }

  /** The slap: faster work, a little damage, a lot of resentment. */
  slap(c: Creature): void {
    if (c.owner !== Owner.Player) return;
    slapCreature(this, c);
  }

  /** Creature nearest to a world position, within `radius` tiles. */
  creatureAt(x: number, y: number, radius = 0.8, owner?: Owner): Creature | null {
    let best: Creature | null = null;
    let bestD = radius * radius;
    for (const c of this.creatures) {
      if (c.inHand || c.state === CreatureState.Dying) continue;
      if (owner !== undefined && c.owner !== owner) continue;
      const dx = c.x - x, dy = c.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  /* ---------------------------------------------------------- spells ---- */

  /** Mana price of a spell right now (Create Imp scales with your imp count). */
  spellCost(type: SpellType): number {
    if (type === SpellType.CreateImp) {
      const imps = this.creatures.filter(
        (c) => c.owner === Owner.Player && c.type === CreatureType.Imp,
      ).length;
      return impCost(imps);
    }
    return SPELL_SPECS[type].cost;
  }

  canCast(type: SpellType): boolean {
    return this.keeper(Owner.Player).mana >= this.spellCost(type);
  }

  /** Cast a targeted keeper spell at a tile. Returns true if it went off. */
  cast(type: SpellType, x: number, y: number): boolean {
    const k = this.keeper(Owner.Player);
    const cost = this.spellCost(type);
    if (k.mana < cost) {
      this.notifyThrottled('Not enough mana.', 'mana', 'no-mana');
      return false;
    }
    const tx = Math.round(x), ty = Math.round(y);

    switch (type) {
      case SpellType.CreateImp: {
        if (this.map.terrainAt(tx, ty) !== Terrain.Claimed
          || this.map.ownerAt(tx, ty) !== Owner.Player) {
          this.notifyThrottled(
            'Imps can only be summoned onto your own floor.', 'imp-place', 'bad-placement');
          return false;
        }
        const c = createCreature(CreatureType.Imp, Owner.Player, tx, ty);
        this.creatures.push(c);
        this.effect('poof', tx, ty);
        break;
      }
      case SpellType.Heal: {
        let healed = 0;
        for (const c of this.creatures) {
          if (c.owner !== Owner.Player) continue;
          if (Math.hypot(c.x - tx, c.y - ty) > 4) continue;
          healCreature(c, maxHpOf(c) * 0.5);
          this.effect('heal', c.x, c.y);
          healed++;
        }
        if (healed === 0) return false;
        break;
      }
      case SpellType.Lightning: {
        let hit = 0;
        for (const c of this.creatures) {
          if (c.owner === Owner.Player || c.owner === Owner.None) continue;
          if (Math.hypot(c.x - tx, c.y - ty) > 3.5) continue;
          damageCreature(this, c, 70);
          hit++;
        }
        this.effect('lightning', tx, ty);
        if (hit === 0) return false;
        break;
      }
      case SpellType.Speed: {
        let n = 0;
        for (const c of this.creatures) {
          if (c.owner !== Owner.Player) continue;
          if (Math.hypot(c.x - tx, c.y - ty) > 5) continue;
          c.hasteTicks = TICKS_PER_SECOND * 25;
          this.effect('haste', c.x, c.y);
          n++;
        }
        if (n === 0) return false;
        break;
      }
      case SpellType.CallToArms: {
        const tile = this.map.idx(tx, ty);
        let n = 0;
        for (const c of this.creatures) {
          if (c.owner !== Owner.Player) continue;
          if (CREATURE_SPECS[c.type].worker) continue;
          c.targetTile = tile;
          c.state = CreatureState.Walking;
          c.thinkCooldown = TICKS_PER_SECOND * 8;
          const gx = tx + ((Math.random() * 3) | 0) - 1;
          const gy = ty + ((Math.random() * 3) | 0) - 1;
          const path = this.finder.find(
            Math.round(c.x), Math.round(c.y), gx, gy,
            (px, py) => isWalkable(this.map.terrainAt(px, py)),
          );
          if (path) { c.path = path; c.pathIndex = 0; n++; }
        }
        this.effect('rally', tx, ty);
        if (n === 0) return false;
        break;
      }
      case SpellType.Possess:
        // Handled by the camera layer; the sim only charges for it.
        this.effect('poof', tx, ty);
        break;
      default:
        return false;
    }

    k.mana -= cost;
    return true;
  }

  /* ------------------------------------------------------------ stats --- */

  playerCreatureCounts(): Map<CreatureType, number> {
    const counts = new Map<CreatureType, number>();
    for (const c of this.creatures) {
      if (c.owner !== Owner.Player) continue;
      counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
    }
    return counts;
  }

  treasuryCap(): number {
    return treasuryCapacity(this.map, this.rooms, Owner.Player);
  }

  roomTileCount(type: RoomType): number {
    return this.rooms.count(this.map, Owner.Player, type);
  }

  /** Tick the next payday falls on, so the UI can count down to it. */
  nextPaydayTick(): number {
    return this.nextPayday;
  }

  /** Where the camera should start: on the player's heart. */
  startView(): { x: number; y: number } {
    const t = heartTile(this.map, this.rooms, Owner.Player);
    if (t >= 0) return { x: this.map.xOf(t), y: this.map.yOf(t) };
    return { x: this.map.width / 2, y: this.map.height / 2 };
  }

  /** Nearest owned floor tile to a point — used to keep drops legal. */
  nearestOwnedFloor(x: number, y: number): { x: number; y: number } | null {
    const t = nearestRoomTile(this.map, this.rooms, Owner.Player, RoomType.DungeonHeart, x, y);
    if (t < 0) return null;
    return { x: this.map.xOf(t), y: this.map.yOf(t) };
  }

  /** Cost of a room, for the UI. */
  static roomCost(type: RoomType): number {
    return ROOM_SPECS[type].cost;
  }
}
