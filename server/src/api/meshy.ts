/**
 * /api/meshy — server-mediated Meshy.ai generation + asset download.
 *
 * Credentials live in Settings (`meshy_api_key`). The SPA never sees the key.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../auth/middleware.js';
import {
  createImageTo3dTask,
  createTextTo3dTask,
  downloadMeshyAsset,
  getImageTo3dTask,
  getTextTo3dTask,
  isMeshyConfigured,
  MeshyClientError,
  testMeshyConnection,
} from '../meshy/client.js';

function errorReply(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  if (err instanceof MeshyClientError) {
    return reply.code(err.status || 502).send({ error: err.message, detail: err.body });
  }
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(502).send({ error: message });
}

const textPreviewBody = z.object({
  mode: z.literal('preview'),
  prompt: z.string().min(1).max(600),
  art_style: z.string().optional(),
  should_remesh: z.boolean().optional(),
  topology: z.enum(['quad', 'triangle']).optional(),
  target_polycount: z.number().int().positive().optional(),
  ai_model: z.string().optional(),
}).passthrough();

const textRefineBody = z.object({
  mode: z.literal('refine'),
  preview_task_id: z.string().min(1),
  enable_pbr: z.boolean().optional(),
  texture_prompt: z.string().max(600).optional(),
}).passthrough();

const textCreateBody = z.union([textPreviewBody, textRefineBody]);

const imageCreateBody = z.object({
  image_url: z.string().min(1),
  should_texture: z.boolean().optional(),
  enable_pbr: z.boolean().optional(),
  should_remesh: z.boolean().optional(),
  topology: z.enum(['quad', 'triangle']).optional(),
  target_polycount: z.number().int().positive().optional(),
  ai_model: z.string().optional(),
  model_type: z.string().optional(),
  texture_prompt: z.string().max(600).optional(),
}).passthrough();

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  // GET /api/meshy/status — whether a key is configured (no secret leak)
  app.get('/status', { preHandler: [requireScope('models:read')] }, async () => ({
    configured: await isMeshyConfigured(),
  }));

  // GET /api/meshy/test — validate credentials (balance or auth probe)
  app.get('/test', { preHandler: [requireScope('models:read')] }, async (req, reply) => {
    if (!(await isMeshyConfigured())) {
      return reply.code(412).send({
        ok: false,
        error: 'Set the Meshy API key in Admin → Settings → Meshy first.',
      });
    }
    const r = await testMeshyConnection();
    if (!r.ok) return reply.code(401).send({ ok: false, error: r.error });
    return { ok: true, balance: r.balance ?? null };
  });

  // POST /api/meshy/text-to-3d — create preview or refine task
  app.post('/text-to-3d', { preHandler: [requireScope('models:write')] }, async (req, reply) => {
    const body = textCreateBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid body', detail: body.error.flatten() });
    }
    try {
      const created = await createTextTo3dTask(body.data as Record<string, unknown>);
      return reply.code(201).send(created);
    } catch (err) {
      return errorReply(reply, err);
    }
  });

  // GET /api/meshy/text-to-3d/:id
  app.get<{ Params: { id: string } }>('/text-to-3d/:id', {
    preHandler: [requireScope('models:read')],
  }, async (req, reply) => {
    try {
      return await getTextTo3dTask(req.params.id);
    } catch (err) {
      return errorReply(reply, err);
    }
  });

  // POST /api/meshy/image-to-3d
  app.post('/image-to-3d', { preHandler: [requireScope('models:write')] }, async (req, reply) => {
    const body = imageCreateBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid body', detail: body.error.flatten() });
    }
    try {
      const created = await createImageTo3dTask(body.data as Record<string, unknown>);
      return reply.code(201).send(created);
    } catch (err) {
      return errorReply(reply, err);
    }
  });

  // GET /api/meshy/image-to-3d/:id
  app.get<{ Params: { id: string } }>('/image-to-3d/:id', {
    preHandler: [requireScope('models:read')],
  }, async (req, reply) => {
    try {
      return await getImageTo3dTask(req.params.id);
    } catch (err) {
      return errorReply(reply, err);
    }
  });

  // GET /api/meshy/download?url=… — proxy signed Meshy asset URLs (avoids CORS)
  app.get<{ Querystring: { url?: string } }>('/download', {
    preHandler: [requireScope('models:read')],
  }, async (req, reply) => {
    const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!url) return reply.code(400).send({ error: 'url is required' });
    try {
      const { bytes, contentType } = await downloadMeshyAsset(url);
      return reply
        .header('Content-Type', contentType)
        .header('Cache-Control', 'private, max-age=300')
        .send(bytes);
    } catch (err) {
      return errorReply(reply, err);
    }
  });
};

export default plugin;
