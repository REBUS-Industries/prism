/** Read the fixture-body Z drop stored in definition metadata (metres, GDTF Z-up). */
export function fixtureZOffsetM(metadata: Record<string, unknown> | undefined): number {
  const v = metadata?.fixtureZOffsetM;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

export const REBUS_CLAMP_MODEL_ID = 'rebus-clamp';
export const REBUS_CLAMP_PART_ID = 'rebus-clamp-part';

export interface ClampPlacement {
  /** Duplicate the clamp mesh mirrored across GDTF Y (depth) for dual omega brackets. */
  mirrorY: boolean;
  /** Rotate clamp(s) around GDTF Z through the fixture origin (degrees). */
  rotateZDeg: number;
}

export function readClampPlacement(metadata: Record<string, unknown> | undefined): ClampPlacement {
  const rot = metadata?.clampRotateZDeg;
  return {
    mirrorY: metadata?.clampMirrorY === true,
    rotateZDeg: typeof rot === 'number' && Number.isFinite(rot) ? rot : 0,
  };
}

/** Model Library id for the REBUS clamp mesh (alternative to per-fixture upload). */
export function readClampModelLibraryId(metadata: Record<string, unknown> | undefined): string | null {
  const id = metadata?.clampModelLibraryId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
