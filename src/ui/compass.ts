import * as THREE from 'three';
import { OWNER_COLORS, Owner, RoomType } from '../core/constants';
import { Game } from '../core/game';
import { heartTile } from '../core/rooms';

/**
 * Which way to dig.
 *
 * A generated realm hands you a heart, a portal and a wall of rock in every
 * direction, and an objective that says "destroy the rival keeper's Dungeon
 * Heart" without saying where he is. There is no answer to that but to tag rock
 * at random and hope, which is not exploration, it is a coin toss with a five
 * minute wait attached — and the level's whole shape, the thing a generator is
 * supposed to be producing, stays invisible.
 *
 * So the things a level is *about* get a marker at the edge of the screen,
 * pointing at them, with the distance in tiles. A rival keeper's heart in his
 * colour, the hero gate the raids come out of, and the same gate again as the
 * road the Lord of the Land will walk in on.
 *
 * ## They show before you have found them, and that is the point
 *
 * The obvious objection is that this gives the map away. It does not: it gives
 * the *bearing* away, and nothing else — no route, no layout, no idea what is
 * between you and it. Knowing the rival is somewhere north-east is the difference
 * between digging with a plan and digging in a random direction, and the plan is
 * the interesting part. What you do not get is any help executing it, which is
 * where gold, seams, lava and the rival's own imps are waiting.
 */

interface Target {
  key: string;
  tile: number;
  label: string;
  colour: number;
}

/** Where a marker sits, as a fraction of the play area, at its furthest. */
const EDGE = 0.92;

export class ObjectiveCompass {
  private readonly game: Game;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly root: HTMLElement;
  private readonly markers = new Map<string, HTMLElement>();
  private readonly probe = new THREE.Vector3();
  private throttle = 0;

  constructor(container: HTMLElement, game: Game, camera: THREE.PerspectiveCamera) {
    this.game = game;
    this.camera = camera;
    this.root = document.createElement('div');
    this.root.id = 'compass';
    container.appendChild(this.root);
  }

  /** What this level is about, in map terms. */
  private targets(): Target[] {
    const { game } = this;
    const out: Target[] = [];

    for (const owner of [Owner.KeeperBlue, Owner.KeeperGreen]) {
      if (!game.keeperAlive(owner)) continue;
      const tile = heartTile(game.map, game.rooms, owner);
      if (tile < 0) continue;
      out.push({
        key: `keeper-${owner}`, tile, label: 'Rival Keeper', colour: OWNER_COLORS[owner],
      });
    }

    // One marker for the hero gate, whichever tile of it is nearest — it is a
    // door, not nine doors, and the raid and the Lord both come through it.
    const gates = game.rooms.tilesOf(game.map, Owner.Heroes, RoomType.Portal);
    if (gates.length > 0) {
      const view = game.startView();
      let best = gates[0], bestD = Infinity;
      for (const t of gates) {
        const d = (game.map.xOf(t) - view.x) ** 2 + (game.map.yOf(t) - view.y) ** 2;
        if (d < bestD) { bestD = d; best = t; }
      }
      out.push({ key: 'heroes', tile: best, label: 'Hero Gate', colour: 0xbcd8ff });
    }
    return out;
  }

  /** Called every frame; does real work a few times a second. */
  update(dt: number): void {
    this.throttle -= dt;
    if (this.throttle > 0) return;
    this.throttle = 0.12;

    const { game, camera } = this;
    const box = this.root.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) return;

    const live = new Set<string>();
    for (const target of this.targets()) {
      live.add(target.key);
      const tx = game.map.xOf(target.tile), ty = game.map.yOf(target.tile);
      this.probe.set(tx, 0.8, ty).project(camera);

      // Behind the camera projects to the opposite side of the screen, which puts
      // the marker exactly where the thing is not. Flip it back.
      const behind = this.probe.z > 1;
      let nx = behind ? -this.probe.x : this.probe.x;
      let ny = behind ? -this.probe.y : this.probe.y;

      const reach = Math.max(Math.abs(nx), Math.abs(ny));
      const onScreen = !behind && reach <= EDGE;
      if (reach > EDGE) {
        nx = (nx / reach) * EDGE;
        ny = (ny / reach) * EDGE;
      }

      const el = this.markerFor(target);
      el.style.left = `${(nx * 0.5 + 0.5) * box.width}px`;
      el.style.top = `${(-ny * 0.5 + 0.5) * box.height}px`;
      el.classList.toggle('on-screen', onScreen);

      // The arrow points from the middle of the view outward at the target, which
      // is the direction you would set off in.
      const arrow = el.querySelector('.arrow') as HTMLElement;
      arrow.style.transform = `rotate(${Math.atan2(nx, ny) * 180 / Math.PI}deg)`;

      const focus = game.startView();
      const away = Math.round(Math.hypot(tx - focus.x, ty - focus.y));
      (el.querySelector('.dist') as HTMLElement).textContent = `${away}`;
    }

    for (const [key, el] of this.markers) {
      if (live.has(key)) continue;
      el.remove();
      this.markers.delete(key);
    }
  }

  private markerFor(target: Target): HTMLElement {
    let el = this.markers.get(target.key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'compass-mark';
      el.innerHTML = '<span class="arrow">▲</span>'
        + `<span class="label">${target.label}</span><span class="dist"></span>`;
      const hex = `#${target.colour.toString(16).padStart(6, '0')}`;
      el.style.setProperty('--mark', hex);
      this.root.appendChild(el);
      this.markers.set(target.key, el);
    }
    return el;
  }

  dispose(): void {
    this.root.remove();
  }
}
