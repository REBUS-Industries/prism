/**
 * Dynamic fixture-category ("Fixture Types") store.
 *
 * Fetches the user-managed palette from `/api/fixtures/categories` once and
 * caches it for the session. Components read labels + colours from here
 * instead of the hardcoded constants in utils/fixtureTypes.ts (which now only
 * serve as the server-side seed defaults), so anything created/edited in
 * Settings → Fixture Types flows straight through to the library list stripes,
 * the type dropdown, and the detail panel.
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { fixtureTypesApi, type ApiError, type FixtureCategoryConfig } from '../../shared/api';
import {
  ASSIGNABLE_FIXTURE_CATEGORIES,
  FIXTURE_CATEGORY_COLORS,
  LIBRARY_FIXTURE_CATEGORIES,
  type LibraryFixtureCategory,
} from '../utils/fixtureTypes';

const FALLBACK_COLOR = '#4b5563';

export const useFixtureTypesStore = defineStore('fixtureTypes', () => {
  const categories = ref<FixtureCategoryConfig[]>([]);
  const loaded = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const ready = computed(() => loaded.value && categories.value.length > 0);

  /** All labels in display order (includes the protected `Unassigned`).
   *  Falls back to the hardcoded seed list until the fetch resolves. */
  const labels = computed<string[]>(() =>
    ready.value ? categories.value.map((c) => c.label) : [...LIBRARY_FIXTURE_CATEGORIES],
  );
  /** Selectable labels — excludes the default fallback (`Unassigned`). */
  const assignableLabels = computed<string[]>(() =>
    ready.value
      ? categories.value.filter((c) => !c.isDefault).map((c) => c.label)
      : [...ASSIGNABLE_FIXTURE_CATEGORIES],
  );

  /** Resolve a category label (case-insensitive) to its configured colour.
   *  Falls back to the seed palette (then grey) before the fetch resolves. */
  function colorFor(label: string | null | undefined): string {
    if (!label) return FALLBACK_COLOR;
    const lower = label.toLowerCase();
    const hit = categories.value.find((c) => c.label.toLowerCase() === lower);
    if (hit) return hit.color;
    const seed = LIBRARY_FIXTURE_CATEGORIES.find((c) => c.toLowerCase() === lower);
    return seed ? FIXTURE_CATEGORY_COLORS[seed as LibraryFixtureCategory] : FALLBACK_COLOR;
  }

  function sortInPlace(list: FixtureCategoryConfig[]): FixtureCategoryConfig[] {
    return [...list].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }

  async function reload(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await fixtureTypesApi.list();
      categories.value = sortInPlace(res.categories);
      loaded.value = true;
    } catch (e) {
      error.value = (e as ApiError).message ?? 'failed to load fixture types';
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /** Fetch once; safe to call from every component's onMounted. */
  async function ensureLoaded(): Promise<void> {
    if (loaded.value || loading.value) return;
    try {
      await reload();
    } catch {
      /* error is surfaced via `error` ref; callers fall back to defaults */
    }
  }

  async function create(label: string, color: string): Promise<FixtureCategoryConfig> {
    const res = await fixtureTypesApi.create({ label, color });
    await reload();
    return res.category;
  }

  async function update(
    id: string,
    body: { label?: string; color?: string; order?: number },
  ): Promise<FixtureCategoryConfig> {
    const res = await fixtureTypesApi.update(id, body);
    await reload();
    return res.category;
  }

  async function remove(id: string, reassign = false): Promise<void> {
    await fixtureTypesApi.remove(id, reassign);
    await reload();
  }

  async function reorder(ids: string[]): Promise<void> {
    const res = await fixtureTypesApi.reorder(ids);
    categories.value = sortInPlace(res.categories);
  }

  return {
    categories,
    loaded,
    loading,
    error,
    labels,
    assignableLabels,
    colorFor,
    reload,
    ensureLoaded,
    create,
    update,
    remove,
    reorder,
  };
});
