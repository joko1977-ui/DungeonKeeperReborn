import {
  Owner,
  ROOM_BUTTON_ORDER,
  ROOM_SPECS,
  RoomType,
  SPELL_BUTTON_ORDER,
  SPELL_SPECS,
  SpellType,
  TICKS_PER_SECOND,
} from '../core/constants';
import {
  CREATURE_SPECS,
  Creature,
  CreatureType,
  STATE_NAMES,
  maxHpOf,
  wageOf,
  xpForNextLevel,
} from '../core/creatures';
import { Game } from '../core/game';
import {
  DOOR_BUTTON_ORDER,
  DOOR_SPECS,
  DoorType,
  TRAP_BUTTON_ORDER,
  TRAP_SPECS,
  TrapType,
} from '../core/devices';
import { Tool } from '../input/hand';
import {
  CREATURE_GLYPH,
  GOLD_GLYPH,
  MANA_GLYPH,
  TAB_ICONS,
  creatureIcon,
  doorIcon,
  roomIcon,
  spellIcon,
  trapIcon,
} from './icons';
import { Minimap } from './minimap';

type TabId = 'rooms' | 'spells' | 'workshop' | 'creatures';

export interface HudCallbacks {
  onToolChange(tool: Tool): void;
  onNavigate(x: number, y: number): void;
  /** Zoom to and pick up the next creature of a type, as the roster does. */
  onPickCreatureType(type: CreatureType): void;
  /** Take the view to one of them, without picking anything up. */
  onFindCreatureType(type: CreatureType): void;
}

/**
 * The keeper's control panel.
 *
 * Laid out like the original's: minimap on the left, a rail of tabs, the button
 * grid for whichever tab is open, and an information column on the right that
 * describes whatever you're pointing at. Everything is plain DOM — it composites
 * over the WebGL canvas, costs nothing to render, and stays legible at any
 * resolution, which a texture-based panel would not.
 */
export class Hud {
  readonly minimap: Minimap;

  private readonly game: Game;
  private readonly callbacks: HudCallbacks;

  private readonly root: HTMLElement;
  private readonly goldValue: HTMLElement;
  private readonly goldReadout: HTMLElement;
  private readonly manaValue: HTMLElement;
  private readonly creatureValue: HTMLElement;
  private readonly toolTitle: HTMLElement;
  private readonly toolGrid: HTMLElement;
  private readonly infoTitle: HTMLElement;
  private readonly infoBody: HTMLElement;
  private readonly messageList: HTMLElement;
  private readonly tabButtons = new Map<TabId, HTMLElement>();

  private activeTab: TabId = 'rooms';
  private selectedTool: Tool = { kind: 'hand' };
  /** Creature the cursor is over, which takes over the info column. */
  private hoveredCreature: Creature | null = null;
  private lastMessageCount = 0;

  constructor(container: HTMLElement, game: Game, callbacks: HudCallbacks) {
    this.game = game;
    this.callbacks = callbacks;

    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div class="panel-block" id="minimap-block">
        <div id="minimap-frame"><canvas id="minimap"></canvas></div>
        <div class="readouts">
          <div class="readout" id="gold-readout">
            <span class="glyph">${GOLD_GLYPH}</span><span class="value" id="gold-value">0</span>
          </div>
          <div class="readout mana">
            <span class="glyph">${MANA_GLYPH}</span><span class="value" id="mana-value">0</span>
          </div>
        </div>
        <div class="readouts">
          <div class="readout">
            <span class="glyph">${CREATURE_GLYPH}</span>
            <span class="value" id="creature-value">0</span>
          </div>
        </div>
      </div>

      <div class="panel-block" id="tabs"></div>

      <div class="panel-block" id="tool-block">
        <div id="tool-title">Rooms</div>
        <div id="tool-grid"></div>
      </div>

      <div class="panel-block" id="info-block">
        <div id="info-title">Your Dungeon</div>
        <div id="info-body"></div>
      </div>
    `;
    container.appendChild(this.root);

    this.messageList = document.createElement('div');
    this.messageList.id = 'messages';
    container.appendChild(this.messageList);

    this.goldValue = this.mustFind('gold-value');
    this.goldReadout = this.mustFind('gold-readout');
    this.manaValue = this.mustFind('mana-value');
    this.creatureValue = this.mustFind('creature-value');
    this.toolTitle = this.mustFind('tool-title');
    this.toolGrid = this.mustFind('tool-grid');
    this.infoTitle = this.mustFind('info-title');
    this.infoBody = this.mustFind('info-body');

    this.buildTabs();
    this.buildGrid();

    const canvas = this.mustFind('minimap') as HTMLCanvasElement;
    this.minimap = new Minimap(canvas, game);
    this.minimap.setNavigateHandler((x, y) => this.callbacks.onNavigate(x, y));

    window.addEventListener('keydown', this.onKeyDown);
  }

  private mustFind(id: string): HTMLElement {
    const el = this.root.querySelector(`#${id}`);
    if (!(el instanceof HTMLElement)) throw new Error(`HUD element #${id} missing`);
    return el;
  }

