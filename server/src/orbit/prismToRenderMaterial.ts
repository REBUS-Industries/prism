/**
 * Map a PRISM library material (+ uploaded ORBIT blob ids) to an inline
 * ORBIT `Objects.Other.RenderMaterial` body.
 */
import type { MaterialDetail } from '../materials/loadDetail.js';
import { hexColorToArgbLong } from './objectHash.js';

export interface OrbitTextureRefs {
  baseColor?: string;
  normal?: string;
  roughness?: string;
  metalness?: string;
  emissive?: string;
  opacity?: string;
}

export interface OrbitRenderMaterialBody {
  speckle_type: 'Objects.Other.RenderMaterial';
  name: string;
  opacity: number;
  roughness: number;
  metalness: number;
  diffuse: number;
  emissive: number;
  emissiveIntensity?: number;
  baseColorTexture?: string;
  diffuseTexture?: string;
  normalTexture?: string;
  roughnessTexture?: string;
  metalnessTexture?: string;
  emissiveTexture?: string;
  pbrEmissionTexture?: string;
  opacityTexture?: string;
  diffuseTextureRepeat?: [number, number];
  diffuseTextureOffset?: [number, number];
}

/** Map PRISM slot name → ORBIT RenderMaterial texture field(s). */
const SLOT_TO_ORBIT: Record<string, keyof OrbitTextureRefs> = {
  albedo: 'baseColor',
  normal: 'normal',
  roughness: 'roughness',
  metallic: 'metalness',
  emissive: 'emissive',
  opacity: 'opacity',
};

export function buildOrbitRenderMaterial(
  material: MaterialDetail,
  blobIds: OrbitTextureRefs,
): OrbitRenderMaterialBody {
  const p = material.parameters;
  const body: OrbitRenderMaterialBody = {
    speckle_type: 'Objects.Other.RenderMaterial',
    name: material.name,
    opacity: p.opacity,
    roughness: p.roughness,
    metalness: p.metallic,
    diffuse: hexColorToArgbLong(p.baseColor),
    emissive: hexColorToArgbLong(p.emissiveColor),
  };

  if (p.emissiveIntensity !== 1) body.emissiveIntensity = p.emissiveIntensity;

  if (blobIds.baseColor) {
    body.baseColorTexture = blobIds.baseColor;
    body.diffuseTexture = blobIds.baseColor;
    body.diffuse = 4278190080; // black base — texture carries colour (connector convention)
  }
  if (blobIds.normal) body.normalTexture = blobIds.normal;
  if (blobIds.roughness) body.roughnessTexture = blobIds.roughness;
  if (blobIds.metalness) body.metalnessTexture = blobIds.metalness;
  if (blobIds.emissive) {
    body.emissiveTexture = blobIds.emissive;
    body.pbrEmissionTexture = blobIds.emissive;
  }
  if (blobIds.opacity) body.opacityTexture = blobIds.opacity;

  if (p.tilingX !== 1 || p.tilingY !== 1) {
    body.diffuseTextureRepeat = [p.tilingX, p.tilingY];
  }
  if (p.offsetX !== 0 || p.offsetY !== 0) {
    body.diffuseTextureOffset = [p.offsetX, p.offsetY];
  }

  return body;
}

/** Resolve which PRISM slots need blob upload for a material. */
export function prismSlotsForUpload(material: MaterialDetail): Array<{ slot: string; textureId: string; storagePath: string }> {
  const out: Array<{ slot: string; textureId: string; storagePath: string }> = [];
  for (const assignment of material.slots) {
    if (!SLOT_TO_ORBIT[assignment.slot]) continue;
    // storagePath filled by caller after DB join — placeholder here
    out.push({ slot: assignment.slot, textureId: assignment.textureId, storagePath: '' });
  }
  return out;
}

export { SLOT_TO_ORBIT };
