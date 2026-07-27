import * as THREE from 'three';
import { Owner, ROOM_SPECS, RoomType, SPELL_SPECS, SpellType, Terrain, isSolid } from '../core/constants';
import { DoorType, TrapType } from '../core/devices';
import { Creature } from '../core/creatures';
import { Game } from '../core/game';
import { CreatureRenderer } from '../render/creatureRenderer';
import { TerrainRenderer, WALL_HEIGHT } from '../render/terrain';

/** What the player's next click will do. */
export type Tool =
  | { kind: 'hand' }
  | { kind: 'room'; room: RoomType }
  | { kind: 'spell'; spell: SpellType }
  | { kind: 'trap'; trap: TrapType }
  | { kind: 'door'; door: DoorType }
  | { kind: 'sell' };

export interface HandEvents {
  /** Fired when a tool finishes its action, so the panel can deselect. */
  onToolConsumed?: (tool: Tool) => void;
  /** Fired when the hovered creature changes, for the info panel. */
  onHoverCreature?: (creature: Creature | null) => void;
}

/**
 * The Hand of Evil.
 *
 * The original's mouse language is unusual and worth preserving exactly,
 * because it *is* the game's interface:
 *
 *   - Left button on a wall tags it for excavation. Dragging paints tags, and
 *     whether you're tagging or untagging is decided by the first tile you hit.
 *   - Left button on one of your creatures snatches it into your hand; the next
 *     left click drops it on any floor you own.
 *   - Right button slaps a creature — faster work, a little damage — and clears
 *     excavation tags off walls.
 *
 * Rooms and spells temporarily take over the left button, and hand back to the
 * default behaviour once used.
 *
 * On a touch screen there are no buttons to press, so the same three verbs are
 * mapped onto one finger: a tap is the left button, a drag paints exactly as a
 * held left button does, and a press-and-hold is the right button — the slap.
 * The moment a second finger lands the gesture is handed to the camera and
 * anything in progress here is abandoned, so a two-finger pan never leaves a
 * trail of tagged walls behind it.
 */
export class HandOfEvil {
  readonly group = new THREE.Group();

  tool: Tool = { kind: 'hand' };

  private readonly game: Game;
  private readonly camera: THREE.Camera;
  private readonly element: HTMLElement;
  private readonly terrain: TerrainRenderer;
  private readonly creatures: CreatureRenderer;
  private readonly events: HandEvents;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly planeHit = new THREE.Vector3();

  /** Tile currently under the cursor, or -1. */
  hoverTile = -1;
  hoverCreature: Creature | null = null;

  /** Drag state for tagging and for rectangular room placement. */
  private dragging = false;
  private dragButton = -1;
  private dragTagValue = true;
  private dragStartTile = -1;
  private dragMoved = false;

  private readonly hoverMesh: THREE.Mesh;
  private readonly rectMesh: THREE.Mesh;
  private readonly rectMaterial: THREE.MeshBasicMaterial;
  private readonly hoverMaterial: THREE.MeshBasicMaterial;

  /** Set while dropping is illegal, so the cursor can show it. */
  dropBlocked = false;

  /* Touch state. One finger acts; two or more belong to the camera. */
  private readonly activeTouches = new Set<number>();
  /** The finger currently driving an action, or -1. */
  private touchId = -1;
  private touchStartX = 0;
  private touchStartY = 0;
  private touchMoved = false;
  /** Set once a long press has fired, so releasing does not also act. */
  private touchHandled = false;
  /** A tap on a creature picks it up on release, not on contact. */
  private pendingPickup: Creature | null = null;
  private longPressTimer = 0;

  /** Pixels of movement before a tap becomes a drag. */
  private static readonly TAP_SLOP = 12;
  /** Milliseconds of stillness before a press becomes a slap. */
  private static readonly LONG_PRESS_MS = 450;