  /* -------------------------------------------------------------- tabs -- */

  private buildTabs(): void {
    const rail = this.mustFind('tabs');
    const tabs: Array<{ id: TabId; icon: string; title: string }> = [
      { id: 'rooms', icon: TAB_ICONS.rooms, title: 'Rooms' },
      { id: 'spells', icon: TAB_ICONS.spells, title: 'Spells' },
      { id: 'workshop', icon: TAB_ICONS.workshop, title: 'Workshop — traps and doors' },
      { id: 'creatures', icon: TAB_ICONS.creatures, title: 'Creatures' },
    ];
    for (const tab of tabs) {
      const button = document.createElement('div');
      button.className = 'tab';
      button.innerHTML = tab.icon;
      button.title = tab.title;
      button.addEventListener('click', () => this.setTab(tab.id));
      rail.appendChild(button);
      this.tabButtons.set(tab.id, button);
    }

    // The sell tool lives on the rail too, since it applies across all rooms.
    const sell = document.createElement('div');
    sell.className = 'tab';
    sell.innerHTML = TAB_ICONS.sell;
    sell.title = 'Sell rooms (drag over your rooms to reclaim half their cost)';
    sell.addEventListener('click', () => {
      this.selectTool(this.selectedTool.kind === 'sell' ? { kind: 'hand' } : { kind: 'sell' });
    });
    rail.appendChild(sell);
    this.tabButtons.set('sell' as TabId, sell);

    // Improving applies across all rooms too, so it sits beside selling.
    const improve = document.createElement('div');
    improve.className = 'tab';
    improve.innerHTML = TAB_ICONS.improve;
    improve.title = 'Improve a room (click one of your rooms to level up the whole building)';
    improve.addEventListener('click', () => {
      this.selectTool(
        this.selectedTool.kind === 'improve' ? { kind: 'hand' } : { kind: 'improve' });
    });
    rail.appendChild(improve);
    this.tabButtons.set('improve' as TabId, improve);

    this.updateTabHighlight();
  }

  private setTab(id: TabId): void {
    this.activeTab = id;
    this.buildGrid();
    this.updateTabHighlight();
  }

  private updateTabHighlight(): void {
    for (const [id, el] of this.tabButtons) {
      const asString = id as string;
      const isAction = asString === 'sell' || asString === 'improve';
      const active = isAction
        ? this.selectedTool.kind === asString
        : id === this.activeTab && !isAction && this.selectedTool.kind !== 'sell'
          && this.selectedTool.kind !== 'improve';
      el.classList.toggle('active', active);
    }
  }

  /* -------------------------------------------------------------- grid -- */

  private buildGrid(): void {
    this.toolGrid.innerHTML = '';
    switch (this.activeTab) {
      case 'rooms':
        this.toolTitle.textContent = 'Rooms';
        for (const room of ROOM_BUTTON_ORDER) this.toolGrid.appendChild(this.roomButton(room));
        break;
      case 'spells':
        this.toolTitle.textContent = 'Keeper Spells';
        for (const spell of SPELL_BUTTON_ORDER) this.toolGrid.appendChild(this.spellButton(spell));
        break;
      case 'workshop':
        this.buildWorkshopGrid();
        break;
      case 'creatures':
        this.toolTitle.textContent = 'Your Creatures';
        this.buildCreatureGrid();
        break;
    }
  }

