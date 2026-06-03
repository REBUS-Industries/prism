/**
 * /api/admin/logs — admin-only feed of the server-side API-call ring buffer.
 *
 * The admin Logs page merges these entries (every inbound API request the
 * server answered: external API-key calls, ORBIT bearers, internal
 * download-token traffic, and the admin SPA's own calls) with the
 * client-side browser log it already keeps.
 *
 * Returns only safe metadata (method, path, status, duration, principal
 * kind + label, client IP, category, level). No headers/cookies/bodies are
 * ever stored in the buffer, so nothing sensitive can be returned here. See
 * observability/apiLog.ts.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireAdmin } from '../auth/middleware.js';
import { serverApiLog } from '../observability/apiLog.js';

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  // GET /api/admin/logs?since=<id>&limit=<n>
  app.get<{ Querystring: { since?: string; limit?: string } }>('/', async (req) => {
    const since = req.query.since ? Number(req.query.since) : 0;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 1000), 1), 1000);
    const entries = serverApiLog.list(Number.isFinite(since) ? since : 0, limit);
    return { entries, bufferSize: serverApiLog.size };
  });
};

export default plugin;
