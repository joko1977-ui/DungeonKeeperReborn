import {
  envelope,
  isWebKit,
  makeBrownNoise,
  makeCaveImpulse,
  makeWhiteNoise,
  midiToFreq,
} from './synth';

/**
 * The dungeon's soundscape.
 *
 * Three layers, all synthesised:
 *
 *  - **Ambience** — a low drone, cave rumble, water drips and torch crackle.
 *    Continuous, and the thing that makes an empty corridor feel underground.
 *  - **Score** — slow minor-key pads that drift between chords, with a heartbeat
 *    under them. Deliberately sparse; it should sit beneath the game, not on it.
 *  - **Effects** — one-shot hits fired from game events, panned and attenuated
 *    by where they happened relative to the camera.
 *
 * Browsers will not let audio start without a gesture, so nothing is built
 * until `unlock()` is called from a real click.
 */

export interface AudioSettings {
  master: number;
  ambience: number;
  score: number;
  effects: number;
  narrator: number;
  muted: boolean;
}

const DEFAULT_SETTINGS: AudioSettings = {
  master: 0.85,
  ambience: 0.55,
  score: 0.35,
  effects: 0.7,
  narrator: 1.0,
  muted: false,
};

const STORAGE_KEY = 'dk-reborn-audio';

/** How each game event sounds. */
type EffectKind =
  | 'dig' | 'claim' | 'gold' | 'poof' | 'hit' | 'slap' | 'heal' | 'lightning'
  | 'haste' | 'rally' | 'levelup' | 'build' | 'drop' | 'grab' | 'eat'
  | 'sleep' | 'train' | 'research';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private settings: AudioSettings;

  /* Bus graph: sources -> bus gain -> master -> limiter -> out. */
  private master!: GainNode;
  private ambienceBus!: GainNode;
  private scoreBus!: GainNode;
  private effectsBus!: GainNode;
  private reverbSend!: GainNode;
  /** Pulled down while the narrator speaks so the voice stays intelligible. */
  private duck!: GainNode;

  private noiseWhite!: AudioBuffer;
  private noiseBrown!: AudioBuffer;

  private started = false;
  private suspended = false;
  /** Extra headroom on platforms whose limiter we deliberately under-drive. */
  private masterTrim = 1;

  /** Where the camera is looking, for panning effects. */
  private listenerX = 0;
  private listenerY = 0;
  private listenerScale = 18;

  /** Scheduling state for the sparse ambience and score. */
  private nextDrip = 0;
  private nextChord = 0;
  private nextHeartbeat = 0;
  private chordIndex = 0;
  private heartbeatRate = 1.9;

  constructor() {
    this.settings = AudioEngine.load();
  }

  private static load(): AudioSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      // Private browsing and similar: fall back to defaults rather than break.
    }
    return { ...DEFAULT_SETTINGS };
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // Not being able to remember the volume is not worth an error.
    }
  }

  getSettings(): Readonly<AudioSettings> {
    return this.settings;
  }

  get isRunning(): boolean {
    return this.started && !this.suspended;
  }

  /**
   * Build the audio graph. Must be called from inside a user gesture — every
   * browser blocks audio otherwise, and a silently-dead AudioContext is a very
   * confusing thing to debug.
   */
  unlock(): void {
    if (this.started) {
      void this.ctx?.resume();
      return;
    }
    type WindowWithWebkit = Window & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext
      ?? (window as WindowWithWebkit).webkitAudioContext;
    if (!Ctor) return; // No Web Audio: the game simply runs silent.

    this.ctx = new Ctor();
    const ctx = this.ctx;
    this.started = true;

    // A limiter on the end keeps a busy dungeon from clipping.
    //
    // WebKit's DynamicsCompressor does not match Blink's for the same
    // parameters — the gain-reduction curve differs, so a setting that limits
    // transparently in Chrome audibly pumps in Safari. Ask it to do less work
    // there and make up the headroom by running the master a little lower.
    const webkit = isWebKit();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = webkit ? -3 : -8;
    limiter.knee.value = webkit ? 12 : 6;
    limiter.ratio.value = webkit ? 5 : 12;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.22;
    limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.masterTrim = webkit ? 0.78 : 1;
    this.master.gain.value = this.settings.muted
      ? 0 : this.settings.master * this.masterTrim;
    this.master.connect(limiter);

    this.duck = ctx.createGain();
    this.duck.gain.value = 1;
    this.duck.connect(this.master);

    // One shared convolver puts everything in the same stone room. WebKit's
    // convolution is markedly more expensive and normalises the impulse
    // differently, so it gets a shorter, faster-decaying tail — a glitching
    // reverb sounds far worse than a smaller one.
    const reverb = ctx.createConvolver();
    reverb.buffer = webkit
      ? makeCaveImpulse(ctx, 1.5, 3.0)
      : makeCaveImpulse(ctx, 2.8, 2.6);
    reverb.connect(this.duck);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.9;
    this.reverbSend.connect(reverb);

    this.ambienceBus = ctx.createGain();
    this.ambienceBus.gain.value = this.settings.ambience;
    this.ambienceBus.connect(this.duck);

    this.scoreBus = ctx.createGain();
    this.scoreBus.gain.value = this.settings.score;
    this.scoreBus.connect(this.duck);

    this.effectsBus = ctx.createGain();
    this.effectsBus.gain.value = this.settings.effects;
    this.effectsBus.connect(this.duck);

    this.noiseWhite = makeWhiteNoise(ctx, 2.0, 11);
    this.noiseBrown = makeBrownNoise(ctx, 6.0, 23);

    this.startAmbience();

    const now = ctx.currentTime;
    this.nextDrip = now + 2;
    this.nextChord = now + 0.5;
    this.nextHeartbeat = now + 1;
  }

  /* ----------------------------------------------------------- ambience -- */

  /** Continuous layers: they run for the lifetime of the page. */
  private startAmbience(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;

    // A very low drone, two oscillators detuned against each other so the
    // beating between them keeps it from sounding like a test tone.
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.16;
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 220;
    droneFilter.Q.value = 3;
    droneGain.connect(droneFilter);
    droneFilter.connect(this.ambienceBus);

    for (const [freq, detune] of [[41.2, 0], [41.2, 7], [61.7, -5]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = 0.34;
      osc.connect(g);
      g.connect(droneGain);
      osc.start(now);
    }

    // A slow LFO opens and closes the drone's filter, so it breathes.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 90;
    lfo.connect(lfoDepth);
    lfoDepth.connect(droneFilter.frequency);
    lfo.start(now);

    // Cave rumble: looping brown noise, heavily filtered.
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noiseBrown;
    rumble.loop = true;
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 160;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.5;
    rumble.connect(rumbleFilter);
    rumbleFilter.connect(rumbleGain);
    rumbleGain.connect(this.ambienceBus);
    rumble.start(now);

    // Torch crackle: a band of noise, wobbling, sent mostly to reverb so it
    // sounds like it is coming from somewhere down the corridor.
    const crackle = ctx.createBufferSource();
    crackle.buffer = this.noiseWhite;
    crackle.loop = true;
    const crackleFilter = ctx.createBiquadFilter();
    crackleFilter.type = 'bandpass';
    crackleFilter.frequency.value = 1400;
    crackleFilter.Q.value = 1.2;
    const crackleGain = ctx.createGain();
    // Measured on the output tap, the mix had nothing at all above 2kHz with
    // this any lower — correct for a cave in principle, muffled and lifeless
    // in practice. The crackle is what gives the bed some air.
    crackleGain.gain.value = 0.075;
    crackle.connect(crackleFilter);
    crackleFilter.connect(crackleGain);
    crackleGain.connect(this.ambienceBus);
    crackleGain.connect(this.reverbSend);
    crackle.start(now);

    const crackleLfo = ctx.createOscillator();
    crackleLfo.frequency.value = 3.1;
    const crackleDepth = ctx.createGain();
    crackleDepth.gain.value = 0.042;
    crackleLfo.connect(crackleDepth);
    crackleDepth.connect(crackleGain.gain);
    crackleLfo.start(now);
  }

  /**
   * Sparse, scheduled ambience and score. Called every frame; it looks a little
   * ahead of the clock and schedules anything due, which is far steadier than
   * firing sounds straight off `requestAnimationFrame`.
   */
  update(dt: number, cameraX: number, cameraY: number, cameraDistance: number): void {
    void dt;
    if (!this.ctx || this.suspended) return;
    this.listenerX = cameraX;
    this.listenerY = cameraY;
    this.listenerScale = Math.max(8, cameraDistance);

    const now = this.ctx.currentTime;

    if (now >= this.nextDrip) {
      this.drip();
      this.nextDrip = now + 3 + Math.random() * 9;
    }
    if (now >= this.nextChord) {
      this.nextChord = now + this.chord();
    }
    if (now >= this.nextHeartbeat) {
      this.heartbeat();
      this.nextHeartbeat = now + this.heartbeatRate;
    }
  }

  /**
   * The Dungeon Heart's pulse. Speeds up as things get dangerous, which gives
   * the player a reason to feel uneasy before they have worked out why.
   */
  setTension(tension: number): void {
    this.heartbeatRate = 1.9 - Math.min(1, Math.max(0, tension)) * 0.9;
  }

  private heartbeat(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    // Two thumps, lub-dub, from a fast downward pitch sweep.
    for (const [offset, level] of [[0, 0.5], [0.28, 0.32]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const t = now + offset;
      osc.frequency.setValueAtTime(78, t);
      osc.frequency.exponentialRampToValueAtTime(34, t + 0.16);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(g);
      g.connect(this.ambienceBus);
      osc.start(t);
      osc.stop(t + 0.34);
    }
  }

  private drip(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const base = 700 + Math.random() * 900;
    osc.frequency.setValueAtTime(base * 2.4, now);
    osc.frequency.exponentialRampToValueAtTime(base, now + 0.06);
    const g = ctx.createGain();
    envelope(g, now, 0.16, 0.002, 0.12);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    osc.connect(g);
    g.connect(pan);
    // Mostly reverb: a drip you hear directly is a tap, a drip you hear in a
    // tail is a cave.
    pan.connect(this.reverbSend);
    const dry = ctx.createGain();
    dry.gain.value = 0.4;
    pan.connect(dry);
    dry.connect(this.ambienceBus);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  /* -------------------------------------------------------------- score -- */

  /** A slow progression in a natural minor: i - VI - III - VII. */
  private static readonly CHORDS: readonly (readonly number[])[] = [
    [33, 40, 45],   // A1 minor-ish root voicing
    [29, 36, 41],   // F
    [32, 39, 44],   // G#/Ab
    [31, 38, 43],   // G
  ];

  private chord(): number {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const notes = AudioEngine.CHORDS[this.chordIndex % AudioEngine.CHORDS.length];
    this.chordIndex++;

    const length = 11 + Math.random() * 4;
    for (const midi of notes) {
      // Two detuned voices per note: thin single oscillators sound synthetic,
      // and this is meant to read as something bowed and far away.
      for (const detune of [-6, 6]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = midiToFreq(midi);
        osc.detune.value = detune;

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(300, now);
        filter.frequency.linearRampToValueAtTime(900, now + length * 0.45);
        filter.frequency.linearRampToValueAtTime(260, now + length);

        const g = ctx.createGain();
        // Long swell in, long fade out — no attack transient at all.
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.075, now + length * 0.4);
        g.gain.exponentialRampToValueAtTime(0.0001, now + length);

        osc.connect(filter);
        filter.connect(g);
        g.connect(this.scoreBus);
        g.connect(this.reverbSend);
        osc.start(now);
        osc.stop(now + length + 0.1);
      }
    }
    // Overlap the next chord slightly so the pad never fully drops out.
    return length * 0.8;
  }

  /* ------------------------------------------------------------ effects -- */

  /**
   * Pan and attenuation for a sound at a world position. Distant events are
   * quieter and wider; anything past the camera's reach is dropped entirely.
   */
  private place(x: number, y: number): { gain: number; pan: number } | null {
    const dx = x - this.listenerX;
    const dy = y - this.listenerY;
    const distance = Math.hypot(dx, dy);
    const reach = this.listenerScale * 1.4;
    if (distance > reach) return null;
    const gain = Math.pow(1 - distance / reach, 1.6);
    const pan = Math.max(-0.85, Math.min(0.85, dx / (this.listenerScale * 0.6)));
    return { gain, pan };
  }

  /** Fire a one-shot at a world position. */
  play(kind: string, x: number, y: number): void {
    if (!this.ctx || this.suspended) return;
    const placed = this.place(x, y);
    if (!placed || placed.gain < 0.02) return;
    this.spawn(kind as EffectKind, placed.gain, placed.pan);
  }

  /** Fire a one-shot with no position — UI clicks and the like. */
  playUi(kind: string, gain = 0.6): void {
    if (!this.ctx || this.suspended) return;
    this.spawn(kind as EffectKind, gain, 0);
  }

  private spawn(kind: EffectKind, level: number, pan: number): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;

    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    panner.connect(this.effectsBus);
    // Everything gets a little of the room.
    const send = ctx.createGain();
    send.gain.value = 0.28;
    panner.connect(send);
    send.connect(this.reverbSend);

    /** A shaped burst of noise: the basis of every impact in here. */
    const noise = (
      buffer: AudioBuffer, type: BiquadFilterType, freq: number, q: number,
      peak: number, attack: number, decay: number,
      sweepTo?: number,
    ): void => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      // Start somewhere random in the buffer so repeats don't sound identical.
      const offset = Math.random() * Math.max(0, buffer.duration - decay - attack - 0.02);
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.setValueAtTime(freq, now);
      if (sweepTo !== undefined) {
        filter.frequency.exponentialRampToValueAtTime(sweepTo, now + attack + decay);
      }
      filter.Q.value = q;
      const g = ctx.createGain();
      envelope(g, now, peak * level, attack, decay);
      src.connect(filter);
      filter.connect(g);
      g.connect(panner);
      src.start(now, offset, attack + decay + 0.05);
    };

    /** A pitched blip, optionally swept. */
    const tone = (
      type: OscillatorType, from: number, to: number,
      peak: number, attack: number, decay: number, delay = 0,
    ): void => {
      const osc = ctx.createOscillator();
      osc.type = type;
      const t = now + delay;
      osc.frequency.setValueAtTime(from, t);
      if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + attack + decay);
      const g = ctx.createGain();
      envelope(g, t, peak * level, attack, decay);
      osc.connect(g);
      g.connect(panner);
      osc.start(t);
      osc.stop(t + attack + decay + 0.06);
    };

    switch (kind) {
      case 'dig':
        // A dull thud into earth, plus the gravel that comes away with it.
        tone('sine', 150, 60, 0.28, 0.004, 0.09);
        noise(this.noiseBrown, 'bandpass', 900, 1.1, 0.20, 0.002, 0.11);
        break;

      case 'build':
        // Stone set down hard.
        tone('sine', 110, 45, 0.42, 0.003, 0.22);
        noise(this.noiseWhite, 'lowpass', 2200, 0.7, 0.30, 0.002, 0.2, 400);
        break;

      case 'claim':
        // A low swell as the floor turns: this is territory changing hands.
        tone('triangle', 180, 320, 0.16, 0.06, 0.35);
        tone('sine', 90, 160, 0.14, 0.05, 0.4);
        break;

      case 'gold': {
        // Coins: several short bright partials at once, slightly detuned.
        for (let i = 0; i < 4; i++) {
          const f = 1600 + Math.random() * 1500;
          tone('triangle', f, f * 0.94, 0.13, 0.002, 0.14, i * 0.022);
        }
        noise(this.noiseWhite, 'highpass', 3200, 0.6, 0.10, 0.002, 0.1);
        break;
      }

      case 'poof':
        // Something arriving or leaving that should not have been able to.
        noise(this.noiseWhite, 'bandpass', 700, 0.8, 0.34, 0.006, 0.45, 3000);
        tone('sine', 420, 90, 0.20, 0.01, 0.4);
        break;

      case 'hit':
        tone('sine', 190, 70, 0.34, 0.002, 0.11);
        noise(this.noiseWhite, 'bandpass', 1700, 1.4, 0.28, 0.001, 0.09);
        break;

      case 'slap':
        // Sharp, bright, unpleasant — it should feel like it stung.
        noise(this.noiseWhite, 'highpass', 2400, 0.7, 0.42, 0.001, 0.08);
        tone('sine', 700, 160, 0.20, 0.001, 0.07);
        break;

      case 'heal':
        for (let i = 0; i < 3; i++) tone('sine', midiToFreq(72 + i * 4), midiToFreq(72 + i * 4), 0.11, 0.04, 0.5, i * 0.07);
        break;

      case 'lightning':
        noise(this.noiseWhite, 'highpass', 1200, 0.5, 0.55, 0.001, 0.5, 240);
        tone('sawtooth', 220, 42, 0.28, 0.002, 0.45);
        break;

      case 'haste':
        tone('square', 380, 1500, 0.11, 0.01, 0.24);
        break;

      case 'rally':
        // A horn call: two notes, a fifth apart.
        tone('sawtooth', midiToFreq(50), midiToFreq(50), 0.16, 0.03, 0.34);
        tone('sawtooth', midiToFreq(57), midiToFreq(57), 0.15, 0.03, 0.5, 0.18);
        break;

      case 'levelup': {
        const root = 60;
        [0, 4, 7, 12].forEach((step, i) => {
          tone('triangle', midiToFreq(root + step), midiToFreq(root + step), 0.14, 0.008, 0.32, i * 0.07);
        });
        break;
      }

      case 'grab':
        tone('sine', 300, 720, 0.16, 0.008, 0.12);
        break;

      case 'drop':
        tone('sine', 260, 90, 0.24, 0.004, 0.16);
        noise(this.noiseBrown, 'lowpass', 700, 0.7, 0.22, 0.002, 0.14);
        break;

      case 'eat':
        noise(this.noiseBrown, 'bandpass', 500, 2.0, 0.16, 0.01, 0.13);
        break;

      case 'sleep':
        tone('sine', 130, 88, 0.07, 0.22, 0.7);
        break;

      case 'train':
        // Metal on metal.
        noise(this.noiseWhite, 'bandpass', 3000, 3.5, 0.24, 0.001, 0.16);
        tone('square', 900, 700, 0.09, 0.001, 0.1);
        break;

      case 'research':
        tone('sine', midiToFreq(79), midiToFreq(86), 0.08, 0.05, 0.45);
        break;

      default:
        tone('sine', 400, 200, 0.12, 0.005, 0.12);
        break;
    }
  }

  /* ------------------------------------------------------------ ducking -- */

  /** Pull the mix down while the narrator talks, and let it back up after. */
  setDuck(amount: number, seconds = 0.25): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.duck.gain.cancelScheduledValues(now);
    this.duck.gain.setValueAtTime(this.duck.gain.value, now);
    this.duck.gain.linearRampToValueAtTime(Math.max(0.05, amount), now + seconds);
  }

  /* ----------------------------------------------------------- settings -- */

  setMuted(muted: boolean): void {
    this.settings.muted = muted;
    if (this.ctx) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.linearRampToValueAtTime(
        muted ? 0 : this.settings.master * this.masterTrim, now + 0.15);
    }
    this.save();
  }

  setVolume(bus: 'master' | 'ambience' | 'score' | 'effects' | 'narrator', value: number): void {
    const v = Math.max(0, Math.min(1, value));
    this.settings[bus] = v;
    if (this.ctx) {
      const target = bus === 'master' ? this.master
        : bus === 'ambience' ? this.ambienceBus
          : bus === 'score' ? this.scoreBus
            : bus === 'effects' ? this.effectsBus : null;
      if (target && !(bus === 'master' && this.settings.muted)) {
        const scaled = bus === 'master' ? v * this.masterTrim : v;
        target.gain.setTargetAtTime(scaled, this.ctx.currentTime, 0.05);
      }
    }
    this.save();
  }

  /** Silence everything while the game is paused or the tab is hidden. */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    if (!this.ctx) return;
    if (suspended) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}
