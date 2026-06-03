/**
 * Fastify plugin: registers /ws/agent and /ws/admin endpoints.
 */
import type { FastifyPluginAsync } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { handleAgentSocket } from './agentProtocol.js';
import { handleAdminSocket } from './adminProtocol.js';
import signallingProxyPlugin from './signallingProxy.js';
import visualiserControlPlugin from './visualiserControl.js';
import { tryAuthAdminSession } from '../auth/adminSession.js';
import { initVisualiserIdleReaper } from '../visualiser/idleReaper.js';

const plugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifyWebsocket, {
    options: {
      // Conversion jobs are long; allow large message bursts.
      maxPayload: 16 * 1024 * 1024,
    },
  });

  // Subscribe the viewer-aware idle reaper to per-run viewer-count changes so
  // a `streaming` run with zero connected viewers is reclaimed after
  // VISUALISER_IDLE_TIMEOUT_MS (active sessions are never touched). This is
  // separate from the pre-`streaming` START timeout in runRegistry.
  initVisualiserIdleReaper(app.log);

  // Agent WS endpoint.
  // Phase 2: open to any caller — the agent's `hello` message identifies
  // the machine. Phase 8 introduces an agent enrollment token issued at
  // install time and required as a query param here.
  app.get('/ws/agent', { websocket: true }, (socket, req) => {
    handleAgentSocket(socket, req.ip, req.log);
  });

  // Admin WS endpoint — requires an authenticated admin session.
  app.get('/ws/admin', { websocket: true, preHandler: async (req, reply) => {
      const ok = await tryAuthAdminSession(req);
      if (!ok) reply.code(401).send({ error: 'admin session required' });
    },
  }, (socket, req) => {
    handleAdminSocket(socket, req.log);
  });

  // Visualiser signalling proxy (Phase G). Browser ↔ PRISM ↔ Agent ↔ Cirrus.
  // Auth is the short-lived JWT in the `token` query param — see
  // `../visualiser/signallingToken.ts`.
  await app.register(signallingProxyPlugin);

  // Visualiser control channel (multi-viewer): single-controller lock
  // take/release + controller-state broadcast. Separate from the PS
  // signalling stream. Same JWT auth (tier + viewerId claims).
  await app.register(visualiserControlPlugin);
};

export default plugin;
