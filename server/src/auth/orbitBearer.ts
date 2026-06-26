/**
 * ORBIT bearer auth: forwards `Authorization: Bearer <orbit-token>` to
 * orbit-server's GraphQL endpoint, asks for `{ activeUser { id } }`,
 * and caches positive results for 5 minutes.
 */
import { request } from 'undici';
import type { FastifyRequest } from 'fastify';
import { getSetting } from '../db/settings.js';

interface CacheEntry {
  userId: string;
  serverUrl: string;
  expiresAt: number;
}
const POSITIVE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

const GQL_ACTIVE_USER = `query { activeUser { id } }`;

const CANONICAL_ORBIT_URLS = [
  'https://orbit.rebus.industries',
] as const;

function normalizeUrl(raw?: string | null): string | undefined {
  const u = raw?.trim().replace(/\/+$/, '');
  return u || undefined;
}

/** Deduped ORBIT hosts to probe — settings, env, then the canonical prod URL.
 *  (ORBIT dev/staging was retired — there is a single production server.) */
async function collectOrbitUrls(): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw?: string | null) => {
    const u = normalizeUrl(raw);
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };

  add(await getSetting('orbit_server_url'));
  add(process.env.ORBIT_SERVER_URL);
  for (const u of CANONICAL_ORBIT_URLS) add(u);
  return out;
}

/**
 * @returns the ORBIT user id if the token validates against `serverUrl`, or null.
 */
async function validateAgainstUrl(
  token: string,
  serverUrl: string,
): Promise<{ userId: string; serverUrl: string } | null> {
  try {
    const res = await request(`${serverUrl}/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: GQL_ACTIVE_USER }),
    });
    if (res.statusCode !== 200) return null;
    const body = await res.body.json() as {
      data?: { activeUser?: { id?: string } };
      errors?: Array<{ message?: string }>;
    };
    if (body.errors?.length) return null;
    const id = body?.data?.activeUser?.id;
    if (!id) return null;
    return { userId: id, serverUrl };
  } catch {
    return null;
  }
}

/**
 * @returns the ORBIT user id if the token validates on any known host, or null.
 */
async function validate(token: string): Promise<{ userId: string; serverUrl: string } | null> {
  const cached = cache.get(token);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return { userId: cached.userId, serverUrl: cached.serverUrl };
  }

  for (const serverUrl of await collectOrbitUrls()) {
    const result = await validateAgainstUrl(token, serverUrl);
    if (result) {
      cache.set(token, { userId: result.userId, serverUrl: result.serverUrl, expiresAt: now + POSITIVE_TTL_MS });
      return result;
    }
  }
  return null;
}

/** Periodically drop expired entries so the cache doesn't grow unbounded. */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
}, 60_000).unref();

export async function tryAuthOrbitBearer(req: FastifyRequest): Promise<boolean> {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim();
  if (!token) return false;

  const result = await validate(token);
  if (!result) return false;

  req.principal = {
    kind: 'orbitUser',
    userId: result.userId,
    orbitToken: token,
    serverUrl: result.serverUrl,
  };
  return true;
}
