import * as THREE from 'three';
import './ui/style.css';

import { Owner, RoomType, TICK_MS } from './core/constants';
import { Creature, CreatureType, createCreature } from './core/creatures';
import { Game } from './core/game';
import { generateLevel } from './core/levelgen';
import { CameraController } from './input/cameraController';
import { HandOfEvil, Tool } from './input/hand';
import { CreatureRenderer } from './render/creatureRenderer';
import { DeviceRenderer } from './render/deviceRenderer';
import { Atmosphere } from './render/atmosphere';
import { DungeonDressing } from './render/dressing';
import { LandmarkRenderer } from './render/landmarks';
import { ImpFlow } from './render/impFlow';
import { RoomShell } from './render/roomShell';
import { SurveyView } from './render/surveyView';
import { ThreatPath } from './render/threatPath';
import { LavaGlow } from './render/lavaGlow';
import { ParticleSystem, TorchSystem } from './render/effects';
import { SceneRig, detectQuality } from './render/scene';
import { RoomPropRenderer } from './render/roomProps';
import { TerrainRenderer } from './render/terrain';
import { AudioEngine } from './audio/audio';
import { AudioDirector } from './audio/director';
import { Narrator } from './audio/narrator';
import { Hud } from './ui/hud';
import { ObjectiveCompass } from './ui/compass';
import { ObjectivePanel } from './ui/objectivePanel';
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
const roomProps = new RoomPropRenderer(game.map);
const devices = new DeviceRenderer(game.map);
const landmarks = new LandmarkRenderer(game.map);
const dressing = new DungeonDressing(game.map);
const threat = new ThreatPath(game.map, game.rooms);
const survey = new SurveyView(game.map);
const roomShell = new RoomShell(game.map);
const impFlow = new ImpFlow(game.map);
const atmosphere = new Atmosphere();
const lavaGlow = new LavaGlow(game.map);
const torches = new TorchSystem(game.map);
const particles = new ParticleSystem();

rig.scene.add(terrain.group);
rig.scene.add(creatureRenderer.group);
rig.scene.add(roomProps.group);
rig.scene.add(devices.group);
rig.scene.add(landmarks.group);
rig.scene.add(dressing.group);
rig.scene.add(threat.group);
rig.scene.add(survey.group);
rig.scene.add(roomShell.group);
rig.scene.add(impFlow.group);
rig.scene.add(atmosphere.group);
rig.scene.add(lavaGlow.group);
rig.scene.add(torches.group);
rig.scene.add(particles.points);

const audio = new AudioEngine();
const narrator = new Narrator(audio);
const director = new AudioDirector(game, audio, narrator);

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

const objectivePanel = new ObjectivePanel(uiRoot, game);
const compass = new ObjectiveCompass(uiRoot, game, rig.camera);

/* ------------------------------------------------------------ top strip -- */

const topbar = document.createElement('div');
topbar.id = 'topbar';
topbar.innerHTML = `
  <span class="title">Dungeon Keeper Reborn</span>
  <span class="spacer"></span>
  <span class="chip" id="chip-payday">Payday in <b>—</b></span>
  <span class="chip" id="chip-raid">Heroes in <b>—</b></span>
  <span class="chip" id="chip-fps"><b>—</b> fps</span>
  <button class="icon-button" id="btn-survey" title="Show or hide the dig plan (V)">Dig plan</button>
  <button class="icon-button" id="btn-sound" title="Mute or unmute all sound">Sound</button>
  <button class="icon-button" id="btn-voice" title="Silence the narrator">Narrator</button>
  <button class="icon-button" id="btn-help">Controls</button>
  <button class="icon-button" id="btn-pause">Pause</button>`;
uiRoot.appendChild(topbar);

const paydayChip = topbar.querySelector('#chip-payday b') as HTMLElement;
const raidChip = topbar.querySelector('#chip-raid') as HTMLElement;
const raidValue = raidChip.querySelector('b') as HTMLElement;
const fpsChip = topbar.querySelector('#chip-fps b') as HTMLElement;
const pauseButton = topbar.querySelector('#btn-pause') as HTMLButtonElement;
const helpButton = topbar.querySelector('#btn-help') as HTMLButtonElement;
const soundButton = topbar.querySelector('#btn-sound') as HTMLButtonElement;
const surveyButton = topbar.querySelector('#btn-survey') as HTMLButtonElement;
const voiceButton = topbar.querySelector('#btn-voice') as HTMLButtonElement;

