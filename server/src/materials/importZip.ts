/**
 * Shared ZIP → material import used by POST /api/materials/import and external providers.
 */
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { materials, materialTextures, textures } from '../db/schema.js';
import {
  ALLOWED_SLOTS,
  detectSlot,
  imageContentType,
  isImageFilename,
  megascansImportParameters,
} from './slots.js';
import { normalizeTextureBody } from './textureNormalize.js';
import { parseGltfMaterialZip } from './gltfImport.js';
import type { MaterialParametersPatch } from './parameters.js';

const DATA_DIR = process.env.PRISM_DATA_DIR ?? process.env.DATA_DIR ?? '/data/prism';
const TEXTURES_ROOT = resolve(DATA_DIR, 'textures');

export const MAX_MATERIAL_ZIP_BYTES = 500 * 1024 * 1024;

function sanitiseFilename(input: string): string {
  const base = input.replace(/[\\/]+/g, '_');
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'texture';
}

function baseName(entryName: string): string {
  const norm = entryName.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  return slash === -1 ? norm : norm.slice(slash + 1);
}

export interface ImportZipOptions {
  name?: string;
  zipFilename?: string;
  tags?: string[];
  adminId: string | null;
  apiKeyId: string | null;
}

export interface ImportZipResult {
  materialId: string;
  skipped: string[];
}

async function writeMaterialFromDetected(
  detected: Map<string, { base: string; contentType: string; data: Buffer }>,
  options: {
    name: string;
    tags: string[];
    parametersPatch?: MaterialParametersPatch;
    adminId: string | null;
    apiKeyId: string | null;
  },
): Promise<ImportZipResult> {
  const { name, tags, parametersPatch, adminId, apiKeyId } = options;
  const skipped: string[] = [];
  const writtenPaths: string[] = [];

  try {
    const materialId = await db.transaction(async (tx) => {
      const insertedMaterial = await tx
        .insert(materials)
        .values({
          name,
          tags,
          ...(parametersPatch ? { parameters: parametersPatch } : {}),
          createdByAdminId: adminId,
          createdByApiKeyId: apiKeyId,
        })
        .returning({ id: materials.id });
      const newMaterialId = insertedMaterial[0]!.id;

      let thumbnailTextureId: string | null = null;
      const textureIdByFilename = new Map<string, string>();
      for (const slot of ALLOWED_SLOTS) {
        const det = detected.get(slot);
        if (!det) continue;

        let textureId = textureIdByFilename.get(det.base);
        if (!textureId) {
          let body: Buffer;
          let storageName: string;
          let contentType: string;
          try {
            const normalized = await normalizeTextureBody(det.data, det.base, det.contentType);
            body = normalized.data;
            storageName = normalized.storageFilename;
            contentType = normalized.contentType;
          } catch {
            skipped.push(det.base);
            continue;
          }
          textureId = randomUUID();
          const storagePath = resolve(TEXTURES_ROOT, `${textureId}_${sanitiseFilename(storageName)}`);
          await writeFile(storagePath, body);
          writtenPaths.push(storagePath);

          await tx.insert(textures).values({
            id: textureId,
            originalFilename: det.base.slice(0, 256),
            displayName: det.base.slice(0, 256),
            contentType,
            sizeBytes: body.length,
            storagePath,
            tags: [],
            uploadedByAdminId: adminId,
            uploadedByApiKeyId: apiKeyId,
          });
          textureIdByFilename.set(det.base, textureId);
        }

        await tx.insert(materialTextures).values({ materialId: newMaterialId, slot, textureId });
        if (slot === 'albedo') thumbnailTextureId = textureId;
      }

      if (thumbnailTextureId) {
        await tx
          .update(materials)
          .set({ thumbnailTextureId, updatedAt: new Date() })
          .where(eq(materials.id, newMaterialId));
      }
      return newMaterialId;
    });

    return { materialId, skipped };
  } catch (err) {
    await Promise.all(writtenPaths.map((p) => unlink(p).catch(() => { /* already gone */ })));
    throw err;
  }
}

function parseZipEntries(zipBuffer: Buffer): {
  detected: Map<string, { base: string; contentType: string; data: Buffer }>;
  skipped: string[];
  parametersPatch?: MaterialParametersPatch;
  defaultName?: string;
} {
  let entries: AdmZip.IZipEntry[];
  try {
    entries = new AdmZip(zipBuffer).getEntries();
  } catch {
    throw new Error('invalid zip archive');
  }

  const detected = new Map<string, { base: string; contentType: string; data: Buffer }>();
  let skipped: string[] = [];
  let parametersPatch: MaterialParametersPatch | undefined;

  const gltfImport = parseGltfMaterialZip(entries);
  if (gltfImport) {
    for (const slot of ALLOWED_SLOTS) {
      const tex = gltfImport.slots[slot];
      if (tex) detected.set(slot, { base: tex.filename, contentType: tex.contentType, data: tex.data });
    }
    skipped = gltfImport.skipped;
    if (Object.keys(gltfImport.parameters).length) parametersPatch = gltfImport.parameters;
    return { detected, skipped, parametersPatch, defaultName: gltfImport.materialName };
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const base = baseName(entry.entryName);
    if (!base) continue;
    const contentType = imageContentType(base);
    const slot = isImageFilename(base) ? detectSlot(base) : null;
    if (!contentType || !slot || detected.has(slot)) {
      skipped.push(base);
      continue;
    }
    detected.set(slot, { base, contentType, data: entry.getData() });
  }

  const assignedFilenames: Partial<Record<(typeof ALLOWED_SLOTS)[number], string>> = {};
  for (const slot of ALLOWED_SLOTS) {
    const det = detected.get(slot);
    if (det) assignedFilenames[slot] = det.base;
  }
  const megascansParams = megascansImportParameters(assignedFilenames);
  if (Object.keys(megascansParams).length) {
    parametersPatch = { ...parametersPatch, ...megascansParams };
  }

  return { detected, skipped, parametersPatch };
}

export async function importMaterialZipBuffer(
  zipBuffer: Buffer,
  options: ImportZipOptions,
): Promise<ImportZipResult> {
  if (zipBuffer.length === 0) throw new Error('zip is empty');
  if (zipBuffer.length > MAX_MATERIAL_ZIP_BYTES) {
    throw new Error(`zip too large (max ${MAX_MATERIAL_ZIP_BYTES} bytes)`);
  }

  await mkdir(TEXTURES_ROOT, { recursive: true }).catch(() => { /* race-tolerant */ });

  const { detected, skipped: parseSkipped, parametersPatch, defaultName } = parseZipEntries(zipBuffer);
  const zipBase = (options.zipFilename || '').replace(/\.zip$/i, '');
  const name = (options.name?.trim() || defaultName?.trim() || zipBase || 'Imported material').slice(0, 256);
  const tags = options.tags ?? [];

  const result = await writeMaterialFromDetected(detected, {
    name,
    tags,
    parametersPatch,
    adminId: options.adminId,
    apiKeyId: options.apiKeyId,
  });
  return { materialId: result.materialId, skipped: [...parseSkipped, ...result.skipped] };
}
