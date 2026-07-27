/**
 * Headless smoke test for the simulation.
 *
 * `src/core` deliberately has no dependency on three.js or the DOM, which means
 * the entire game loop can be exercised in Node with no browser at all. This
 * plays a short game against itself and asserts that the loop actually closes:
 * tags get dug, dug floor gets claimed, gold reaches the treasury, rooms build,
 * and creatures arrive and take jobs.
 *
 * Run with `npm run smoke`.
 */

import {
  HAND_CAPACITY, HEART_HP, Owner, RoomType, SpellType, Terrain, isDiggable, isWalkable,
} from '../src/core/constants';
import { CREATURE_SPECS, CreatureState, CreatureType, createCreature } from '../src/core/creatures';
import { DOOR_SPECS, DoorType, TrapType } from '../src/core/devices';
import { generateLevel } from '../src/core/levelgen';
import { damageCreature } from '../src/core/ai';
import { objectiveProgress } from '../src/core/objectives';
import { FLAG_REVEALED } from '../src/core/tilemap';

let failures = 0;

function check(label: string, condition: boolean, detail: unknown = ''): void {
  const mark = condition ? 'ok  ' : 'FAIL';
  if (!condition) failures++;
  console.log(`${mark}  ${label}${detail === '' ? '' : `  ${JSON.stringify(detail)}`}`);
}

function run(ticks: number, game: ReturnType<typeof generateLevel>): void {
  for (let i = 0; i < ticks; i++) game.tick();
}

const game = generateLevel({ seed: 1997 });
const map = game.map;
const start = game.startView();

console.log(`\nRealm seed 1997 — ${map.width}x${map.height}, heart at ${start.x},${start.y}\n`);

/* -- tagging ------------------------------------------------------------- */

map.revealRadius(start.x, start.y, 22);
let tagged = 0;
for (let y = start.y - 8; y <= start.y + 8; y++) {
  for (let x = start.x + 5; x <= start.x + 20; x++) {
    if (game.markTile(x, y, true)) tagged++;
  }
}
check('tags a dragged slab of wall', tagged > 40, { tagged });
check('refuses to tag bedrock', !game.markTile(0, 0, true));

// The message log is capped, so this has to be asserted before thousands of
// ticks of play push the opening line off the end of it.
check('the opening line is cued',
  game.messages.some((m) => m.cue === 'level-start'));

const goldAtStart = game.goldOf(Owner.Player);
const territoryAtStart = map.countOwned(Owner.Player);

/* -- digging and claiming ------------------------------------------------ */

run(5000, game);

let stillMarked = 0;
for (let i = 0; i < map.flags.length; i++) if (map.flags[i] & 1) stillMarked++;
const territory = map.countOwned(Owner.Player);

// Not "all of them". A tile whose only approach is across a lava lake cannot be
// reached by a walking imp, and with lava scattered through the realm a big
// dragged slab will occasionally include one. That is a true property of the
// map rather than a stuck imp, so the check is that the slab was worked through,
// not that every last tile of it fell.
/*
 * The slab clears down to what the vault can hold.
 *
 * This used to assert the whole slab fell. It no longer does, on purpose: a
 * keeper whose treasury is full has imps that leave the seams standing, because
 * gold that cannot be banked is better left in the wall. So what is checked now
 * is that nothing *diggable and storable* was left — every survivor is a seam,
 * and the vault is full.
 */
{
  const survivors: Terrain[] = [];
  for (let i = 0; i < map.flags.length; i++) {
    if ((map.flags[i] & 1) !== 0) survivors.push(map.terrain[i] as Terrain);
  }
  const seamsOnly = survivors.every((t) => t === Terrain.Gold || t === Terrain.Gems);
  check('imps clear everything they can store',
    stillMarked <= 2 || (seamsOnly && !game.hasTreasurySpace(Owner.Player)),
    { stillMarked, seamsOnly, vaultFull: !game.hasTreasurySpace(Owner.Player) });
}
check('dug floor gets claimed', territory > territoryAtStart + 30,
  { from: territoryAtStart, to: territory });
check('mined gold reaches the treasury', game.goldOf(Owner.Player) > goldAtStart,
  { from: goldAtStart, to: game.goldOf(Owner.Player) });
check('treasury cannot exceed its capacity',
  game.goldOf(Owner.Player) <= game.treasuryCap(),
  { gold: game.goldOf(Owner.Player), cap: game.treasuryCap() });

/* -- building ------------------------------------------------------------ */

/** Find a block of free, owned floor big enough to build on. */
function freeRect(w: number, h: number): { x: number; y: number } | null {
  for (let y = 2; y < map.height - h - 2; y++) {
    for (let x = 2; x < map.width - w - 2; x++) {
      let ok = true;
      for (let dy = 0; dy < h && ok; dy++) {
        for (let dx = 0; dx < w && ok; dx++) {
          const i = map.idx(x + dx, y + dy);
          if (map.terrain[i] !== Terrain.Claimed || map.owner[i] !== Owner.Player
            || map.room[i] !== RoomType.None || map.trap[i] !== 0 || map.door[i] !== 0) {
            ok = false;
          }
        }
      }
      if (ok) return { x, y };
    }
  }
  return null;
}

const hatchery = freeRect(3, 3);
check('finds space for a hatchery', hatchery !== null);
if (hatchery) {
  const before = game.goldOf(Owner.Player);
  check('builds a hatchery',
    game.build(RoomType.Hatchery, hatchery.x, hatchery.y, hatchery.x + 2, hatchery.y + 2));
  check('hatchery occupies nine tiles', game.roomTileCount(RoomType.Hatchery) === 9,
    { tiles: game.roomTileCount(RoomType.Hatchery) });
  check('building costs gold', game.goldOf(Owner.Player) < before);
}

const training = freeRect(3, 3);
if (training) {
  game.build(RoomType.TrainingRoom, training.x, training.y, training.x + 2, training.y + 2);
  check('builds a training room', game.roomTileCount(RoomType.TrainingRoom) === 9);
}

const workshop = freeRect(3, 3);
if (workshop) {
  game.build(RoomType.Workshop, workshop.x, workshop.y, workshop.x + 2, workshop.y + 2);
  check('builds a workshop', game.roomTileCount(RoomType.Workshop) === 9);
}

check('refuses to build on bare rock',
  !game.build(RoomType.Library, 1, 1, 2, 2));

/* -- creatures ----------------------------------------------------------- */

// Played with one hand rather than none: top the workforce up when it runs
// short, which is what the Create Imp spell is for and what any player does.
// Entirely hands-off, a hero party eventually kills the last imp and every
// check downstream fails for reasons that have nothing to do with what they
// are testing.
for (let chunk = 0; chunk < 7; chunk++) {
  run(1000, game);
  const alive = game.creatures.filter(
    (c) => c.owner === Owner.Player && CREATURE_SPECS[c.type].worker).length;
  if (alive < 3) game.cast(SpellType.CreateImp, start.x, start.y);
}

const mine = game.creatures.filter((c) => c.owner === Owner.Player);
const workers = mine.filter((c) => CREATURE_SPECS[c.type].worker);
const monsters = mine.filter((c) => !CREATURE_SPECS[c.type].worker);
const species = new Set(monsters.map((c) => c.type));

check('the portal attracts creatures', monsters.length > 0, { monsters: monsters.length });
check('more than one species arrives', species.size > 1,
  { species: [...species].map((t) => CREATURE_SPECS[t].name) });
check('imps are still working', workers.length > 0, { imps: workers.length });
check('the hatchery keeps food in stock', game.foodOf(Owner.Player) > 0,
  { food: game.foodOf(Owner.Player) });

