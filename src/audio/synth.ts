/**
 * Low-level synthesis helpers.
 *
 * As with the textures, no audio files ship with the game — every sound is
 * built out of oscillators and shaped noise at runtime. That keeps the download
 * to nothing, means the whole soundscape is tweakable as numbers rather than
 * assets, and leaves no question about whose recordings these are.
 */

/** Deterministic noise source, so a given buffer is identical every run. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Flat-spectrum noise. The raw material for impacts, wind and crackle. */
export function makeWhiteNoise(ctx: BaseAudioContext, seconds: number, seed = 1): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rnd = makeRandom(seed);
  for (let i = 0; i < data.length; i++) data[i] = rnd();
  return buffer;
}

/**
 * Brown noise: white noise integrated, so energy falls off with frequency.
 * This is what a big empty stone space actually sounds like.
 */
export function makeBrownNoise(ctx: BaseAudioContext, seconds: number, seed = 2): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rnd = makeRandom(seed);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    last = (last + 0.02 * rnd()) / 1.02;
    data[i] = last * 3.5;
  }
  return buffer;
}

/**
 * A synthetic impulse response for the convolver: exponentially decaying noise,
 * darkened over time. Turns dry blips into sounds happening inside rock.
 */
export function makeCaveImpulse(
  ctx: BaseAudioContext,
  seconds = 2.6,
  decay = 2.4,
): AudioBuffer {
  const length = Math.ceil(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    const rnd = makeRandom(7 + channel * 31);
    // A one-pole lowpass whose cutoff falls as the tail decays: high frequencies
    // die away first in a real space, and that is most of what sells a room.
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const envelope = Math.pow(1 - t, decay);
      const coefficient = 0.28 - 0.2 * t;
      lp += coefficient * (rnd() - lp);
      // A few early reflections give the tail some shape.
      const slap = (i === (ctx.sampleRate * 0.017 | 0) || i === (ctx.sampleRate * 0.029 | 0))
        ? 0.6 : 0;
      data[i] = (lp * 2.4 + slap) * envelope;
    }
  }
  return buffer;
}

/**
 * ADSR-ish envelope applied to a gain node, in seconds.
 *
 * Every tail ends with a short *linear* ramp to true zero rather than an
 * exponential ramp to a small epsilon. An exponential curve can never reach
 * zero, so it leaves a step at the end — inaudible in Blink, which interpolates
 * automation finely, but an audible tick in WebKit, whose automation resolution
 * is coarser. With ~1ms attacks on the impact sounds, that tick was on every
 * pick swing.
 */
export function envelope(
  gain: GainNode,
  now: number,
  peak: number,
  attack: number,
  decay: number,
  sustain = 0,
  release = 0.05,
  hold = 0,
): number {
  const g = gain.gain;
  const floor = 0.0001;
  /** Silence properly: exponential down to the floor, then linear to zero. */
  const toSilence = (at: number): void => {
    g.exponentialRampToValueAtTime(floor, at);
    g.linearRampToValueAtTime(0, at + 0.006);
  };

  g.cancelScheduledValues(now);
  g.setValueAtTime(floor, now);
  g.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + attack);
  if (sustain > 0) {
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak * sustain), now + attack + decay);
    g.setValueAtTime(Math.max(0.0002, peak * sustain), now + attack + decay + hold);
    toSilence(now + attack + decay + hold + release);
    return attack + decay + hold + release + 0.006;
  }
  toSilence(now + attack + decay);
  return attack + decay + 0.006;
}

/**
 * True when running on WebKit (Safari, and every browser on iOS).
 *
 * Used to back off the parts of the graph whose implementations diverge most
 * from Blink's: the compressor curve, and convolution cost.
 */
export function isWebKit(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
}

/** Semitone offset to a frequency ratio. */
export function semitones(n: number): number {
  return Math.pow(2, n / 12);
}

/** Note name to frequency, e.g. midiToFreq(45) === 110 (A2). */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
