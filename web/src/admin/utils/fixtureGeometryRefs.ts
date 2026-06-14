import type { FixturePart } from '../../shared/api';

export function collectReferencedGeometryIds(parts: FixturePart[]): Set<string> {
  const ids = new Set<string>();
  for (const p of parts) {
    const meta = (p.metadata ?? {}) as {
      isGeometryReference?: boolean;
      referencedGeometryId?: string;
    };
    if (meta.isGeometryReference && meta.referencedGeometryId) {
      ids.add(meta.referencedGeometryId);
    }
  }
  return ids;
}

/**
 * Shared BeamPixel-style library geometry: flagged by the parser (v6+) or inferred
 * on the web when any GeometryReference points at this geometry id (pre-v7 defs).
 */
export function isLibraryGeometryPart(
  part: FixturePart,
  referencedGeomIds: Set<string>,
): boolean {
  const meta = (part.metadata ?? {}) as { isGeometryTemplate?: boolean };
  if (meta.isGeometryTemplate) return true;
  const gid = part.sourceGdtfGeometryId;
  return !!gid && referencedGeomIds.has(gid);
}