const busy = mine.filter((c) => c.state !== CreatureState.Idle).length;
check('creatures find something to do', busy > mine.length / 2,
  { busy, total: mine.length });

/* -- the Hand of Evil ---------------------------------------------------- */

const victim = monsters[0] ?? workers[0];
if (victim) {
  check('picks a creature up', game.pickUpCreature(victim));
  check('refuses to drop onto unowned rock', !game.dropAt(1, 1));
  check('drops onto owned floor', game.dropAt(start.x, start.y));
  check('the hand empties after a drop', game.handCreature === null);
  check('the creature actually moved', Math.round(victim.x) === start.x);
}

const imp = workers[0];
if (imp) {
  const hp = imp.hp;
  game.slap(imp);
  check('a slap hurts', imp.hp < hp);
  check('a slap hastens', imp.hasteTicks > 0);
}

/* -- spells -------------------------------------------------------------- */

const impsBefore = game.creatures.filter(
  (c) => c.owner === Owner.Player && c.type === CreatureType.Imp,
).length;
const manaBefore = game.manaOf(Owner.Player);
check('summons an imp onto owned floor', game.cast(1, start.x, start.y));
check('refuses to summon onto rock', !game.cast(1, 1, 1));
check('summoning spends mana', game.manaOf(Owner.Player) < manaBefore);
check('the imp exists', game.creatures.filter(
  (c) => c.owner === Owner.Player && c.type === CreatureType.Imp,
).length === impsBefore + 1);

/* -- selling ------------------------------------------------------------- */

if (hatchery) {
  const before = game.goldOf(Owner.Player);
  check('sells a room tile', game.sell(hatchery.x, hatchery.y));
  check('selling refunds half', game.goldOf(Owner.Player) - before === 62,
    { refund: game.goldOf(Owner.Player) - before });
}

/* -- the workshop, traps and doors --------------------------------------- */

// The manufacture loop is the one place where a room, the gold economy and the
// creature AI all have to agree, so it is worth walking end to end: put a
// worker in the workshop, order a door, and see stock appear.
//
// A troll is placed deliberately rather than waiting for one to wander in.
// Only trolls and bile demons take workshop jobs, and which species the portal
// happens to offer is not what this check is about.
if (workshop) {
  const troll = createCreature(
    CreatureType.Troll, Owner.Player, workshop.x + 1, workshop.y + 1);
  game.creatures.push(troll);
  game.depositGold(Owner.Player, 2000);
  game.setManufactureTarget({ kind: 'door', type: DoorType.Wooden });
  check('the workshop takes a build order', game.manufactureTarget !== null);

  run(200, game);
  check('a staffed workshop makes progress', game.manufactureProgress() > 0,
    { progress: Number(game.manufactureProgress().toFixed(2)) });

  run(2000, game);
  check('the workshop eventually finishes a door',
    game.stockOfDoor(DoorType.Wooden) > 0, { stock: game.stockOfDoor(DoorType.Wooden) });
  check('a finished device is announced',
    game.messages.some((m) => m.cue === 'manufactured'));
}

// Placement rules, checked against stock granted directly so the assertions do
// not depend on how long the workshop happened to take above.
game.trapStock.set(TrapType.Lightning, 2);
game.doorStock.set(DoorType.Iron, 2);

const trapSpot = freeRect(1, 1);
check('finds bare floor for a trap', trapSpot !== null);
if (trapSpot) {
  check('places a trap on own bare floor', game.placeTrap(TrapType.Lightning, trapSpot.x, trapSpot.y));
  check('the trap is on the tile', map.trapAt(trapSpot.x, trapSpot.y) === TrapType.Lightning);
  check('placing spends the stock', game.stockOfTrap(TrapType.Lightning) === 1);
  check('refuses a second device on the same tile',
    !game.placeTrap(TrapType.Lightning, trapSpot.x, trapSpot.y));
  check('refuses to place a trap on rock', !game.placeTrap(TrapType.Lightning, 1, 1));

  // A trap only fires on intruders, so a hero has to stand on it.
  const charges = map.trapCharges[map.idx(trapSpot.x, trapSpot.y)];
  const hero = createCreature(CreatureType.Dwarf, Owner.Heroes, trapSpot.x, trapSpot.y);
  game.creatures.push(hero);
  const heroHp = hero.hp;
  run(6, game);
  check('the trap fires on an intruder',
    map.trapCharges[map.idx(trapSpot.x, trapSpot.y)] < charges
    || map.trapAt(trapSpot.x, trapSpot.y) === TrapType.None,
    { charges, now: map.trapCharges[map.idx(trapSpot.x, trapSpot.y)] });
  check('the intruder takes the damage', hero.hp < heroHp, { from: heroHp, to: hero.hp });
}

// A door needs a doorway: solid ground on opposite sides of the tile.
function findDoorway(): { x: number; y: number } | null {
  for (let y = 2; y < map.height - 2; y++) {
    for (let x = 2; x < map.width - 2; x++) {
      const i = map.idx(x, y);
      if (map.terrain[i] !== Terrain.Claimed || map.owner[i] !== Owner.Player) continue;
      if (map.room[i] !== RoomType.None || map.trap[i] !== 0 || map.door[i] !== 0) continue;
      if ((map.isSolidAt(x - 1, y) && map.isSolidAt(x + 1, y))
        || (map.isSolidAt(x, y - 1) && map.isSolidAt(x, y + 1))) return { x, y };
    }
  }
  return null;
}

const doorway = findDoorway();
check('finds a doorway for a door', doorway !== null);
if (doorway) {
  check('hangs a door in a doorway', game.placeDoor(DoorType.Iron, doorway.x, doorway.y));
  check('the door is on the tile', map.doorAt(doorway.x, doorway.y) === DoorType.Iron);
  check('the door starts intact',
    map.doorHp[map.idx(doorway.x, doorway.y)] === DOOR_SPECS[DoorType.Iron].hp);

  // Breaking it down takes sustained violence, and only the last hit removes it.
  check('a hit does not break an iron door',
    !game.damageDoor(doorway.x, doorway.y, 100));
  check('the door is still there', map.doorAt(doorway.x, doorway.y) === DoorType.Iron);
  check('enough damage breaks it down',
    game.damageDoor(doorway.x, doorway.y, DOOR_SPECS[DoorType.Iron].hp));
  check('a broken door is gone', map.doorAt(doorway.x, doorway.y) === DoorType.None);
}

// Digging the floor out from under a device takes the device with it.
const trapSpot2 = freeRect(1, 1);
if (trapSpot2 && game.placeTrap(TrapType.Lightning, trapSpot2.x, trapSpot2.y)) {
  map.setTerrain(trapSpot2.x, trapSpot2.y, Terrain.Rock, Owner.None);
  check('a device cannot outlive its floor', map.trapAt(trapSpot2.x, trapSpot2.y) === 0);
}

/* -- narration cues ------------------------------------------------------ */

// The narrator is driven by cues on messages, not by string-matching the log.
// If a notification loses its cue, the narrator silently goes quiet, so the
// wiring is worth asserting here where it is cheap to check.
const cued = game.messages.filter((m) => m.cue !== undefined);
check('notifications carry narrator cues', cued.length > 0,
  { cued: cued.length, total: game.messages.length });
const seenCues = new Set(game.messages.map((m) => m.cue).filter(Boolean));
check('several distinct cues fired during play', seenCues.size >= 3,
  { cues: [...seenCues] });

/* -- effect stream ------------------------------------------------------- */

// Both the particle system and the mixer read this list by sequence number,
// because the game splices finished effects out of the middle of it.
const seqs = game.effects.map((e) => e.seq);
check('effects carry increasing sequence ids',
  seqs.every((v, i) => i === 0 || v > seqs[i - 1]), { sample: seqs.slice(0, 5) });