function refreshAudioButtons(): void {
  const muted = audio.getSettings().muted;
  soundButton.textContent = muted ? 'Sound off' : 'Sound';
  soundButton.classList.toggle('is-off', muted);
  const speaking = narrator.isEnabled() && narrator.available;
  voiceButton.textContent = narrator.available
    ? (speaking ? 'Narrator' : 'Narrator off')
    : 'No voice';
  voiceButton.classList.toggle('is-off', !speaking);
  voiceButton.disabled = !narrator.available;
  voiceButton.title = narrator.available
    ? `Narrator voice: ${narrator.voiceName}`
    : 'This browser has no speech synthesis; the message log still works.';
}

soundButton.addEventListener('click', () => {
  audio.setMuted(!audio.getSettings().muted);
  if (audio.getSettings().muted) narrator.stop();
  refreshAudioButtons();
});
voiceButton.addEventListener('click', () => {
  narrator.setEnabled(!narrator.isEnabled());
  refreshAudioButtons();
});
refreshAudioButtons();

let paused = false;
function setPaused(value: boolean): void {
  paused = value;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
  // A paused dungeon should go quiet, narrator included.
  audio.setSuspended(paused);
  if (paused) narrator.stop();
}
pauseButton.addEventListener('click', () => setPaused(!paused));
helpButton.addEventListener('click', () => showBriefing(uiRoot!, () => {
  setPaused(false);
}, true));

/*
 * The dig plan is on by default.
 *
 * Every instinct says an overlay should start hidden and be opted into. That is
 * wrong here: the thing it fixes is a player looking at two hundred identical
 * blocks with no idea which one to tag, and a player in that position does not
 * know there is a button that would tell them. A feature that answers the
 * opening question of the game has to be visible when the game opens. It is one
 * key and one button away from off for anyone who would rather prospect blind.
 */
function setSurvey(on: boolean): void {
  survey.setEnabled(on);
  // The imps' traffic rides the same switch. It answers the other half of the
  // same question — the plan is where to dig, this is who is already on the way.
  impFlow.setEnabled(on);
  surveyButton.classList.toggle('is-off', !on);
  surveyButton.textContent = on ? 'Dig plan' : 'Dig plan off';
}
surveyButton.addEventListener('click', () => setSurvey(!survey.enabled));
setSurvey(true);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.code === 'Space' && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
    setPaused(!paused);
  }
  if (e.code === 'KeyV') setSurvey(!survey.enabled);
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
  rig.setFogForDistance(camera.getDistance());

  terrain.syncIfDirty();
  terrain.update(time);
  roomProps.syncIfDirty();
  roomShell.syncIfDirty();
  // Rooms show what they hold: the hoard spreads across the vault floor, and
  // every other room stocks up with whatever it is actually storing or doing.
  roomProps.setStock({
    gold: game.goldOf(Owner.Player),
    goldCap: game.treasuryCap(),
    fills: game.roomStock(Owner.Player),
  });
  roomProps.update(time);
  devices.syncIfDirty();
  devices.update(time, game.gasTiles());
  landmarks.syncIfDirty();
  dressing.syncIfDirty();
  threat.syncIfDirty();
  threat.update(time, game.waveImminence());
  if (survey.enabled) survey.syncIfDirty(game.survey());
  survey.update(time);
  // Live traffic, not a plan: rebuilt every frame off the paths the imps are
  // actually walking, so it costs nothing to keep in step with them.
  impFlow.update(game.creatures, time);
  landmarks.update(time, camera.getDistance());
  atmosphere.update(dt, camera.target, time);
  lavaGlow.syncIfDirty();
  lavaGlow.update(time, camera.target);
  torches.syncIfDirty();
  torches.update(time, camera.target);
  creatureRenderer.update(game.creatures, time, paused ? 0 : dt, rig.camera);
  particles.update(game.effects, dt);
  hand.update();

  // The cursor tells you what the next click does.
  const cursor = hand.cursorClass();
  if (canvas!.dataset.cursor !== cursor) {
    canvas!.className = cursor;
    canvas!.dataset.cursor = cursor;
  }

  if (!paused) {
    director.update(camera.target.x, camera.target.z, camera.getDistance(), dt);
  }

  hud.update();
  objectivePanel.update();
  compass.update(dt);
  hud.minimap.draw(camera.target.x, camera.target.z, camera.getYaw(), camera.getDistance());

  rosterTimer += dt;
  if (rosterTimer > 1.5) {
    rosterTimer = 0;
    hud.refreshCreatureTab();
  }

  paydayChip.textContent = hud.paydayCountdown();

  // The raid clock. It goes red as the wave lands, because that is the window in
  // which hanging a door or dropping a trap still changes the outcome.
  const raidLeft = game.secondsToNextWave();
  const mins = Math.floor(raidLeft / 60);
  raidValue.textContent = `${mins}:${String(Math.floor(raidLeft % 60)).padStart(2, '0')}`;
  raidChip.classList.toggle('urgent', raidLeft < 45);

  frameCount++;
  fpsAccumulator += dt;
  if (fpsAccumulator >= 0.5) {
    const fps = Math.round(frameCount / fpsAccumulator);
    fpsChip.textContent = String(fps);
    frameCount = 0;
    fpsAccumulator = 0;

    // Give the device a few seconds to settle before judging it, then shed
    // effects if it still cannot keep up.
    if (clock.elapsedTime > 6) {
      const change = rig.considerPerformance(fps);
      if (change) game.notify(change);
      // The air is the cheapest thing to thin out, so it goes first — before
      // bloom, before shadows, before resolution.
      atmosphere.setDensity(fps > 45 ? 1 : fps > 30 ? 0.6 : fps > 20 ? 0.3 : 0);
      dressing.setDensity(fps > 45 ? 1 : fps > 30 ? 0.7 : fps > 20 ? 0.4 : 0.2);
      lavaGlow.setBudget(fps > 40 ? 3 : fps > 25 ? 2 : 1);
      // The kerbs and posts go late: they are what makes a room read as built,
      // so they are worth more than the air or the scatter and are only shed
      // when the device is genuinely struggling.
      roomShell.setEnabled(fps > 18);
    }
  }

  if (game.status !== 'playing' && !outcomeShown) {
    outcomeShown = true;
    showOutcome(uiRoot!, game.status, () => location.reload(),
      game.objectives, game.elapsedTicks);
  }

  rig.render();

  // Straight after the render, while the frame can still be read back: does the
  // post-processing chain actually put anything on screen on this device?
  const blank = rig.selfCheck();
  if (blank) game.notify(blank);
}

