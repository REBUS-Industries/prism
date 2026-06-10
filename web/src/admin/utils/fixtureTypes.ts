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

const CATEGORY_LOOKUP = new Set(
  LIBRARY_FIXTURE_CATEGORIES.filter((c) => c !== 'Unassigned').map((c) => c.toLowerCase()),
);

export function fixtureCategoryFromTags(tags: string[]): LibraryFixtureCategory {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (CATEGORY_LOOKUP.has(lower)) {
      return LIBRARY_FIXTURE_CATEGORIES.find((c) => c.toLowerCase() === lower)!;
    }
  }
  return 'Unassigned';
}

export function tagsWithFixtureCategory(tags: string[], category: LibraryFixtureCategory): string[] {
  const rest = tags.filter((t) => !CATEGORY_LOOKUP.has(t.toLowerCase()));
  if (category === 'Unassigned') return rest;
  return [category, ...rest];
}

/** Selectable categories (excludes Unassigned in download modal default list). */
export const ASSIGNABLE_FIXTURE_CATEGORIES = LIBRARY_FIXTURE_CATEGORIES.filter(
  (c) => c !== 'Unassigned',
);