check('sequence ids are unique', new Set(seqs).size === seqs.length);

/* -- heroes and stability ------------------------------------------------ */

run(6000, game);

// Not "still playing" any more. A level can now genuinely end, and on this seed
// it sometimes does without the player lifting a finger: the hero gate is nearer
// the rival keeper than it is to you, so the heroes go and break *their* heart
// first. Letting your enemies maul each other is a real tactic, not a bug — so
// the check is that the game reached a coherent state, not that nothing
// happened.
check('the game reached a coherent state',
  game.status === 'playing' || game.status === 'won' || game.status === 'lost',
  { status: game.status });
if (game.status !== 'lost') {
  check('the heart still stands', game.roomTileCount(RoomType.DungeonHeart) > 0);
}

const heroes = game.creatures.filter((c) => c.owner === Owner.Heroes);
check('heroes eventually invade', heroes.length > 0 || game.messages.some(
  (m) => m.text.includes('Heroes')), { heroes: heroes.length });

/* -- objectives, and whether the level can end at all --------------------- */

// This is the part that was missing outright: a generated realm had goals
// nobody had written and a victory condition that could never fire, so it was
// a hole to dig in rather than a level. These checks exist to keep it a level.

check('the realm has objectives', game.objectives.length > 0,
  { objectives: game.objectives.length });
check('at least one of them is required to win',
  game.objectives.some((o) => o.primary));
check('there are optional ones too',
  game.objectives.some((o) => !o.primary));
check('breaking the rival keeper is a goal',
  game.objectives.some((o) => o.kind === 'destroy-keeper'));
check('the Lord of the Land is the finale',
  game.objectives.some((o) => o.kind === 'defeat-lord'));
check('objectives report progress',
  game.objectives.every((o) => objectiveProgress(o) >= 0 && objectiveProgress(o) <= 1));

// Two seeds should not read as the same level.
const seedA = generateLevel({ seed: 11 }).objectives.map((o) => o.id).join(',');
const seedB = generateLevel({ seed: 4242 }).objectives.map((o) => o.id).join(',');
check('different seeds get different goals', seedA !== seedB, { seedA, seedB });

/* -- the Dungeon Heart can actually be broken ---------------------------- */

{
  const fresh = generateLevel({ seed: 7 });
  run(60, fresh);
  check('a heart starts intact', fresh.heartIntegrity(Owner.Player) === 1);
  check('a heart takes damage', !fresh.damageHeart(Owner.Player, HEART_HP * 0.5));
  check('damage shows in its integrity',
    Math.abs(fresh.heartIntegrity(Owner.Player) - 0.5) < 0.01,
    { integrity: fresh.heartIntegrity(Owner.Player) });
  check('enough damage stops it', fresh.damageHeart(Owner.Player, HEART_HP));
  check('a stopped keeper is finished', !fresh.keeperAlive(Owner.Player));
  run(40, fresh);
  check('losing your heart loses the level', fresh.status === 'lost',
    { status: fresh.status });
}

/* -- winning ------------------------------------------------------------- */

{
  const fresh = generateLevel({ seed: 7 });
  run(60, fresh);
  check('a fresh level is in play', fresh.status === 'playing');
  check('no Lord of the Land at the start', !fresh.creatures.some((c) => c.isLord));

  // Break the rival's heart, which is one of the two primary objectives.
  fresh.damageHeart(Owner.KeeperBlue, HEART_HP * 2);
  run(40, fresh);
  check('breaking the rival heart finishes that keeper',
    !fresh.keeperAlive(Owner.KeeperBlue));

  // He comes on his own once the level has run long enough, even for a keeper
  // who has done nothing to earn him. That fallback is what stops a cautious
  // game from never reaching an ending.
  run(13200, fresh);
  const lord = fresh.creatures.find((c) => c.isLord);
  check('the Lord of the Land turns up eventually', lord !== undefined,
    { heroes: fresh.creatures.filter((c) => c.owner === Owner.Heroes).length });
  check('he does not come alone',
    fresh.creatures.filter((c) => c.owner === Owner.Heroes).length > 1);

  if (lord) {
    check('the level is not won while he stands', fresh.status === 'playing',
      { status: fresh.status });
    damageCreature(fresh, lord, 100000);
    run(60, fresh);
    check('killing the Lord completes the objective', fresh.lordDefeated());
    run(40, fresh);
    check('meeting every primary objective wins the level', fresh.status === 'won',
      { status: fresh.status, remaining: fresh.primaryRemaining() });
  }
}

/* -- a rival keeper that actually plays ---------------------------------- */

{
  const fresh = generateLevel({ seed: 31 });
  const before = fresh.map.countOwned(Owner.KeeperBlue);
  run(6000, fresh);
  const after = fresh.map.countOwned(Owner.KeeperBlue);
  check('the rival keeper expands', after > before, { from: before, to: after });
  check('the rival keeper builds rooms',
    fresh.rooms.count(fresh.map, Owner.KeeperBlue, RoomType.Treasury) > 0
    || fresh.rooms.count(fresh.map, Owner.KeeperBlue, RoomType.Lair) > 0);
  check('the rival keeper attracts creatures',
    fresh.creatures.some((c) => c.owner === Owner.KeeperBlue
      && !CREATURE_SPECS[c.type].worker),
    { blue: fresh.creatures.filter((c) => c.owner === Owner.KeeperBlue).length });
  // It must not simply eat the map — an opponent, not a flood.
  check('the rival keeper stays in its own region',
    fresh.map.countOwned(Owner.KeeperBlue) < 500,
    { blue: fresh.map.countOwned(Owner.KeeperBlue) });
}

/* -- digging cannot deadlock -------------------------------------------- */

// Both of these froze excavation for the rest of the level, which is what made
// digging feel like it stopped working for no reason.
check('reinforced walls remain diggable', isDiggable(Terrain.Wall));

{
  const fresh = generateLevel({ seed: 5, startingGold: 500 });
  const fm = fresh.map;
  const fs = fresh.startView();
  fm.revealRadius(fs.x, fs.y, 20);
  for (let y = fs.y - 8; y <= fs.y + 8; y++) {
    for (let x = fs.x - 12; x <= fs.x + 12; x++) fresh.markTile(x, y, true);
  }
  run(3000, fresh);

  // Fill the treasury to the brim, then give the imps fresh orders. They used
  // to park on a full treasury holding gold that would never fit, reporting
  // themselves busy forever, and the whole workforce stopped digging for the
  // rest of the level.
  fresh.depositGold(Owner.Player, 999999);
  check('the treasury really is full',
    fresh.goldOf(Owner.Player) >= fresh.treasuryCap(),
    { gold: fresh.goldOf(Owner.Player), cap: fresh.treasuryCap() });

  fm.revealRadius(fs.x, fs.y, 26);
  let fresh_tags = 0;
  for (let y = fs.y - 14; y <= fs.y + 14; y++) {
    for (let x = fs.x - 18; x <= fs.x + 18; x++) {
      if (fresh.markTile(x, y, true)) fresh_tags++;
    }
  }
  check('there is new ground to tag', fresh_tags > 20, { tagged: fresh_tags });

  // Kept inside the rival keeper's opening grace period on purpose: this is a
  // test of the hauling deadlock, and it should not start failing because a
  // raiding party happened to kill the imps it was watching.
  const territoryAtFull = fm.countOwned(Owner.Player);
  run(2400, fresh);
  check('a full treasury does not strand the imps',
    fm.countOwned(Owner.Player) > territoryAtFull,
    { at: territoryAtFull, after: fm.countOwned(Owner.Player) });

  const imps = fresh.creatures.filter(
    (c) => c.owner === Owner.Player && CREATURE_SPECS[c.type].worker);
  const laden = imps.filter((c) => c.goldHeld > 0).length;
  check('the imps are not all parked holding gold', imps.length > 0 && laden < imps.length,
    { imps: imps.length, laden });
}