  private roomButton(room: RoomType): HTMLElement {
    const spec = ROOM_SPECS[room];
    const button = document.createElement('div');
    button.className = 'tool-button';
    button.dataset.room = String(room);
    button.innerHTML = `
      ${roomIcon(room)}
      <span class="cost">${spec.cost}</span>
      <span class="label">${spec.name}</span>`;
    button.title = `${spec.name} — ${spec.cost} gold per tile. ${spec.blurb}`;
    button.addEventListener('click', () => {
      const already = this.selectedTool.kind === 'room' && this.selectedTool.room === room;
      this.selectTool(already ? { kind: 'hand' } : { kind: 'room', room });
    });
    button.addEventListener('pointerenter', () => this.showRoomInfo(room));
    return button;
  }

  private spellButton(spell: SpellType): HTMLElement {
    const spec = SPELL_SPECS[spell];
    const button = document.createElement('div');
    button.className = 'tool-button';
    button.dataset.spell = String(spell);
    button.innerHTML = `
      ${spellIcon(spell)}
      <span class="cost">${this.game.spellCost(spell)}</span>
      <span class="label">${spec.name}</span>`;
    button.title = `${spec.name} — ${spec.blurb}`;
    button.addEventListener('click', () => {
      const already = this.selectedTool.kind === 'spell' && this.selectedTool.spell === spell;
      this.selectTool(already ? { kind: 'hand' } : { kind: 'spell', spell });
    });
    button.addEventListener('pointerenter', () => this.showSpellInfo(spell));
    return button;
  }

  /**
   * The workshop tab. Every button does two jobs, which is how the original
   * works: click one with stock and you arm it for placing; click one with no
   * stock and the workshop starts building it instead.
   */
  private buildWorkshopGrid(): void {
    const workshopTiles = this.game.roomTileCount(RoomType.Workshop);
    const progress = Math.round(this.game.manufactureProgress() * 100);
    const target = this.game.manufactureTarget;
    const targetName = target
      ? (target.kind === 'trap' ? TRAP_SPECS[target.type].name : DOOR_SPECS[target.type].name)
      : null;

    this.toolTitle.textContent = workshopTiles === 0
      ? 'Workshop — build one first'
      : targetName
        ? `Workshop — ${targetName} ${progress}%`
        : 'Workshop — pick something to build';

    if (workshopTiles === 0) {
      const empty = document.createElement('div');
      // A grid cell is a button's width. Prose has to span the whole row or it
      // wraps to one word per line.
      empty.className = 'grid-note';
      empty.textContent =
        'You have no workshop. Build one from the Rooms tab and put creatures in it — '
        + 'trolls and bile demons will work there.';
      this.toolGrid.appendChild(empty);
      return;
    }

    for (const trap of TRAP_BUTTON_ORDER) {
      this.toolGrid.appendChild(this.deviceButton('trap', trap));
    }
    for (const door of DOOR_BUTTON_ORDER) {
      this.toolGrid.appendChild(this.deviceButton('door', door));
    }
  }

