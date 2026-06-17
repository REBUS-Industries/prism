/**
 * /api/materials — PBR materials store.
 *
 * A material is a named bundle of PBR slot assignments (albedo / normal /
 * roughness / metallic / ao / emissive / opacity / displacement). Slots
 * reference rows in the shared texture library (see api/textures.ts) through
 * the `material_textures` join table, so the same texture can back many
 * materials. Materials can be created blank and filled slot-by-slot, exported
 * as a ZIP (texture bodies + a manifest), or created in bulk by importing a
 * Megascans-style ZIP whose entries are matched to slots by filename, or a
 * packaged glTF / GLB whose material texture references are mapped to slots.
 *
 * Each material also carries editable PBR `parameters` (base colour,
 * roughness/metallic/opacity, emissive, UV tiling/offset, etc. — see
 * materials/parameters.ts) stored as a partial jsonb and served complete via
 * read-time defaulting. They map onto a three.js MeshStandardMaterial.
 *
 * Surface:
 *
 *   GET    /api/materials                     list (q / tags / cursor / limit)
 *   POST   /api/materials                     create blank material      (write)
 *   GET    /api/materials/:id                 full detail (slots + textures + parameters)
 *   PUT    /api/materials/:id                 rename / retag / set params / groupId (write)
 *   PUT    /api/materials/:id/parameters      merge PBR parameters       (write)
 *   DELETE /api/materials/:id                 soft-delete                (delete)
 *   PUT    /api/materials/:id/slots/:slot     assign a texture to a slot (write)
 *   DELETE /api/materials/:id/slots/:slot     clear a slot               (write)
 *   GET    /api/materials/:id/download        stream a ZIP of the material
 *   POST   /api/materials/import              ZIP -> material (Megascans or glTF) (write)
 *   POST   /api/materials/:id/duplicate       deep-copy material + textures     (write)
 *   POST   /api/materials/:id/branch          branch (copy with lineage)        (write)
 *
 * Reads require `materials:read`; admin sessions and ORBIT bearers bypass
 * scope checks as usual (see auth/middleware.ts requireScope).
 */
import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { ZipArchive } from 'archiver';
import { db } from '../db/client.js';
import { materials, materialGroups, materialTextures, textures } from '../db/schema.js';
import { requireAuth, requireScope, requireTool } from '../auth/middleware.js';
import type { Principal } from '../auth/principal.js';
import { ALLOWED_SLOTS, isMaterialSlot } from '../materials/slots.js';
import { importMaterialZipBuffer, MAX_MATERIAL_ZIP_BYTES } from '../materials/importZip.js';
import { duplicateMaterial } from '../materials/duplicate.js';
import { loadMaterialDetail, SLOTS_TOTAL } from '../materials/loadDetail.js';
import { saveMaterialThumbnail, MAX_MATERIAL_THUMBNAIL_BYTES } from '../materials/saveThumbnail.js';
import {
  type MaterialParametersPatch,
  materialParametersSchema,
  mergeParameters,
} from '../materials/parameters.js';

const DATA_DIR = process.env.PRISM_DATA_DIR ?? process.env.DATA_DIR ?? '/data/prism';
const TEXTURES_ROOT = resolve(DATA_DIR, 'textures');

// Megascans 8K sets routinely run into the hundreds of MB once every channel
// is bundled; cap the import body generously below the 1 GB multipart ceiling.
const MAX_ZIP_BYTES = MAX_MATERIAL_ZIP_BYTES;

const idParam = z.object({ id: z.string().uuid() });
const tagsSchema = z.array(z.string().min(1).max(64)).max(64);

const createBody = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(8192).optional(),
  tags: tagsSchema.optional(),
});

const updateBody = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(8192).nullable().optional(),
  tags: tagsSchema.optional(),
  parameters: materialParametersSchema.optional(),
  groupId: z.string().uuid().nullable().optional(),
});

const assignBody = z.object({ textureId: z.string().uuid() });

const copyBody = z.object({
  name: z.string().min(1).max(256).optional(),
});

/** A read-modify-write-free shallow jsonb merge of a validated parameters
 * partial onto whatever is already stored — mirrors the `jobs.outputs`
 * merge in api/internal.ts. The column is NOT NULL, but COALESCE keeps the
 * expression safe against any legacy NULL. */