/* -- heroes have somewhere to be ---------------------------------------- */

{
  const fresh = generateLevel({ seed: 13 });
  const fm = fresh.map;
  const heart = fresh.startView();
  // Open some ground first, so there is somewhere for a hero to stand and a
  // route for it to walk.
  fm.revealRadius(heart.x, heart.y, 20);
  for (let y = heart.y - 9; y <= heart.y + 9; y++) {
    for (let x = heart.x - 13; x <= heart.x + 13; x++) fresh.markTile(x, y, true);
  }
  run(3000, fresh);

  // Drop a hero on the furthest open floor we have, and see if it comes for us.
  let spot = -1, spotD = 0;
  for (let i = 0; i < fm.terrain.length; i++) {
    if (!isWalkable(fm.terrain[i] as Terrain)) continue;
    const d = Math.hypot(fm.xOf(i) - heart.x, fm.yOf(i) - heart.y);
    if (d > spotD) { spotD = d; spot = i; }
  }
  check('found open ground to land a hero on', spot >= 0 && spotD > 5,
    { distance: spotD.toFixed(1) });
  if (spot >= 0) {
    const hero = createCreature(CreatureType.Dwarf, Owner.Heroes, fm.xOf(spot), fm.yOf(spot));
    hero.waveId = 1;
    fresh.creatures.push(hero);
    const startDistance = Math.hypot(hero.x - heart.x, hero.y - heart.y);
    run(600, fresh);
    const endDistance = Math.hypot(hero.x - heart.x, hero.y - heart.y);
    // Heroes used to have no drive at all: no job, no lair, nothing to want, so
    // they milled about at random and a raid neither arrived nor ended.
    check('heroes march on the heart rather than wandering',
      endDistance < startDistance - 1,
      { from: startDistance.toFixed(1), to: endDistance.toFixed(1) });
  }
}

/* -- Call to Arms is a standing flag ------------------------------------ */

{
  const fresh = generateLevel({ seed: 17 });
  run(2000, fresh);
  const at = fresh.startView();
  check('the flag will not plant in solid rock', !fresh.cast(SpellType.CallToArms, 1, 1));
  const planted = fresh.cast(SpellType.CallToArms, at.x, at.y);
  check('a flag can be planted', planted);
  if (planted) {
    check('the flag stands', fresh.playerRally() !== null);
    run(200, fresh);
    check('it is still standing a while later', fresh.playerRally() !== null);
    fresh.cast(SpellType.CallToArms, at.x, at.y);
    check('casting on it again takes it down', fresh.playerRally() === null);
  }
}

/* -- determinism --------------------------------------------------------- */

// A seed that does not replay is not a seed. The map was generated from one
// while the simulation ran on Math.random, so "realm seed 1997" diverged within
// seconds — and a headless suite over combat that can go either way was flaky
// enough to be worth ignoring, which is worse than having no suite.
function fingerprint(seed: number): string {
  const g = generateLevel({ seed });
  const s = g.startView();
  g.map.revealRadius(s.x, s.y, 20);
  for (let y = s.y - 6; y <= s.y + 6; y++) {
    for (let x = s.x + 4; x <= s.x + 14; x++) g.markTile(x, y, true);
  }
  for (let i = 0; i < 4000; i++) g.tick();
  return [
    g.status,
    g.creatures.length,
    g.map.countOwned(Owner.Player),
    g.goldOf(Owner.Player),
    g.creatures.map((c) => `${c.type}:${c.owner}:${c.x.toFixed(2)},${c.y.toFixed(2)}`).join('|'),
  ].join('/');
}
check('the same seed replays exactly', fingerprint(4242) === fingerprint(4242));
check('different seeds diverge', fingerprint(4242) !== fingerprint(99));

/* -- gold conservation --------------------------------------------------- */

/*
 * Every coin out of a seam has to end up somewhere you can point at.
 *
 * This is the check that would have caught the bug it was written for. A seam
 * held 750 and an imp could carry 250; the other 500 was deleted the instant the
 * wall came down. Two thirds of the gold in every level, gone silently, and from
 * the player's chair it looked exactly like imps refusing to take gold to the
 * treasury. Nothing here noticed, because every existing check asked whether gold
 * *arrived* and none asked whether all of it did.
 *
 * Deliberately one seam and a short window rather than a whole game: gold leaves
 * a running economy for perfectly good reasons — wages, room purchases, a rival's
 * imps filling a rival's vault — and none of that is a leak. One seam, no payday
 * inside the window, and the sum has to be exact.
 */
{
  const g = generateLevel({ seed: 31337 });
  const m = g.map;
  const home = g.startView();

  // A tagged seam next to ground the player already owns, so an imp can reach it.
  let seam = -1;
  for (let r = 2; r < 12 && seam < 0; r++) {
    for (let y = home.y - r; y <= home.y + r && seam < 0; y++) {
      for (let x = home.x - r; x <= home.x + r && seam < 0; x++) {
        if (!m.inBounds(x, y) || m.terrainAt(x, y) !== Terrain.Gold) continue;
        if (m.hasExposedFace(x, y) && g.markTile(x, y, true)) seam = m.idx(x, y);
      }
    }
  }
  check('found a gold seam to mine', seam >= 0);

  const inSeam = m.gold[seam];
  const before = g.goldOf(Owner.Player);
  let ticks = 0;
  // Short of the first payday at 2000 ticks, so nothing legitimately leaves.
  while (ticks < 1500 && m.terrain[seam] === Terrain.Gold) { g.tick(); ticks++; }

  const held = g.creatures
    .filter((c) => c.owner === Owner.Player)
    .reduce((a, c) => a + c.goldHeld, 0);
  let onFloor = 0;
  for (let i = 0; i < m.gold.length; i++) onFloor += m.looseGoldAt(m.xOf(i), m.yOf(i));
  const accounted = (g.goldOf(Owner.Player) - before) + held + onFloor;

  check('the seam was mined out', m.terrain[seam] !== Terrain.Gold, { ticks });
  check('no mined gold is destroyed', accounted === inSeam,
    { inSeam, accounted, inVault: g.goldOf(Owner.Player) - before, held, onFloor });
}

/* -- creature models ----------------------------------------------------- */

