import * as THREE from 'three';
import './ui/style.css';

import { Owner, RoomType, TICK_MS } from './core/constants';
import { CreatureType } from './core/creatures';
import { Game } from './core/game';
import { generateLevel } from './core/levelgen';
import { CameraController } from './input/cameraController';
import { HandOfEvil, Tool } from './input/hand';
import { CreatureRenderer } from './render/creatureRenderer';
import { ParticleSystem, TorchSystem } from './render/effects';
import { SceneRig, detectQuality } from './render/scene';
import { TerrainRenderer } from './render/terrain';
import { Hud } from './ui/hud';
import { showBriefing, showOutcome } from './ui/overlay';

/**
 * Boots the game and owns the frame loop.
 *
 * Simulation runs on a fixed 20Hz step so behaviour is identical regardless of
 * frame rate, with rendering interpolating on top at whatever the display can
 * manage. That split is what keeps a phone at 30fps and a desktop at 144fps
 * playing exactly the same game.
 */

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
const uiRoot = document.getElementById('ui-root');
if (!canvas || !uiRoot) throw new Error('page scaffolding missing');

const seedParam = new URLSearchParams(location.search).get('seed');
const seed = seedParam ? Number(seedParam) || 1997 : 1997;

const game: Game = generateLevel({ seed });

const rig = new SceneRig(canvas, detectQuality());
const terrain = new TerrainRenderer(game.map);
const creatureRenderer = new CreatureRenderer();
const torches = new TorchSystem(game.map);
const particles = new ParticleSystem();

rig.scene.add(terrain.group);
rig.scene.add(creatureRenderer.group);
rig.scene.add(torches.group);
rig.scene.add(particles.points);

const camera = new CameraController(rig.camera, canvas, game.map.width, game.map.height);
const start = game.startView();
camera.snapTo(start.x, start.y);

let hud: Hud;

const hand = new HandOfEvil(game, rig.camera, canvas, terrain, creatureRenderer, {
  onToolConsumed: () => hud.setTool({ kind: 'hand' }),
  onHoverCreature: (creature) => hud.setHoveredCreature(creature),
});
rig.scene.add(hand.group);

hud = new Hud(uiRoot, game, {
  onToolChange: (tool: Tool) => { hand.tool = tool; },
  onNavigate: (x, y) => camera.panTo(x, y),
  onPickCreatureType: (type: CreatureType) => {
    // Mirror the original's roster click: grab the next idle one of that type
    // and bring the view to where it was standing.
    const candidate = game.creatures.find(
      (c) => c.owner === Owner.Player && c.type === type && !c.inHand,
    );
    if (!candidate) return;
    camera.panTo(candidate.x, candidate.y);
    game.pickUpCreature(candidate);
  },
});

/* ------------------------------------------------------------ top strip -- */

const topbar = document.createElement('div');
topbar.id = 'topbar';
topbar.innerHTML = `
  <span class="title">Dungeon Keeper Reborn</span>
  <span class="spacer"></span>
  <span class="chip" id="chip-payday">Payday in <b>—</b></span>
  <span class="chip" id="chip-fps"><b>—</b> fps</span>
  <button class="icon-button" id="btn-help">Controls</button>
  <button class="icon-button" id="btn-pause">Pause</button>`;
uiRoot.appendChild(topbar);

const paydayChip = topbar.querySelector('#chip-payday b') as HTMLElement;
const fpsChip = topbar.querySelector('#chip-fps b') as HTMLElement;
const pauseButton = topbar.querySelector('#btn-pause') as HTMLButtonElement;
const helpButton = topbar.querySelector('#btn-help') as HTMLButtonElement;

let paused = false;
function setPaused(value: boolean): void {
  paused = value;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
}
pauseButton.addEventListener('click', () => setPaused(!paused));
helpButton.addEventListener('click', () => showBriefing(uiRoot!, () => setPaused(false), true));

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
    setPaused(!paused);
  }
});

/* ------------------------------------------------------------ the loop -- */

const clock = new THREE.Clock();
let simAccumulator = 0;
let fpsAccumulator = 0;
let frameCount = 0;
let outcomeShown = false;

/** Keep creature-roster rebuilds off the per-frame path. */
let rosterTimer = 0;

function frame(): void {
  requestAnimationFrame(frame);

  // Clamp dt so a backgrounded tab doesn't try to catch up on ten minutes.
  const dt = Math.min(clock.getDelta(), 0.1);
  const time = clock.elapsedTime;

  if (!paused && game.status === 'playing') {
    simAccumulator += dt * 1000;
    // Cap the catch-up work per frame; better to run slow than to freeze.
    let steps = 0;
    while (simAccumulator >= TICK_MS && steps < 6) {
      game.tick();
      simAccumulator -= TICK_MS;
      steps++;
    }
    if (steps === 6) simAccumulator = 0;
  }

  camera.update(dt);
  rig.followTarget(camera.target);

  terrain.syncIfDirty();
  terrain.update(time);
  torches.syncIfDirty();
  torches.update(time, camera.target);
  creatureRenderer.update(game.creatures, time, paused ? 0 : dt);
  particles.update(game.effects, dt);
  hand.update();

  // The cursor tells you what the next click does.
  const cursor = hand.cursorClass();
  if (canvas!.dataset.cursor !== cursor) {
    canvas!.className = cursor;
    canvas!.dataset.cursor = cursor;
  }

  hud.update();
  hud.minimap.draw(camera.target.x, camera.target.z, camera.getYaw(), camera.getDistance());

  rosterTimer += dt;
  if (rosterTimer > 1.5) {
    rosterTimer = 0;
    hud.refreshCreatureTab();
  }

  paydayChip.textContent = hud.paydayCountdown();

  frameCount++;
  fpsAccumulator += dt;
  if (fpsAccumulator >= 0.5) {
    fpsChip.textContent = String(Math.round(frameCount / fpsAccumulator));
    frameCount = 0;
    fpsAccumulator = 0;
  }

  if (game.status !== 'playing' && !outcomeShown) {
    outcomeShown = true;
    showOutcome(uiRoot!, game.status, () => location.reload());
  }

  rig.render();
}

// Open on the briefing, the way the original opens on its scroll.
showBriefing(uiRoot, () => setPaused(false), false);
setPaused(true);
frame();
window.dispatchEvent(new Event('dk-ready'));

/* --------------------------------------------------------------- debug -- */

// Handy for poking at a running game from the console.
declare global {
  interface Window {
    dk?: { game: Game; camera: CameraController; rig: SceneRig };
  }
}
window.dk = { game, camera, rig };

// Keep hot-module reloads from stacking up renderers during development.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    hand.dispose();
    camera.dispose();
    hud.dispose();
    terrain.dispose();
    creatureRenderer.dispose();
    torches.dispose();
    particles.dispose();
    rig.dispose();
    topbar.remove();
  });
}

export { game, RoomType };
