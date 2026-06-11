/**
 * Per-material PBR parameters — scalar/colour values that exist independently
 * of whether a texture is assigned to a slot. They map onto a three.js
 * `MeshStandardMaterial` (the visualiser/SPA applies them live) and are
 * persisted per material as a partial JSON object in `materials.parameters`.
 *
 * Only the keys the user has changed are stored; `mergeParameters` fills the
 * rest from `DEFAULT_MATERIAL_PARAMETERS` at read time so the API always
 * serves a complete object. Kept dependency-light (Zod only) and free of any
 * DB/Fastify imports so the contract + validation are unit-testable in
 * isolation, mirroring `slots.ts`.
 */
import { z } from 'zod';

/** Complete, fully-populated PBR parameter set for one material. */
export interface MaterialParameters {
  // ---- Core PBR ---------------------------------------------------------
  /** material.color — also tints the albedo map when one is assigned. */
  baseColor: string;
  /** material.roughness — multiplies the roughnessMap when present. */
  roughness: number;
  /** material.metalness — multiplies the metalnessMap when present. */
  metallic: number;
  /** material.emissive. */
  emissiveColor: string;
  /** material.emissiveIntensity. */
  emissiveIntensity: number;
  /** material.opacity (+ transparent when < 1 or an alphaMap is present). */
  opacity: number;
  /** material.normalScale (x = y, then y negated when flipNormalY). */
  normalScale: number;
  /** material.aoMapIntensity. */
  aoIntensity: number;
  /** material.displacementScale. */
  displacementScale: number;
  /** material.displacementBias. */
  displacementBias: number;
  /** every assigned map's repeat.x. */
  tilingX: number;
  /** every assigned map's repeat.y. */
  tilingY: number;
  /** every assigned map's offset.x. */
  offsetX: number;
  /** every assigned map's offset.y. */
  offsetY: number;
  /** material.side — DoubleSide when true, FrontSide otherwise. */
  doubleSided: boolean;
  /** negate material.normalScale.y. */
  flipNormalY: boolean;

  // ---- Alpha ------------------------------------------------------------
  /** Alpha blending mode: 'opaque' | 'blend' | 'mask'. */
  alphaMode: 'opaque' | 'blend' | 'mask';
  /** Alpha cut-off threshold when alphaMode = 'mask'. */
  alphaCutoff: number;

  // ---- KHR_materials_clearcoat ------------------------------------------
  clearCoatFactor: number;
  clearCoatRoughness: number;

  // ---- KHR_materials_transmission ---------------------------------------
  transmissionFactor: number;

  // ---- KHR_materials_ior ------------------------------------------------
  ior: number;

  // ---- KHR_materials_specular -------------------------------------------
  specularFactor: number;
  specularColor: string;

  // ---- Active extensions (drives which sections are shown in the editor) -
  /** Names of currently-enabled material extensions, e.g. ['clearCoat', 'ior']. */
  activeExtensions: string[];

  // ---- KHR_materials_sheen ----------------------------------------------
  sheenColor: string;
  sheenRoughness: number;

  // ---- KHR_materials_volume ---------------------------------------------
  volumeThicknessFactor: number;
  /** Attenuation distance in world units; use a large value for near-infinite distance. */
  volumeAttenuationDistance: number;
  volumeAttenuationColor: string;

  // ---- KHR_materials_anisotropy -----------------------------------------
  anisotropyStrength: number;
  /** Rotation in radians (0–2π). */
  anisotropyRotation: number;

  // ---- KHR_materials_iridescence ----------------------------------------
  iridescenceFactor: number;
  iridescenceIor: number;
  iridescenceThicknessMin: number;
  iridescenceThicknessMax: number;

  // ---- KHR_materials_emissive_strength ----------------------------------
  emissiveStrength: number;

  // ---- KHR_materials_dispersion -----------------------------------------
  dispersionFactor: number;

  // ---- KHR_materials_unlit ----------------------------------------------
  unlit: boolean;
}

/** Canonical defaults — applied at read time over the stored partial. Each
 * entry notes the `MeshStandardMaterial` property it drives. */
