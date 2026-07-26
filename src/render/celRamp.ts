import * as THREE from 'three';

/**
 * The shading ramp every surface in the dungeon is lit through.
 *
 * One ramp, shared by the creatures, the walls, the floors and the furniture,
 * because that is what makes a look *coherent* rather than a collection of
 * treatments. The creatures were cel-shaded first and everything else was left on
 * physically-based materials, which put two incompatible pictures in one frame: a
 * flat-shaded imp with a hard shadow edge, standing on a floor whose light fell
 * off in a smooth photographic gradient. The imp read as pasted on.
 *
 * Three steps — deep shadow, mid, lit — sampled with `NearestFilter` so the
 * transitions stay hard. That hardness is the whole point: a drawing shades a form
 * as flat areas separated by a line, and no amount of roughness tuning on a
 * standard material will produce one.
 *
 * The range is compressed at both ends on purpose. A ramp running to white blows
 * the lit side out to blank paper under this warm key, and one running to black
 * turns the shadow side into a hole; either way the surface's own colour is thrown
 * away, and that colour is what the flat shading exists to show off.
 */
export function makeCelRamp(): THREE.DataTexture {
  const steps = new Uint8Array([
    112, 108, 118, 255,
    180, 176, 178, 255,
    238, 234, 228, 255,
  ]);
  const tex = new THREE.DataTexture(steps, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The one ramp instance, so every material samples the same texture.
 *
 * Built on first use rather than at module load: this runs in a headless Node
 * process during the smoke tests, where `DataTexture` is harmless but pointless.
 */
let shared: THREE.DataTexture | null = null;

export function celRamp(): THREE.DataTexture {
  if (!shared) shared = makeCelRamp();
  return shared;
}
