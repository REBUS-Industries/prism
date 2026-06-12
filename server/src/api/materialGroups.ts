/**
 * /api/material-groups — user-created material groupings for the admin library.
 *
 *   GET    /api/material-groups              list groups (materials:read)
 *   POST   /api/material-groups              create group               (materials:write)
 *   PATCH  /api/material-groups/:id          rename / reorder           (materials:write)
 *   DELETE /api/material-groups/:id          delete (materials ungroup) (materials:delete)
 *   POST   /api/material-groups/:id/materials bulk assign materials     (materials:write)
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { materialGroups, materials } from '../db/schema.js';
import { requireAuth, requireScope } from '../auth/middleware.js';

const idParam = z.object({ id: z.string().uuid() });
const createBody = z.object({ name: z.string().min(1).max(128) });
const updateBody = z.object({
  name: z.string().min(1).max(128).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
const bulkAssignBody = z.object({
  materialIds: z.array(z.string().uuid()).min(1).max(100),
});

function serializeGroup(g: typeof materialGroups.$inferSelect) {
  return {
    id: g.id,
    name: g.name,
    sortOrder: g.sortOrder,
    createdAt: g.createdAt.toISOString(),
  };
}

const plugin: FastifyPluginAsync = async (app) => {
  app.get('/', {
    preHandler: [requireAuth, requireScope('materials:read')],
  }, async () => {
    const rows = await db
      .select()
      .from(materialGroups)
      .orderBy(asc(materialGroups.sortOrder), asc(materialGroups.name));
    return { groups: rows.map(serializeGroup) };
  });

  app.post<{ Body: unknown }>('/', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });

    const [{ maxOrder }] = await db
      .select({ maxOrder: sql<number>`coalesce(max(${materialGroups.sortOrder}), -1)` })
      .from(materialGroups);
    const sortOrder = Number(maxOrder ?? -1) + 1;

    const inserted = await db
      .insert(materialGroups)
      .values({ name: parsed.data.name.trim(), sortOrder })
      .returning();
    return reply.code(201).send(serializeGroup(inserted[0]!));
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/:id', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsedId = idParam.safeParse(req.params);
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid id' });
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    if (parsed.data.name === undefined && parsed.data.sortOrder === undefined) {
      return reply.code(400).send({ error: 'no fields to update' });
    }

    const patch: Partial<typeof materialGroups.$inferInsert> = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name.trim();
    if (parsed.data.sortOrder !== undefined) patch.sortOrder = parsed.data.sortOrder;

    const updated = await db
      .update(materialGroups)
      .set(patch)
      .where(eq(materialGroups.id, parsedId.data.id))
      .returning();
    if (!updated[0]) return reply.code(404).send({ error: 'not found' });
    return reply.send(serializeGroup(updated[0]));
  });

  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [requireAuth, requireScope('materials:delete')],
  }, async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid id' });

    const deleted = await db
      .delete(materialGroups)
      .where(eq(materialGroups.id, parsed.data.id))
      .returning({ id: materialGroups.id });
    if (!deleted[0]) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/:id/materials', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsedId = idParam.safeParse(req.params);
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid id' });
    const parsed = bulkAssignBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });

    const group = await db.query.materialGroups.findFirst({
      where: eq(materialGroups.id, parsedId.data.id),
    });
    if (!group) return reply.code(404).send({ error: 'group not found' });

    const updated = await db
      .update(materials)
      .set({ groupId: parsedId.data.id, updatedAt: new Date() })
      .where(and(
        inArray(materials.id, parsed.data.materialIds),
        isNull(materials.deletedAt),
      ))
      .returning({ id: materials.id });

    return reply.send({ assigned: updated.length, materialIds: updated.map((r) => r.id) });
  });
};

export default plugin;
