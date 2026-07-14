/**
 * Height / bump preview helpers for the materials editor.
 *
 * The displacement slot stores a greyscale height map. True `displacementMap`
 * moves vertices along normals; on a hard-edged BoxGeometry that tears seams
 * because faces do not share edge vertices. `bumpMap` only changes shading,
 * but Three.js ignores bumpMap whenever `normalMap` is set — so Megascans-style
 * materials (normal + height) would show no response to bump strength.
 *
 * Preview policy:
 * - No normal map → bumpMap (edges stay fixed)
 * - Normal map present → displacementMap (strength visible), with welded/smooth
 *   cube geometry so seams stay connected
 */
import type { MeshPhysicalMaterial, Texture } from 'three';

/** Map stored displacementScale onto Three bumpScale when using bump path. */
export const HEIGHT_TO_BUMP_SCALE = 20;

export function applyHeightPreview(
  material: MeshPhysicalMaterial,
  tex: Texture | null,
  displacementScale: number,
  displacementBias = 0,
): void {
  material.bumpMap = null;
  material.displacementMap = null;
  material.bumpScale = 0;
  material.displacementScale = 0;
  material.displacementBias = 0;

  if (!tex) return;

  // Three.js fragment shader skips bump when a normal map is bound.
  if (material.normalMap) {
    material.displacementMap = tex;
    material.displacementScale = displacementScale;
    material.displacementBias = displacementBias;
  } else {
    material.bumpMap = tex;
    material.bumpScale = displacementScale * HEIGHT_TO_BUMP_SCALE;
  }
}
