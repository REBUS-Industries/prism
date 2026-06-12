/**
 * Poly Haven texture map selection + slot filename helpers.
 */
import type { MaterialSlot } from '../materials/slots.js';

export interface PolyHavenFileEntry {
  url: string;
  size: number;
  md5?: string;
}

export type PolyHavenFilesTree = Record<
  string,
  Record<string, Record<string, PolyHavenFileEntry>>
>;

/** Map Poly Haven channel names to PRISM slots (first match wins). */
export const POLYHAVEN_MAP_SLOTS: Array<{ map: string; slot: MaterialSlot; filenameToken: string }> = [
  { map: 'Diffuse', slot: 'albedo', filenameToken: '_diff' },
  { map: 'nor_gl', slot: 'normal', filenameToken: '_nor_gl' },
  { map: 'nor_dx', slot: 'normal', filenameToken: '_nor_dx' },
  { map: 'Rough', slot: 'roughness', filenameToken: '_rough' },
  { map: 'AO', slot: 'ao', filenameToken: '_ao' },
  { map: 'Displacement', slot: 'displacement', filenameToken: '_disp' },
];

const RESOLUTION_ORDER = ['1k', '2k', '4k', '8k', '16k'] as const;
const FORMAT_PREF = ['jpg', 'png', 'exr'] as const;

export function pickResolution(
  available: string[],
  preferred: string,
): string | null {
  const prefIdx = RESOLUTION_ORDER.indexOf(preferred as typeof RESOLUTION_ORDER[number]);
  const sorted = [...available].sort(
    (a, b) => RESOLUTION_ORDER.indexOf(a as typeof RESOLUTION_ORDER[number])
      - RESOLUTION_ORDER.indexOf(b as typeof RESOLUTION_ORDER[number]),
  );
  if (prefIdx >= 0) {
    const atOrBelow = sorted.filter(
      (r) => RESOLUTION_ORDER.indexOf(r as typeof RESOLUTION_ORDER[number]) <= prefIdx,
    );
    if (atOrBelow.length) return atOrBelow.at(-1)!;
  }
  return sorted[0] ?? null;
}

export function pickMapFile(
  mapTree: Record<string, Record<string, PolyHavenFileEntry>> | undefined,
  resolution: string,
): PolyHavenFileEntry | null {
  if (!mapTree) return null;
  const resNode = mapTree[resolution] ?? mapTree[pickResolution(Object.keys(mapTree), resolution)!];
  if (!resNode) return null;
  for (const fmt of FORMAT_PREF) {
    const entry = resNode[fmt];
    if (entry?.url) return entry;
  }
  const anyFmt = Object.values(resNode)[0];
  return anyFmt?.url ? anyFmt : null;
}

export interface SelectedPolyHavenMap {
  slot: MaterialSlot;
  map: string;
  filename: string;
  url: string;
  size: number;
}

export function selectPolyHavenMaps(
  files: PolyHavenFilesTree,
  assetId: string,
  resolution: string,
): SelectedPolyHavenMap[] {
  const selected: SelectedPolyHavenMap[] = [];
  const usedSlots = new Set<MaterialSlot>();

  for (const { map, slot, filenameToken } of POLYHAVEN_MAP_SLOTS) {
    if (usedSlots.has(slot)) continue;
    const file = pickMapFile(files[map], resolution);
    if (!file) continue;
    const ext = file.url.split('.').pop()?.split('?')[0] ?? 'jpg';
    selected.push({
      slot,
      map,
      filename: `${assetId}${filenameToken}_${resolution}.${ext}`,
      url: file.url,
      size: file.size,
    });
    usedSlots.add(slot);
  }
  return selected;
}

export function estimatePolyHavenDownloadSize(
  files: PolyHavenFilesTree,
  resolution: string,
): number {
  return selectPolyHavenMaps(files, 'estimate', resolution)
    .reduce((sum, m) => sum + m.size, 0);
}

/** Human-readable labels for Poly Haven channel keys. */
export const POLYHAVEN_MAP_LABELS: Record<string, string> = {
  Diffuse: 'Albedo',
  nor_gl: 'Normal',
  nor_dx: 'Normal',
  Rough: 'Roughness',
  AO: 'AO',
  Displacement: 'Displacement',
};

export function listPolyHavenResolutions(files: PolyHavenFilesTree): string[] {
  const resolutions = new Set<string>();
  for (const mapTree of Object.values(files)) {
    for (const res of Object.keys(mapTree)) resolutions.add(res);
  }
  return [...resolutions].sort(
    (a, b) => RESOLUTION_ORDER.indexOf(a as typeof RESOLUTION_ORDER[number])
      - RESOLUTION_ORDER.indexOf(b as typeof RESOLUTION_ORDER[number]),
  );
}

export function listPolyHavenMapLabels(files: PolyHavenFilesTree, resolution: string): string[] {
  const labels: string[] = [];
  const usedSlots = new Set<MaterialSlot>();
  for (const { map, slot } of POLYHAVEN_MAP_SLOTS) {
    if (usedSlots.has(slot)) continue;
    if (!pickMapFile(files[map], resolution)) continue;
    const label = POLYHAVEN_MAP_LABELS[map] ?? map;
    if (!labels.includes(label)) labels.push(label);
    usedSlots.add(slot);
  }
  return labels;
}

export function defaultPolyHavenResolution(
  available: string[],
  preferred = '2k',
): string | null {
  return pickResolution(available, preferred) ?? available[0] ?? null;
}

/** Diffuse/albedo map URL at a resolution — used for detail preview when switching resolution. */
export function polyHavenPreviewUrl(
  files: PolyHavenFilesTree,
  resolution: string,
): string | null {
  return pickMapFile(files.Diffuse, resolution)?.url ?? null;
}

export function buildPolyHavenPreviewUrlByResolution(
  files: PolyHavenFilesTree,
  resolutions: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const resolution of resolutions) {
    const url = polyHavenPreviewUrl(files, resolution);
    if (url) out[resolution] = url;
  }
  return out;
}
