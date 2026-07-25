import { NarrationCue } from '../core/game';
import { AudioEngine } from './audio';

/**
 * The narrator.
 *
 * The original's voice is a performance by a specific actor and is not
 * something that can — or should — be reproduced here. What *can* be
 * reproduced is the role it played: a dry, faintly contemptuous presence that
 * comments on your dungeon and is never quite on your side.
 *
 * So the delivery goes through the platform's own speech synthesiser, pitched
 * well down and slowed, with a deep English voice preferred where one exists.
 * The writing is original. It will not sound like Richard Ridings; it will
 * sound like something that lives under a mountain and is unimpressed by you,
 * which is the part that actually matters in play.
 *
 * Everything degrades quietly: no speech synthesis, no voices, or a user who
 * has turned it off, and the game simply relies on its printed messages.
 */

interface QueuedLine {
  text: string;
  /** Higher wins. A low-priority quip never interrupts a real announcement. */
  priority: number;
}

/** Voice names that tend to be deep and English, in rough order of preference. */
const PREFERRED_VOICES = [
  'Google UK English Male',
  'Microsoft George',
  'Microsoft Ryan',
  'Daniel',
  'Arthur',
  'Oliver',
  'Alex',
  'Fred',
  'Rishi',
  'Microsoft David',
  'Google US English',
];

/**
 * What the narrator says, per cue.
 *
 * All original writing. Several variants each so a long game does not turn
 * into the same sentence on a loop.
 */
const LINES: Record<NarrationCue, string[]> = {
  'level-start': [
    'Your dungeon heart is beating. Try not to embarrass it.',
    'Fresh rock. Fresh ambition. Start digging.',
    'A new realm, and it is entirely too peaceful. See to that.',
  ],
  'creature-joined': [
    'Something has crawled in through your portal.',
    'A new arrival. It has not learned to fear you yet.',
    'You have a visitor. It expects to be fed.',
  ],
  'creature-left': [
    'One of your creatures has walked out. You did that.',
    'It has gone. Neither of you will miss the other.',
    'Another one leaves. Word will get around.',
  ],
  'creature-died': [
    'One of yours is dead. There will be others. Probably.',
    'That one will not be reporting for work.',
    'A death in the dungeon. How atmospheric.',
  ],
  'creature-levelled': [
    'One of your creatures has improved itself. Do keep up.',
    'That one is stronger now. It has noticed.',
  ],
  payday: [
    'Payday. Your creatures are briefly tolerable.',
    'Wages paid. Morale is now merely awful.',
  ],
  'payday-broke': [
    'You cannot pay them. They have noticed.',
    'No wages. Your creatures are drawing conclusions.',
  ],
  'treasury-full': [
    'Your treasury is full. Gold is going to waste. Build.',
    'There is nowhere left to put the gold. Think about that.',
  ],
  heroes: [
    'Heroes. They have come to be reasonable at you. Kill them.',
    'The forces of good are here, radiating virtue. Stop them.',
    'Visitors from the surface. They will not be staying.',
  ],
  victory: [
    'The realm is yours. Enjoy it. Briefly.',
    'The heroes are broken and the land is yours. Well. Finally.',
  ],
  defeat: [
    'Your heart is broken. Somewhere a knight is being given a medal.',
    'It is over. The surface will be insufferable about this.',
  ],
  'no-mana': [
    'You have no mana. Wanting a thing is not the same as having it.',
    'Not enough mana. Patience, keeper.',
  ],
  'bad-placement': [
    'Not there.',
    'That will not work, and you knew it.',
  ],
  manufactured: [
    'Your workshop has finished something unpleasant.',
    'A new device, fresh from the workshop. Do put it somewhere useful.',
  ],
  'trap-fired': [
    'A trap has gone off. Somebody is having a worse day than you.',
    'Your trap worked. Try to look surprised.',
  ],
  'door-broken': [
    'They have broken through a door. That was what it was for.',
    'A door has fallen. They are inside.',
  ],
};

/** Cues that must never be dropped, however busy the narrator is. */
const HIGH_PRIORITY: ReadonlySet<NarrationCue> = new Set<NarrationCue>([
  'level-start', 'victory', 'defeat', 'heroes', 'payday-broke', 'door-broken',
]);

/** Minimum gap between repeats of the same cue, in milliseconds. */
const CUE_COOLDOWN: Partial<Record<NarrationCue, number>> = {
  'creature-joined': 25000,
  'creature-died': 20000,
  'creature-levelled': 30000,
  'bad-placement': 12000,
  'no-mana': 15000,
  'treasury-full': 40000,
  'creature-left': 20000,
  manufactured: 20000,
  'trap-fired': 18000,
  'door-broken': 15000,
};
const DEFAULT_COOLDOWN = 8000;