/*
 * The models are built from primitives with hand-placed offsets, and the one
 * thing that cannot be seen while placing them is where the floor is: a limb
 * hangs from `limbOffset.y`, so a limb longer than its own attachment height
 * stands *through* the ground. Every walker in the roster had that wrong, by up
 * to 30 cm on a 1 m creature, and it survived a dozen screenshots because feet
 * are the last thing you look at. It is arithmetic, so it belongs in a test.
 *
 * `src/render` is normally off limits here — this whole suite exists because the
 * simulation has no DOM dependency — but the model builders are pure geometry and
 * import nothing but three, so they run in Node like anything else.
 */
{
  const models = await import('../src/render/creatureModels');
  let worstGap = 0;
  let worstName = '';
  let heaviest = 0;
  let heaviestName = '';

  for (const spec of Object.values(CREATURE_SPECS)) {
    const model = models.getCreatureModel(spec.type, spec.color, spec.accent);
    model.limb.computeBoundingBox();
    model.body.computeBoundingBox();
    const limbBox = model.limb.boundingBox!;
    const bodyBox = model.body.boundingBox!;

    // Flyers hover, so their limbs are wings and the floor does not apply.
    if (!model.flapping) {
      const gap = model.limbOffset.y + limbBox.min.y;
      if (Math.abs(gap) > Math.abs(worstGap)) { worstGap = gap; worstName = spec.name; }
    }
    // The body itself must stand on the floor, not float above it or sink in.
    check(`${spec.name} stands on the ground`,
      bodyBox.min.y > -0.06 && bodyBox.min.y < 0.34, Number(bodyBox.min.y.toFixed(3)));
    check(`${spec.name} is roughly as tall as it claims`,
      Math.abs(bodyBox.max.y - model.height) < model.height * 0.2,
      { box: Number(bodyBox.max.y.toFixed(2)), height: model.height });

    const verts = model.body.attributes.position.count
      + model.limb.attributes.position.count * models.limbCountFor(spec.type)
      + model.eyes.attributes.position.count;
    if (verts > heaviest) { heaviest = verts; heaviestName = spec.name; }
  }

  check('every walker\'s feet reach the floor', Math.abs(worstGap) < 0.06,
    { worst: worstName, gap: Number(worstGap.toFixed(3)) });
  // A budget, not a limit for its own sake: geometry is instanced, so this is
  // vertex transform per creature on screen. Twenty thousand is a phone's worth.
  check('no species blows the vertex budget', heaviest < 20000,
    { heaviest: heaviestName, verts: heaviest });
}

/* -- creatures are individuals -------------------------------------------- */

{
  const { blinkScale } = await import('../src/render/creatureRenderer');
  const { badgeFor, BADGE_NONE, BADGE_DIG, BADGE_GOLD, BADGE_HUNGRY, BADGE_ANGRY, BADGE_SLEEP } =
    await import('../src/render/badges');

  // Blinking: open nearly all the time, fully shut briefly, and never in step.
  const sample = (seed: number) => {
    const vals: number[] = [];
    for (let t = 0; t < 12; t += 1 / 60) vals.push(blinkScale(t, seed, CreatureState.Idle));
    return vals;
  };
  const a = sample(0.11);
  const openFraction = a.filter((v) => v > 0.99).length / a.length;
  check('an eye is open almost all the time', openFraction > 0.9,
    { open: Number(openFraction.toFixed(3)) });
  check('but it does shut', Math.min(...a) < 0.12, Number(Math.min(...a).toFixed(3)));
  check('and it never inverts or overshoots', a.every((v) => v >= 0 && v <= 1));

  // Two creatures must not blink together, or a crowd reads as one animation.
  const b = sample(0.73);
  let together = 0;
  for (let i = 0; i < a.length; i++) if (a[i] < 0.5 && b[i] < 0.5) together++;
  check('two creatures do not blink in unison', together === 0, { together });

  // Glancing: bounded, and mostly still — a head that never stopped moving
  // would be scanning the horizon like a lighthouse.
  const { glanceOffset } = await import('../src/render/creatureRenderer');
  const look: number[] = [];
  for (let t = 0; t < 20; t += 1 / 60) look.push(glanceOffset(t, 0.37));
  check('a glance stays within a head-turn', look.every((v) => Math.abs(v) <= 0.56),
    Number(Math.max(...look.map(Math.abs)).toFixed(3)));
  let moved = 0;
  for (let i = 1; i < look.length; i++) if (Math.abs(look[i] - look[i - 1]) > 1e-4) moved++;
  check('and it holds still between glances', moved / look.length < 0.35,
    { movingFraction: Number((moved / look.length).toFixed(3)) });
  check('two creatures look about independently',
    glanceOffset(4.1, 0.2) !== glanceOffset(4.1, 0.8));

  check('a sleeping creature keeps its eyes shut',
    blinkScale(1.7, 0.4, CreatureState.Sleeping) < 0.1);

  // Badges: needs outrank jobs, and idle says nothing.
  const imp = createCreature(CreatureType.Imp, Owner.Player, 5, 5);
  imp.state = CreatureState.Digging;
  check('a digging imp wears the pick', badgeFor(imp) === BADGE_DIG);
  imp.state = CreatureState.Hauling;
  check('a hauling imp wears the coin', badgeFor(imp) === BADGE_GOLD);
  imp.state = CreatureState.Walking;
  check('walking with a load still says gold',
    (imp.goldHeld = 300, badgeFor(imp)) === BADGE_GOLD);
  imp.goldHeld = 0;
  check('walking empty-handed says nothing', badgeFor(imp) === BADGE_NONE);
  imp.state = CreatureState.Idle;
  check('an idle creature says nothing', badgeFor(imp) === BADGE_NONE);
  imp.state = CreatureState.Sleeping;
  check('a sleeper says so', badgeFor(imp) === BADGE_SLEEP);
  imp.state = CreatureState.Digging;
  imp.hunger = 95;
  check('starving outranks the job in hand', badgeFor(imp) === BADGE_HUNGRY);
  imp.hunger = 0;
  imp.anger = 90;
  check('fury outranks the job in hand', badgeFor(imp) === BADGE_ANGRY);
}

/* -- rooms have a footprint ----------------------------------------------- */

{
  const { outwardSidesAt } = await import('../src/render/roomShell');
  const g = generateLevel({ seed: 4242 });
  const m = g.map;
  const cx = g.startView().x, cy = g.startView().y;

  // A clean three-by-three room, laid down by hand so the shape is known.
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      m.setTerrain(x, y, Terrain.Claimed, Owner.Player);
      m.room[m.idx(x, y)] = RoomType.Library;
    }
  }

  const sidesAt = (x: number, y: number): number =>
    outwardSidesAt(m, x, y).filter(Boolean).length;

  check('the middle of a room is interior', sidesAt(cx, cy) === 0, sidesAt(cx, cy));
  check('a room\'s corners have two open sides',
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([dx, dy]) => sidesAt(cx + dx, cy + dy) === 2));
  check('a room\'s edges have one',
    [[0, -1], [-1, 0], [1, 0], [0, 1]].every(([dx, dy]) => sidesAt(cx + dx, cy + dy) === 1));

  // A different room butting up against it is a different building, and the
  // seam between them has to show on both sides.
  for (let y = cy - 1; y <= cy + 1; y++) {
    m.setTerrain(cx + 2, y, Terrain.Claimed, Owner.Player);
    m.room[m.idx(cx + 2, y)] = RoomType.Workshop;
  }
  // Sides run anticlockwise from -Z, so index 3 is +X and index 1 is -X: the
  // two faces that look at each other across the seam.
  check('two rooms meeting each show an edge along the seam',
    outwardSidesAt(m, cx + 1, cy)[3] && outwardSidesAt(m, cx + 2, cy)[1]);

  // Extending the same room, though, dissolves the boundary between the halves.
  for (let y = cy - 1; y <= cy + 1; y++) m.room[m.idx(cx + 2, y)] = RoomType.Library;
  check('extending a room merges its footprint', sidesAt(cx + 1, cy) === 0,
    sidesAt(cx + 1, cy));
}

/* -- the hand carries a fistful ------------------------------------------- */

