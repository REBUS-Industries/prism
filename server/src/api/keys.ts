/**
 * /api/keys — admin manages API keys for external /v1/* callers.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { mintApiKey } from '../auth/apiKey.js';
import { requireAdmin } from '../auth/middleware.js';

/**
 * Known API-key scopes. The admin UI surfaces these as checkboxes on the
 * create form and the edit modal; the `requireScope(scope)` middleware
 * (server/src/auth/middleware.ts) enforces them per-route.
 *
 * Keep this list narrow — it's the source of truth for both the
 * back-end Zod validation and the front-end checkbox set, so adding a
 * scope is a deliberate two-line change here.
 */
const KNOWN_SCOPES = [
  'convert:run',
  'visualiser:create_stream',
  // Phase J — Portal users that upload lighting-design files (MVR scenes /
  // GDTF fixture libraries) to an ORBIT project need write access to the
  // project-attachments REST surface. Split off from create_stream so a
  // read-only "kick off a visualiser run" key can't silently upload assets
  // (and so the portal can mint two keys with different lifetimes).
  'visualiser:attach_project_files',
  // Multi-viewer — mint share links for a streaming run. Distinct from
  // create_stream so a portal can issue a dedicated "share manager" key
  // that can hand out view/control seats without being able to start new
  // streams. A key with create_stream also implicitly owns the runs it
  // started (see ownerCanCancel) and can mint shares for those without
  // this scope; this scope is for keys that manage shares for runs they
  // did not start (e.g. an org-wide sharing service).
  'visualiser:join_stream',
  // Materials store — the shared texture library + PBR materials surface
  // (`/api/textures/*`, `/api/materials/*`). Split read / write / delete so
  // a key can be granted browse-only access, asset-authoring access, or the
  // ability to retire library rows independently. Admin sessions and ORBIT
  // bearers bypass scope checks as usual.
  'materials:read',
  'materials:write',
  'materials:delete',
  // Fixture library — GDTF/MVR import, CRUD, IES (routes on prism-fixtures-service).
  'fixtures:read',
  'fixtures:write',
  'fixtures:delete',
  'fixtures:import',
  // Model library — generic 3D assets (routes on prism-models-service).
  'models:read',
  'models:write',
  'models:delete',
  'models:import',
  // Permissions service — portal-brokered access + policy graph admin.
  'access:read',
  'access:admin',
] as const;
const scopesSchema = z.array(z.enum(KNOWN_SCOPES)).default([]);

const createBody = z.object({
  name: z.string().min(1).max(128),
  rateLimitPerMin: z.number().int().positive().optional(),
  monthlyQuota: z.number().int().positive().optional(),
  scopes: scopesSchema.optional(),
});

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => {
    const rows = await db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
    return { keys: rows.map((r) => ({
      id: r.id,
      name: r.name,
      isActive: r.isActive,
      rateLimitPerMin: r.rateLimitPerMin,
      monthlyQuota: r.monthlyQuota,
      scopes: Array.isArray(r.scopes) ? r.scopes : [],
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    })) };
  });

  app.get('/scopes', async () => ({ scopes: [...KNOWN_SCOPES] }));

  // POST /api/keys -> { plaintext, ...row }
  // The plaintext is shown to the admin once and never again.
  app.post('/', async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const { plaintext, hash } = mintApiKey();
    const inserted = await db
      .insert(apiKeys)
      .values({
        name: parsed.data.name,
        keyHash: hash,
        rateLimitPerMin: parsed.data.rateLimitPerMin ?? null,
        monthlyQuota: parsed.data.monthlyQuota ?? null,
        scopes: parsed.data.scopes ?? [],
      })
      .returning();
    const row = inserted[0]!;
    return reply.code(201).send({
      plaintext,
      key: {
        id: row.id,
        name: row.name,
        isActive: row.isActive,
        rateLimitPerMin: row.rateLimitPerMin,
        monthlyQuota: row.monthlyQuota,
        scopes: Array.isArray(row.scopes) ? row.scopes : [],
        createdAt: row.createdAt,
      },
    });
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const res = await db.delete(apiKeys).where(eq(apiKeys.id, req.params.id)).returning({ id: apiKeys.id });
    if (res.length === 0) return reply.code(404).send({ error: 'not found' });
    return { deleted: res[0]!.id };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/:id', async (req, reply) => {
    const body = z
      .object({
        isActive: z.boolean().optional(),
        scopes: scopesSchema.optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
    const updated = await db
      .update(apiKeys)
      .set({ ...body.data })
      .where(eq(apiKeys.id, req.params.id))
      .returning();
    if (updated.length === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });
};

export default plugin;
