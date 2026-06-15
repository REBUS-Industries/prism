export type ModelCategoryOption = { value: string; label: string };

/** Predefined model library categories (stored lowercase). */
export const MODEL_CATEGORY_OPTIONS: readonly ModelCategoryOption[] = [
  { value: '', label: '—' },
  { value: 'truss', label: 'Truss' },
  { value: 'clamp', label: 'Clamp' },
  { value: 'staging', label: 'Staging' },
  { value: 'audio', label: 'Audio' },
  { value: 'video', label: 'Video' },
  { value: 'lighting', label: 'Lighting' },
  { value: 'speaker', label: 'Speaker' },
  { value: 'projector', label: 'Projector' },
  { value: 'rigging', label: 'Rigging' },
  { value: 'scenery', label: 'Scenery' },
  { value: 'other', label: 'Other' },
];

const KNOWN_VALUES = new Set(
  MODEL_CATEGORY_OPTIONS.map((o) => o.value).filter(Boolean),
);

export function isKnownModelCategory(value: string): boolean {
  return KNOWN_VALUES.has(value.toLowerCase());
}

/** Map stored value to select value; known categories normalize to lowercase. */
export function normalizeModelCategory(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  const match = MODEL_CATEGORY_OPTIONS.find(
    (o) => o.value && o.value.toLowerCase() === trimmed.toLowerCase(),
  );
  return match?.value ?? trimmed;
}

/** Options for `<select>` — includes a one-off entry when the model has an unknown category. */
export function modelCategorySelectOptions(current: string | null | undefined): ModelCategoryOption[] {
  const normalized = normalizeModelCategory(current);
  if (!normalized || isKnownModelCategory(normalized)) {
    return [...MODEL_CATEGORY_OPTIONS];
  }
  return [...MODEL_CATEGORY_OPTIONS, { value: normalized, label: normalized }];
}

export function modelCategoryLabel(value: string | null | undefined): string {
  const normalized = normalizeModelCategory(value);
  if (!normalized) return '—';
  const match = MODEL_CATEGORY_OPTIONS.find((o) => o.value === normalized);
  return match?.label ?? normalized;
}