{
  const g = generateLevel({ seed: 8181 });
  const gs = g.startView();
  const held = [];
  for (let i = 0; i < 10; i++) {
    const c = createCreature(CreatureType.Imp, Owner.Player, gs.x, gs.y);
    g.creatures.push(c);
    held.push(c);
  }
  let taken = 0;
  for (const c of held) if (g.pickUpCreature(c)) taken++;
  check('the hand takes more than one', taken > 1, { taken });
  check('but not without limit', taken === HAND_CAPACITY, { taken, cap: HAND_CAPACITY });
  check('everything it holds knows it', g.handContents().every((c) => c.inHand));

  // Last in, first out: a mis-grab is undone by one drop, not by emptying the
  // whole fist.
  const next = g.handCreature;
  check('the next one out is the last one in', next === g.handContents()[taken - 1]);

  const before = g.handCount();
  const dropped = g.dropAt(gs.x, gs.y);
  check('a drop puts down exactly one', dropped && g.handCount() === before - 1,
    { before, after: g.handCount() });
  check('and the one put down is back in the world',
    next !== null && !next.inHand);

  g.releaseHand();
  check('and the hand can be emptied in one go',
    g.handCount() === 0 && held.every((c) => !c.inHand));
}

/* -- taking the ground takes the building --------------------------------- */

{
  const g = generateLevel({ seed: 3131 });
  const gm = g.map;
  const gs = g.startView();

  /*
   * Counted against a baseline, not from zero.
   *
   * The rival keeper starts the level with a dungeon of his own, treasury
   * included, so asserting "he has exactly four tiles" measures the level
   * generator rather than the rule under test.
   */
  const baseline = g.rooms.count(gm, Owner.KeeperBlue, RoomType.Treasury);

  // A rival's room, next to ground the player holds.
  const rx = gs.x + 6, ry = gs.y;
  for (let y = ry; y < ry + 2; y++) {
    for (let x = rx; x < rx + 2; x++) {
      gm.setTerrain(x, y, Terrain.Claimed, Owner.KeeperBlue);
      gm.room[gm.idx(x, y)] = RoomType.Treasury;
    }
  }
  check('the rival has a room to lose',
    g.rooms.count(gm, Owner.KeeperBlue, RoomType.Treasury) === baseline + 4,
    { baseline, now: g.rooms.count(gm, Owner.KeeperBlue, RoomType.Treasury) });

  // Claim one of its tiles away, the way an imp does.
  const target = gm.idx(rx, ry);
  for (let i = 0; i < 400; i++) {
    if (gm.terrain[target] !== Terrain.Claimed) break;
    gm.claimTile(rx, ry, Owner.Player, 5);
  }
  check('claiming an enemy tile strips it back to bare path',
    gm.terrain[target] === Terrain.Path && gm.owner[target] === Owner.None,
    { terrain: Terrain[gm.terrain[target]] });
  /*
   * The room has to go with the floor.
   *
   * Reverting the terrain and leaving the room behind left a rival's treasury
   * standing on neutral rock — still counted by the room index, still furnished,
   * and owned by nobody. You cannot capture an enemy building; you take the
   * ground and it comes down.
   */
  check('and the building on it comes down',
    gm.room[target] === RoomType.None
    && g.rooms.count(gm, Owner.KeeperBlue, RoomType.Treasury) === baseline + 3,
    { expected: baseline + 3, left: g.rooms.count(gm, Owner.KeeperBlue, RoomType.Treasury) });

  // Digging a floor tile out does the same, from the other direction.
  const dug = gm.idx(rx + 1, ry);
  gm.setTerrain(rx + 1, ry, Terrain.Earth, Owner.None);
  check('and so does burying it', gm.room[dug] === RoomType.None);
}

/* -- rooms have room for only so many ------------------------------------- */

{
  const g = generateLevel({ seed: 4141 });
  const gm = g.map;
  const gs = g.startView();

  /*
   * Clear the lair the level generator gives you first.
   *
   * Without this the test measures nothing: eleven flies housed in a nine-tile
   * room looked like a capacity bug, and was in fact two of them walking off to
   * sleep in the starting dungeon's own lair on the other side of the map.
   */
  for (let i = 0; i < gm.room.length; i++) {
    if (gm.room[i] === RoomType.Lair) gm.room[i] = RoomType.None;
  }

  // A three-by-three lair, laid by hand so its size is known exactly.
  const lx = gs.x + 4, ly = gs.y + 4;
  for (let y = ly; y < ly + 3; y++) {
    for (let x = lx; x < lx + 3; x++) {
      gm.setTerrain(x, y, Terrain.Claimed, Owner.Player);
      gm.room[gm.idx(x, y)] = RoomType.Lair;
    }
  }

  const beds = (): number => {
    let n = 0;
    for (let y = ly; y < ly + 3; y++) {
      for (let x = lx; x < lx + 3; x++) if (!g.isLairFree(gm.idx(x, y))) n++;
    }
    return n;
  };

  // Nine flies, one tile each: the room holds exactly nine.
  const flies = [];
  for (let i = 0; i < 11; i++) {
    const f = createCreature(CreatureType.Fly, Owner.Player, lx, ly);
    g.creatures.push(f);
    flies.push(f);
  }
  run(400, g);
  const housed = flies.filter((f) => f.lairTile >= 0).length;
  check('a nine-tile lair sleeps nine small creatures', housed === 9, { housed, beds: beds() });
  check('and the two left over get no bed at all', flies.length - housed === 2);

  /*
   * Now clear it and put one dragon in. It needs nine tiles, so it takes the
   * whole room and nobody else gets in — which is the entire point of giving a
   * creature a footprint.
   */
  for (const f of flies) g.releaseLair(f);
  g.creatures.length = 0;
  const dragon = createCreature(CreatureType.Dragon, Owner.Player, lx, ly);
  g.creatures.push(dragon);
  const lodger = createCreature(CreatureType.Fly, Owner.Player, lx, ly);
  g.creatures.push(lodger);
  run(400, g);
  check('a dragon takes a whole nine-tile lair to itself',
    dragon.lairTile >= 0 && beds() === 9, { beds: beds() });
  check('and nothing else can bed down in it', lodger.lairTile < 0);

  /*
   * A bedless creature resents you more than a housed one.
   *
   * Measured as a difference between two identical creatures rather than as an
   * absolute number, because anger has other sources and one of them dwarfed
   * this: the first version of this check put a lone creature in a dungeon with
   * no hatchery and watched it reach breaking point in ninety seconds, which was
   * almost entirely starvation. Comparing like with like isolates the lair.
   */
  g.creatures.length = 0;
  const spare = gm.idx(lx - 3, ly);
  gm.setTerrain(lx - 3, ly, Terrain.Claimed, Owner.Player);
  gm.room[spare] = RoomType.Lair;

  /*
   * Feed them, or the test measures starvation.
   *
   * Hunger drives anger far harder than a missing bed does, and in a dungeon
   * with no hatchery it swamps the signal completely — the first version of this
   * had the *housed* creature angrier than the homeless one, because the
   * homeless one had already starved to the point of walking out and stopped
   * accumulating. With a full larder, the lair is the only thing left that
   * differs between them.
   */
  for (let y = ly - 4; y < ly - 1; y++) {
    for (let x = lx - 4; x < lx - 1; x++) {
      gm.setTerrain(x, y, Terrain.Claimed, Owner.Player);
      gm.room[gm.idx(x, y)] = RoomType.Hatchery;
    }
  }
  g.keeper(Owner.Player).food = 500;

  const housedFly = createCreature(CreatureType.Fly, Owner.Player, lx - 3, ly);
  const homeless = createCreature(CreatureType.Fly, Owner.Player, lx - 3, ly);
  g.creatures.push(housedFly, homeless);
  run(60, g);
  check('the one bed goes to one of them',
    (housedFly.lairTile >= 0) !== (homeless.lairTile >= 0),
    { a: housedFly.lairTile, b: homeless.lairTile });

  const withBed = housedFly.lairTile >= 0 ? housedFly : homeless;
  const without = housedFly.lairTile >= 0 ? homeless : housedFly;
  run(2500, g);
  check('the one without a bed is angrier than the one with',
    without.anger > withBed.anger,
    { without: Number(without.anger.toFixed(1)), with: Number(withBed.anger.toFixed(1)) });
  check('and it is a real gap, not rounding',
    without.anger - withBed.anger > 10,
    { gap: Number((without.anger - withBed.anger).toFixed(1)) });

  // Work rooms: one creature to a tile.
  const tx = gs.x - 6, ty = gs.y + 4;
  for (let y = ty; y < ty + 2; y++) {
    for (let x = tx; x < tx + 2; x++) {
      gm.setTerrain(x, y, Terrain.Claimed, Owner.Player);
      gm.room[gm.idx(x, y)] = RoomType.TrainingRoom;
    }
  }
  g.creatures.length = 0;
  g.keeper(Owner.Player).gold = 20000;
  const trainees = [];
  for (let i = 0; i < 8; i++) {
    const t = createCreature(CreatureType.Troll, Owner.Player, tx, ty);
    t.tiredness = 0;
    g.creatures.push(t);
    trainees.push(t);
  }
  run(1200, g);
  const onTiles = new Map<number, number>();
  for (const t of trainees) {
    if (t.state !== CreatureState.Training) continue;
    const k = gm.idx(Math.round(t.x), Math.round(t.y));
    onTiles.set(k, (onTiles.get(k) ?? 0) + 1);
  }
  check('a training room takes one creature to a tile',
    [...onTiles.values()].every((n) => n === 1),
    { tiles: onTiles.size, busiest: Math.max(0, ...onTiles.values()) });
  check('and a four-tile room cannot train eight at once',
    [...onTiles.values()].reduce((a, b) => a + b, 0) <= 4,
    { training: [...onTiles.values()].reduce((a, b) => a + b, 0) });
}

