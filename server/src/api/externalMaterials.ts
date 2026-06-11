/**
 * /api/external-materials — unified browse/search/import for Fab, Poly Haven, etc.
 *
 *   GET  /api/external-materials/search?q=&sources=fab,polyhaven,ambientcg&cursor=&limit=
 *   GET  /api/external-materials/:source/:id
 *   POST /api/external-materials/:source/:id/import
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Principal } from '../auth/principal.js';
import { loadMaterialDetail } from '../materials/loadDetail.js';
import { importMaterialZipBuffer } from '../materials/importZip.js';
import {
  decodeUnifiedCursor,
  isExternalMaterialSource,
  parseSourcesParam,
} from '../external-materials/types.js';
import { unifiedSearch } from '../external-materials/unifiedSearch.js';
import {
  enabledExternalMaterialSources,
  getExternalMaterialProvider,
  listExternalMaterialProviders,
  providerLabels,
} from '../external-materials/registry.js';
import { applyExternalMaterialsSettings } from '../settings/externalMaterials.js';

const sourceParam = z.object({ source: z.string(), id: z.string().min(1) });

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

  app.get<{ Querystring: { q?: string; sources?: string; cursor?: string; limit?: string } }>('/search', {
    preHandler: [requireAuth, requireScope('materials:read')],
  }, async (req, reply) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 24), 1), 50);
    const q = (req.query.q ?? '').trim();
    const sources = parseSourcesParam(req.query.sources);
    const cursorRaw = req.query.cursor?.trim() || null;
    const cursor = decodeUnifiedCursor(cursorRaw);

    try {
      const result = await unifiedSearch(listExternalMaterialProviders(), {
        q,
        sources,
        cursor,
        limit,
      });

      return {
        ...result,
        cursor: cursorRaw,
        providerLabels: providerLabels(),
        configuredSources: enabledExternalMaterialSources(),
      };
    } catch (err) {
      req.log.warn({ err, q, sources }, 'external materials search failed');
      const message = err instanceof Error ? err.message : 'search failed';
      return reply.code(502).send({ error: message });
    }
  });

  app.get<{ Params: { source: string; id: string } }>('/:source/:id', {
    preHandler: [requireAuth, requireScope('materials:read')],
  }, async (req, reply) => {
    const parsed = sourceParam.safeParse(req.params);
    if (!parsed.success || !isExternalMaterialSource(parsed.data.source)) {
      return reply.code(400).send({ error: 'invalid source', allowed: enabledExternalMaterialSources() });
    }
    const provider = getExternalMaterialProvider(parsed.data.source);
    if (!provider?.enabled) {
      return reply.code(503).send({ error: 'provider disabled', source: parsed.data.source });
    }
    const detail = await provider.getDetail(parsed.data.id);
    if (!detail) return reply.code(404).send({ error: 'not found' });
    return reply.send(detail);
  });

  app.post<{ Params: { source: string; id: string }; Body: { name?: string } | unknown }>('/:source/:id/import', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsed = sourceParam.safeParse(req.params);
    if (!parsed.success || !isExternalMaterialSource(parsed.data.source)) {
      return reply.code(400).send({ error: 'invalid source', allowed: enabledExternalMaterialSources() });
    }
    const provider = getExternalMaterialProvider(parsed.data.source);
    if (!provider?.enabled) {
      return reply.code(503).send({ error: 'provider disabled', source: parsed.data.source });
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { name?: string };
    const { adminId, apiKeyId } = provenance(req.principal);

    try {
      const payload = await provider.downloadForImport(parsed.data.id);
      const { materialId, skipped } = await importMaterialZipBuffer(payload.buffer, {
        name: body.name?.trim() || payload.name,
        zipFilename: payload.filename,
        tags: [parsed.data.source, 'external-import'],
        adminId,
        apiKeyId,
      });
      const detail = await loadMaterialDetail(materialId);
      return reply.code(201).send({ ...detail, skipped });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'import failed';
      req.log.warn({ err, source: parsed.data.source, id: parsed.data.id }, 'external material import failed');
      if (message.includes('FAB_EPIC') || message.includes('Fab import requires')) {
        return reply.code(503).send({
          error: message,
          code: 'fab_not_configured',
          hint: 'Set FAB_EPIC_REFRESH_TOKEN on the server for Fab downloads (see infra/.env.example).',
        });
      }
      return reply.code(502).send({ error: message });
    }
  });
};

export default plugin;