export class Narrator {
  private readonly audio: AudioEngine;
  private synth: SpeechSynthesis | null = null;
  private voice: SpeechSynthesisVoice | null = null;

  private queue: QueuedLine[] = [];
  private speaking = false;
  private enabled = true;

  /** Last time each cue fired, and which variant it used. */
  private readonly lastSpoken = new Map<NarrationCue, number>();
  private readonly lastVariant = new Map<NarrationCue, number>();

  /** Guards against a synthesiser that starts a line and never finishes it. */
  private watchdog = 0;

  constructor(audio: AudioEngine) {
    this.audio = audio;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    this.synth = window.speechSynthesis;
    this.pickVoice();
    // Chrome populates the voice list asynchronously.
    this.synth.addEventListener?.('voiceschanged', this.pickVoice);
  }

  get available(): boolean {
    return this.synth !== null;
  }

  /** The voice actually in use, for the settings panel to show. */
  get voiceName(): string {
    return this.voice?.name ?? 'system default';
  }

  private pickVoice = (): void => {
    if (!this.synth) return;
    const voices = this.synth.getVoices();
    if (voices.length === 0) return;

    const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
    const pool = english.length > 0 ? english : voices;

    for (const wanted of PREFERRED_VOICES) {
      const found = pool.find((v) => v.name.includes(wanted));
      if (found) { this.voice = found; return; }
    }
    // Nothing recognised: anything explicitly male beats the default.
    const male = pool.find((v) => /male|george|daniel|james|david|arthur/i.test(v.name));
    this.voice = male ?? pool[0] ?? null;
  };

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Queue the line for a game cue. Returns false if it was suppressed. */
  say(cue: NarrationCue): boolean {
    if (!this.enabled || !this.synth) return false;

    const now = Date.now();
    const last = this.lastSpoken.get(cue) ?? -Infinity;
    const cooldown = CUE_COOLDOWN[cue] ?? DEFAULT_COOLDOWN;
    if (now - last < cooldown) return false;

    const variants = LINES[cue];
    if (!variants || variants.length === 0) return false;

    // Pick a variant, avoiding the one used last time for this cue.
    let index = Math.floor(Math.random() * variants.length);
    if (variants.length > 1 && index === this.lastVariant.get(cue)) {
      index = (index + 1) % variants.length;
    }
    this.lastVariant.set(cue, index);
    this.lastSpoken.set(cue, now);

    this.enqueue(variants[index], HIGH_PRIORITY.has(cue) ? 2 : 1);
    return true;
  }

  /** Speak an arbitrary line — used by the briefing. */
  speak(text: string, priority = 2): void {
    if (!this.enabled || !this.synth) return;
    this.enqueue(text, priority);
  }

  private enqueue(text: string, priority: number): void {
    // A low-priority quip arriving during a real announcement is just dropped:
    // a narrator with a backlog stops feeling like a narrator.
    if (this.speaking && priority < 2) return;
    if (this.queue.length > 3) this.queue.length = 3;
    this.queue.push({ text, priority });
    this.queue.sort((a, b) => b.priority - a.priority);
    if (!this.speaking) this.drain();
  }

  private drain(): void {
    if (!this.synth || this.speaking) return;
    const line = this.queue.shift();
    if (!line) {
      this.audio.setDuck(1, 0.4);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(line.text);
    if (this.voice) utterance.voice = this.voice;
    // Deep and unhurried. Most synthesisers clamp pitch at 0, and going too
    // low turns to mud, so this is about as far down as stays intelligible.
    utterance.pitch = 0.45;
    utterance.rate = 0.88;
    utterance.volume = this.audio.getSettings().narrator;

    this.speaking = true;
    this.audio.setDuck(0.35, 0.18);

    const finish = (): void => {
      window.clearTimeout(this.watchdog);
      if (!this.speaking) return;
      this.speaking = false;
      // Small gap before the next line, so it does not sound like a list.
      window.setTimeout(() => this.drain(), 260);
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    // Some engines silently drop an utterance; don't get stuck ducked forever.
    const estimate = 1500 + line.text.length * 90;
    this.watchdog = window.setTimeout(finish, estimate);

    try {
      this.synth.speak(utterance);
    } catch {
      finish();
    }
  }

  /** Cut the narrator off — pausing, muting, or leaving the level. */
  stop(): void {
    window.clearTimeout(this.watchdog);
    this.queue.length = 0;
    this.speaking = false;
    try {
      this.synth?.cancel();
    } catch {
      // Cancelling an idle synthesiser throws on some engines. Harmless.
    }
    this.audio.setDuck(1, 0.2);
  }

  dispose(): void {
    this.stop();
    this.synth?.removeEventListener?.('voiceschanged', this.pickVoice);
  }
}