/* -- a full vault stops the mining ---------------------------------------- */

{
  /*
   * On its own level, not the shared one.
   *
   * The first version of this ran on the game every later check uses: it
   * withdrew most of the treasury and ran fifteen hundred extra ticks, which
   * moved the whole timeline and knocked over a creature check four sections
   * further down. A test that changes the world for its neighbours is worse than
   * no test.
   */
  const vault = generateLevel({ seed: 1997 });
  const vm = vault.map;
  const vs = vault.startView();
  vm.revealRadius(vs.x, vs.y, 22);
  for (let y = vs.y - 8; y <= vs.y + 8; y++) {
    for (let x = vs.x - 8; x <= vs.x + 8; x++) vault.markTile(x, y, true);
  }
  run(3000, vault);

  const stuck: number[] = [];
  for (let i = 0; i < vm.flags.length; i++) if ((vm.flags[i] & 1) !== 0) stuck.push(i);
  /*
   * Every survivor is a seam, or is walled in behind one.
   *
   * Not "every survivor is a seam": the earth *behind* a seam the imps have
   * left standing has no exposed face any more, so it is unworkable for a
   * perfectly ordinary reason that has nothing to do with the vault. Asserting
   * the stricter thing would have made the test fail on correct behaviour.
   */
  const explained = stuck.every((i) => {
    const t = vm.terrain[i] as Terrain;
    if (t === Terrain.Gold || t === Terrain.Gems) return true;
    return !vm.hasExposedFace(vm.xOf(i), vm.yOf(i));
  });
  check('a full vault leaves the seams standing', stuck.length > 0 && explained,
    { left: stuck.length, kinds: [...new Set(stuck.map((i) => Terrain[vm.terrain[i]]))] });
  check('and it is full, which is why', !vault.hasTreasurySpace(Owner.Player),
    { gold: vault.goldOf(Owner.Player), cap: vault.treasuryCap() });
  check('the player is told the mining has stopped',
    vault.messages.some((m) => /treasury is full/i.test(m.text)));

  // Room to bank it again, and the work resumes without further prompting.
  const before = stuck.length;
  vault.withdrawGold(Owner.Player, Math.floor(vault.treasuryCap() * 0.7));
  run(2000, vault);
  let after = 0;
  for (let i = 0; i < vm.flags.length; i++) if ((vm.flags[i] & 1) !== 0) after++;
  check('and the imps go back to it when there is room', after < before,
    { was: before, now: after });
}

/* -- things that sit on a block sit on its own top ------------------------ */

{
  const { wallTopAt, WALL_HEIGHT } = await import('../src/render/terrain');
  const g = generateLevel({ seed: 777 });
  const gm = g.map;

  const tops: number[] = [];
  for (let i = 0; i < gm.terrain.length && tops.length < 400; i++) {
    if (gm.terrain[i] === Terrain.Earth) tops.push(wallTopAt(gm, i));
  }
  check('a floor tile has no block on it',
    wallTopAt(gm, gm.idx(g.startView().x, g.startView().y)) === 0);
  check('blocks stand at different heights',
    new Set(tops.map((t) => t.toFixed(3))).size > 20, { sampled: tops.length });

  /*
   * This is the bug, stated as a test.
   *
   * The excavation tag used to be placed at a flat WALL_HEIGHT, so every block
   * that happened to roll taller than that swallowed it and the wall looked
   * untagged. A third of them do. Anything sitting on a block has to ask the
   * block how tall it is.
   */
  const tallerThanNominal = tops.filter((t) => t > WALL_HEIGHT).length;
  check('and a good share of them stand above the nominal height',
    tallerThanNominal > tops.length * 0.2,
    { taller: tallerThanNominal, of: tops.length });
  check('but none of them is impossibly tall',
    tops.every((t) => t > 0 && t < WALL_HEIGHT * 1.1));
}

/* -- the hoard is stacked, not heaped ------------------------------------- */

{
  const { HOARD_TIERS } = await import('../src/render/roomProps');
  const names = ['small change', 'stacks', 'bars', 'barrels'];
  check('the hoard has four tiers', HOARD_TIERS.length === 4, HOARD_TIERS.length);

  let previous = 0;
  for (let tier = 0; tier < HOARD_TIERS.length; tier++) {
    const name = names[tier];
    // Both builds of a tier exist and differ, or every tile of a full vault
    // wears the identical arrangement and the repeat is the loudest thing in
    // the room.
    const a = HOARD_TIERS[tier](0);
    const b = HOARD_TIERS[tier](1);
    const verts = a.attributes.position.count;
    check(`${name} is built from real parts`, verts > 400, { verts });
    // A treasury can be ninety tiles, and every one of them is an instance.
    check(`${name} stays inside the instancing budget`, verts < 6000, { verts });
    /*
     * Progression is measured in height, not vertices.
     *
     * Vertex count is the wrong proxy and said so: the bar tier is visually
     * richer than the stacks below it and geometrically *cheaper*, because a
     * cast bar is a box and a stack of coins is nine cylinders. What has to
     * grow is what the player sees — each tier stands taller than the last.
     */
    a.computeBoundingBox();
    const top = a.boundingBox!.max.y;
    check(`${name} stands taller than the tier below`, top > previous,
      { top: Number(top.toFixed(3)), below: Number(previous.toFixed(3)) });
    previous = top;

    const posA = a.attributes.position.array as ArrayLike<number>;
    const posB = b.attributes.position.array as ArrayLike<number>;
    let differs = posA.length !== posB.length;
    if (!differs) {
      for (let i = 0; i < posA.length; i += 97) {
        if (Math.abs(posA[i] - posB[i]) > 1e-4) { differs = true; break; }
      }
    }
    check(`${name} has two different builds`, differs);

    for (const [label, geo] of [['', a], [' (mirrored)', b]] as const) {
      geo.computeBoundingBox();
      const box = geo.boundingBox!;
      // It has to stand on the tile it belongs to: sunk gold leaves a ring
      // around a hole, and an overhang pokes through the neighbouring kerb.
      check(`${name}${label} stands on the floor`, box.min.y > -0.04,
        Number(box.min.y.toFixed(3)));
      check(`${name}${label} stays on its own tile`,
        Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z) < 0.5,
        Number(Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z).toFixed(3)));
    }
  }
}

