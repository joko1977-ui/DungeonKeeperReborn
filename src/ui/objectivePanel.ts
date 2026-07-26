import { Game } from '../core/game';
import { Objective, objectiveDetail, objectiveProgress } from '../core/objectives';

/**
 * The objectives card.
 *
 * The original told you what the level wanted in the opening briefing and left
 * the mentor to nag you about it. A generated realm has no hand-written briefing
 * to lean on, so the goals have to be on screen: primary objectives you must
 * finish to win, bonus ones worth doing, and a tick as each one lands.
 *
 * It sits over the view rather than in the keeper's panel because the panel
 * collapses on small screens and this is the one thing that must never be the
 * part that gets hidden. Click the header to fold it away; it starts folded on a
 * short screen, where a fixed card would cover half the dungeon.
 */

const TICK = '<svg viewBox="0 0 16 16" aria-hidden="true">'
  + '<path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor"'
  + ' stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const DOT = '<svg viewBox="0 0 16 16" aria-hidden="true">'
  + '<circle cx="8" cy="8" r="3.4" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

export class ObjectivePanel {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly banner: HTMLElement;

  /** Signature of the last render, so the DOM is only rebuilt when it changes. */
  private lastSignature = '';
  private collapsed = false;

  constructor(container: HTMLElement, game: Game) {
    this.game = game;

    this.root = document.createElement('div');
    this.root.id = 'objectives';
    this.root.innerHTML = `
      <button type="button" id="objectives-header">
        <span class="caret" aria-hidden="true">▾</span>
        <span class="label">Objectives</span>
        <span class="count" id="objectives-count"></span>
      </button>
      <div id="objectives-banner" class="hidden"></div>
      <ul id="objectives-list"></ul>`;
    container.appendChild(this.root);

    this.list = this.root.querySelector('#objectives-list') as HTMLElement;
    this.banner = this.root.querySelector('#objectives-banner') as HTMLElement;
    const header = this.root.querySelector('#objectives-header') as HTMLElement;
    header.addEventListener('click', () => this.setCollapsed(!this.collapsed));

    // A small screen has no room for a standing card; start it folded there.
    //
    // Height alone was the wrong test. A phone held upright is *tall* — an iPhone
    // reports 664 points and a large one over 900 — so the card stood open on
    // exactly the screens with least room for it, where it is also at its widest
    // relative to the view and its goals wrap to three lines each. Narrow is the
    // signal that matters, with the short-screen case kept for landscape.
    this.setCollapsed(window.innerWidth < 760 || window.innerHeight < 620);
  }

  private setCollapsed(value: boolean): void {
    this.collapsed = value;
    this.root.classList.toggle('collapsed', value);
  }

  /** Refresh if anything actually moved. Called every frame. */
  update(): void {
    const objectives = this.game.objectives;
    const lordComing = this.game.lordIsComing();
    const signature = objectives
      .map((o) => `${o.id}:${o.done ? 1 : 0}:${Math.round(objectiveProgress(o) * 50)}`)
      .join('|') + `#${lordComing ? 1 : 0}`;
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    const remaining = this.game.primaryRemaining();
    const count = this.root.querySelector('#objectives-count') as HTMLElement;
    count.textContent = remaining === 0 ? 'all done' : `${remaining} to go`;
    count.classList.toggle('done', remaining === 0);

    // The Lord's approach is the level's turning point; it gets its own line.
    this.banner.classList.toggle('hidden', !lordComing);
    if (lordComing) this.banner.textContent = 'The Lord of the Land is coming.';

    this.list.innerHTML = objectives
      .map((o) => this.row(o))
      .join('');
  }

  private row(o: Objective): string {
    const detail = objectiveDetail(o);
    const pct = Math.round(objectiveProgress(o) * 100);
    // Only show a bar for goals that actually creep upward. A yes-or-no goal
    // with a 0%-or-100% bar reads as broken rather than informative.
    const bar = !o.done && o.target > 1
      ? `<span class="bar"><i style="width:${pct}%"></i></span>`
      : '';
    return `
      <li class="${o.done ? 'done' : ''} ${o.primary ? 'primary' : 'bonus'}">
        <span class="mark">${o.done ? TICK : DOT}</span>
        <span class="text">${o.text}${detail ? ` <em>${detail}</em>` : ''}${bar}</span>
      </li>`;
  }

  dispose(): void {
    this.root.remove();
  }
}
