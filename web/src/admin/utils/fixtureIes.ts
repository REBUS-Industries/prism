import type { FixtureBeam } from '../../shared/api';

/** Standard DMX zoom positions manufacturers ship IES sets for. */
export const IES_ZOOM_DMX_SLOTS = [0, 128, 255] as const;

export type IesZoomDmx = (typeof IES_ZOOM_DMX_SLOTS)[number];

export interface FixtureIesProfile {
  zoomDmx: number;
  iesAssetId: string;
}

/** IES asset id for a beam at a given zoom DMX value (0–255). */
export function iesAssetForZoom(beam: FixtureBeam, zoomDmx: number): string | null {
  const profiles = beam.iesProfiles ?? [];
  const hit = profiles.find((p) => p.zoomDmx === zoomDmx);
  if (hit) return hit.iesAssetId;
  // Legacy single-profile uploads map to the middle zoom slot.
  if (!profiles.length && beam.iesAssetId && zoomDmx === 128) return beam.iesAssetId;
  return null;
}

export function iesProfileCount(beam: FixtureBeam): number {
  let n = (beam.iesProfiles ?? []).length;
  if (!n && beam.iesAssetId) n = 1;
  return n;
}

/** Human label for a zoom slot — includes beam angle when the fixture has a zoom range. */
export function iesZoomSlotLabel(zoomDmx: number, beam: FixtureBeam): string {
  const min = beam.zoomMinAngle;
  const max = beam.zoomMaxAngle;
  const role = zoomDmx === 0 ? 'wide' : zoomDmx === 255 ? 'narrow' : 'mid';
  if (min != null && max != null && max > min) {
    const t = zoomDmx / 255;
    const angle = max + (min - max) * t;
    return `Zoom ${zoomDmx} (${role}, ~${angle.toFixed(1)}°)`;
  }
  return `Zoom ${zoomDmx} (${role})`;
}
