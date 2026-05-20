/**
 * PRISM Server entry point.
 *
 * Phase 0 scaffold: just enough to boot the process, register a /health
 * route, and exit cleanly. Phase 1 wires Drizzle / Redis / Fastify
 * routes and middleware.
 */
import 'dotenv/config';
import Fastify from 'fastify';

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
    bodyLimit: 256 * 1024 * 1024, // 256 MB — convert uploads stream via @fastify/multipart anyway
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'prism-server',
    version: process.env.npm_package_version ?? '0.1.0',
    phase: 0,
  }));

  // Phase 1: register api/, ws/, auth/, db/.
  // app.register(import('./api/convert.js'), { prefix: '/api/convert' });
  // app.register(import('./api/jobs.js'),    { prefix: '/api/jobs' });
  // app.register(import('./ws/gateway.js'));

  return app;
}

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      app.log.info({ sig }, 'shutdown');
      await app.close();
      process.exit(0);
    });
  }
}

main();
