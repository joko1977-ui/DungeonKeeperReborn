import { CreatureType } from '../core/creatures';

/**
 * How each species moves, as opposed to how fast.
 *
 * The roster all walked with one gait: the same bob height, the same frequency,
 * the same lean, differing only in how many tiles a second the simulation moved
 * them. So a troll and a fly were the same animation played at two speeds, which
 * is the tell of a prototype — the shapes were unique and the motion was not, and
 * motion is what you actually watch.
 *
 * A gait is a character description. The imp bustles: quick, light, exaggerated
 * bounce, turns on a coin. The troll lumbers: slow, heavy, a deep drop on each
 * step and a long time to come round. The fly jitters. The dragon glides and
 * banks. Everything here is a multiplier on the same handful of curves, so it
 * costs nothing and reads immediately.
 */
export interface Gait {
  /** Steps per unit of distance — the visual cadence, not the speed. */
  cadence: number;
  /** How far the body rises on the up-beat, in world units. */
  bob: number;
  /**
   * Squash on the down-beat, as a fraction. Volume is preserved by widening as
   * it flattens, which is the oldest trick in animation and the one that makes a
   * body read as having weight rather than as a rigid prop being slid about.
   */
  squash: number;
  /** Forward pitch while moving: eagerness, or the lack of it. */
  lean: number;
  /** Side-to-side roll of the torso. Heavy things roll; light things do not. */
  roll: number;
  /** Radians per second the rendered facing chases the simulated one. */
  turn: number;
  /** Amplitude of the idle breath. */
  breath: number;
}

const DEFAULT: Gait = {
  cadence: 3.4, bob: 0.055, squash: 0.05, lean: 0.13, roll: 0.06,
  turn: 9, breath: 0.012,
};

const GAITS: Partial<Record<CreatureType, Gait>> = {
  // Bustles. Everything about an imp is quick and slightly too much.
  [CreatureType.Imp]: {
    cadence: 5.2, bob: 0.085, squash: 0.13, lean: 0.20, roll: 0.10,
    turn: 16, breath: 0.016,
  },
  // Jitters in the air rather than walking at all.
  [CreatureType.Fly]: {
    cadence: 9, bob: 0.02, squash: 0.02, lean: 0.28, roll: 0.16,
    turn: 14, breath: 0.006,
  },
  // Low and scuttling, with almost no vertical travel — six legs do the work.
  [CreatureType.Beetle]: {
    cadence: 6.5, bob: 0.018, squash: 0.03, lean: 0.06, roll: 0.03,
    turn: 5, breath: 0.006,
  },
  // Lumbers. A deep drop on each step and a long time to come round.
  [CreatureType.Troll]: {
    cadence: 2.1, bob: 0.075, squash: 0.11, lean: 0.10, roll: 0.13,
    turn: 3.4, breath: 0.022,
  },
  // Prowls: low, level and fast, the way a running lizard is.
  [CreatureType.DemonSpawn]: {
    cadence: 4.4, bob: 0.045, squash: 0.06, lean: 0.30, roll: 0.05,
    turn: 11, breath: 0.014,
  },
  // Glides. Robed things do not bob, and a caster who bounced would be comic.
  [CreatureType.Warlock]: {
    cadence: 2.6, bob: 0.012, squash: 0.02, lean: 0.08, roll: 0.02,
    turn: 6, breath: 0.02,
  },
  // Waddles, and the whole mass keeps moving after the feet stop.
  [CreatureType.BileDemon]: {
    cadence: 1.7, bob: 0.06, squash: 0.15, lean: 0.05, roll: 0.20,
    turn: 2.2, breath: 0.03,
  },
  // Banks rather than turns, and rides its own wingbeat.
  [CreatureType.Dragon]: {
    cadence: 2.2, bob: 0.05, squash: 0.04, lean: 0.16, roll: 0.22,
    turn: 3.0, breath: 0.024,
  },
  // Short legs, high cadence, and a stomp at the bottom of every step.
  [CreatureType.Dwarf]: {
    cadence: 5.6, bob: 0.05, squash: 0.10, lean: 0.14, roll: 0.09,
    turn: 8, breath: 0.014,
  },
  // Light on the feet and quick to face a new direction.
  [CreatureType.Archer]: {
    cadence: 4.6, bob: 0.05, squash: 0.05, lean: 0.18, roll: 0.05,
    turn: 13, breath: 0.012,
  },
  // Armour does not bounce. It marches, and it turns like a door.
  [CreatureType.Knight]: {
    cadence: 3.0, bob: 0.035, squash: 0.03, lean: 0.09, roll: 0.04,
    turn: 4.5, breath: 0.01,
  },
};

export function gaitFor(type: CreatureType): Gait {
  return GAITS[type] ?? DEFAULT;
}

/**
 * A strike curve: fast out, slow back.
 *
 * A sine is the wrong shape for anything that hits something. A blow spends most
 * of its time winding up and recovering and almost none at the point of contact,
 * and a symmetric wave gives exactly the opposite impression — a creature gently
 * oscillating into a wall rather than swinging at it. This spends a fifth of the
 * cycle on the strike and the rest coming back.
 *
 * Returns 0 at rest, 1 fully extended.
 */
export function strike(phase: number): number {
  const t = phase - Math.floor(phase);
  if (t < 0.2) {
    // Out: quick, and accelerating into the hit.
    const k = t / 0.2;
    return k * k;
  }
  // Back: slow, easing out of it.
  const k = (t - 0.2) / 0.8;
  return (1 - k) * (1 - k * 0.35);
}

/** Shortest signed angular difference, for chasing a heading. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
