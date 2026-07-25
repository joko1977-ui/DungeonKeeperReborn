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

import { Owner, RoomType, Terrain } from '../src/core/constants';
import { CREATURE_SPECS, CreatureState, CreatureType } from '../src/core/creatures';
import { generateLevel } from '../src/core/levelgen';

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

const goldAtStart = game.goldOf(Owner.Player);
const territoryAtStart = map.countOwned(Owner.Player);

/* -- digging and claiming ------------------------------------------------ */

run(5000, game);

let stillMarked = 0;
for (let i = 0; i < map.flags.length; i++) if (map.flags[i] & 1) stillMarked++;
const territory = map.countOwned(Owner.Player);

check('imps clear the tagged slab', stillMarked === 0, { stillMarked });
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
            || map.room[i] !== RoomType.None) ok = false;
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

check('refuses to build on bare rock',
  !game.build(RoomType.Library, 1, 1, 2, 2));

/* -- creatures ----------------------------------------------------------- */

run(7000, game);

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

/* -- narration cues ------------------------------------------------------ */

// The narrator is driven by cues on messages, not by string-matching the log.
// If a notification loses its cue, the narrator silently goes quiet, so the
// wiring is worth asserting here where it is cheap to check.
const cued = game.messages.filter((m) => m.cue !== undefined);
check('notifications carry narrator cues', cued.length > 0,
  { cued: cued.length, total: game.messages.length });
check('the opening line is cued',
  game.messages.some((m) => m.cue === 'level-start'));

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
check('the game is still running', game.status === 'playing', { status: game.status });
check('the heart still stands', game.roomTileCount(RoomType.DungeonHeart) > 0);

const heroes = game.creatures.filter((c) => c.owner === Owner.Heroes);
check('heroes eventually invade', heroes.length > 0 || game.messages.some(
  (m) => m.text.includes('Heroes')), { heroes: heroes.length });

/* -- performance --------------------------------------------------------- */

const t0 = performance.now();
run(2000, game);
const perTick = (performance.now() - t0) / 2000;
check('a tick stays well inside its 50ms budget', perTick < 5,
  { msPerTick: Number(perTick.toFixed(3)), creatures: game.creatures.length });

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
