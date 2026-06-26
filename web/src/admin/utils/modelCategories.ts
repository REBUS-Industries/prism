import { modelsApi, type ModelCategoryOption } from '../../shared/api';

export type { ModelCategoryOption };

const EMPTY_OPTION: ModelCategoryOption = { value: '', label: '—' };

/** Offline fallback when the models service is unreachable. */
const FALLBACK_CATEGORIES: ModelCategoryOption[] = [
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

/** @deprecated Use loadModelCategories() — kept for backwards compatibility during migration. */
export const MODEL_CATEGORY_OPTIONS: readonly ModelCategoryOption[] = [
  EMPTY_OPTION,
  ...FALLBACK_CATEGORIES,
];

let cachedPalette: ModelCategoryOption[] | null = null;

function paletteWithEmpty(categories: ModelCategoryOption[]): ModelCategoryOption[] {
  return [EMPTY_OPTION, ...categories.filter((c) => c.value)];
}

/** Fetch the category palette from GET /api/models/categories (cached for the session). */
export async function loadModelCategories(force = false): Promise<ModelCategoryOption[]> {
  if (cachedPalette && !force) return cachedPalette;
  try {
    const res = await modelsApi.categories();
    cachedPalette = paletteWithEmpty(res.categories);
  } catch {
    cachedPalette = paletteWithEmpty(FALLBACK_CATEGORIES);
  }
  return cachedPalette;
}

function activeOptions(): ModelCategoryOption[] {
  return cachedPalette ?? MODEL_CATEGORY_OPTIONS;
}

const knownValues = (): Set<string> =>
  new Set(activeOptions().map((o) => o.value).filter(Boolean).map((v) => v.toLowerCase()));

export function isKnownModelCategory(value: string): boolean {
  return knownValues().has(value.trim().toLowerCase());
}

/** Map stored value to select value; known categories normalize to lowercase. */
export function normalizeModelCategory(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  const match = activeOptions().find(
    (o) => o.value && o.value.toLowerCase() === trimmed.toLowerCase(),
  );
  return match?.value ?? trimmed;
}

/** Options for `<select>` — includes a one-off entry when the model has an unknown category. */
export function modelCategorySelectOptions(current: string | null | undefined): ModelCategoryOption[] {
  const normalized = normalizeModelCategory(current);
  const base = activeOptions();
  if (!normalized || isKnownModelCategory(normalized)) return [...base];
  return [...base, { value: normalized, label: normalized }];
}

export function modelCategoryLabel(value: string | null | undefined): string {
  const normalized = normalizeModelCategory(value);
  if (!normalized) return '—';
  const match = activeOptions().find((o) => o.value === normalized);
  return match?.label ?? normalized;
}

/** Filter chips for the library list (excludes the empty option). */
export function modelCategoryFilterOptions(): ModelCategoryOption[] {
  return activeOptions().filter((o) => o.value);
}
