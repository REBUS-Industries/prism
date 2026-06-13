/**
 * Persist a rendered material preview PNG as a library texture and point the
 * material's thumbnailTextureId at it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { materials, textures } from '../db/schema.js';
import { normalizeTextureBody } from './textureNormalize.js';

const DATA_DIR = process.env.PRISM_DATA_DIR ?? process.env.DATA_DIR ?? '/data/prism';
const TEXTURES_ROOT = resolve(DATA_DIR, 'textures');

const PREVIEW_TAG = 'material-preview';
export const MAX_MATERIAL_THUMBNAIL_BYTES = 2 * 1024 * 1024;

function sanitiseFilename(input: string): string {
  const base = input.replace(/[\\/]+/g, '_');
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'preview.png';
}

export interface SaveMaterialThumbnailOpts {
  materialId: string;
  body: Buffer;
  filename?: string;
  mime?: string;
  adminId: string | null;
  apiKeyId: string | null;
}

/** Returns the new thumbnail texture id, or throws on validation / not-found. */
export async function saveMaterialThumbnail(opts: SaveMaterialThumbnailOpts): Promise<string> {
  const { materialId, body, filename = 'preview.png', mime = 'image/png' } = opts;
  if (body.length === 0) throw new Error('thumbnail is empty');
  if (body.length > MAX_MATERIAL_THUMBNAIL_BYTES) throw new Error('thumbnail too large');

  const material = await db.query.materials.findFirst({
    where: and(eq(materials.id, materialId), isNull(materials.deletedAt)),
  });
  if (!material) throw new Error('not found');

  await mkdir(TEXTURES_ROOT, { recursive: true }).catch(() => { /* race-tolerant */ });

  let normalized;
  try {
    normalized = await normalizeTextureBody(body, filename, mime);
  } catch {
    throw new Error('unsupported image format');
  }

  const inserted = await db
    .insert(textures)
    .values({
      originalFilename: filename.slice(0, 256),
      displayName: `${material.name} preview`.slice(0, 256),
      contentType: normalized.contentType,
      sizeBytes: normalized.data.length,
      storagePath: '',
      tags: [PREVIEW_TAG],
      uploadedByAdminId: opts.adminId,
      uploadedByApiKeyId: opts.apiKeyId,
    })
    .returning({ id: textures.id });

  const textureId = inserted[0]!.id;
  const storagePath = resolve(TEXTURES_ROOT, `${textureId}_${sanitiseFilename(normalized.storageFilename)}`);
  await writeFile(storagePath, normalized.data);

  await db.update(textures).set({ storagePath }).where(eq(textures.id, textureId));

  await db
    .update(materials)
    .set({ thumbnailTextureId: textureId, updatedAt: new Date() })
    .where(eq(materials.id, materialId));

  return textureId;
}

export function isMaterialPreviewTag(tags: unknown): boolean {
  return Array.isArray(tags) && tags.includes(PREVIEW_TAG);
}
