import type { FixtureDefinition } from '../../shared/api';

/** Approximate CIE xyY → CSS rgb for wheel swatches. */
export function cieColorToCss(cie?: string): string | null {
  if (!cie) return null;
  const parts = cie.split(',').map((s) => parseFloat(s.trim()));
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return null;
  const [x, y] = parts;
  const Y = parts[2] ?? 1;
  if (y <= 0) return null;
  const X = (x * Y) / y;
  const Z = ((1 - x - y) * Y) / y;
  let r = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
  let g = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
  let b = X * 0.0557 + Y * -0.2040 + Z * 1.0570;
  const max = Math.max(r, g, b, 0.001);
  r = Math.round(Math.min(255, Math.max(0, (r / max) * 255)));
  g = Math.round(Math.min(255, Math.max(0, (g / max) * 255)));
  b = Math.round(Math.min(255, Math.max(0, (b / max) * 255)));
  return `rgb(${r}, ${g}, ${b})`;
}

export function dmxModeCount(definition: FixtureDefinition | null, catalogModes = 0): number {
  if (definition?.dmxMapping?.modes && Array.isArray(definition.dmxMapping.modes)) {
    return definition.dmxMapping.modes.length;
  }
  return catalogModes;
}

export function wheelSlotCount(definition: FixtureDefinition | null): number {
  if (!definition?.wheels?.length) return 0;
  return definition.wheels.reduce((sum, w) => sum + (w.slots?.length ?? 0), 0);
}

export interface FixtureImageAsset {
  mediaId: string;
  filename: string;
  kind: string;
  label: string;
}

export function imageAssetsFromDefinition(
  definition: FixtureDefinition | null,
  fixtureId: string | null,
): FixtureImageAsset[] {
  if (!definition || !fixtureId) return [];
  const raw = definition.metadata?.images;
  if (!Array.isArray(raw)) {
    const thumbId = definition.metadata?.thumbnailMediaId;
    if (typeof thumbId === 'string') {
      return [{
        mediaId: thumbId,
        filename: String(definition.fixtureInformation.thumbnail ?? 'thumbnail'),
        kind: 'thumbnail',
        label: 'thumbnail.png',
      }];
    }
    return [];
  }
  return raw.map((item, i) => {
    const o = item as Record<string, unknown>;
    const filename = String(o.filename ?? `image-${i + 1}`);
    const kind = String(o.kind ?? 'image');
    const ext = filename.includes('.') ? '' : (kind.includes('svg') ? '.svg' : '.png');
    return {
      mediaId: String(o.mediaId ?? ''),
      filename,
      kind,
      label: filename.includes('.') ? filename : `${filename}${ext}`,
    };
  }).filter((a) => a.mediaId);
}
