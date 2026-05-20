/**
 * /api/orbit — server-mediated ORBIT lookups.
 *
 * The admin stores credentials in Settings (`orbit_server_url` + `orbit_token`
 * for prod, `orbit_dev_*` for dev). These routes use those stored credentials
 * to call ORBIT's GraphQL on behalf of the SPA, so the browser never sees
 * the token directly.
 *
 * Auth: same as the rest of /api — admin session, ORBIT bearer, or API key.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import {
  listModels,
  listProjects,
  OrbitClientError,
  testConnection,
  type OrbitTarget,
} from '../orbit/client.js';

const targetSchema = z.object({ target: z.enum(['prod', 'dev']).optional() });

function pickTarget(q: unknown): OrbitTarget {
  const parsed = targetSchema.safeParse(q ?? {});
  return parsed.success ? (parsed.data.target ?? 'prod') : 'prod';
}

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  // GET /api/orbit/test?target=prod|dev
  app.get('/test', async (req, reply) => {
    const target = pickTarget(req.query);
    try {
      const r = await testConnection(target);
      if (r.ok) return reply.send({ ok: true, target, user: r.user, serverInfo: r.serverInfo });
      return reply.code(r.reason === 'no-creds' ? 412 : 401).send({
        ok: false,
        target,
        reason: r.reason,
        serverInfo: r.serverInfo,
        error: r.reason === 'no-creds'
          ? `Set ORBIT URL + token for "${target}" in Settings first.`
          : 'Token did not resolve to a user (likely invalid or expired).',
      });
    } catch (err) {
      const e = err as OrbitClientError;
      return reply.code(e.status || 502).send({ ok: false, target, error: e.message });
    }
  });

  // GET /api/orbit/projects?target=prod|dev&limit=100&cursor=…
  app.get<{ Querystring: { target?: string; limit?: string; cursor?: string } }>('/projects', async (req, reply) => {
    const target = pickTarget(req.query);
    const limit  = clampInt(req.query.limit, 1, 200, 100);
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor.length ? req.query.cursor : undefined;
    try {
      const r = await listProjects(target, { limit, cursor });
      return reply.send({ target, ...r });
    } catch (err) {
      return errorReply(reply, err);
    }
  });

  // GET /api/orbit/projects/:id/models?target=prod|dev&limit=200&cursor=…
  app.get<{ Params: { id: string }; Querystring: { target?: string; limit?: string; cursor?: string } }>(
    '/projects/:id/models',
    async (req, reply) => {
      const target = pickTarget(req.query);
      const limit  = clampInt(req.query.limit, 1, 500, 200);
      const cursor = typeof req.query.cursor === 'string' && req.query.cursor.length ? req.query.cursor : undefined;
      try {
        const r = await listModels(target, req.params.id, { limit, cursor });
        return reply.send({ target, projectId: req.params.id, ...r });
      } catch (err) {
        return errorReply(reply, err);
      }
    },
  );
};

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function errorReply(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  if (err instanceof OrbitClientError) {
    return reply.code(err.status || 502).send({ error: err.message });
  }
  return reply.code(500).send({ error: (err as Error).message ?? 'internal error' });
}

export default plugin;
