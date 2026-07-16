/**
 * PRISM Server entry point.
 *
 * Phase 1 wiring: Fastify app + cookie + multipart + cors + auth +
 * REST routes for jobs / convert / admin / settings / keys /
 * workstations / layer-presets. The WS gateway lands in Phase 2.
 */
import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBootstrap } from './bootstrap.js';
import { MAX_UPLOAD_BYTES } from './conversion/uploadLimits.js';
import { resolveProvenance } from './auth/provenance.js';
import { serverApiLog, redactPath, categoryFor, levelFor } from './observability/apiLog.js';
import { redisRegistry } from './ws/redisRegistry.js';
import { sessionRegistry } from './ws/sessionRegistry.js';

// Sourced from this package's package.json at startup. The process is always
// launched from the package root: `npm run dev`/`start` run with cwd=server/,
// and the Docker image runs with WORKDIR=/prism where package.json is copied
// (see server/Dockerfile). `tsc` does not copy the JSON into dist/, so we read
// it at runtime rather than importing it.
function resolveServerVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SERVER_VERSION = resolveServerVersion();
const PORT = Number(process.env.PORT ?? 8765);
const HOST = process.env.HOST ?? '0.0.0.0';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

async function buildApp() {
  const app = Fastify({
    logger: {
      level: LOG_LEVEL,
      transport: process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' } },
    },
    // Must be >= @fastify/multipart limits.fileSize or large convert uploads 413
    // before the route handler runs (Fastify rejects the raw body first).
    bodyLimit: MAX_UPLOAD_BYTES,
    disableRequestLogging: false,
    // Trust the external Caddy reverse proxy so that `req.ip` reflects the
    // real client IP from `X-Forwarded-For` instead of the proxy LXC's
    // address (10.0.200.251). Required for `agent_sessions.remote_addr`
    // to land the agent workstation's actual IP, which the admin SPA
    // then uses for the "Open Web UI" link (see web/src/shared/workstationUrl.ts).
    //
    // Safe to trust unconditionally because prism-server is only
    // reachable from (a) the proxy LXC pair on 10.0.200.251/.252 via the
    // public hostname `prism.rebus.industries`, or (b) other hosts on the
    // private 10.0.200.0/24 service VLAN where clients are already
    // trusted to set their own source IP.
    trustProxy: true,
  });

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    app.log.warn('SESSION_SECRET is not set — admin login cookies will not be signable. Set this in production!');
  }
  await app.register(cookie, { secret: sessionSecret ?? 'unsafe-dev-only-do-not-use-in-prod' });
  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin (no Origin header) is always fine. Cross-origin only in dev.
      if (!origin) return cb(null, true);
      if (process.env.NODE_ENV !== 'production') return cb(null, true);
      const allowed = (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      cb(null, allowed.includes(origin));
    },
    credentials: true,
  });
  await app.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
      fields: 32,
    },
  });

  // Capture safe metadata for every inbound API request into the in-memory
  // ring buffer that backs the admin Logs page. Runs after route preHandlers
  // so `req.principal` is resolved; records ONLY method/path/status/duration/
  // principal label/IP/category — never headers, cookies, or bodies, so no
  // credential can leak. Scoped to the API surfaces (skips static SPA assets).
  app.addHook('onResponse', async (req, reply) => {
    const url = req.raw.url ?? req.url ?? '';
    const path = url.split('?')[0] ?? url;
    if (!(path.startsWith('/api') || path.startsWith('/v1') || path.startsWith('/internal') || path === '/health')) {
      return;
    }
    // Don't record the Logs page polling its own feed — it would flood the
    // bounded buffer with self-referential admin polls and evict real traffic.
    if (path === '/api/admin/logs' || path.startsWith('/api/admin/logs/')) {
      return;
    }
    const { originKind, originAddress, originPrincipal } = resolveProvenance(req);
    const status = reply.statusCode;
    serverApiLog.push({
      ts: Date.now() - Math.round(reply.elapsedTime),
      durationMs: Math.round(reply.elapsedTime),
      method: req.method,
      path: redactPath(url),
      status,
      originKind,
      originPrincipal,
      clientIp: originAddress,
      category: categoryFor(path, originKind),
      level: levelFor(status),
    });
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'prism-server',
    version: SERVER_VERSION,
    phase: 1,
  }));

  // WS gateway must be registered before any REST plugins so its
  // `upgrade`-aware handler wins for /ws/* paths.
  await app.register(import('./ws/gateway.js'));

  await app.register(import('./api/admin.js'),         { prefix: '/api/admin' });
  await app.register(import('./api/logs.js'),          { prefix: '/api/admin/logs' });
  await app.register(import('./api/jobs.js'),          { prefix: '/api/jobs' });
  await app.register(import('./api/sse.js'),           { prefix: '/api/jobs' });
  await app.register(import('./api/convert.js'),       { prefix: '/api/convert' });
  await app.register(import('./api/settings.js'),      { prefix: '/api/settings' });
  await app.register(import('./api/keys.js'),          { prefix: '/api/keys' });
  await app.register(import('./api/workstations.js'),  { prefix: '/api/workstations' });
  await app.register(import('./api/workstationDownloads.js'), { prefix: '/api/admin/workstations/downloads' });
  await app.register(import('./api/layerPresets.js'),  { prefix: '/api/layer-presets' });
  await app.register(import('./api/pipelines.js'),     { prefix: '/api/pipelines' });
  await app.register(import('./api/receive.js'),       { prefix: '/api/receive' });
  await app.register(import('./api/webhooks.js'),      { prefix: '/api/webhooks' });
  await app.register(import('./api/orbit.js'),         { prefix: '/api/orbit' });
  await app.register(import('./api/orbitMaterialSwap.js'), { prefix: '/api/orbit/material-swap' });
  await app.register(import('./api/meshy.js'),         { prefix: '/api/meshy' });
  await app.register(import('./api/visualiser.js'),    { prefix: '/api/visualiser' });
  // Phase J — portal users upload MVR/GDTF lighting files here and the
  // visualiser dispatcher forwards download URLs to the orchestrator.
  await app.register(import('./api/projectAttachments.js'), { prefix: '/api/projects' });
  // Materials store — shared texture library + PBR materials.
  await app.register(import('./api/textures.js'),      { prefix: '/api/textures' });
  await app.register(import('./api/materials.js'),     { prefix: '/api/materials' });
  await app.register(import('./api/materialGroups.js'), { prefix: '/api/material-groups' });
  await app.register(import('./api/externalMaterials.js'), { prefix: '/api/external-materials' });
  await app.register(import('./api/fab.js'),           { prefix: '/api/fab' });
  await app.register(import('./api/internal.js'),      { prefix: '/internal' });
  await app.register(import('./v1/routes.js'),         { prefix: '/v1' });

  // Public API documentation: must register before webStatic so its
  // /docs route wins over the static handler.
  await app.register(import('./docs/plugin.js'));

  const { registerWebStatic } = await import('./webStatic.js');
  await registerWebStatic(app);

  return app;
}

