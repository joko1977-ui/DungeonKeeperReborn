import { TICKS_PER_SECOND } from '../core/constants';
import { Objective, objectiveBriefing, objectiveDetail } from '../core/objectives';

/**
 * Full-screen overlays: the opening briefing and the end-of-level verdict.
 *
 * The original opened every level on a scroll narrated with obvious relish, and
 * the controls it taught you were unusual enough to be worth spelling out. This
 * is the same idea: read it once, dismiss it, get on with digging.
 */

function ensureOverlay(container: HTMLElement): HTMLElement {
  const existing = container.querySelector('#overlay');
  if (existing instanceof HTMLElement) return existing;
  const overlay = document.createElement('div');
  overlay.id = 'overlay';
  container.appendChild(overlay);
  return overlay;
}

/** The briefing. `returning` is true when the player asked to see it again. */
export function showBriefing(
  container: HTMLElement,
  onDismiss: () => void,
  returning: boolean,
  objectives: readonly Objective[] = [],
): void {
  const overlay = ensureOverlay(container);
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="overlay-card">
      <div class="overlay-scroll">
      <h1>Dungeon Keeper Reborn</h1>
      <h2>${returning ? 'Controls' : 'The realm above is far too cheerful'}</h2>
      ${returning ? '' : `
        <p>
          Your Dungeon Heart beats in the dark. Tag the earth and your imps will
          dig it out; claim what they dig and the dungeon becomes yours. Build
          a lair and a hatchery, and creatures will come to you through the
          portal — feed them, pay them, and they may even fight for you when the
          heroes arrive. They always arrive — along the line of orange arrows, from
          their gate to your heart, which is where a trap earns its keep. The Lord
          of the Land comes last, once you have turned back enough of them.
        </p>
        <p>
          Every direction looks like the same brown rock, so when you cannot tell
          which way is worth the digging, press <b>V</b> for the dig plan: coloured
          wedges over the wall tops marking the blocks that lead to each thing the
          compass points at, marks on the stone for the seams you have found, and
          arrows following your imps to wherever they are working. It stays off
          until you ask for it, and it remembers which you prefer.
        </p>
        ${briefingObjectives(objectives)}`}
      <h3 class="brief-heading">Reading the dungeon</h3>
      <dl class="keys">
        <dt>Warm brown rock</dt><dd>Diggable. Tag it and your imps will cut through</dd>
        <dt>Tall blue-black rock</dt><dd>Bedrock. Nothing digs it — it is the edge of the world</dd>
        <dt>Orange arrows</dt><dd>The way the heroes will come. Put your traps and doors on it</dd>
        <dt>Coloured wedges</dt><dd>The dig plan: the blocks to cut through to reach what the compass is pointing at, in that thing's own colour. The big arrow is where it leaves ground you have seen</dd>
        <dt>Marks on the stone</dt><dd>A seam you have found — gold, or blue-white for gems</dd>
        <dt>Green arrows</dt><dd>Your imps' traffic, sliding along the route each one is walking. They turn gold when the imp is carrying a load home</dd>
        <dt>Yellow diamonds</dt><dd>Walls you have tagged for excavation. They sit above everything else on the block, so an order is never hidden by an overlay</dd>
        <dt>Shafts of light</dt><dd>A Dungeon Heart or a portal, in its owner's colour</dd>
        <dt>Heroes in…</dt><dd>The raid clock, top right. It turns red when the wave is close</dd>
      </dl>
      <dl class="keys">
        <dt>Left click</dt><dd>Tag walls for excavation — drag to tag a whole slab</dd>
        <dt>Left click</dt><dd>Snatch up one of your creatures. Grab a fistful — up to eight — and each click on your own floor drops one, the last one grabbed first. <b>Esc</b> puts them all back</dd>
        <dt>Roster panel</dt><dd>Click a creature to snatch one without moving the view; click again for more. Right-click to go and look at one instead</dd>
        <dt>Health bars</dt><dd>Over anything hurt or fighting. Snatch the one that is nearly dead out of the brawl</dd>
        <dt>Enemy rooms</dt><dd>You cannot capture them. Send imps to claim the floor they stand on and the building comes down with the ground</dd>
        <dt>Improve</dt><dd>The trowel on the tool rail. Click one of your rooms to level the whole building up — three levels, dearer each time. A better vault holds more, a better lair rests faster, a better training room teaches quicker. Widening is still the cheap way to grow; improving is what you do when there is nowhere left to widen into</dd>
        <dt>Right click</dt><dd>Slap a creature to hurry it along, or clear an excavation tag</dd>
        <dt>Middle drag</dt><dd>Rotate the view &nbsp;·&nbsp; <b>Q</b> / <b>E</b> to spin</dd>
        <dt>Wheel</dt><dd>Zoom &nbsp;·&nbsp; <b>W A S D</b> or arrows to move &nbsp;·&nbsp; edge of screen scrolls</dd>
        <dt>R / F / T / C</dt><dd>Rooms, spells, workshop and creature tabs &nbsp;·&nbsp; <b>1–9</b> picks from the open tab</dd>
        <dt>Space</dt><dd>Pause &nbsp;·&nbsp; <b>Esc</b> puts down whatever tool you picked up</dd>
        <dt>V</dt><dd>Show or hide the dig plan — off by default, and it remembers &nbsp;·&nbsp; also the <b>Dig plan</b> button, top right</dd>
        <dt>One finger</dt><dd>Tap or drag to tag walls · tap a creature to pick it up · hold to slap</dd>
        <dt>Two fingers</dt><dd>Drag to move · pinch to zoom · twist to rotate</dd>
        <dt>Sound</dt><dd>Toggle the mix and the narrator from the top right</dd>
      </dl>
      <p style="font-size:12px;opacity:0.6;margin-top:-4px">
        Every sound here is synthesised in your browser, and the narrator speaks
        through your system voice — so he will not sound like the one you
        remember, but he is no fonder of you.
      </p>
      </div>
      <button class="big-button" id="overlay-dismiss">
        ${returning ? 'Back to the dungeon' : 'Begin'}
      </button>
    </div>`;

  const button = overlay.querySelector('#overlay-dismiss');
  button?.addEventListener('click', () => {
    overlay.classList.add('hidden');
    onDismiss();
  });
}

/** The objectives, as the briefing lays them out. */
function briefingObjectives(objectives: readonly Objective[]): string {
  if (objectives.length === 0) return '';
  const primary = objectives.filter((o) => o.primary);
  const bonus = objectives.filter((o) => !o.primary);

  const rows = (list: readonly Objective[]): string => list
    .map((o) => `<dt>${o.text}</dt><dd>${objectiveBriefing(o)}</dd>`)
    .join('');

  return `
    <h3 class="brief-heading">To take this realm</h3>
    <dl class="objectives">${rows(primary)}</dl>
    ${bonus.length === 0 ? '' : `
      <h3 class="brief-heading">Worth doing anyway</h3>
      <dl class="objectives bonus">${rows(bonus)}</dl>`}
    <p class="brief-note">
      Lose your Dungeon Heart and none of it matters. The goals are also listed
      in the corner of the screen while you play.
    </p>`;
}

/** The verdict screen, shown when the heart falls or the realm is won. */
export function showOutcome(
  container: HTMLElement,
  status: 'won' | 'lost',
  onRestart: () => void,
  objectives: readonly Objective[] = [],
  elapsedTicks = 0,
): void {
  const overlay = ensureOverlay(container);
  overlay.classList.remove('hidden');
  const won = status === 'won';

  const seconds = Math.round(elapsedTicks / TICKS_PER_SECOND);
  const time = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  const met = objectives.filter((o) => o.done).length;

  // A verdict that only says won or lost teaches nothing. Showing which goals
  // landed and which did not is how a player works out what to do differently.
  const scoreboard = objectives.length === 0 ? '' : `
    <dl class="objectives outcome">
      ${objectives.map((o) => {
        const detail = objectiveDetail(o);
        return `<dt class="${o.done ? 'met' : 'missed'}">${o.done ? '✓' : '✕'} ${o.text}</dt>`
          + `<dd>${o.done ? 'done' : (detail || 'not achieved')}</dd>`;
      }).join('')}
    </dl>
    <p class="brief-note">${met} of ${objectives.length} objectives met in ${time}.</p>`;

  overlay.innerHTML = `
    <div class="overlay-card">
      <div class="overlay-scroll">
      <h1>${won ? 'The realm is yours' : 'Your heart is broken'}</h1>
      <h2>${won
        ? 'The heroes are scattered and the land above has learned to be afraid.'
        : 'The last of your dungeon goes dark. Somewhere, a knight is being congratulated.'}</h2>
      ${scoreboard}
      </div>
      <button class="big-button" id="overlay-restart">Dig again</button>
    </div>`;

  overlay.querySelector('#overlay-restart')?.addEventListener('click', onRestart);
}