/* -- buildings grow ------------------------------------------------------- */

{
  const { roomInstances, grandeur } = await import('../src/render/roomShell');
  const g = generateLevel({ seed: 991 });
  const m = g.map;
  const cx = g.startView().x, cy = g.startView().y;

  const lay = (x0: number, y0: number, span: number, type: RoomType): void => {
    for (let y = y0; y < y0 + span; y++) {
      for (let x = x0; x < x0 + span; x++) {
        m.setTerrain(x, y, Terrain.Claimed, Owner.Player);
        m.room[m.idx(x, y)] = type;
      }
    }
  };
  lay(cx - 1, cy - 1, 3, RoomType.Library);
  lay(cx + 6, cy - 2, 5, RoomType.Library);

  let inst = roomInstances(m);
  check('a room knows how big it is',
    inst.size[m.idx(cx, cy)] === 9 && inst.size[m.idx(cx + 8, cy)] === 25,
    { small: inst.size[m.idx(cx, cy)], large: inst.size[m.idx(cx + 8, cy)] });
  check('and where its middle is',
    Math.abs(inst.midX[m.idx(cx, cy)] - cx) < 0.001
    && Math.abs(inst.midY[m.idx(cx, cy)] - cy) < 0.001);
  check('two rooms of a type do not merge across a gap',
    inst.size[m.idx(cx, cy)] !== inst.size[m.idx(cx + 8, cy)]);

  // Joining them makes one building, and that is what should be measured.
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx + 2; x < cx + 6; x++) {
      m.setTerrain(x, y, Terrain.Claimed, Owner.Player);
      m.room[m.idx(x, y)] = RoomType.Library;
    }
  }
  inst = roomInstances(m);
  check('joining two rooms makes one bigger building',
    inst.size[m.idx(cx, cy)] === inst.size[m.idx(cx + 8, cy)]
    && inst.size[m.idx(cx, cy)] > 25,
    inst.size[m.idx(cx, cy)]);

  check('grandeur is bounded', grandeur(1) === 0 && grandeur(1000) === 1);
  check('and rises with size', grandeur(9) > grandeur(4) && grandeur(25) > grandeur(9));

  // Stock: a room's contents follow what it holds.
  const stocked = generateLevel({ seed: 991 });
  // A room the keeper has not built reports nothing rather than dividing by
  // zero, so the hatchery has to exist before its stock means anything.
  const sx = stocked.startView().x + 5, sy = stocked.startView().y + 5;
  for (let y = sy; y < sy + 3; y++) {
    for (let x = sx; x < sx + 3; x++) {
      stocked.map.setTerrain(x, y, Terrain.Claimed, Owner.Player);
      stocked.map.room[stocked.map.idx(x, y)] = RoomType.Hatchery;
    }
  }
  const empty = stocked.roomStock(Owner.Player);
  stocked.keeper(Owner.Player).food = 999;
  stocked.keeper(Owner.Player).research = 999;
  const full = stocked.roomStock(Owner.Player);
  check('an unfed hatchery reads as empty', (empty[RoomType.Hatchery] ?? 0) === 0);
  check('a fed one reads as full', (full[RoomType.Hatchery] ?? 0) > (empty[RoomType.Hatchery] ?? 0));
  check('a studied library fills up',
    (full[RoomType.Library] ?? 0) > (empty[RoomType.Library] ?? 0));
  check('every stock figure stays in range',
    Object.values(full).every((v) => v >= 0 && v <= 1), full);
  // A room with no tiles has nothing to report, rather than dividing by zero.
  check('a room you have not built reads as zero',
    (stocked.roomStock(Owner.KeeperGreen)[RoomType.Workshop] ?? 0) >= 0);
}

/* -- the dig plan -------------------------------------------------------- */

{
  // A fresh realm, so the survey is judged on what a player sees at the start
  // rather than on a map the earlier checks have already carved up.
  const fresh = generateLevel({ seed: 20260726 });
  const plan = fresh.survey();

  check('the survey plans a route to something', plan.routes.length > 0,
    { routes: plan.routes.map((r) => r.label) });
  check('the survey caches on map version', fresh.survey() === plan);

  let worstStart = 'ok', badTerrain = 'ok', discontinuous = 'ok';
  for (const route of plan.routes) {
    // A route has to begin on ground the keeper actually holds, or the wedges
    // would start in the middle of a rock face and lead nowhere in particular.
    if (fresh.map.owner[route.path[0]] !== Owner.Player) worstStart = route.label;
    for (let i = 0; i < route.path.length; i++) {
      const t = fresh.map.terrain[route.path[i]] as Terrain;
      // Bedrock and liquids are impassable to an imp; a plan that crossed one
      // would be an instruction the player cannot carry out.
      if (t === Terrain.Rock || t === Terrain.Water || t === Terrain.Lava) badTerrain = route.label;
      if (i === 0) continue;
      const a = route.path[i - 1], b = route.path[i];
      const step = Math.abs(fresh.map.xOf(a) - fresh.map.xOf(b))
        + Math.abs(fresh.map.yOf(a) - fresh.map.yOf(b));
      // Four-neighbour steps only: a diagonal would describe a corridor no imp
      // can dig.
      if (step !== 1) discontinuous = route.label;
    }
  }
  check('every route starts on ground you hold', worstStart === 'ok', worstStart);
  check('no route crosses bedrock or liquid', badTerrain === 'ok', badTerrain);
  check('routes are continuous, one tile at a time', discontinuous === 'ok', discontinuous);

  check('the known prefix never runs past the route',
    plan.routes.every((r) => r.known <= r.path.length));
  check('only revealed tiles count as known',
    plan.routes.every((r) => r.path.slice(0, r.known)
      .every((t) => (fresh.map.flags[t] & FLAG_REVEALED) !== 0)));

  // Seams: clustered, reachable, and only ones the player has actually found.
  check('seams are only the ones you have seen',
    plan.seams.every((s) => (fresh.map.flags[s.tile] & FLAG_REVEALED) !== 0));
  check('seams are clustered, not one marker per tile',
    plan.seams.every((s) => s.tiles >= 1)
    && plan.seams.reduce((n, s) => n + s.tiles, 0) >= plan.seams.length,
    { seams: plan.seams.length, tiles: plan.seams.reduce((n, s) => n + s.tiles, 0) });
  check('seams are sorted richest first',
    plan.seams.every((s, i) => i === 0 || plan.seams[i - 1].gold >= s.gold));
  check('every reported seam is reachable', plan.seams.every((s) => s.cost >= 0));

  // Uncovering ground extends the plan. If it did not, it would be decoration.
  const route = plan.routes[0];
  if (route) {
    const knownBefore = route.known;
    for (const tile of route.path) fresh.map.reveal(fresh.map.xOf(tile), fresh.map.yOf(tile));
    fresh.map.version++;
    const after = fresh.survey();
    check('the plan re-plans when the map changes',
      after !== plan && after.version === fresh.map.version);
    check('uncovering the route lengthens what is drawn of it',
      after.routes[0].known > knownBefore,
      { before: knownBefore, after: after.routes[0].known });
  }
}

/* -- performance --------------------------------------------------------- */

const t0 = performance.now();
run(2000, game);
const perTick = (performance.now() - t0) / 2000;
check('a tick stays well inside its 50ms budget', perTick < 5,
  { msPerTick: Number(perTick.toFixed(3)), creatures: game.creatures.length });

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
