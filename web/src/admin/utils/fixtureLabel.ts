/**
 * Human-facing fixture label.
 *
 * Returns the optional custom "pretty" name (`displayName`) when it is a
 * non-empty string after trimming, otherwise the canonical fixture `name`.
 * The custom name is a label only — keep using `id` / `manufacturer` /
 * `fixtureName` for keys, sorting groups, and GDTF identity displays.
 */
export function fixtureLabel(f: { displayName?: string | null; name: string }): string {
  return f.displayName?.trim() || f.name;
}