function parametersMergeSql(patch: MaterialParametersPatch) {
  return sql`COALESCE(${materials.parameters}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

/** Sanitise a filename for use on disk / inside the export ZIP. */
function sanitiseFilename(input: string): string {
  const base = input.replace(/[\\/]+/g, '_');
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'texture';
}

function fieldValue(fields: unknown, name: string): string | undefined {
  const bag = fields as Record<string, unknown> | undefined;
  const raw = bag?.[name];
  const one = Array.isArray(raw) ? raw[0] : raw;
  const node = one as { type?: string; value?: unknown } | undefined;
  if (node && node.type === 'field' && node.value != null) return String(node.value);
  return undefined;
}

function provenance(principal: Principal | undefined) {
  return {
    adminId: principal?.kind === 'adminSession' ? principal.adminUserId : null,
    apiKeyId: principal?.kind === 'apiKey' ? principal.apiKeyId : null,
  };
}

/**
 * Append 'external-edited' to the material's tags if it was imported from an
 * external provider (has 'external-import' tag) but has not yet been marked
 * edited. Called whenever a slot or parameter is changed after initial import.
 * No-op for non-external materials; idempotent if already tagged.
 */
async function maybeMarkExternalEdited(materialId: string): Promise<void> {
  await db.execute(sql`
    UPDATE ${materials}
    SET tags = tags || ARRAY['external-edited']::text[]
    WHERE id = ${materialId}
      AND tags @> ARRAY['external-import']::text[]
      AND NOT tags @> ARRAY['external-edited']::text[]
      AND deleted_at IS NULL
  `);
}

const slotsFilledSql = sql<number>`(
  select count(*)::int from ${materialTextures} mt where mt.material_id = ${materials.id}
)`;

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTool('materials'));
  await mkdir(TEXTURES_ROOT, { recursive: true }).catch(() => { /* race-tolerant */ });

  /* ---------- GET /api/materials ---------- */
  app.get<{ Querystring: { q?: string; tags?: string; cursor?: string; limit?: string } }>('/', {
    preHandler: [requireAuth, requireScope('materials:read')],
  }, async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
    const offset = Math.max(Number(req.query.cursor ?? 0), 0);
    const q = (req.query.q ?? '').trim();
    const tags = (req.query.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);

    const conditions = [isNull(materials.deletedAt)];
    if (q) {
      conditions.push(or(ilike(materials.name, `%${q}%`), ilike(materials.description, `%${q}%`))!);
    }
    if (tags.length) {
      conditions.push(sql`${materials.tags} && ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[]`);
    }

    const rows = await db
      .select({
        id: materials.id,
        name: materials.name,
        description: materials.description,
        tags: materials.tags,
        thumbnailTextureId: materials.thumbnailTextureId,
        branchedFromId: materials.branchedFromId,
        groupId: materials.groupId,
        createdAt: materials.createdAt,
        updatedAt: materials.updatedAt,
        slotsFilled: slotsFilledSql,
      })
      .from(materials)
      .where(and(...conditions))
      .orderBy(desc(materials.createdAt))
      .limit(limit)
      .offset(offset);

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      tags: Array.isArray(r.tags) ? r.tags : [],
      thumbnailTextureId: r.thumbnailTextureId,
      branchedFromId: r.branchedFromId ?? null,
      groupId: r.groupId ?? null,
      slotsFilled: Number(r.slotsFilled ?? 0),
      slotsTotal: SLOTS_TOTAL,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    const nextCursor = rows.length === limit ? String(offset + rows.length) : null;
    return { materials: items, limit, cursor: String(offset), nextCursor };
  });

  /* ---------- POST /api/materials ---------- */
  app.post<{ Body: unknown }>('/', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });

    const { adminId, apiKeyId } = provenance(req.principal);
    const inserted = await db
      .insert(materials)
      .values({
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        tags: parsed.data.tags ?? [],
        createdByAdminId: adminId,
        createdByApiKeyId: apiKeyId,
      })
      .returning({ id: materials.id });

    const detail = await loadMaterialDetail(inserted[0]!.id);
    return reply.code(201).send(detail);
  });

  /* ---------- GET /api/materials/:id ---------- */
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: [requireAuth, requireScope('materials:read')],
  }, async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid id' });
    const detail = await loadMaterialDetail(parsed.data.id);
    if (!detail) return reply.code(404).send({ error: 'not found' });
    return reply.send(detail);
  });

  /* ---------- PUT /api/materials/:id ---------- */
  app.put<{ Params: { id: string }; Body: unknown }>('/:id', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsedId = idParam.safeParse(req.params);
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid id' });
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });

    const patch: Partial<typeof materials.$inferInsert> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.tags !== undefined) patch.tags = parsed.data.tags;
    if (parsed.data.parameters !== undefined) patch.parameters = parametersMergeSql(parsed.data.parameters);
    if (parsed.data.groupId !== undefined) {
      if (parsed.data.groupId === null) {
        patch.groupId = null;
      } else {
        const group = await db.query.materialGroups.findFirst({
          where: eq(materialGroups.id, parsed.data.groupId),
        });
        if (!group) return reply.code(400).send({ error: 'group not found' });
        patch.groupId = parsed.data.groupId;
      }
    }

    const updated = await db
      .update(materials)
      .set(patch)
      .where(and(eq(materials.id, parsedId.data.id), isNull(materials.deletedAt)))
      .returning({ id: materials.id });
    if (!updated[0]) return reply.code(404).send({ error: 'not found' });
    return reply.send(await loadMaterialDetail(parsedId.data.id));
  });

  /* ---------- PUT /api/materials/:id/parameters ---------- */
  // Focused endpoint for live PBR edits: accepts a partial parameters object,
  // shallow-merges it into the stored jsonb and bumps updatedAt, without
  // touching name/description/tags. The SPA debounces slider/colour changes
  // here so they never clobber the metadata form.
  app.put<{ Params: { id: string }; Body: unknown }>('/:id/parameters', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsedId = idParam.safeParse(req.params);
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid id' });
    const parsed = materialParametersSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });

    const updated = await db
      .update(materials)
      .set({ parameters: parametersMergeSql(parsed.data), updatedAt: new Date() })
      .where(and(eq(materials.id, parsedId.data.id), isNull(materials.deletedAt)))
      .returning({ id: materials.id });
    if (!updated[0]) return reply.code(404).send({ error: 'not found' });
    await maybeMarkExternalEdited(parsedId.data.id);
    return reply.send(await loadMaterialDetail(parsedId.data.id));
  });

  /* ---------- DELETE /api/materials/:id ---------- */
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [requireAuth, requireScope('materials:delete')],
  }, async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid id' });
    const updated = await db
      .update(materials)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(materials.id, parsed.data.id), isNull(materials.deletedAt)))
      .returning({ id: materials.id });
    if (!updated[0]) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });

  /* ---------- PUT /api/materials/:id/slots/:slot ---------- */
  app.put<{ Params: { id: string; slot: string }; Body: unknown }>('/:id/slots/:slot', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsedId = idParam.safeParse({ id: req.params.id });
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid id' });
    const slot = req.params.slot.toLowerCase();
    if (!isMaterialSlot(slot)) {
      return reply.code(400).send({ error: 'invalid slot', allowedSlots: [...ALLOWED_SLOTS] });
    }
    const parsed = assignBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });

    const material = await db.query.materials.findFirst({
      where: and(eq(materials.id, parsedId.data.id), isNull(materials.deletedAt)),
    });
    if (!material) return reply.code(404).send({ error: 'material not found' });

    const texture = await db.query.textures.findFirst({
      where: and(eq(textures.id, parsed.data.textureId), isNull(textures.deletedAt)),
    });
    if (!texture) return reply.code(404).send({ error: 'texture not found' });

    await db
      .insert(materialTextures)
      .values({ materialId: parsedId.data.id, slot, textureId: parsed.data.textureId })
      .onConflictDoUpdate({
        target: [materialTextures.materialId, materialTextures.slot],
        set: { textureId: parsed.data.textureId, assignedAt: new Date() },
      });

    await db
      .update(materials)
      .set({ updatedAt: new Date(), ...(slot === 'albedo' ? { thumbnailTextureId: parsed.data.textureId } : {}) })
      .where(eq(materials.id, parsedId.data.id));

    await maybeMarkExternalEdited(parsedId.data.id);
    return reply.send(await loadMaterialDetail(parsedId.data.id));
  });

  /* ---------- DELETE /api/materials/:id/slots/:slot ---------- */
  app.delete<{ Params: { id: string; slot: string } }>('/:id/slots/:slot', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsedId = idParam.safeParse({ id: req.params.id });
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid id' });
    const slot = req.params.slot.toLowerCase();
    if (!isMaterialSlot(slot)) {
      return reply.code(400).send({ error: 'invalid slot', allowedSlots: [...ALLOWED_SLOTS] });
    }

    const material = await db.query.materials.findFirst({
      where: and(eq(materials.id, parsedId.data.id), isNull(materials.deletedAt)),
    });
    if (!material) return reply.code(404).send({ error: 'material not found' });

    await db
      .delete(materialTextures)
      .where(and(eq(materialTextures.materialId, parsedId.data.id), eq(materialTextures.slot, slot)));

    // The thumbnail mirrors the albedo slot — clearing albedo clears it too.
    await db
      .update(materials)
      .set({ updatedAt: new Date(), ...(slot === 'albedo' ? { thumbnailTextureId: null } : {}) })
      .where(eq(materials.id, parsedId.data.id));

    await maybeMarkExternalEdited(parsedId.data.id);
    return reply.send(await loadMaterialDetail(parsedId.data.id));
  });

  /* ---------- POST /api/materials/:id/duplicate ---------- */
  app.post<{ Params: { id: string }; Body: unknown }>('/:id/duplicate', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsedId = idParam.safeParse(req.params);
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid id' });
    const parsed = copyBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });

    const { adminId, apiKeyId } = provenance(req.principal);
    try {
      const newId = await duplicateMaterial(parsedId.data.id, {
        name: parsed.data.name,
        branch: false,
        adminId,
        apiKeyId,
      });
      return reply.code(201).send(await loadMaterialDetail(newId));
    } catch (err) {
      if (err instanceof Error && err.message === 'not found') {
        return reply.code(404).send({ error: 'not found' });
      }
      req.log.error({ err }, 'material duplicate failed');
      return reply.code(500).send({ error: 'duplicate failed' });
    }
  });

  /* ---------- POST /api/materials/:id/branch ---------- */
  app.post<{ Params: { id: string }; Body: unknown }>('/:id/branch', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsedId = idParam.safeParse(req.params);
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid id' });
    const parsed = copyBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });

    const { adminId, apiKeyId } = provenance(req.principal);
    try {
      const newId = await duplicateMaterial(parsedId.data.id, {
        name: parsed.data.name,
        branch: true,
        adminId,
        apiKeyId,
      });
      return reply.code(201).send(await loadMaterialDetail(newId));
    } catch (err) {
      if (err instanceof Error && err.message === 'not found') {
        return reply.code(404).send({ error: 'not found' });
      }
      req.log.error({ err }, 'material branch failed');
      return reply.code(500).send({ error: 'branch failed' });
    }
  });

  /* ---------- POST /api/materials/:id/thumbnail ---------- */
  // Client-captured GlbViewer sphere PNG — stored as a tagged texture and set
  // as thumbnailTextureId so the materials grid can show a static preview.
  app.post<{ Params: { id: string } }>('/:id/thumbnail', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsedId = idParam.safeParse(req.params);
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid id' });
    if (!req.isMultipart()) return reply.code(415).send({ error: 'multipart/form-data required' });

    const part = await req.file({ limits: { fileSize: MAX_MATERIAL_THUMBNAIL_BYTES + 1 } });
    if (!part) return reply.code(400).send({ error: 'file part missing' });

    const chunks: Buffer[] = [];
    let bytesSoFar = 0;
    for await (const chunk of part.file) {
      const buf = chunk as Buffer;
      bytesSoFar += buf.length;
      if (bytesSoFar > MAX_MATERIAL_THUMBNAIL_BYTES || part.file.truncated) {
        return reply.code(413).send({ error: 'thumbnail too large', maxBytes: MAX_MATERIAL_THUMBNAIL_BYTES });
      }
      chunks.push(buf);
    }
    if (part.file.truncated) {
      return reply.code(413).send({ error: 'thumbnail too large', maxBytes: MAX_MATERIAL_THUMBNAIL_BYTES });
    }

    const { adminId, apiKeyId } = provenance(req.principal);
    try {
      await saveMaterialThumbnail({
        materialId: parsedId.data.id,
        body: Buffer.concat(chunks, bytesSoFar),
        filename: part.filename || 'preview.png',
        mime: (part.mimetype || 'image/png').toLowerCase().split(';')[0]!.trim(),
        adminId,
        apiKeyId,
      });
      await maybeMarkExternalEdited(parsedId.data.id);
      return reply.send(await loadMaterialDetail(parsedId.data.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'thumbnail upload failed';
      if (message === 'not found') return reply.code(404).send({ error: 'not found' });
      if (message === 'thumbnail is empty') return reply.code(400).send({ error: message });
      if (message === 'thumbnail too large') {
        return reply.code(413).send({ error: message, maxBytes: MAX_MATERIAL_THUMBNAIL_BYTES });
      }
      if (message === 'unsupported image format') return reply.code(415).send({ error: message });
      req.log.error({ err }, 'material thumbnail upload failed');
      return reply.code(500).send({ error: 'thumbnail upload failed' });
    }
  });

  /* ---------- GET /api/materials/:id/download ---------- */
  app.get<{ Params: { id: string } }>('/:id/download', {
    preHandler: [requireAuth, requireScope('materials:read')],
  }, async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid id' });

    const material = await db.query.materials.findFirst({
      where: and(eq(materials.id, parsed.data.id), isNull(materials.deletedAt)),
    });
    if (!material) return reply.code(404).send({ error: 'not found' });

    const slotRows = await db
      .select({
        slot: materialTextures.slot,
        textureId: materialTextures.textureId,
        originalFilename: textures.originalFilename,
        contentType: textures.contentType,
        storagePath: textures.storagePath,
      })
      .from(materialTextures)
      .innerJoin(textures, eq(textures.id, materialTextures.textureId))
      .where(eq(materialTextures.materialId, parsed.data.id));

    const manifestSlots: Record<string, { textureId: string; filename: string; contentType: string }> = {};
    const files: Array<{ name: string; path: string }> = [];
    for (const r of slotRows) {
      const name = `${r.slot}_${sanitiseFilename(r.originalFilename)}`;
      try {
        await stat(r.storagePath);
      } catch {
        continue; // body missing on disk — omit from the archive + manifest
      }
      files.push({ name, path: r.storagePath });
      manifestSlots[r.slot] = { textureId: r.textureId, filename: name, contentType: r.contentType };
    }

    const manifest = {
      materialId: material.id,
      name: material.name,
      parameters: mergeParameters(material.parameters),
      slots: manifestSlots,
    };
    const zipName = `${sanitiseFilename(material.name)}.zip`;

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on('warning', (err) => req.log.warn({ err }, 'material zip warning'));
    archive.on('error', (err) => req.log.error({ err }, 'material zip error'));

    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${encodeURIComponent(zipName)}"`);

    for (const f of files) archive.file(f.path, { name: f.name });
    archive.append(Buffer.from(JSON.stringify(manifest, null, 2)), { name: 'manifest.json' });
    void archive.finalize();

    return reply.send(archive);
  });

  /* ---------- POST /api/materials/import ---------- */
  app.post('/import', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(415).send({ error: 'multipart/form-data required' });

    const part = await req.file({ limits: { fileSize: MAX_ZIP_BYTES + 1 } });
    if (!part) return reply.code(400).send({ error: 'file part missing' });
    const nameField = fieldValue(part.fields, 'name');

    const chunks: Buffer[] = [];
    let bytesSoFar = 0;
    for await (const chunk of part.file) {
      const buf = chunk as Buffer;
      bytesSoFar += buf.length;
      if (bytesSoFar > MAX_ZIP_BYTES || part.file.truncated) {
        return reply.code(413).send({ error: 'zip too large', maxBytes: MAX_ZIP_BYTES });
      }
      chunks.push(buf);
    }
    if (part.file.truncated) return reply.code(413).send({ error: 'zip too large', maxBytes: MAX_ZIP_BYTES });
    if (bytesSoFar === 0) return reply.code(400).send({ error: 'zip is empty' });

    const zipBuffer = Buffer.concat(chunks, bytesSoFar);
    const zipBase = (part.filename || '').replace(/\.zip$/i, '');
    const name = (nameField?.trim() || zipBase || 'Imported material').slice(0, 256);
    const { adminId, apiKeyId } = provenance(req.principal);

    try {
      const { materialId, skipped } = await importMaterialZipBuffer(zipBuffer, {
        name,
        zipFilename: part.filename,
        adminId,
        apiKeyId,
      });
      const detail = await loadMaterialDetail(materialId);
      return reply.code(201).send({ ...detail, skipped });
    } catch (err) {
      req.log.error({ err }, 'material import failed');
      const message = err instanceof Error ? err.message : 'import failed';
      if (message.includes('too large')) {
        return reply.code(413).send({ error: message, maxBytes: MAX_ZIP_BYTES });
      }
      if (message.includes('empty') || message.includes('invalid zip')) {
        return reply.code(400).send({ error: message });
      }
      return reply.code(500).send({ error: 'import failed' });
    }
  });
};

export default plugin;