export const DEFAULT_MATERIAL_PARAMETERS: MaterialParameters = {
  baseColor: '#ffffff',        // material.color (also tints the albedo map)
  roughness: 1.0,              // material.roughness (multiplies roughnessMap)
  metallic: 0.0,               // material.metalness (multiplies metalnessMap)
  emissiveColor: '#000000',    // material.emissive
  emissiveIntensity: 1.0,      // material.emissiveIntensity
  opacity: 1.0,                // material.opacity (+ transparent)
  normalScale: 1.0,            // material.normalScale (x = y)
  aoIntensity: 1.0,            // material.aoMapIntensity
  displacementScale: 0.05,     // material.displacementScale
  displacementBias: 0.0,       // material.displacementBias
  tilingX: 1.0,                // every map's repeat.x
  tilingY: 1.0,                // every map's repeat.y
  offsetX: 0.0,                // every map's offset.x
  offsetY: 0.0,                // every map's offset.y
  doubleSided: false,          // material.side (FrontSide vs DoubleSide)
  flipNormalY: false,          // negate normalScale.y

  alphaMode: 'opaque',
  alphaCutoff: 0.5,

  clearCoatFactor: 0,
  clearCoatRoughness: 0,

  transmissionFactor: 0,

  ior: 1.5,

  specularFactor: 1.0,
  specularColor: '#ffffff',

  // Default active extensions — Clear Coat, Transmission, IOR, Specular
  // appear for new/legacy materials that haven't stored an explicit list.
  activeExtensions: ['clearCoat', 'transmission', 'ior', 'specular'],

  sheenColor: '#000000',
  sheenRoughness: 0,

  volumeThicknessFactor: 0,
  volumeAttenuationDistance: 1000,
  volumeAttenuationColor: '#ffffff',

  anisotropyStrength: 0,
  anisotropyRotation: 0,

  iridescenceFactor: 0,
  iridescenceIor: 1.3,
  iridescenceThicknessMin: 100,
  iridescenceThicknessMax: 400,

  emissiveStrength: 1.0,

  dispersionFactor: 0,

  unlit: false,
};

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb hex colour');

/**
 * Validates a PARTIAL parameters payload — every key optional, each bounded to
 * the range the UI control honours. Unknown keys are stripped (Zod default) so
 * only recognised parameters are ever merged into the stored jsonb.
 */
export const materialParametersSchema = z
  .object({
    // Core
    baseColor: hexColor,
    roughness: z.number().min(0).max(1),
    metallic: z.number().min(0).max(1),
    emissiveColor: hexColor,
    emissiveIntensity: z.number().min(0),
    opacity: z.number().min(0).max(1),
    normalScale: z.number().min(0).max(2),
    aoIntensity: z.number().min(0).max(1),
    displacementScale: z.number(),
    displacementBias: z.number(),
    tilingX: z.number().gt(0),
    tilingY: z.number().gt(0),
    offsetX: z.number(),
    offsetY: z.number(),
    doubleSided: z.boolean(),
    flipNormalY: z.boolean(),
    // Alpha
    alphaMode: z.enum(['opaque', 'blend', 'mask']),
    alphaCutoff: z.number().min(0).max(1),
    // Clear Coat
    clearCoatFactor: z.number().min(0).max(1),
    clearCoatRoughness: z.number().min(0).max(1),
    // Transmission
    transmissionFactor: z.number().min(0).max(1),
    // IOR
    ior: z.number().min(1),
    // Specular
    specularFactor: z.number().min(0).max(1),
    specularColor: hexColor,
    // Extension tracking
    activeExtensions: z.array(z.string()),
    // Sheen
    sheenColor: hexColor,
    sheenRoughness: z.number().min(0).max(1),
    // Volume
    volumeThicknessFactor: z.number().min(0),
    volumeAttenuationDistance: z.number().positive(),
    volumeAttenuationColor: hexColor,
    // Anisotropy
    anisotropyStrength: z.number().min(0).max(1),
    anisotropyRotation: z.number().min(0),
    // Iridescence
    iridescenceFactor: z.number().min(0).max(1),
    iridescenceIor: z.number().min(1),
    iridescenceThicknessMin: z.number().min(0),
    iridescenceThicknessMax: z.number().min(0),
    // Emissive Strength
    emissiveStrength: z.number().min(0),
    // Dispersion
    dispersionFactor: z.number().min(0).max(1),
    // Unlit
    unlit: z.boolean(),
  })
  .partial();

export type MaterialParametersPatch = z.infer<typeof materialParametersSchema>;

function assignParameter<K extends keyof MaterialParameters>(
  target: MaterialParameters,
  key: K,
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  // For array-typed defaults only accept valid arrays to prevent junk injection.
  if (Array.isArray(target[key])) {
    if (Array.isArray(value)) target[key] = value as MaterialParameters[K];
    return;
  }
  target[key] = value as MaterialParameters[K];
}

/**
 * Merge a stored partial (whatever sits in `materials.parameters`) onto the
 * defaults, returning a complete parameter set. Only recognised keys are
 * copied through, so junk in the column can never leak into a response.
 */
export function mergeParameters(stored: unknown): MaterialParameters {
  const merged: MaterialParameters = { ...DEFAULT_MATERIAL_PARAMETERS };
  if (stored && typeof stored === 'object') {
    const source = stored as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_MATERIAL_PARAMETERS) as Array<keyof MaterialParameters>) {
      assignParameter(merged, key, source[key]);
    }
  }
  return merged;
}
