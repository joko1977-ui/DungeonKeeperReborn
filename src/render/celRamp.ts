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

/**
 * Add a rim light to a lit material.
 *
 * The one thing this style has that the shading model does not: a bright edge
 * where a form turns away from the camera, as if a light sat just behind it. Comic
 * and animation lighting leans on it constantly, and for a very practical reason
 * that applies exactly here — it is what separates a character from a background
 * of similar value. A dark red imp on a dark red floor is one shape until you draw
 * a line of light along its shoulder.
 *
 * It is not a physical effect and does not pretend to be. Fresnel would put the
 * rim where the *surface* faces away; this puts it where the surface faces away
 * from the *viewer*, which is where an artist puts it, and it means the rim stays
 * put as the creature turns rather than sliding around its body.
 *
 * Added after the material's own lighting so the ramp cannot quantise it into a
 * step — a rim that snaps between bands reads as a rendering error, and the whole
 * point of it is a clean line.
 */
export function addRimLight(
  material: THREE.Material, colour: number, strength: number, power = 2.6,
): void {
  const rim = new THREE.Color(colour).convertSRGBToLinear();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColour = { value: new THREE.Vector3(rim.r, rim.g, rim.b) };
    shader.uniforms.uRimStrength = { value: strength };
    shader.uniforms.uRimPower = { value: power };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3 uRimColour;
         uniform float uRimStrength;
         uniform float uRimPower;`,
      )
      .replace(
        '#include <fog_fragment>',
        `{
           // The normal and the view direction are both in view space here, so the
           // camera direction is simply +Z and no matrices are needed. Inserted
           // before the fog so a rim on a distant creature fades with everything
           // else instead of shining through it.
           float facing = abs( dot( normalize( vNormal ), vec3( 0.0, 0.0, 1.0 ) ) );
           gl_FragColor.rgb += uRimColour * pow( 1.0 - facing, uRimPower ) * uRimStrength;
         }
         #include <fog_fragment>`,
      );
  };
  material.customProgramCacheKey = () => `rim-${colour}-${strength}-${power}`;
}
