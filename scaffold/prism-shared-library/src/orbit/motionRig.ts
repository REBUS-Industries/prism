import type { FixturePart, FixturePartTag, MotionAxis, Vec3 } from '../contracts/fixtures.js';

export type MotionAxisType = MotionAxis['axisType'];

/** Orbit `FixtureType.motionRig[]` row — includes publish-only denormalised fields. */
export interface OrbitMotionAxis extends MotionAxis {
  controlledPartTag?: FixturePartTag;
  realFade?: number;
  realAcceleration?: number;
}

export interface OrbitMotionSummaryEntry {
  motionAxisId: string;
  axisType: MotionAxisType;
  controlledPartId?: string;
  controlledPartTag?: FixturePartTag;
  minValue: number;
  maxValue: number;
}

export function partTagById(
  parts: FixturePart[],
  partId?: string | null,
): FixturePartTag | undefined {
  if (!partId) return undefined;
  return parts.find((p) => p.partId === partId)?.tag;
}

/**
 * Resolve PAN/TILT from explicit axis type, controlled part tag, or geometry name.
 * Matches PRISM admin `effectiveAxisType()` and `buildFixtureAssembly()` fallbacks.
 */
export function effectiveMotionAxisType(
  axis: Pick<MotionAxis, 'axisType' | 'controlledPartId' | 'sourceGdtfGeometryId'>,
  parts: FixturePart[],
): MotionAxisType {
  if (axis.axisType === 'PAN' || axis.axisType === 'TILT') return axis.axisType;
  const tag = partTagById(parts, axis.controlledPartId);
  const name = (axis.sourceGdtfGeometryId ?? '').toLowerCase();
  if (tag === 'YOKE' || name.includes('pan')) return 'PAN';
  if (tag === 'HEAD' || name.includes('tilt')) return 'TILT';
  return axis.axisType;
}

/** PRISM preview / assembly convention — type-based axes in GDTF Z-up space. */
export function axisVectorForMotionType(axisType: MotionAxisType, fallback?: Vec3): Vec3 {
  if (axisType === 'PAN') return { x: 0, y: 0, z: 1 };
  if (axisType === 'TILT') return { x: 1, y: 0, z: 0 };
  if (fallback && (fallback.x !== 0 || fallback.y !== 0 || fallback.z !== 0)) return fallback;
  return { x: 0, y: 0, z: 1 };
}

/** Physical pan/tilt range from active DMX mode logical channels when present. */
export function dmxPhysicalRangeForPanTilt(
  dmxMapping: Record<string, unknown> | undefined,
  type: 'PAN' | 'TILT',
): { min: number; max: number } | null {
  const attr = type === 'PAN' ? 'pan' : 'tilt';
  const modeList = dmxMapping?.modes;
  if (!Array.isArray(modeList)) return null;
  for (const mode of modeList as Array<Record<string, unknown>>) {
    const channels = Array.isArray(mode.channels)
      ? (mode.channels as Array<Record<string, unknown>>)
      : [];
    for (const ch of channels) {
      const lcs = Array.isArray(ch.logicalChannels)
        ? (ch.logicalChannels as Array<Record<string, unknown>>)
        : [];
      for (const lc of lcs) {
        const fns = Array.isArray(lc.functions)
          ? (lc.functions as Array<Record<string, unknown>>)
          : [];
        for (const fn of fns) {
          const a = String(fn.attribute ?? lc.attribute ?? '').toLowerCase();
          if (a !== attr) continue;
          const pf = parseFloat(String(fn.physicalFrom ?? ''));
          const pt = parseFloat(String(fn.physicalTo ?? ''));
          if (!Number.isNaN(pf) && !Number.isNaN(pt) && Math.abs(pt - pf) > 1) {
            return { min: Math.min(pf, pt), max: Math.max(pf, pt) };
          }
        }
      }
    }
  }
  return null;
}

/**
 * Normalise one motion axis for Orbit publish so third-party viewers and Rhino
 * plugins can drive pan/tilt without re-implementing PRISM heuristics.
 */
export function normalizeMotionAxisForOrbit(
  axis: MotionAxis,
  parts: FixturePart[],
  dmxMapping?: Record<string, unknown>,
): OrbitMotionAxis {
  const axisType = effectiveMotionAxisType(axis, parts);
  const controlledPartTag = partTagById(parts, axis.controlledPartId);
  const range =
    axisType === 'PAN' || axisType === 'TILT'
      ? dmxPhysicalRangeForPanTilt(dmxMapping, axisType)
      : null;
  const axisVector =
    axisType === 'PAN' || axisType === 'TILT'
      ? axisVectorForMotionType(axisType)
      : axisVectorForMotionType(axisType, axis.axisVector);

  return {
    ...axis,
    axisType,
    axisVector,
    ...(controlledPartTag ? { controlledPartTag } : {}),
    ...(range ? { minValue: range.min, maxValue: range.max } : {}),
  };
}

/** Normalise the full rig and keep Collection `motionSummary` in sync. */
export function normalizeMotionRigForOrbit(
  motionRig: MotionAxis[],
  parts: FixturePart[],
  dmxMapping?: Record<string, unknown>,
): OrbitMotionAxis[] {
  return motionRig.map((axis) => normalizeMotionAxisForOrbit(axis, parts, dmxMapping));
}

export function buildOrbitMotionSummary(motionRig: OrbitMotionAxis[]): OrbitMotionSummaryEntry[] {
  return motionRig.map((axis) => ({
    motionAxisId: axis.motionAxisId,
    axisType: axis.axisType,
    ...(axis.controlledPartId ? { controlledPartId: axis.controlledPartId } : {}),
    ...(axis.controlledPartTag ? { controlledPartTag: axis.controlledPartTag } : {}),
    minValue: axis.minValue,
    maxValue: axis.maxValue,
  }));
}
