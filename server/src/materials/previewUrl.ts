/** Relative URL for a material card preview image (cache-busted on edit). */
export function materialPreviewUrl(
  materialId: string,
  updatedAt: Date | string,
  thumbnailTextureId: string | null | undefined,
): string | null {
  if (!thumbnailTextureId) return null;
  const ts = typeof updatedAt === 'string' ? Date.parse(updatedAt) : updatedAt.getTime();
  if (!Number.isFinite(ts)) return `/api/materials/${materialId}/preview`;
  return `/api/materials/${materialId}/preview?v=${ts}`;
}

/** Stable ETag for a material preview — changes when the thumbnail or material is updated. */
export function materialPreviewEtag(thumbnailTextureId: string, updatedAt: Date | string): string {
  const ts = typeof updatedAt === 'string' ? Date.parse(updatedAt) : updatedAt.getTime();
  return `"${thumbnailTextureId}-${ts}"`;
}
