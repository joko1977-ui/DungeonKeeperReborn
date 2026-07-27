import * as THREE from 'three';
import { Creature, CreatureState } from '../core/creatures';

/**
 * What a creature is doing, said out loud.
 *
 * The roster had bodies, gaits and rank on it and still read as a set of moving
 * props, and the reason is that a prop has no interior. You could watch an imp
 * for a minute and not know whether it was digging, carrying, or milling about
 * with nothing to do — and the player who tags a wall and then wonders where his
 * gold went is asking exactly that question about exactly that creature.
 *
 * So each one carries a small badge: a pick while it digs, a coin while it is
 * hauling a load to the vault, crossed swords in a fight, a Z asleep. And when
 * something is wrong — starving, or angry enough to walk out — the badge turns
 * red and says so instead, because a need outranks a job every time.
 *
 * Drawn as one instanced quad billboarded at the camera, with a per-instance
 * atlas index, so the whole dungeon's worth costs a single draw call.
 */

/** Atlas slots, in the order they are drawn into the sheet. */
export const BADGE_NONE = -1;
export const BADGE_DIG = 0;
export const BADGE_GOLD = 1;
export const BADGE_FIGHT = 2;
export const BADGE_SLEEP = 3;
export const BADGE_EAT = 4;
export const BADGE_TRAIN = 5;
export const BADGE_STUDY = 6;
export const BADGE_BUILD = 7;
export const BADGE_CLAIM = 8;
export const BADGE_HUNGRY = 9;
export const BADGE_ANGRY = 10;
export const BADGE_FLEE = 11;

const SLOTS = 12;
export const BADGE_COLS = 4;
export const BADGE_ROWS = 3;
const CELL = 64;

/** Needs that shout over whatever the creature happens to be doing. */
const HUNGRY_AT = 80;
const ANGRY_AT = 75;

/**
 * Which badge a creature should wear, or BADGE_NONE for nothing at all.
 *
 * Idle and plain walking get no badge on purpose. A marker over every creature
 * all the time is wallpaper; the point is that the ones with something to say
 * stand out, and a dungeon where half the workforce is unbadged is a dungeon
 * telling you half your workforce is doing nothing.
 */
export function badgeFor(c: Creature): number {
  // Needs first. A starving creature's job is not the interesting fact about it.
  if (c.hunger >= HUNGRY_AT && c.state !== CreatureState.Eating) return BADGE_HUNGRY;
  if (c.anger >= ANGRY_AT) return BADGE_ANGRY;

  switch (c.state) {
    case CreatureState.Digging: return BADGE_DIG;
    case CreatureState.Hauling: return BADGE_GOLD;
    case CreatureState.Fighting:
    case CreatureState.AttackingHeart: return BADGE_FIGHT;
    case CreatureState.Sleeping: return BADGE_SLEEP;
    case CreatureState.Eating: return BADGE_EAT;
    case CreatureState.Training: return BADGE_TRAIN;
    case CreatureState.Researching: return BADGE_STUDY;
    case CreatureState.Manufacturing: return BADGE_BUILD;
    case CreatureState.Claiming: return BADGE_CLAIM;
    case CreatureState.Fleeing: return BADGE_FLEE;
    // Walking counts as hauling when there is a load on its back, which is the
    // whole answer to "I dug a seam and saw no gold".
    case CreatureState.Walking: return c.goldHeld > 0 ? BADGE_GOLD : BADGE_NONE;
    default: return BADGE_NONE;
  }
}

/** True for the badges that mean something is wrong. */
export function badgeIsAlarm(slot: number): boolean {
  return slot === BADGE_HUNGRY || slot === BADGE_ANGRY || slot === BADGE_FLEE;
}

