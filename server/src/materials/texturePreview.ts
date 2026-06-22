/** Relative URL for embedding a texture image in portals or admin UI. */
export function texturePreviewUrl(textureId: string): string {
  return `/api/textures/${textureId}/preview`;
}
