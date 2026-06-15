/**
 * Model library length units. Internal/canonical storage is metres (GDTF/fixture
 * convention); `sourceUnits` describes the coordinate space of the imported GLB.
 */

export type ModelLengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export const MODEL_LENGTH_UNITS: readonly ModelLengthUnit[] = ['mm', 'cm', 'm', 'in', 'ft'] as const;

export const DEFAULT_MODEL_SOURCE_UNITS: ModelLengthUnit = 'mm';

/** Metres per one unit (multiply a value in `unit` by this to get metres). */
export const METRES_PER_UNIT: Record<ModelLengthUnit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
};

export function isModelLengthUnit(v: unknown): v is ModelLengthUnit {
  return typeof v === 'string' && (MODEL_LENGTH_UNITS as readonly string[]).includes(v);
}

export function ensureModelSourceUnits(u?: string | null): ModelLengthUnit {
  return isModelLengthUnit(u) ? u : DEFAULT_MODEL_SOURCE_UNITS;
}

export function unitToMetres(value: number, unit: ModelLengthUnit): number {
  return value * METRES_PER_UNIT[unit];
}

export function metresToUnit(value: number, unit: ModelLengthUnit): number {
  return value / METRES_PER_UNIT[unit];
}

/** Three.js uniform scale to convert mesh vertices from `sourceUnits` → metres. */
export function unitScaleToMetres(unit: ModelLengthUnit): number {
  return METRES_PER_UNIT[unit];
}


/** Sensible slider range for position edits in the given display unit. */
export function positionSliderRange(unit: ModelLengthUnit): { min: number; max: number; step: number } {
  switch (unit) {
    case 'mm':
      return { min: -5000, max: 5000, step: 1 };
    case 'cm':
      return { min: -500, max: 500, step: 0.1 };
    case 'm':
      return { min: -5, max: 5, step: 0.001 };
    case 'in':
      return { min: -200, max: 200, step: 0.1 };
    case 'ft':
      return { min: -16, max: 16, step: 0.01 };
  }
}
