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
  createRemeshTask,
  createRetextureTask,
  createTextTo3dTask,
  downloadMeshyAsset,
  getImageTo3dTask,
  getRemeshTask,
  getRetextureTask,
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

const retextureBody = z.object({
  input_task_id: z.string().min(1).optional(),
  model_url: z.string().min(1).optional(),
  text_style_prompt: z.string().max(600).optional(),
  image_style_url: z.string().min(1).optional(),
  enable_pbr: z.boolean().optional(),
  enable_original_uv: z.boolean().optional(),
  ai_model: z.string().optional(),
  hd_texture: z.boolean().optional(),
  remove_lighting: z.boolean().optional(),
  target_formats: z.array(z.string()).optional(),
}).passthrough().refine(
  (b) => !!(b.input_task_id || b.model_url),
  { message: 'input_task_id or model_url is required' },
).refine(
  (b) => !!(b.text_style_prompt || b.image_style_url),
  { message: 'text_style_prompt or image_style_url is required' },
);

const remeshBody = z.object({
  input_task_id: z.string().min(1).optional(),
  model_url: z.string().min(1).optional(),
  topology: z.enum(['quad', 'triangle']).optional(),
  target_polycount: z.number().int().positive().optional(),
  target_formats: z.array(z.string()).optional(),
  decimation_mode: z.number().int().optional(),
}).passthrough().refine(
  (b) => !!(b.input_task_id || b.model_url),
  { message: 'input_task_id or model_url is required' },
);

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

  // POST /api/meshy/retexture
  app.post('/retexture', { preHandler: [requireScope('models:write')] }, async (req, reply) => {
    const body = retextureBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid body', detail: body.error.flatten() });
    }
    try {
      const created = await createRetextureTask(body.data as Record<string, unknown>);
      return reply.code(201).send(created);
    } catch (err) {
      return errorReply(reply, err);
    }
  });

  // GET /api/meshy/retexture/:id
  app.get<{ Params: { id: string } }>('/retexture/:id', {
    preHandler: [requireScope('models:read')],
  }, async (req, reply) => {
    try {
      return await getRetextureTask(req.params.id);
    } catch (err) {
      return errorReply(reply, err);
    }
  });

  // POST /api/meshy/remesh
  app.post('/remesh', { preHandler: [requireScope('models:write')] }, async (req, reply) => {
    const body = remeshBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid body', detail: body.error.flatten() });
    }
    try {
      const created = await createRemeshTask(body.data as Record<string, unknown>);
      return reply.code(201).send(created);
    } catch (err) {
      return errorReply(reply, err);
    }
  });

  // GET /api/meshy/remesh/:id
  app.get<{ Params: { id: string } }>('/remesh/:id', {
    preHandler: [requireScope('models:read')],
  }, async (req, reply) => {
    try {
      return await getRemeshTask(req.params.id);
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
