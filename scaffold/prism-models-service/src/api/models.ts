import type { FastifyInstance } from 'fastify';

/** Stub routes — replace with full CRUD + import pipeline (see PRISM/docs/MODEL_LIBRARY.md). */
export async function registerModelsRoutes(app: FastifyInstance) {
  app.get('/api/models', async () => ({
    items: [],
    total: 0,
    message: 'Model library scaffold — implement in prism-models-service',
  }));

  app.get<{ Params: { id: string } }>('/api/models/:id', async (req, reply) => {
    return reply.status(404).send({ error: 'Not found', id: req.params.id });
  });
}
