/** Mirror of prism-shared/src/contracts/fixtures.ts — keep in sync. */

export const LIBRARY_FIXTURE_CATEGORIES = [
  'Unassigned',
  'Spot',
  'Wash',
  'Beam',
  'Strobe',
  'Followspot',
  'Conventional',
] as const;

export type LibraryFixtureCategory = (typeof LIBRARY_FIXTURE_CATEGORIES)[number];

export const FIXTURE_CATEGORY_COLORS: Record<LibraryFixtureCategory, string> = {
  Unassigned: '#4b5563',
  Spot: '#ef4444',
  Wash: '#3b82f6',
  Beam: '#f97316',
  Strobe: '#22c55e',
  Followspot: '#a855f7',
  Conventional: '#ec4899',
};

/** Selectable categories (excludes Unassigned in download modal default list). */
export const ASSIGNABLE_FIXTURE_CATEGORIES = LIBRARY_FIXTURE_CATEGORIES.filter(
  (c) => c !== 'Unassigned',
);

/**
 * Resolve a fixture's category from its tags.
 *
 * `knownCategories` defaults to the hardcoded seed list so existing 1-arg
 * call sites behave exactly as before; the dynamic store passes its live
 * `assignableLabels` so user-created categories resolve too. Matching is
 * case-insensitive and returns the canonical-cased label.
 */
export function fixtureCategoryFromTags(
  tags: string[],
  knownCategories: readonly string[] = ASSIGNABLE_FIXTURE_CATEGORIES,
): string {
  const lookup = new Map(knownCategories.map((c) => [c.toLowerCase(), c]));
  for (const tag of tags) {
    const hit = lookup.get(tag.toLowerCase());
    if (hit) return hit;
  }
  return 'Unassigned';
}

/**
 * Replace whichever category tag is present with `category` (stored as the
 * first tag). `knownCategories` defaults to the seed list for backwards
 * compatibility; pass the dynamic labels so custom categories are stripped
 * correctly on reassignment. `Unassigned` (or empty) clears the category.
 */
export function tagsWithFixtureCategory(
  tags: string[],
  category: string,
  knownCategories: readonly string[] = ASSIGNABLE_FIXTURE_CATEGORIES,
): string[] {
  const lookup = new Set(knownCategories.map((c) => c.toLowerCase()));
  const rest = tags.filter((t) => !lookup.has(t.toLowerCase()));
  if (!category || category.toLowerCase() === 'unassigned') return rest;
  return [category, ...rest];
}
