import { Owner, RoomType } from '../core/constants';
import { Game } from '../core/game';
import { AudioEngine } from './audio';
import { Narrator } from './narrator';

/**
 * Turns what the game is doing into what the game sounds like.
 *
 * Two problems this exists to solve. First, a dozen imps digging produce a dig
 * event several times a second each; played straight, that is a wall of noise
 * rather than a dungeon at work, so each kind of sound gets a minimum spacing
 * and the whole mix a per-frame cap. Second, the narrator needs to be told what
 * happened rather than made to read the message log, which is why game
 * notifications carry a cue.
 */

/** Minimum milliseconds between two sounds of the same kind. */
const THROTTLE: Record<string, number> = {
  dig: 110,
  claim: 260,
  gold: 180,
  hit: 90,
  train: 220,
  eat: 400,
  sleep: 1800,
  research: 900,
  levelup: 400,
  poof: 200,
  build: 150,
  drop: 80,
  grab: 80,
  slap: 60,
  heal: 300,
  lightning: 200,
  haste: 300,
  rally: 400,
};
const DEFAULT_THROTTLE = 120;

/** Never start more than this many one-shots in a single frame. */
const MAX_VOICES_PER_FRAME = 5;

export class AudioDirector {
  private readonly game: Game;
  private readonly audio: AudioEngine;
  private readonly narrator: Narrator;

  private lastEffectSeq = 0;
  private lastMessageCount = 0;
  private readonly lastPlayed = new Map<string, number>();

  constructor(game: Game, audio: AudioEngine, narrator: Narrator) {
    this.game = game;
    this.audio = audio;
    this.narrator = narrator;
    // Anything already in the log at construction is history, not news.
    this.lastMessageCount = game.messages.length;
  }

  /** Speak the opening line once the player has dismissed the briefing. */
  begin(): void {
    this.narrator.say('level-start');
  }

  update(cameraX: number, cameraY: number, cameraDistance: number, dt: number): void {
    this.audio.update(dt, cameraX, cameraY, cameraDistance);
    this.playEffects();
    this.narrateMessages();
    this.updateTension();
  }

  /* ------------------------------------------------------------ effects -- */

  private playEffects(): void {
    const now = performance.now();
    let voices = 0;

    for (const e of this.game.effects) {
      if (e.seq <= this.lastEffectSeq) continue;
      if (e.seq > this.lastEffectSeq) this.lastEffectSeq = e.seq;
      if (voices >= MAX_VOICES_PER_FRAME) continue;

      const gap = THROTTLE[e.kind] ?? DEFAULT_THROTTLE;
      const last = this.lastPlayed.get(e.kind) ?? -Infinity;
      if (now - last < gap) continue;

      this.lastPlayed.set(e.kind, now);
      this.audio.play(e.kind, e.x, e.y);
      voices++;
    }
  }

  /* ---------------------------------------------------------- narration -- */

  private narrateMessages(): void {
    const messages = this.game.messages;
    if (messages.length === this.lastMessageCount) return;

    // The log is capped and shifts from the front, so compare against its
    // length rather than holding an index into it.
    const fresh = messages.slice(Math.max(0, this.lastMessageCount));
    this.lastMessageCount = messages.length;

    for (const message of fresh) {
      if (message.cue) this.narrator.say(message.cue);
    }
  }

  /* ------------------------------------------------------------ tension -- */

  /**
   * The heartbeat quickens when hostiles are close to the heart. It is the
   * cheapest possible warning system and the player feels it before they read
   * anything.
   */
  private updateTension(): void {
    if (this.game.tickCount % 10 !== 0) return;

    const heartTiles = this.game.rooms.tilesOf(
      this.game.map, Owner.Player, RoomType.DungeonHeart,
    );
    if (heartTiles.length === 0) { this.audio.setTension(1); return; }

    const heart = heartTiles[0];
    const hx = this.game.map.xOf(heart);
    const hy = this.game.map.yOf(heart);

    let nearest = Infinity;
    for (const c of this.game.creatures) {
      if (c.owner === Owner.Player || c.owner === Owner.None) continue;
      const d = Math.hypot(c.x - hx, c.y - hy);
      if (d < nearest) nearest = d;
    }
    // Full tension when something hostile is on top of the heart, none at 30
    // tiles out or with the map clear.
    const tension = nearest === Infinity ? 0 : Math.max(0, 1 - nearest / 30);
    this.audio.setTension(tension);
  }

  /** Start a fresh level: forget everything we have already reacted to. */
  reset(): void {
    this.lastEffectSeq = 0;
    this.lastMessageCount = this.game.messages.length;
    this.lastPlayed.clear();
  }
}
