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
  HEART_HP, Owner, RoomType, SpellType, Terrain, isDiggable, isWalkable,
} from '../src/core/constants';
import { CREATURE_SPECS, CreatureState, CreatureType, createCreature } from '../src/core/creatures';
import { DOOR_SPECS, DoorType, TrapType } from '../src/core/devices';
import { generateLevel } from '../src/core/levelgen';
import { damageCreature } from '../src/core/ai';
import { objectiveProgress } from '../src/core/objectives';

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
check('imps clear the tagged slab', stillMarked <= 2, { stillMarked });
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

/* -- performance --------------------------------------------------------- */

const t0 = performance.now();
run(2000, game);
const perTick = (performance.now() - t0) / 2000;
check('a tick stays well inside its 50ms budget', perTick < 5,
  { msPerTick: Number(perTick.toFixed(3)), creatures: game.creatures.length });

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
