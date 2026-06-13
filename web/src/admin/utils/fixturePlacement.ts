/** Read the fixture-body Z drop stored in definition metadata (metres, GDTF Z-up). */
export function fixtureZOffsetM(metadata: Record<string, unknown> | undefined): number {
  const v = metadata?.fixtureZOffsetM;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

export const REBUS_CLAMP_MODEL_ID = 'rebus-clamp';
