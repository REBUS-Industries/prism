/**
 * /api/fab — Fab marketplace proxy (search, preview, import).
 *
 * Thin wrapper around server/src/fab/client.ts for Fab-only UI flows.
 * Unified multi-provider browse lives at /api/external-materials.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Principal } from '../auth/principal.js';
import {
  fabDownloadMaterialZip,
  fabGetListing,
  fabSearch,
  isFabImportConfigured,
} from '../fab/client.js';
import { importMaterialZipBuffer } from '../materials/importZip.js';
import { loadMaterialDetail } from '../materials/loadDetail.js';
import { applyExternalMaterialsSettings } from '../settings/externalMaterials.js';

const idParam = z.object({ id: z.string().uuid() });

const importBody = z.object({
  name: z.string().min(1).max(256).optional(),
}).optional();

function provenance(principal: Principal | undefined) {
  return {
    adminId: principal?.kind === 'adminSession' ? principal.adminUserId : null,
    apiKeyId: principal?.kind === 'apiKey' ? principal.apiKeyId : null,
  };
}

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async () => {
    await applyExternalMaterialsSettings();
  });

  app.get<{ Querystring: { q?: string; cursor?: string; limit?: string } }>('/search', {
    preHandler: [requireAuth, requireScope('materials:read')],
  }, async (req, reply) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 24), 1), 48);
    const q = (req.query.q ?? '').trim();
    const cursor = (req.query.cursor ?? '').trim() || null;

    try {
      return reply.send(await fabSearch(q, limit, cursor));
    } catch (err) {
      req.log.warn({ err }, 'fab search failed');
      return reply.code(502).send({ error: 'Fab search failed' });
    }
  });

  app.get<{ Params: { id: string } }>('/assets/:id', {
    preHandler: [requireAuth, requireScope('materials:read')],
  }, async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid id' });

    try {
      const detail = await fabGetListing(parsed.data.id);
      if (!detail) return reply.code(404).send({ error: 'not found' });
      return reply.send({ ...detail, importConfigured: isFabImportConfigured() });
    } catch (err) {
      req.log.warn({ err, id: parsed.data.id }, 'fab asset detail failed');
      return reply.code(502).send({ error: 'Fab asset lookup failed' });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/assets/:id/import', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid id' });
    const body = importBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });

    const listingId = parsed.data.id;
    const { adminId, apiKeyId } = provenance(req.principal);

    try {
      const payload = await fabDownloadMaterialZip(listingId);
      const { materialId, skipped } = await importMaterialZipBuffer(payload.buffer, {
        name: (body.data?.name?.trim() || payload.name).slice(0, 256),
        zipFilename: payload.filename,
        tags: ['fab'],
        adminId,
        apiKeyId,
      });
      const detail = await loadMaterialDetail(materialId);
      if (!detail) return reply.code(500).send({ error: 'import succeeded but material missing' });
      return reply.code(201).send({ ...detail, skipped, fabListingId: listingId });
    } catch (err) {
      req.log.error({ err, listingId }, 'fab import failed');
      const message = err instanceof Error ? err.message : 'import failed';
      if (message.includes('FAB_EPIC') || message.includes('Fab import requires')) {
        return reply.code(503).send({ error: message, code: 'fab_not_configured' });
      }
      return reply.code(502).send({ error: message });
    }
  });
};

export default plugin;