function disc(ctx: CanvasRenderingContext2D, alarm: boolean): void {
  // A filled roundel behind every glyph. Line art alone vanished against a lit
  // floor at one moment and a black wall the next; a solid backing means the
  // badge is legible over anything, which is the entire job.
  ctx.beginPath();
  ctx.arc(CELL / 2, CELL / 2, CELL * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = alarm ? 'rgba(58,10,10,0.92)' : 'rgba(14,18,26,0.88)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = alarm ? '#ff6b52' : '#cfd8e4';
  ctx.stroke();
}

function stroke(ctx: CanvasRenderingContext2D, colour: string, width = 7): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

/** Draw one glyph, centred in a cell whose origin the caller has translated to. */
function drawGlyph(ctx: CanvasRenderingContext2D, slot: number): void {
  const c = CELL / 2;
  const pale = '#e8eef6';
  const gold = '#ffcc47';
  const red = '#ff8a72';

  disc(ctx, badgeIsAlarm(slot));

  switch (slot) {
    case BADGE_DIG: {
      // A pick: a haft with a curved head across it.
      stroke(ctx, pale);
      ctx.beginPath();
      ctx.moveTo(c - 13, c + 15); ctx.lineTo(c + 12, c - 14);
      ctx.stroke();
      stroke(ctx, gold, 6);
      ctx.beginPath();
      ctx.moveTo(c - 1, c - 18); ctx.quadraticCurveTo(c + 12, c - 10, c + 19, c - 1);
      ctx.stroke();
      break;
    }
    case BADGE_GOLD: {
      // A coin, edge-on highlight and all.
      ctx.beginPath();
      ctx.ellipse(c, c, 15, 15, 0, 0, Math.PI * 2);
      ctx.fillStyle = gold;
      ctx.fill();
      stroke(ctx, '#8a5f10', 4);
      ctx.stroke();
      stroke(ctx, '#fff0bc', 4);
      ctx.beginPath();
      ctx.arc(c, c, 8, Math.PI * 0.9, Math.PI * 1.7);
      ctx.stroke();
      break;
    }
    case BADGE_FIGHT: {
      stroke(ctx, pale);
      ctx.beginPath();
      ctx.moveTo(c - 15, c + 15); ctx.lineTo(c + 15, c - 15);
      ctx.moveTo(c + 15, c + 15); ctx.lineTo(c - 15, c - 15);
      ctx.stroke();
      stroke(ctx, red, 5);
      ctx.beginPath();
      ctx.moveTo(c + 6, c - 15); ctx.lineTo(c + 15, c - 15); ctx.lineTo(c + 15, c - 6);
      ctx.moveTo(c - 6, c - 15); ctx.lineTo(c - 15, c - 15); ctx.lineTo(c - 15, c - 6);
      ctx.stroke();
      break;
    }
    case BADGE_SLEEP: {
      // Two Zs, the small one trailing.
      ctx.fillStyle = pale;
      ctx.font = 'bold 30px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('z', c + 7, c + 5);
      ctx.font = 'bold 20px system-ui, sans-serif';
      ctx.fillText('z', c - 10, c - 9);
      break;
    }
    case BADGE_EAT: {
      // A drumstick: bone and all.
      stroke(ctx, '#e7d3ac', 8);
      ctx.beginPath();
      ctx.moveTo(c + 13, c + 13); ctx.lineTo(c - 2, c - 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(c - 8, c - 8, 12, 10, -Math.PI / 4, 0, Math.PI * 2);
      ctx.fillStyle = '#c9743f';
      ctx.fill();
      break;
    }
    case BADGE_TRAIN: {
      // A dumbbell.
      stroke(ctx, pale, 6);
      ctx.beginPath();
      ctx.moveTo(c - 10, c); ctx.lineTo(c + 10, c);
      ctx.stroke();
      stroke(ctx, pale, 12);
      ctx.beginPath();
      ctx.moveTo(c - 14, c - 8); ctx.lineTo(c - 14, c + 8);
      ctx.moveTo(c + 14, c - 8); ctx.lineTo(c + 14, c + 8);
      ctx.stroke();
      break;
    }
    case BADGE_STUDY: {
      // An open book.
      ctx.fillStyle = '#9fc2ff';
      ctx.beginPath();
      ctx.moveTo(c - 16, c - 11); ctx.lineTo(c - 1, c - 7);
      ctx.lineTo(c - 1, c + 13); ctx.lineTo(c - 16, c + 9);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(c + 16, c - 11); ctx.lineTo(c + 1, c - 7);
      ctx.lineTo(c + 1, c + 13); ctx.lineTo(c + 16, c + 9);
      ctx.closePath(); ctx.fill();
      break;
    }
    case BADGE_BUILD: {
      // A hammer.
      stroke(ctx, '#c9a06a', 7);
      ctx.beginPath();
      ctx.moveTo(c - 2, c - 6); ctx.lineTo(c - 10, c + 16);
      ctx.stroke();
      ctx.fillStyle = pale;
      ctx.fillRect(c - 12, c - 20, 28, 12);
      break;
    }
    case BADGE_CLAIM: {
      // A flag on a staff: this ground is mine now.
      stroke(ctx, pale, 6);
      ctx.beginPath();
      ctx.moveTo(c - 9, c - 17); ctx.lineTo(c - 9, c + 17);
      ctx.stroke();
      ctx.fillStyle = '#ff7a4a';
      ctx.beginPath();
      ctx.moveTo(c - 9, c - 16); ctx.lineTo(c + 17, c - 8); ctx.lineTo(c - 9, c);
      ctx.closePath(); ctx.fill();
      break;
    }
    case BADGE_HUNGRY: {
      // An empty bowl.
      stroke(ctx, '#ffd9cf', 7);
      ctx.beginPath();
      ctx.arc(c, c - 2, 16, 0, Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(c - 20, c - 2); ctx.lineTo(c + 20, c - 2);
      ctx.stroke();
      break;
    }
    case BADGE_ANGRY: {
      ctx.fillStyle = '#ffd0c4';
      ctx.font = 'bold 44px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', c, c + 2);
      break;
    }
    case BADGE_FLEE: {
      // A pair of chevrons running off.
      stroke(ctx, '#ffd0c4', 7);
      ctx.beginPath();
      ctx.moveTo(c - 16, c - 12); ctx.lineTo(c - 2, c); ctx.lineTo(c - 16, c + 12);
      ctx.moveTo(c + 1, c - 12); ctx.lineTo(c + 15, c); ctx.lineTo(c + 1, c + 12);
      ctx.stroke();
      break;
    }
    default: break;
  }
}

let cached: THREE.Texture | null = null;

/** The badge sheet, drawn once and shared. */
export function badgeAtlas(): THREE.Texture {
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = BADGE_COLS * CELL;
  canvas.height = BADGE_ROWS * CELL;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context for the badge atlas');

  for (let slot = 0; slot < SLOTS; slot++) {
    ctx.save();
    ctx.translate((slot % BADGE_COLS) * CELL, Math.floor(slot / BADGE_COLS) * CELL);
    drawGlyph(ctx, slot);
    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  cached = texture;
  return texture;
}