// Open on the briefing, the way the original opens on its scroll. Its dismiss
// button is also where audio gets unlocked: browsers refuse to start an
// AudioContext outside a real user gesture, and this is the first one we get.
showBriefing(uiRoot, () => {
  audio.unlock();
  refreshAudioButtons();
  setPaused(false);
  director.begin();
}, false, game.objectives);
setPaused(true);
frame();
window.dispatchEvent(new Event('dk-ready'));

/* --------------------------------------------------------------- debug -- */

// Handy for poking at a running game from the console.
declare global {
  interface Window {
    dk?: {
      game: Game;
      camera: CameraController;
      rig: SceneRig;
      audio: AudioEngine;
      narrator: Narrator;
      director: AudioDirector;
      spawn?: (type: CreatureType, x: number, y: number) => Creature;
      /** The renderers, so a harness can hide the dungeon and look at one thing. */
      groups?: Record<string, THREE.Object3D>;
    };
  }
}
window.dk = { game, camera, rig, audio, narrator, director };
// Named so the model harness can strip the scene back to a plain backdrop.
// Judging a creature against a wall of glowing lava is judging the lava.
window.dk.groups = {
  terrain: terrain.group, roomProps: roomProps.group, devices: devices.group,
  landmarks: landmarks.group, dressing: dressing.group, threat: threat.group,
  survey: survey.group, roomShell: roomShell.group, impFlow: impFlow.group,
  atmosphere: atmosphere.group, lavaGlow: lavaGlow.group,
  torches: torches.group, particles: particles.points, creatures: creatureRenderer.group,
  hand: hand.group,
};
// Spawn helper, used by the creature-model screenshot harness and handy for
// poking at behaviour from the console.
window.dk.spawn = (type: CreatureType, x: number, y: number) => {
  const c = createCreature(type, Owner.Player, x, y);
  game.creatures.push(c);
  return c;
};

// Keep hot-module reloads from stacking up renderers during development.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    narrator.dispose();
    audio.dispose();
    hand.dispose();
    camera.dispose();
    hud.dispose();
    objectivePanel.dispose();
    compass.dispose();
    terrain.dispose();
    roomProps.dispose();
    devices.dispose();
    landmarks.dispose();
    dressing.dispose();
    threat.dispose();
    survey.dispose();
    roomShell.dispose();
    impFlow.dispose();
    atmosphere.dispose();
    lavaGlow.dispose();
    creatureRenderer.dispose();
    torches.dispose();
    particles.dispose();
    rig.dispose();
    topbar.remove();
  });
}

export { game, RoomType };
