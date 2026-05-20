/**
 * /api/webhooks — admin-managed callback endpoints fired on terminal job
 * events. Each row carries a URL, an optional HMAC secret, and the set
 * of events it cares about.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { webhooks } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';

const upsertBody = z.object({
  name: z.string().min(1).max(128),
  url:  z.string().url(),
  events: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  regenerateSecret: z.boolean().optional(),
});

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => {
    const rows = await db.select().from(webhooks);
    return { webhooks: rows };
  });

  app.post('/', async (req, reply) => {
    const parsed = upsertBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const secret = randomBytes(24).toString('base64url');
    const [inserted] = await db.insert(webhooks).values({
      name: parsed.data.name,
      url:  parsed.data.url,
      events: parsed.data.events ?? ['job.complete', 'job.failed'],
      secret,
      isActive: parsed.data.isActive ?? true,
    }).returning();
    // Plaintext secret only shown on create.
    return reply.code(201).send({ ...inserted, secret });
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const parsed = upsertBody.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const updates: Record<string, unknown> = {};
    if (parsed.data.name !== undefined)     updates['name']     = parsed.data.name;
    if (parsed.data.url !== undefined)      updates['url']      = parsed.data.url;
    if (parsed.data.events !== undefined)   updates['events']   = parsed.data.events;
    if (parsed.data.isActive !== undefined) updates['isActive'] = parsed.data.isActive;
    if (parsed.data.regenerateSecret)       updates['secret']   = randomBytes(24).toString('base64url');
    const [row] = await db.update(webhooks).set(updates).where(eq(webhooks.id, req.params.id)).returning();
    if (!row) return reply.code(404).send({ error: 'not found' });
    return row;
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const res = await db.delete(webhooks).where(eq(webhooks.id, req.params.id)).returning({ id: webhooks.id });
    if (!res.length) return reply.code(404).send({ error: 'not found' });
    return { deleted: res[0]!.id };
  });
};

export default plugin;