async function main() {
  const app = await buildApp();
  try {
    await runBootstrap(app.log);
  } catch (err) {
    app.log.error({ err }, 'bootstrap failed');
    process.exit(1);
  }

  // Start the BullMQ worker that turns queued jobs into agent dispatches.
  const { startConvertWorker } = await import('./jobs/worker.js');
  const worker = startConvertWorker(app.log);

  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Relay cross-process admin/job broadcasts to the subscribers held in THIS
  // process — most importantly the convert page's `/api/jobs/:id/stream` SSE
  // clients. In the dev microservice split the agent gateway runs in a
  // separate process (`/ws/agent` -> prism-agent) and publishes the job's
  // `awaiting_selection` / `processing` / `complete` frames to the Redis
  // `admin:broadcast` channel. Without this subscription those frames never
  // reach the SSE clients registered here, so the convert page sits on its
  // initial `queued` snapshot forever (the SSE socket never errors, so the
  // client-side polling fallback never starts). broadcastAdminLocal does not
  // re-publish to Redis, so there is no fan-out loop. Mirrors
  // visualiser-service.ts, which already does this for its /ws/admin sockets.
  void redisRegistry.subscribeToAdminBroadcast((topic, frame) => {
    sessionRegistry.broadcastAdminLocal(topic, frame);
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      app.log.info({ sig }, 'shutdown');
      try { await worker.close(); } catch (err) { app.log.warn({ err }, 'worker close failed'); }
      await app.close();
      process.exit(0);
    });
  }
}

main();
