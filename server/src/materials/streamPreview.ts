import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyReply } from 'fastify';
import type { textures } from '../db/schema.js';
import { materialPreviewEtag } from './previewUrl.js';

const MATERIAL_PREVIEW_CACHE = 'private, max-age=31536000, immutable';

type TextureRow = Pick<
  typeof textures.$inferSelect,
  'id' | 'originalFilename' | 'contentType' | 'storagePath' | 'sizeBytes'
>;

export async function streamTexturePreviewBody(
  row: TextureRow,
  reply: FastifyReply,
  opts: {
    cacheControl?: string;
    etag?: string;
    ifNoneMatch?: string | string[];
  } = {},
): Promise<unknown> {
  const etag = opts.etag;
  const incoming = opts.ifNoneMatch;
  const match = Array.isArray(incoming) ? incoming.join(', ') : incoming;
  if (etag && match === etag) {
    reply.header('etag', etag);
    if (opts.cacheControl) reply.header('cache-control', opts.cacheControl);
    return reply.code(304).send();
  }

  const s = await stat(row.storagePath);
  reply.header('content-type', row.contentType);
  reply.header('content-length', String(s.size));
  reply.header('content-disposition', `inline; filename="${encodeURIComponent(row.originalFilename)}"`);
  if (opts.cacheControl) reply.header('cache-control', opts.cacheControl);
  if (etag) reply.header('etag', etag);
  return reply.send(createReadStream(row.storagePath));
}

export async function streamMaterialPreview(
  material: {
    thumbnailTextureId: string | null;
    updatedAt: Date;
  },
  texture: TextureRow,
  reply: FastifyReply,
  ifNoneMatch?: string | string[],
): Promise<unknown> {
  if (!material.thumbnailTextureId) {
    return reply.code(404).send({ error: 'no preview' });
  }
  return streamTexturePreviewBody(texture, reply, {
    cacheControl: MATERIAL_PREVIEW_CACHE,
    etag: materialPreviewEtag(material.thumbnailTextureId, material.updatedAt),
    ifNoneMatch,
  });
}
