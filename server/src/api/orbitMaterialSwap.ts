/**
 * POST /api/orbit/material-swap — replace an ORBIT mesh material with a PRISM
 * library material and commit a new ORBIT version.
 *
 * Auth: admin session, ORBIT bearer, or API key with `materials:write`.
 * ORBIT bearer callers must have write access on the target project.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../auth/middleware.js';
import { OrbitClientError } from '../orbit/client.js';
import { swapOrbitMaterial } from '../orbit/materialSwap.js';

const bodySchema = z.object({
  projectId: z.string().min(1),
  modelId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  prismMaterialId: z.string().uuid(),
  objectId: z.string().min(1).optional(),
  applicationId: z.string().min(1).optional(),
  orbitTarget: z.enum(['prod', 'dev']).optional(),
  message: z.string().max(1024).optional(),
}).refine((b) => Boolean(b.objectId || b.applicationId), {
  message: 'objectId or applicationId is required',
});

const plugin: FastifyPluginAsync = async (app) => {
  app.post('/', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }

    try {
      const result = await swapOrbitMaterial(req.principal, parsed.data);
      return reply.send({ ok: true, ...result });
    } catch (err) {
      if (err instanceof OrbitClientError) {
        return reply.code(err.status || 502).send({ ok: false, error: err.message, detail: err.detail });
      }
      return reply.code(500).send({ ok: false, error: (err as Error).message ?? 'internal error' });
    }
  });
};

export default plugin;
