/**
 * Height / bump preview helpers for the materials editor.
 *
 * The displacement slot stores a greyscale height map. Applying it as Three.js
 * `displacementMap` moves vertices along normals — on hard-edged meshes
 * (BoxGeometry faces do not share edge vertices) that tears seams apart.
 * Preview uses `bumpMap` instead so silhouette/edges stay fixed and only
 * shading changes. Stored parameter names stay `displacementScale` /
 * `displacementBias` for API compatibility; bias is unused for bump.
 */
import type { MeshPhysicalMaterial, Texture } from 'three';

/** Map stored displacementScale (metres-ish) onto a usable Three bumpScale. */
export const HEIGHT_TO_BUMP_SCALE = 20;

export function applyHeightSlotAsBump(
  material: MeshPhysicalMaterial,
  tex: Texture | null,
): void {
  material.bumpMap = tex;
  // Never true-displace in the editor preview — keeps cube seams intact.
  material.displacementMap = null;
  material.displacementScale = 0;
  material.displacementBias = 0;
}

export function applyHeightBumpScale(
  material: MeshPhysicalMaterial,
  displacementScale: number,
): void {
  material.bumpScale = displacementScale * HEIGHT_TO_BUMP_SCALE;
  material.displacementScale = 0;
  material.displacementBias = 0;
}
