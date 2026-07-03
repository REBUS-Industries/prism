import type { FixtureBeam, FixtureDefinition, FixturePart } from '../../shared/api';

/** Standard DMX zoom positions manufacturers ship IES sets for. */
export const IES_ZOOM_DMX_SLOTS = [0, 128, 255] as const;

export type IesZoomDmx = (typeof IES_ZOOM_DMX_SLOTS)[number];

/** Human-readable beam title — never the internal UUID beamId. */
export function beamDisplayLabel(beam: FixtureBeam, parts: FixturePart[] = []): string {
  const part = beam.parentPartId ? parts.find((p) => p.partId === beam.parentPartId) : undefined;
  const type = beam.beamType?.trim();
  const partName = part?.name?.trim();
  if (type && partName && type.toLowerCase() !== partName.toLowerCase()) {
    return `${partName} — ${type}`;
  }
  if (type) return type;
  if (partName) return partName;
  return 'Light beam';
}

/** Optional detail line under the beam title (emitter part tag, flux). */
export function beamDisplayDetail(beam: FixtureBeam, parts: FixturePart[] = []): string | null {
  const part = beam.parentPartId ? parts.find((p) => p.partId === beam.parentPartId) : undefined;
  const bits: string[] = [];
  if (part?.tag) bits.push(part.tag);
  if (beam.luminousFlux) bits.push(`${beam.luminousFlux} lm`);
  return bits.length ? bits.join(' · ') : null;
}

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

/** True when any beam carries an uploaded IES profile (legacy or zoom-keyed). */
export function fixtureHasIesProfiles(definition: FixtureDefinition | null | undefined): boolean {
  return (definition?.beams ?? []).some((b) => iesProfileCount(b) > 0);
}

// ---------------------------------------------------------------------------
// Beam grouping — identical beams (e.g. every pixel/head) share one IES upload.
// ---------------------------------------------------------------------------

/** Strip a trailing instance index so "Beam Pixel 1" / "Head 2" / "Yoke3" collapse. */
function stripInstanceIndex(name: string): string {
  return name.replace(/[\s_-]*\d+$/, '').trim() || name;
}

interface PartMeta { referencedGeometryId?: string }

/**
 * Group key for "similar" beams: same beam type + same source geometry family
 * (the referenced template for instanced cells, otherwise the de-indexed parent
 * geometry name) + same zoom range. Instances of one pixel/head template collapse
 * into a single group so the IES is uploaded once for all of them.
 */
function iesGroupKey(beam: FixtureBeam, parts: FixturePart[]): string {
  const parent = beam.parentPartId ? parts.find((p) => p.partId === beam.parentPartId) : undefined;
  const ref = (parent?.metadata as PartMeta | undefined)?.referencedGeometryId;
  const family = ref
    ?? stripInstanceIndex(parent?.sourceGdtfGeometryId ?? parent?.name ?? beam.beamType ?? 'beam');
  const zoom = `${beam.zoomMinAngle ?? ''}-${beam.zoomMaxAngle ?? ''}`;
  return `${beam.beamType ?? 'beam'}|${family}|${zoom}`;
}

export interface IesBeamGroup {
  key: string;
  /** Representative beam (carries zoom range + label basis). */
  representative: FixtureBeam;
  beams: FixtureBeam[];
  label: string;
  detail: string | null;
}

/** Collapse a fixture's beams into groups of identical beams for IES upload. */
export function groupBeamsForIes(beams: FixtureBeam[], parts: FixturePart[] = []): IesBeamGroup[] {
  const byKey = new Map<string, FixtureBeam[]>();
  for (const beam of beams) {
    const key = iesGroupKey(beam, parts);
    const list = byKey.get(key) ?? byKey.set(key, []).get(key)!;
    list.push(beam);
  }
  return [...byKey.entries()].map(([key, list]) => {
    const representative = list[0]!;
    const parent = representative.parentPartId
      ? parts.find((p) => p.partId === representative.parentPartId)
      : undefined;
    const baseName = stripInstanceIndex(parent?.name ?? '');
    const type = representative.beamType?.trim();
    const namePart = baseName || type || 'Light beam';
    const label = list.length > 1 ? `${namePart} ×${list.length}` : beamDisplayLabel(representative, parts);
    return { key, representative, beams: list, label, detail: beamDisplayDetail(representative, parts) };
  });
}

export type IesGroupStatus = 'all' | 'partial' | 'none';

/** Whether every / some / no beams in a group have an IES at the given zoom slot. */
export function iesGroupStatus(group: IesBeamGroup, zoomDmx: number): IesGroupStatus {
  const withIes = group.beams.filter((b) => iesAssetForZoom(b, zoomDmx) != null).length;
  if (withIes === 0) return 'none';
  if (withIes === group.beams.length) return 'all';
  return 'partial';
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
