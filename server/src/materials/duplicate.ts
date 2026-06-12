/**
 * Deep-copy a material: new row, cloned texture files, slot assignments, and
 * parameters. Used by duplicate (standalone copy) and branch (lineage) routes.
 */
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { materials, materialTextures, textures } from '../db/schema.js';

const DATA_DIR = process.env.PRISM_DATA_DIR ?? process.env.DATA_DIR ?? '/data/prism';
const TEXTURES_ROOT = resolve(DATA_DIR, 'textures');

function sanitiseFilename(input: string): string {
  const base = input.replace(/[\\/]+/g, '_');
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'texture';
}

export function defaultCopyName(sourceName: string, branch: boolean): string {
  const suffix = branch ? ' (branch)' : ' (copy)';
  const max = 256 - suffix.length;
  return `${sourceName.slice(0, max)}${suffix}`;
}

export interface DuplicateMaterialOptions {
  name?: string;
  /** When true, record lineage via `branchedFromId` on the new material. */
  branch?: boolean;
  adminId?: string | null;
  apiKeyId?: string | null;
}

export async function duplicateMaterial(
  sourceId: string,
  options: DuplicateMaterialOptions = {},
): Promise<string> {
  const source = await db.query.materials.findFirst({
    where: and(eq(materials.id, sourceId), isNull(materials.deletedAt)),
  });
  if (!source) throw new Error('not found');

  const slotRows = await db
    .select({
      slot: materialTextures.slot,
      textureId: materialTextures.textureId,
    })
    .from(materialTextures)
    .where(eq(materialTextures.materialId, sourceId));

  const textureIds = [...new Set(slotRows.map((r) => r.textureId))];
  if (source.thumbnailTextureId) textureIds.push(source.thumbnailTextureId);

  const textureRows = textureIds.length
    ? await db
        .select()
        .from(textures)
        .where(and(inArray(textures.id, textureIds), isNull(textures.deletedAt)))
    : [];
  const textureById = new Map(textureRows.map((t) => [t.id, t]));

  const { adminId = null, apiKeyId = null, branch = false } = options;
  const newMaterialId = randomUUID();
  const newName = (options.name?.trim() || defaultCopyName(source.name, branch)).slice(0, 256);
  const copiedTextureId = new Map<string, string>();
  const writtenPaths: string[] = [];

  async function ensureCopiedTexture(
    srcTex: typeof textures.$inferSelect,
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ): Promise<string> {
    const existing = copiedTextureId.get(srcTex.id);
    if (existing) return existing;

    const body = await readFile(srcTex.storagePath);
    const newTextureId = randomUUID();
    const storagePath = resolve(TEXTURES_ROOT, `${newTextureId}_${sanitiseFilename(srcTex.originalFilename)}`);
    await writeFile(storagePath, body);
    writtenPaths.push(storagePath);

    await tx.insert(textures).values({
      id: newTextureId,
      originalFilename: srcTex.originalFilename,
      displayName: srcTex.displayName ?? srcTex.originalFilename,
      contentType: srcTex.contentType,
      sizeBytes: body.length,
      storagePath,
      tags: Array.isArray(srcTex.tags) ? [...srcTex.tags] : [],
      uploadedByAdminId: adminId,
      uploadedByApiKeyId: apiKeyId,
    });
    copiedTextureId.set(srcTex.id, newTextureId);
    return newTextureId;
  }

  try {
    await db.transaction(async (tx) => {
      await tx.insert(materials).values({
        id: newMaterialId,
        name: newName,
        description: source.description,
        tags: Array.isArray(source.tags) ? [...source.tags] : [],
        parameters: source.parameters,
        thumbnailTextureId: null,
        branchedFromId: branch ? sourceId : null,
        groupId: source.groupId,
        createdByAdminId: adminId,
        createdByApiKeyId: apiKeyId,
      });

      let thumbnailTextureId: string | null = null;
      for (const row of slotRows) {
        const srcTex = textureById.get(row.textureId);
        if (!srcTex) continue;
        const newTextureId = await ensureCopiedTexture(srcTex, tx);
        await tx.insert(materialTextures).values({
          materialId: newMaterialId,
          slot: row.slot,
          textureId: newTextureId,
        });
        if (row.slot === 'albedo') thumbnailTextureId = newTextureId;
      }

      if (!thumbnailTextureId && source.thumbnailTextureId) {
        const thumbSrc = textureById.get(source.thumbnailTextureId);
        if (thumbSrc) thumbnailTextureId = await ensureCopiedTexture(thumbSrc, tx);
      }

      if (thumbnailTextureId) {
        await tx
          .update(materials)
          .set({ thumbnailTextureId, updatedAt: new Date() })
          .where(eq(materials.id, newMaterialId));
      }
    });
  } catch (err) {
    await Promise.all(writtenPaths.map((p) => unlink(p).catch(() => { /* already gone */ })));
    throw err;
  }

  return newMaterialId;
}
