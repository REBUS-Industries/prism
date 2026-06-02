/**
 * Static file serving for the admin + convert SPAs.
 *
 * Vite builds `web/dist/` with this layout:
 *   dist/src/admin/index.html
 *   dist/src/convert/index.html
 *   dist/assets/*.{js,css}
 *
 * Container layout (set by server/Dockerfile):
 *   /prism/web-dist/  (top-level — i.e. dist/)
 *
 * We mount /assets at dist/assets/ and serve hash-routed SPA entry HTML
 * at /admin and /convert. Each SPA uses createWebHashHistory so all
 * client-side routing is fragment-based and no SPA-fallback is needed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

export async function registerWebStatic(app: FastifyInstance): Promise<void> {
  const root = resolve(process.env.WEB_DIST_DIR ?? './web-dist');
  if (!existsSync(root)) {
    app.log.warn({ root }, 'web-dist not found; admin + convert SPAs will 404');
    return;
  }

  // Asset bundles (JS / CSS / fonts / images)
  await app.register(fastifyStatic, {
    root: resolve(root, 'assets'),
    prefix: '/assets/',
    decorateReply: false,
  });

  // Vite copies everything in `web/public/` verbatim to `dist/` root, but
  // we don't blanket-serve the dist root because /admin and /convert are
  // already mounted from subdirs and the project root is full of build
  // artefacts we don't want to expose. Whitelist the actually-public
  // assets here (logo + favicon currently). Read them once at startup so
  // the request path is just an in-memory buffer write.
  const publicAssets: Array<{ name: string; type: string }> = [
    { name: 'prism-logo.png', type: 'image/png' },
    { name: 'favicon.png',    type: 'image/png' },
  ];
  for (const asset of publicAssets) {
    const filePath = resolve(root, asset.name);
    if (!existsSync(filePath)) {
      app.log.warn({ filePath }, `public asset missing: ${asset.name}`);
      continue;
    }
    const buf  = readFileSync(filePath);
    const stat = statSync(filePath);
    const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    app.get(`/${asset.name}`, (req, reply) => {
      if (req.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }
      return reply
        .type(asset.type)
        .header('cache-control', 'public, max-age=3600')
        .header('etag', etag)
        .send(buf);
    });
  }

  // Admin SPA
  const adminHtmlDir = resolve(root, 'src', 'admin');
  if (existsSync(resolve(adminHtmlDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: adminHtmlDir,
      prefix: '/admin/',
      decorateReply: false,
      index: 'index.html',
    });
    app.get('/admin', (_req, reply) => reply.redirect('/admin/'));
  }

  // Convert SPA
  const convertHtmlDir = resolve(root, 'src', 'convert');
  if (existsSync(resolve(convertHtmlDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: convertHtmlDir,
      prefix: '/convert/',
      decorateReply: false,
      index: 'index.html',
    });
    app.get('/convert', (_req, reply) => reply.redirect('/convert/'));
  }

  // Viewer SPA (login-free share-link viewer)
  const viewerHtmlDir = resolve(root, 'src', 'viewer');
  if (existsSync(resolve(viewerHtmlDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: viewerHtmlDir,
      prefix: '/viewer/',
      decorateReply: false,
      index: 'index.html',
    });
    app.get('/viewer', (_req, reply) => reply.redirect('/viewer/'));
  }

  // Root -> admin
  app.get('/', (_req, reply) => reply.redirect('/admin/'));
}
