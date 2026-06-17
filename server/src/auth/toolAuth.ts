/**
 * Resolve PRISM tool access via prism-permissions-service.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { adminUsers } from '../db/schema.js';

export type PrismTool = 'convert' | 'visualiser' | 'fixtures' | 'materials' | 'models';

const PERMISSIONS_BASE = () =>
  (process.env.PERMISSIONS_SERVICE_URL ?? 'http://prism-permissions:8771').replace(/\/$/, '');

async function resolveAdminEmail(req: FastifyRequest): Promise<string | null> {
  const principal = req.principal;
  if (principal?.kind !== 'adminSession') return null;
  const username = principal.username.trim();
  if (username.includes('@')) return username.toLowerCase();

  const row = (
    await db.select({ username: adminUsers.username }).from(adminUsers).where(eq(adminUsers.id, principal.adminUserId)).limit(1)
  )[0];
  const resolved = row?.username?.trim();
  if (resolved?.includes('@')) return resolved.toLowerCase();
  return resolved ? `${resolved.toLowerCase()}@rebus.industries` : null;
}

export async function authorizeToolForRequest(req: FastifyRequest, tool: PrismTool): Promise<boolean> {
  const email = await resolveAdminEmail(req);
  if (!email) return false;

  const key = process.env.PERMISSIONS_INTERNAL_KEY?.trim();
  if (!key) {
    req.log.warn('PERMISSIONS_INTERNAL_KEY unset — allowing admin tool access');
    return true;
  }

  try {
    const res = await fetch(`${PERMISSIONS_BASE()}/api/access/authorize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ email, tool }),
    });
    if (!res.ok) {
      req.log.warn({ status: res.status, tool, email }, 'tool authorize failed');
      return false;
    }
    const body = (await res.json()) as { allowed?: boolean };
    return body.allowed === true;
  } catch (err) {
    req.log.warn({ err, tool, email }, 'tool authorize request failed');
    return false;
  }
}

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
      };
      const scope = scopeMap[tool];
      if (principal.scopes.includes(scope)) return;
      reply.code(403).send({ error: 'forbidden', scope, tool });
      return;
    }

    if (principal.kind === 'adminSession') {
      const allowed = await authorizeToolForRequest(req, tool);
      if (allowed) return;
      reply.code(403).send({ error: 'forbidden', tool });
      return;
    }

    if (principal.kind === 'orbitUser') {
      return;
    }

    reply.code(403).send({ error: 'forbidden', tool });
  };
}