  private deviceButton(kind: 'trap' | 'door', type: number): HTMLElement {
    const spec = kind === 'trap' ? TRAP_SPECS[type as TrapType] : DOOR_SPECS[type as DoorType];
    const stock = kind === 'trap'
      ? this.game.stockOfTrap(type as TrapType) : this.game.stockOfDoor(type as DoorType);
    const target = this.game.manufactureTarget;
    const isTarget = target !== null && target.kind === kind && target.type === type;

    const button = document.createElement('div');
    button.className = 'tool-button';
    button.dataset[kind] = String(type);
    button.innerHTML = `
      ${kind === 'trap' ? trapIcon(type as TrapType) : doorIcon(type as DoorType)}
      <span class="cost">${spec.cost}</span>
      <span class="label">${spec.name}</span>
      ${stock > 0 ? `<span class="count">${stock}</span>` : ''}
      ${isTarget ? '<span class="building"></span>' : ''}`;
    button.title = stock > 0
      ? `${spec.name} — ${stock} in stock. Click to place one.`
      : `${spec.name} — click to start building. ${spec.blurb}`;
    button.classList.toggle('selected', isTarget && stock === 0);

    button.addEventListener('click', () => {
      if (stock > 0) {
        this.selectTool(kind === 'trap'
          ? { kind: 'trap', trap: type as TrapType }
          : { kind: 'door', door: type as DoorType });
      } else {
        // Nothing built yet: put it on the workshop's bench.
        this.game.setManufactureTarget(
          kind === 'trap'
            ? { kind: 'trap', type: type as TrapType }
            : { kind: 'door', type: type as DoorType },
        );
        this.buildGrid();
      }
    });
    button.addEventListener('pointerenter', () => {
      this.infoTitle.textContent = spec.name;
      this.infoBody.innerHTML = `
        <p>${spec.blurb}</p>
        <div class="stat"><span>In stock</span><b>${stock}</b></div>
        <div class="stat"><span>Gold on completion</span><b>${spec.cost}</b></div>
        <div class="stat"><span>Build effort</span><b>${spec.build}</b></div>`;
    });
    return button;
  }

