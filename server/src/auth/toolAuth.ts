/**
 * PRISM tool authorization — portal role grants apply to API keys only.
 * Local admin (username/password cookie) always has full access.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export type PrismTool = 'convert' | 'visualiser' | 'fixtures' | 'materials' | 'models' | 'files';

export function requireTool(tool: PrismTool) {
  return async function toolGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const principal = req.principal;
    if (!principal) {
      reply.code(401).send({ error: 'authentication required' });
      return;
    }

    if (principal.kind === 'apiKey') {
      const scopeMap: Record<PrismTool, string> = {
        convert: 'convert:run',
        visualiser: 'visualiser:create_stream',
        fixtures: 'fixtures:read',
        materials: 'materials:read',
        models: 'models:read',
        files: 'files:read',
      };
      const scope = scopeMap[tool];
      if (principal.scopes.includes(scope)) return;
      reply.code(403).send({ error: 'forbidden', scope, tool });
      return;
    }

    if (principal.kind === 'adminSession') {
      // Local username/password admin — never gated by portal tool grants.
      return;
    }

    if (principal.kind === 'orbitUser') {
      return;
    }

    reply.code(403).send({ error: 'forbidden', tool });
  };
}