  constructor(
    game: Game,
    camera: THREE.Camera,
    element: HTMLElement,
    terrain: TerrainRenderer,
    creatures: CreatureRenderer,
    events: HandEvents = {},
  ) {
    this.game = game;
    this.camera = camera;
    this.element = element;
    this.terrain = terrain;
    this.creatures = creatures;
    this.events = events;

    const hoverGeo = new THREE.PlaneGeometry(1, 1);
    hoverGeo.rotateX(-Math.PI / 2);
    this.hoverMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd66a,
      transparent: true,
      opacity: 0.20,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.hoverMesh = new THREE.Mesh(hoverGeo, this.hoverMaterial);
    this.hoverMesh.renderOrder = 6;
    this.hoverMesh.visible = false;

    const rectGeo = new THREE.PlaneGeometry(1, 1);
    rectGeo.rotateX(-Math.PI / 2);
    this.rectMaterial = new THREE.MeshBasicMaterial({
      color: 0x66ff99,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.rectMesh = new THREE.Mesh(rectGeo, this.rectMaterial);
    this.rectMesh.renderOrder = 6;
    this.rectMesh.visible = false;

    this.group.add(this.hoverMesh, this.rectMesh);

    element.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
  }

  /* ------------------------------------------------------------ picking - */

  private updatePointer(e: PointerEvent): void {
    const rect = this.element.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /** Resolve what the cursor is over: a creature takes priority over terrain. */
  private pick(): void {
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const creatureHits = this.raycaster.intersectObjects(this.creatures.pickTargets(), false);
    let creature: Creature | null = null;
    let creatureDistance = Infinity;
    if (creatureHits.length > 0) {
      creature = this.creatures.creatureFromIntersection(creatureHits[0]);
      creatureDistance = creatureHits[0].distance;
    }

    const terrainHits = this.raycaster.intersectObjects(this.terrain.pickTargets(), false);
    let tile = -1;
    let terrainDistance = Infinity;
    if (terrainHits.length > 0) {
      tile = this.terrain.tileFromIntersection(terrainHits[0]);
      terrainDistance = terrainHits[0].distance;
    }

    // Fall back to the floor plane so dragging over unrendered gaps still works.
    if (tile < 0 && this.raycaster.ray.intersectPlane(this.groundPlane, this.planeHit)) {
      const x = Math.round(this.planeHit.x), y = Math.round(this.planeHit.z);
      if (this.game.map.inBounds(x, y)) tile = this.game.map.idx(x, y);
    }

    // A creature only wins if it's actually in front of the terrain.
    this.hoverCreature = creature && creatureDistance <= terrainDistance + 0.4 ? creature : null;
    this.hoverTile = tile;
  }

  /* ------------------------------------------------------------- events - */

  private onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') { this.onTouchDown(e); return; }
    if (e.button === 1) return; // middle button belongs to the camera
    this.updatePointer(e);
    this.pick();

    this.dragging = true;
    this.dragButton = e.button;
    this.dragMoved = false;
    this.dragStartTile = this.hoverTile;

    if (e.button === 0) this.onLeftDown();
    else if (e.button === 2) this.onRightDown();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') { this.onTouchMove(e); return; }
    this.updatePointer(e);
    const previousCreature = this.hoverCreature;
    this.pick();
    if (previousCreature !== this.hoverCreature) {
      this.events.onHoverCreature?.(this.hoverCreature);
    }

    if (!this.dragging) return;
    this.dragMoved = true;

    if (this.dragButton === 0) {
      if (this.tool.kind === 'hand') this.paintTag(this.dragTagValue);
      // Room and sell drags only preview while moving; they commit on release.
    } else if (this.dragButton === 2) {
      if (this.tool.kind === 'hand') this.paintTag(false);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') { this.onTouchUp(e); return; }
    if (!this.dragging || e.button === 1) return;
    this.updatePointer(e);
    this.pick();

    if (this.dragButton === 0) this.onLeftUp();
    this.dragging = false;
    this.dragButton = -1;
    this.rectMesh.visible = false;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    // Escape drops whatever tool is selected, back to the bare hand — and puts
    // back anything the hand is carrying, so a mis-grab is one key to undo.
    if (e.code === 'Escape') {
      this.tool = { kind: 'hand' };
      this.game.releaseHand();
    }
  };

  /* -------------------------------------------------------------- touch - */

  private onTouchDown(e: PointerEvent): void {
    this.activeTouches.add(e.pointerId);

    // A second finger means the player wants the camera. Abandon whatever this
    // one had started — including any tags already painted this gesture.
    if (this.activeTouches.size > 1) {
      this.cancelTouchGesture();
      return;
    }

    this.touchId = e.pointerId;
    this.touchStartX = e.clientX;
    this.touchStartY = e.clientY;
    this.touchMoved = false;
    this.touchHandled = false;
    this.pendingPickup = null;

    this.updatePointer(e);
    this.pick();
    this.events.onHoverCreature?.(this.hoverCreature);

    this.dragging = true;
    this.dragButton = 0;
    this.dragMoved = false;
    this.dragStartTile = this.hoverTile;

    // Holding something: the tap puts it down, immediately.
    if (this.game.handCreature) { this.onLeftDown(); return; }

    // On a creature, wait: a quick tap grabs it, a long press slaps it.
    if (this.hoverCreature && this.tool.kind === 'hand') {
      this.pendingPickup = this.hoverCreature;
      const victim = this.hoverCreature;
      this.longPressTimer = window.setTimeout(() => {
        this.touchHandled = true;
        this.pendingPickup = null;
        this.game.slap(victim);
      }, HandOfEvil.LONG_PRESS_MS);
      return;
    }

    // Everything else acts on contact, so painting tags feels immediate.
    this.onLeftDown();
  }

  private onTouchMove(e: PointerEvent): void {
    if (e.pointerId !== this.touchId || !this.dragging) return;

    if (!this.touchMoved) {
      const moved = Math.hypot(e.clientX - this.touchStartX, e.clientY - this.touchStartY);
      if (moved < HandOfEvil.TAP_SLOP) return;
      this.touchMoved = true;
      // Once it is a drag it is no longer a press, and no longer a tap-to-grab.
      window.clearTimeout(this.longPressTimer);
      this.pendingPickup = null;
    }

    this.updatePointer(e);
    this.pick();
    this.dragMoved = true;

    if (this.tool.kind === 'hand') this.paintTag(this.dragTagValue);
    else this.updateRectPreview();
  }

  private onTouchUp(e: PointerEvent): void {
    this.activeTouches.delete(e.pointerId);
    if (e.pointerId !== this.touchId) return;

    window.clearTimeout(this.longPressTimer);
    this.touchId = -1;

    if (this.dragging && !this.touchHandled) {
      // A tap on one of your creatures snatches it up.
      if (this.pendingPickup && !this.touchMoved) {
        this.game.pickUpCreature(this.pendingPickup);
      } else {
        this.onLeftUp();
      }
    }

    this.pendingPickup = null;
    this.dragging = false;
    this.dragButton = -1;
    this.rectMesh.visible = false;
    // Without a cursor there is no hover, so clear the highlight on release.
    this.hoverCreature = null;
    this.events.onHoverCreature?.(null);
  }

  /** Give up on the current finger — the camera has taken over. */
  private cancelTouchGesture(): void {
    window.clearTimeout(this.longPressTimer);
    this.touchId = -1;
    this.pendingPickup = null;
    this.dragging = false;
    this.dragButton = -1;
    this.touchHandled = true;
    this.rectMesh.visible = false;
    this.hoverMesh.visible = false;
  }

  /* -------------------------------------------------------- left button - */

  private onLeftDown(): void {
    const game = this.game;

    // Holding something? The click puts it down.
    if (game.handCreature) {
      const tile = this.hoverTile;
      if (tile >= 0) {
        const x = game.map.xOf(tile), y = game.map.yOf(tile);
        if (!game.dropAt(x, y)) this.flashBlocked();
      }
      return;
    }

    switch (this.tool.kind) {
      case 'spell': {
        const tile = this.hoverTile;
        if (tile < 0) return;
        const spell = this.tool.spell;
        const ok = game.cast(spell, game.map.xOf(tile), game.map.yOf(tile));
        if (ok && spell !== SpellType.CreateImp) {
          // Most spells are one-shot; Create Imp stays armed for rapid summoning.
          const consumed = this.tool;
          this.tool = { kind: 'hand' };
          this.events.onToolConsumed?.(consumed);
        }
        return;
      }

      case 'trap':
      case 'door': {
        const tile = this.hoverTile;
        if (tile < 0) return;
        const tx = game.map.xOf(tile), ty = game.map.yOf(tile);
        const placed = this.tool.kind === 'trap'
          ? game.placeTrap(this.tool.trap, tx, ty)
          : game.placeDoor(this.tool.door, tx, ty);
        if (!placed) { this.flashBlocked(); return; }
        // Keep the tool armed while stock lasts, so a corridor can be lined.
        const left = this.tool.kind === 'trap'
          ? game.stockOfTrap(this.tool.trap) : game.stockOfDoor(this.tool.door);
        if (left <= 0) {
          const consumed = this.tool;
          this.tool = { kind: 'hand' };
          this.events.onToolConsumed?.(consumed);
        }
        return;
      }

      case 'room':
      case 'sell':
        // Rectangle tools preview during the drag and commit on release.
        this.updateRectPreview();
        return;

      case 'hand':
      default:
        break;
    }

    // Bare hand: grab a creature, or start tagging a wall.
    if (this.hoverCreature && game.pickUpCreature(this.hoverCreature)) return;

    const tile = this.hoverTile;
    if (tile < 0) return;
    const x = game.map.xOf(tile), y = game.map.yOf(tile);
    if (isSolid(game.map.terrainAt(x, y))) {
      // The first tile decides whether this drag tags or untags.
      this.dragTagValue = !game.map.isMarked(x, y);
      this.paintTag(this.dragTagValue);
    }
  }

  private onLeftUp(): void {
    if (this.tool.kind === 'room') {
      const rect = this.currentRect();
      if (rect) {
        this.game.build(this.tool.room, rect.x0, rect.y0, rect.x1, rect.y1);
      }
      return;
    }
    if (this.tool.kind === 'sell') {
      const rect = this.currentRect();
      if (rect) {
        for (let y = rect.y0; y <= rect.y1; y++) {
          for (let x = rect.x0; x <= rect.x1; x++) this.game.sell(x, y);
        }
      }
      return;
    }
    // A click that never moved and never grabbed anything is just a click.
    void this.dragMoved;
  }

  /* ------------------------------------------------------- right button - */

  private onRightDown(): void {
    const game = this.game;

    // A slap is the keeper's whip: it hurts, but it gets results.
    if (this.hoverCreature) {
      game.slap(this.hoverCreature);
      return;
    }
    // On a wall, the right button clears excavation tags.
    const tile = this.hoverTile;
    if (tile < 0) return;
    const x = game.map.xOf(tile), y = game.map.yOf(tile);
    if (isSolid(game.map.terrainAt(x, y))) {
      this.dragTagValue = false;
      this.paintTag(false);
    }
  }

  /* -------------------------------------------------------- tag painting */

  private paintTag(on: boolean): void {
    const tile = this.hoverTile;
    if (tile < 0) return;
    const x = this.game.map.xOf(tile), y = this.game.map.yOf(tile);
    this.game.markTile(x, y, on);
  }

  /* ------------------------------------------------------ rect preview -- */

  /** The tile rectangle currently being dragged, clamped to the map. */
  private currentRect(): { x0: number; y0: number; x1: number; y1: number } | null {
    if (this.dragStartTile < 0 || this.hoverTile < 0) return null;
    const map = this.game.map;
    const ax = map.xOf(this.dragStartTile), ay = map.yOf(this.dragStartTile);
    const bx = map.xOf(this.hoverTile), by = map.yOf(this.hoverTile);
    return {
      x0: Math.min(ax, bx), y0: Math.min(ay, by),
      x1: Math.max(ax, bx), y1: Math.max(ay, by),
    };
  }

  private updateRectPreview(): void {
    const rect = this.currentRect();
    if (!rect) { this.rectMesh.visible = false; return; }
    const w = rect.x1 - rect.x0 + 1;
    const h = rect.y1 - rect.y0 + 1;
    this.rectMesh.position.set((rect.x0 + rect.x1) / 2, 0.035, (rect.y0 + rect.y1) / 2);
    this.rectMesh.scale.set(w, 1, h);
    this.rectMesh.visible = true;

    // Colour the preview by affordability, so you know before you commit.
    if (this.tool.kind === 'room') {
      const cost = ROOM_SPECS[this.tool.room].cost * this.countBuildable(rect);
      const affordable = cost <= this.game.goldOf(Owner.Player);
      this.rectMaterial.color.setHex(affordable ? 0x66ff99 : 0xff5544);
    } else {
      this.rectMaterial.color.setHex(0xffaa33);
    }
  }

  /** How many tiles in a rectangle could actually take a room. */
  private countBuildable(rect: { x0: number; y0: number; x1: number; y1: number }): number {
    const map = this.game.map;
    let n = 0;
    for (let y = rect.y0; y <= rect.y1; y++) {
      for (let x = rect.x0; x <= rect.x1; x++) {
        if (!map.inBounds(x, y)) continue;
        const i = map.idx(x, y);
        if (map.terrain[i] === Terrain.Claimed && map.owner[i] === Owner.Player
          && map.room[i] === RoomType.None) n++;
      }
    }
    return n;
  }

  private flashBlocked(): void {
    this.dropBlocked = true;
    window.setTimeout(() => { this.dropBlocked = false; }, 220);
  }

  /* ------------------------------------------------------------ update -- */

  update(): void {
    const game = this.game;

    // Keep the rectangle preview live while a room drag is in progress.
    if (this.dragging && this.dragButton === 0
      && (this.tool.kind === 'room' || this.tool.kind === 'sell')) {
      this.updateRectPreview();
    }

    const tile = this.hoverTile;
    if (tile < 0) {
      this.hoverMesh.visible = false;
      return;
    }
    const x = game.map.xOf(tile), y = game.map.yOf(tile);
    const solid = isSolid(game.map.terrainAt(x, y));
    this.hoverMesh.position.set(x, solid ? WALL_HEIGHT + 0.03 : 0.03, y);
    this.hoverMesh.visible = !(this.dragging && this.tool.kind !== 'hand');

    // The highlight colour tells you what the click will do.
    if (game.handCreature) {
      const legal = game.map.isWalkableAt(x, y) && game.map.ownerAt(x, y) === Owner.Player;
      this.hoverMaterial.color.setHex(legal ? 0x66ff99 : 0xff4433);
    } else if (this.tool.kind === 'spell') {
      this.hoverMaterial.color.setHex(SPELL_SPECS[this.tool.spell].color);
    } else if (this.hoverCreature) {
      this.hoverMaterial.color.setHex(0xff88cc);
    } else if (solid) {
      this.hoverMaterial.color.setHex(game.map.isMarked(x, y) ? 0xffa040 : 0xffd66a);
    } else {
      this.hoverMaterial.color.setHex(0x88aaff);
    }
  }

  /** The CSS cursor class the page should be wearing right now. */
  cursorClass(): string {
    if (this.dropBlocked) return 'cursor-denied';
    if (this.game.handCreature) return 'cursor-holding';
    if (this.tool.kind === 'spell') return 'cursor-spell';
    if (this.tool.kind === 'room') return 'cursor-build';
    if (this.tool.kind === 'sell') return 'cursor-sell';
    if (this.tool.kind === 'trap' || this.tool.kind === 'door') return 'cursor-build';
    if (this.hoverCreature) return 'cursor-grab';
    return 'cursor-hand';
  }

  dispose(): void {
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    this.hoverMesh.geometry.dispose();
    this.rectMesh.geometry.dispose();
    this.hoverMaterial.dispose();
    this.rectMaterial.dispose();
  }
}