  private buildCreatureGrid(): void {
    const counts = this.game.playerCreatureCounts();
    if (counts.size === 0) {
      const empty = document.createElement('div');
      // A grid cell is a button's width. Prose has to span the whole row or it
      // wraps to one word per line.
      empty.className = 'grid-note';
      empty.textContent = 'No creatures yet. Build a lair and a hatchery, then wait at your portal.';
      this.toolGrid.appendChild(empty);
      return;
    }
    for (const [type, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      const spec = CREATURE_SPECS[type];
      const button = document.createElement('div');
      button.className = 'tool-button';
      button.dataset.creature = String(type);
      button.innerHTML = `
        ${creatureIcon(type)}
        <span class="count">${count}</span>
        <span class="label">${spec.name}</span>`;
      button.title = `${spec.name} — click to snatch one into your hand (click again for more). Right-click to go and look at one.`;
      button.addEventListener('click', () => this.callbacks.onPickCreatureType(type));
      button.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.callbacks.onFindCreatureType(type);
      });
      this.toolGrid.appendChild(button);
    }
  }

  /* -------------------------------------------------------- selection -- */

  private selectTool(tool: Tool): void {
    this.selectedTool = tool;
    this.callbacks.onToolChange(tool);
    this.refreshSelection();
    this.updateTabHighlight();
  }

  /** Called from outside when the hand consumes or clears a tool. */
  setTool(tool: Tool): void {
    this.selectedTool = tool;
    this.refreshSelection();
    this.updateTabHighlight();
  }

  private refreshSelection(): void {
    for (const button of this.toolGrid.querySelectorAll('.tool-button')) {
      const el = button as HTMLElement;
      let selected = false;
      if (this.selectedTool.kind === 'room' && el.dataset.room !== undefined) {
        selected = Number(el.dataset.room) === this.selectedTool.room;
      } else if (this.selectedTool.kind === 'spell' && el.dataset.spell !== undefined) {
        selected = Number(el.dataset.spell) === this.selectedTool.spell;
      } else if (this.selectedTool.kind === 'trap' && el.dataset.trap !== undefined) {
        selected = Number(el.dataset.trap) === this.selectedTool.trap;
      } else if (this.selectedTool.kind === 'door' && el.dataset.door !== undefined) {
        selected = Number(el.dataset.door) === this.selectedTool.door;
      }
      el.classList.toggle('selected', selected);
    }
  }

  /* ------------------------------------------------------------- info -- */

  setHoveredCreature(creature: Creature | null): void {
    this.hoveredCreature = creature;
  }

  private showRoomInfo(room: RoomType): void {
    const spec = ROOM_SPECS[room];
    const built = this.game.roomTileCount(room);
    this.infoTitle.textContent = spec.name;
    this.infoBody.innerHTML = `
      <p>${spec.blurb}</p>
      <div class="stat"><span>Cost per tile</span><b>${spec.cost} gold</b></div>
      <div class="stat"><span>Tiles built</span><b>${built}</b></div>`;
  }

  private showSpellInfo(spell: SpellType): void {
    const spec = SPELL_SPECS[spell];
    this.infoTitle.textContent = spec.name;
    this.infoBody.innerHTML = `
      <p>${spec.blurb}</p>
      <div class="stat"><span>Mana cost</span><b>${this.game.spellCost(spell)}</b></div>`;
  }

  /** Full read-out for a creature: the original's creature panel, condensed. */
  private showCreatureInfo(c: Creature): void {
    const spec = CREATURE_SPECS[c.type];
    const hp = Math.round((c.hp / maxHpOf(c)) * 100);
    const xpNeeded = xpForNextLevel(c.level);
    const xp = Math.min(100, Math.round((c.experience / xpNeeded) * 100));
    const ownerName = c.owner === Owner.Player ? 'Yours'
      : c.owner === Owner.Heroes ? 'Hero' : 'Rival keeper';

    this.infoTitle.textContent = `${spec.name} — Level ${c.level}`;
    this.infoBody.innerHTML = `
      <div class="stat"><span>${ownerName}</span><b>${STATE_NAMES[c.state]}</b></div>
      <div class="bar hp"><i style="width:${hp}%"></i></div>
      <div class="stat"><span>Health</span><b>${Math.round(c.hp)} / ${Math.round(maxHpOf(c))}</b></div>
      <div class="bar hunger"><i style="width:${Math.round(c.hunger)}%"></i></div>
      <div class="stat"><span>Hunger</span><b>${Math.round(c.hunger)}%</b></div>
      <div class="bar tired"><i style="width:${Math.round(c.tiredness)}%"></i></div>
      <div class="stat"><span>Tiredness</span><b>${Math.round(c.tiredness)}%</b></div>
      <div class="bar anger"><i style="width:${Math.round(c.anger)}%"></i></div>
      <div class="stat"><span>Anger</span><b>${Math.round(c.anger)}%</b></div>
      <div class="bar xp"><i style="width:${xp}%"></i></div>
      <div class="stat"><span>Wage</span><b>${wageOf(c)} gold</b></div>`;
  }

  /** Default info: how the dungeon as a whole is doing. */
  private showDungeonInfo(): void {
    const game = this.game;
    const lairs = game.roomTileCount(RoomType.Lair);
    const hatchery = game.roomTileCount(RoomType.Hatchery);
    const treasury = game.roomTileCount(RoomType.Treasury);
    const creatures = [...game.playerCreatureCounts().values()].reduce((a, b) => a + b, 0);

    this.infoTitle.textContent = 'Your Dungeon';
    this.infoBody.innerHTML = `
      <div class="stat"><span>Creatures</span><b>${creatures}</b></div>
      <div class="stat"><span>Lair tiles</span><b>${lairs}</b></div>
      <div class="stat"><span>Hatchery</span><b>${hatchery} (${game.foodOf(Owner.Player)} food)</b></div>
      <div class="stat"><span>Treasury</span><b>${treasury} tiles / ${game.treasuryCap()} gold</b></div>
      <div class="stat"><span>Territory</span><b>${game.map.countOwned(Owner.Player)} tiles</b></div>`;
  }

  /* ----------------------------------------------------------- update -- */

  /** Refresh everything that changes moment to moment. */
  update(): void {
    const game = this.game;
    const gold = game.goldOf(Owner.Player);
    const cap = game.treasuryCap();

    this.goldValue.textContent = String(Math.floor(gold));
    // Warn when the treasury is full — mined gold is being thrown away.
    this.goldReadout.classList.toggle('warn', cap > 0 && gold >= cap);

    this.manaValue.textContent = String(Math.floor(game.manaOf(Owner.Player)));
    const creatures = [...game.playerCreatureCounts().values()].reduce((a, b) => a + b, 0);
    this.creatureValue.textContent = String(creatures);

    // Grey out anything currently unaffordable.
    if (this.activeTab === 'rooms') {
      for (const el of this.toolGrid.querySelectorAll('.tool-button')) {
        const room = Number((el as HTMLElement).dataset.room) as RoomType;
        el.classList.toggle('unaffordable', ROOM_SPECS[room].cost > gold);
      }
    } else if (this.activeTab === 'spells') {
      const mana = game.manaOf(Owner.Player);
      for (const el of this.toolGrid.querySelectorAll('.tool-button')) {
        const spell = Number((el as HTMLElement).dataset.spell) as SpellType;
        const cost = game.spellCost(spell);
        el.classList.toggle('unaffordable', cost > mana);
        const costEl = el.querySelector('.cost');
        if (costEl) costEl.textContent = String(cost);
      }
    }

    if (this.hoveredCreature && this.hoveredCreature.hp > 0) {
      this.showCreatureInfo(this.hoveredCreature);
    } else if (game.handCreature) {
      this.showCreatureInfo(game.handCreature);
      /*
       * Say how many are in the fist, and which one comes out next.
       *
       * With a stack, "what am I holding" stops being obvious the moment it is
       * more than one — and the answer decides where you click, because the next
       * drop puts down the last one you grabbed.
       */
      const held = game.handCount();
      if (held > 1) {
        this.infoTitle.textContent =
          `Holding ${held} — ${CREATURE_SPECS[game.handCreature.type].name} next`;
      }
    } else if (this.infoTitle.textContent === 'Your Dungeon') {
      this.showDungeonInfo();
    }

    this.syncMessages();
  }

  /** Rebuild the roster or workshop tab; only worth doing when one is open. */
  refreshCreatureTab(): void {
    if (this.activeTab === 'creatures' || this.activeTab === 'workshop') this.buildGrid();
  }

  private syncMessages(): void {
    const messages = this.game.messages;
    if (messages.length === this.lastMessageCount) return;

    // Show the newest few; older ones fade out on their own.
    const fresh = messages.slice(this.lastMessageCount);
    this.lastMessageCount = messages.length;

    for (const message of fresh) {
      const el = document.createElement('div');
      el.className = 'message';
      el.textContent = message.text;
      this.messageList.appendChild(el);
      window.setTimeout(() => {
        el.classList.add('fading');
        window.setTimeout(() => el.remove(), 800);
      }, 7000);
    }
    while (this.messageList.childElementCount > 6) {
      this.messageList.firstElementChild?.remove();
    }
  }

  /* -------------------------------------------------------- shortcuts -- */

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    // Number keys pick from the open tab, the way the original's hotkeys did.
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      if (this.activeTab === 'rooms') {
        const room = ROOM_BUTTON_ORDER[n - 1];
        if (room !== undefined) this.selectTool({ kind: 'room', room });
      } else if (this.activeTab === 'spells') {
        const spell = SPELL_BUTTON_ORDER[n - 1];
        if (spell !== undefined) this.selectTool({ kind: 'spell', spell });
      } else if (this.activeTab === 'workshop') {
        const trap = TRAP_BUTTON_ORDER[n - 1];
        if (trap !== undefined && this.game.stockOfTrap(trap) > 0) {
          this.selectTool({ kind: 'trap', trap });
        }
      }
      return;
    }
    switch (e.code) {
      case 'KeyR': this.setTab('rooms'); break;
      case 'KeyF': this.setTab('spells'); break;
      case 'KeyC': this.setTab('creatures'); break;
      case 'KeyT': this.setTab('workshop'); break;
      case 'Escape': this.selectTool({ kind: 'hand' }); break;
      default: break;
    }
  };

  /** Seconds until the next payday, for the top strip. */
  paydayCountdown(): string {
    const remaining = Math.max(0, this.game.nextPaydayTick() - this.game.tickCount);
    const seconds = Math.ceil(remaining / TICKS_PER_SECOND);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.minimap.dispose();
    this.root.remove();
    this.messageList.remove();
  }
}
