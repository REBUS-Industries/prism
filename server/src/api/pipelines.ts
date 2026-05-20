/**
 * GET /api/pipelines              -> all topologies
 * GET /api/pipelines/:id          -> one topology
 *
 * Used by the admin Pipeline page (Vue Flow source of truth).
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import { PIPELINES, type PipelineId } from '../conversion/pipelines.js';

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => ({ pipelines: PIPELINES }));

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = req.params.id as PipelineId;
    const topo = PIPELINES[id];
    if (!topo) return reply.code(404).send({ error: 'unknown pipeline' });
    return topo;
  });
};

export default plugin;
