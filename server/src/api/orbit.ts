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
  createModel as createModelFn,
  createProject as createProjectFn,
  deleteModelVersions,
  fetchBlob,
  fetchObjectBatch,
  fetchObjectJson,
  listModelVersions,
  listModels,
  listProjects,
  OrbitClientError,
  resolveModelVersion,
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

  // POST /api/orbit/projects — create a new project
  app.post<{ Body: { name?: string; description?: string; target?: string } }>('/projects', async (req, reply) => {
    const target = pickTarget(req.body ?? {});
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'name is required' });
    try {
      const project = await createProjectFn(target, name, req.body?.description);
      return reply.send({ target, project });
    } catch (err) {
      return errorReply(reply, err);
    }
  });

  // POST /api/orbit/projects/:id/models — create a new model in a project
  app.post<{ Params: { id: string }; Body: { name?: string; description?: string; target?: string } }>(
    '/projects/:id/models',
    async (req, reply) => {
      const target = pickTarget(req.body ?? {});
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name) return reply.code(400).send({ error: 'name is required' });
      try {
        const model = await createModelFn(target, req.params.id, name, req.body?.description);
        return reply.send({ target, projectId: req.params.id, model });
      } catch (err) {
        return errorReply(reply, err);
      }
    },
  );

  // GET /api/orbit/projects/:projectId/models/:modelId/versions?target=&limit=&cursor=
  app.get<{
    Params: { projectId: string; modelId: string };
    Querystring: { target?: string; limit?: string; cursor?: string };
  }>('/projects/:projectId/models/:modelId/versions', async (req, reply) => {
    const target = pickTarget(req.query);
    const limit = clampInt(req.query.limit, 1, 200, 100);
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor.length ? req.query.cursor : undefined;
    try {
      const r = await listModelVersions(target, req.params.projectId, req.params.modelId, { limit, cursor });
      return reply.send({ target, projectId: req.params.projectId, modelId: req.params.modelId, ...r });
    } catch (err) {
      return errorReply(reply, err);
    }
  });

  // POST /api/orbit/projects/:projectId/versions/delete — delete model versions
  app.post<{
    Params: { projectId: string };
    Body: { target?: string; versionIds?: string[] };
  }>('/projects/:projectId/versions/delete', async (req, reply) => {
    const target = pickTarget(req.body ?? {});
    const versionIds = Array.isArray(req.body?.versionIds)
      ? req.body.versionIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];
    if (!versionIds.length) return reply.code(400).send({ error: 'versionIds is required' });
    try {
      const ok = await deleteModelVersions(target, req.params.projectId, versionIds);
      return reply.send({ target, projectId: req.params.projectId, ok, deletedCount: versionIds.length });
    } catch (err) {
      return errorReply(reply, err);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* 3rd-party viewer proxy — Speckle ObjectLoader2 / @speckle/viewer       */
  /* ---------------------------------------------------------------------- */

  // GET /api/orbit/viewer/resolve?target=&projectId=&modelId=&versionId=
  app.get<{
    Querystring: { target?: string; projectId?: string; modelId?: string; versionId?: string };
  }>('/viewer/resolve', async (req, reply) => {
    const target = pickTarget(req.query);
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    const modelId = typeof req.query.modelId === 'string' ? req.query.modelId.trim() : '';
    const versionId = typeof req.query.versionId === 'string' && req.query.versionId.trim()
      ? req.query.versionId.trim()
      : undefined;
    if (!projectId || !modelId) {
      return reply.code(400).send({ error: 'projectId and modelId are required' });
    }
    try {
      const version = await resolveModelVersion(target, projectId, modelId, versionId);
      return reply.send({ target, ...version });
    } catch (err) {
      return errorReply(reply, err);
    }
  });

  // GET /api/orbit/viewer/:target/objects/:projectId/:objectId/single
  app.get<{ Params: { target: string; projectId: string; objectId: string } }>(
    '/viewer/:target/objects/:projectId/:objectId/single',
    async (req, reply) => {
      const target = parseViewerTarget(req.params.target);
      if (!target) return reply.code(400).send({ error: 'target must be prod or dev' });
      try {
        const json = await fetchObjectJson(target, req.params.projectId, req.params.objectId);
        return reply.type('text/plain').send(json);
      } catch (err) {
        return errorReply(reply, err);
      }
    },
  );

  // POST /api/orbit/viewer/:target/api/v2/projects/:projectId/object-stream/
  app.post<{
    Params: { target: string; projectId: string };
    Body: { objectIds?: string[] };
  }>('/viewer/:target/api/v2/projects/:projectId/object-stream/', async (req, reply) => {
    const target = parseViewerTarget(req.params.target);
    if (!target) return reply.code(400).send({ error: 'target must be prod or dev' });
    const objectIds = Array.isArray(req.body?.objectIds)
      ? req.body.objectIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (!objectIds.length) return reply.code(400).send({ error: 'objectIds is required' });
    try {
      const body = await fetchObjectBatch(target, req.params.projectId, objectIds);
      return reply.type('text/plain').send(body);
    } catch (err) {
      return errorReply(reply, err);
    }
  });

  // GET /api/orbit/viewer/:target/api/stream/:projectId/blob/:blobId
  app.get<{ Params: { target: string; projectId: string; blobId: string } }>(
    '/viewer/:target/api/stream/:projectId/blob/:blobId',
    async (req, reply) => {
      const target = parseViewerTarget(req.params.target);
      if (!target) return reply.code(400).send({ error: 'target must be prod or dev' });
      try {
        const buf = await fetchBlob(target, req.params.projectId, req.params.blobId);
        return reply.send(buf);
      } catch (err) {
        return errorReply(reply, err);
      }
    },
  );
};

function parseViewerTarget(raw: string): OrbitTarget | null {
  return raw === 'prod' || raw === 'dev' ? raw : null;
}

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
