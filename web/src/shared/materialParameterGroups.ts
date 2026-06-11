/**
 * Parameter key groupings for per-node reset in the material editor.
 * Keys mirror controls on TextureNode / ParamNode — keep in sync when adding params.
 */
import type { MaterialParameters, MaterialSlot } from './api';

export const SLOT_PARAMETER_KEYS: Record<MaterialSlot, Array<keyof MaterialParameters>> = {
  albedo: ['baseColor'],
  roughness: ['roughness'],
  metallic: ['metallic'],
  emissive: ['emissiveColor', 'emissiveIntensity'],
  opacity: ['opacity'],
  normal: ['normalScale', 'flipNormalY'],
  ao: ['aoIntensity'],
  displacement: ['displacementScale', 'displacementBias'],
};

export const PARAM_BLOCK_KEYS: Record<string, Array<keyof MaterialParameters>> = {
  textureUv: ['tilingX', 'tilingY', 'offsetX', 'offsetY'],
  alpha: ['alphaMode', 'alphaCutoff', 'doubleSided', 'flipNormalY'],
  clearCoat: ['clearCoatFactor', 'clearCoatRoughness'],
  transmission: ['transmissionFactor'],
  ior: ['ior'],
  specular: ['specularFactor', 'specularColor'],
  sheen: ['sheenColor', 'sheenRoughness'],
  volume: ['volumeThicknessFactor', 'volumeAttenuationDistance', 'volumeAttenuationColor'],
  anisotropy: ['anisotropyStrength', 'anisotropyRotation'],
  iridescence: ['iridescenceFactor', 'iridescenceIor', 'iridescenceThicknessMin', 'iridescenceThicknessMax'],
  emissiveStrength: ['emissiveStrength'],
  dispersion: ['dispersionFactor'],
  unlit: ['unlit'],
};

export const ALL_NODE_PARAMETER_KEYS: Array<keyof MaterialParameters> = [
  ...Object.values(SLOT_PARAMETER_KEYS).flat(),
  ...Object.values(PARAM_BLOCK_KEYS).flat(),
].filter((key, i, arr) => arr.indexOf(key) === i);

/** True when any key in `keys` differs between current and baseline. */
export function parametersGroupDiffers(
  current: MaterialParameters,
  baseline: MaterialParameters,
  keys: ReadonlyArray<keyof MaterialParameters>,
): boolean {
  for (const key of keys) {
    if (current[key] !== baseline[key]) return true;
  }
  return false;
}
