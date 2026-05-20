/**
 * Fastify plugin: registers /ws/agent and /ws/admin endpoints.
 */
import type { FastifyPluginAsync } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { handleAgentSocket } from './agentProtocol.js';
import { handleAdminSocket } from './adminProtocol.js';
import { tryAuthAdminSession } from '../auth/adminSession.js';

const plugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifyWebsocket, {
    options: {
      // Conversion jobs are long; allow large message bursts.
      maxPayload: 16 * 1024 * 1024,
    },
  });

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
};

export default plugin;
