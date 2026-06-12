/**
 * Load a material with slot assignments — shared by materials + external import routes.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { materials, materialTextures, textures } from '../db/schema.js';
import { ALLOWED_SLOTS } from './slots.js';
import { type MaterialParameters, mergeParameters } from './parameters.js';

const SLOTS_TOTAL = ALLOWED_SLOTS.length;

export interface SlotAssignment {
  slot: string;
  textureId: string;
  assignedAt: string;
  texture: {
    id: string;
    displayName: string;
    originalFilename: string;
    contentType: string;
    sizeBytes: number;
  };
}

export interface MaterialDetail {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  thumbnailTextureId: string | null;
  branchedFromId: string | null;
  groupId: string | null;
  createdByAdminId: string | null;
  createdByApiKeyId: string | null;
  createdAt: string;
  updatedAt: string;
  parameters: MaterialParameters;
  slotsTotal: number;
  slotsFilled: number;
  slots: SlotAssignment[];
}

export async function loadMaterialDetail(id: string): Promise<MaterialDetail | null> {
  const m = await db.query.materials.findFirst({
    where: and(eq(materials.id, id), isNull(materials.deletedAt)),
  });
  if (!m) return null;

  const slotRows = await db
    .select({
      slot: materialTextures.slot,
      textureId: materialTextures.textureId,
      assignedAt: materialTextures.assignedAt,
      texId: textures.id,
      texDisplayName: textures.displayName,
      texOriginalFilename: textures.originalFilename,
      texContentType: textures.contentType,
      texSizeBytes: textures.sizeBytes,
    })
    .from(materialTextures)
    .innerJoin(textures, eq(textures.id, materialTextures.textureId))
    .where(eq(materialTextures.materialId, id));

  const slots: SlotAssignment[] = slotRows
    .map((r) => ({
      slot: r.slot,
      textureId: r.textureId,
      assignedAt: r.assignedAt.toISOString(),
      texture: {
        id: r.texId,
        displayName: r.texDisplayName ?? r.texOriginalFilename,
        originalFilename: r.texOriginalFilename,
        contentType: r.texContentType,
        sizeBytes: r.texSizeBytes,
      },
    }))
    .sort((a, b) => ALLOWED_SLOTS.indexOf(a.slot as never) - ALLOWED_SLOTS.indexOf(b.slot as never));

  return {
    id: m.id,
    name: m.name,
    description: m.description,
    tags: Array.isArray(m.tags) ? m.tags : [],
    thumbnailTextureId: m.thumbnailTextureId,
    branchedFromId: m.branchedFromId ?? null,
    groupId: m.groupId ?? null,
    createdByAdminId: m.createdByAdminId,
    createdByApiKeyId: m.createdByApiKeyId,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    parameters: mergeParameters(m.parameters),
    slotsTotal: SLOTS_TOTAL,
    slotsFilled: slots.length,
    slots,
  };
}

export { SLOTS_TOTAL };
