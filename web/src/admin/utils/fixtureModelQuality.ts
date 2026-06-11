/** Mirror of prism-fixtures-service GdtfModelQuality — keep in sync. */
export type GdtfModelQuality = 'low' | 'default' | 'high';

export const GDTF_MODEL_QUALITIES: readonly GdtfModelQuality[] = ['high', 'default', 'low'] as const;

export const GDTF_MODEL_QUALITY_LABELS: Record<GdtfModelQuality, string> = {
  high: 'High resolution',
  default: 'Default (real-time)',
  low: 'Low (distant LOD)',
};

export const DEFAULT_GDTF_MODEL_QUALITY: GdtfModelQuality = 'high';

export function modelQualityFromDefinition(
  metadata: Record<string, unknown> | undefined,
): GdtfModelQuality | null {
  const raw = metadata?.modelQuality;
  return raw === 'low' || raw === 'default' || raw === 'high' ? raw : null;
}

/** Qualities detected from the GDTF package at import; null when not yet scanned. */
export function availableModelQualitiesFromDefinition(
  metadata: Record<string, unknown> | undefined,
): GdtfModelQuality[] | null {
  const raw = metadata?.availableModelQualities;
  if (!Array.isArray(raw)) return null;
  const filtered = GDTF_MODEL_QUALITIES.filter((q) => raw.includes(q));
  return filtered.length ? filtered : null;
}

export function defaultModelQualityForAvailable(
  available: readonly GdtfModelQuality[],
): GdtfModelQuality {
  for (const q of GDTF_MODEL_QUALITIES) {
    if (available.includes(q)) return q;
  }
  return 'default';
}

export function coerceModelQuality(
  value: GdtfModelQuality,
  available: readonly GdtfModelQuality[] | null | undefined,
): GdtfModelQuality {
  if (!available?.length) return value;
  if (available.includes(value)) return value;
  return defaultModelQualityForAvailable(available);
}
