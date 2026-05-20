/**
 * Per-API-key rate limiting and per-month quota enforcement for the
 * /v1/* external API.
 *
 * Implementation:
 *   - Rate limit:  Redis `INCR` on `rl:<keyId>:<min>` with a 65-second
 *                  TTL. Threshold = api_keys.rate_limit_per_min.
 *                  Returns 429 with Retry-After + standard headers.
 *   - Quota:       Redis `INCR` on `quota:<keyId>:<yyyy-mm>` with a 35-day
 *                  TTL. Threshold = api_keys.monthly_quota. Counts each
 *                  successful job submission (not every request).
 *
 * Counters are best-effort: a Redis hiccup fails open (logs a warning).
 * Both ceilings can be null = unlimited.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { redis } from '../jobs/redis.js';

interface KeyMeta {
  id: string;
  ratePerMin: number | null;
  monthlyQuota: number | null;
}

const keyMetaCache = new Map<string, { meta: KeyMeta; expiresAt: number }>();
const KEY_CACHE_TTL_MS = 30_000;

async function getKeyMeta(keyId: string): Promise<KeyMeta | null> {
  const cached = keyMetaCache.get(keyId);
  if (cached && cached.expiresAt > Date.now()) return cached.meta;
  const row = await db.query.apiKeys.findFirst({ where: eq(apiKeys.id, keyId) });
  if (!row) return null;
  const meta: KeyMeta = { id: row.id, ratePerMin: row.rateLimitPerMin, monthlyQuota: row.monthlyQuota };
  keyMetaCache.set(keyId, { meta, expiresAt: Date.now() + KEY_CACHE_TTL_MS });
  return meta;
}

function currentMinuteKey(keyId: string): string {
  return `prism:rl:${keyId}:${Math.floor(Date.now() / 60_000)}`;
}

function currentMonthKey(keyId: string): string {
  const d = new Date();
  return `prism:quota:${keyId}:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Pre-handler: rejects if the API key has blown its per-minute window.
 * Quota is checked at job-creation time (in the route handler) because
 * many requests don't create a job (e.g. GET /v1/jobs/:id).
 */
export async function enforceRateLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const p = req.principal as { kind: string; apiKeyId?: string } | undefined;
  if (p?.kind !== 'apiKey' || !p.apiKeyId) return;
  const meta = await getKeyMeta(p.apiKeyId);
  if (!meta || !meta.ratePerMin) return;

  const k = currentMinuteKey(meta.id);
  try {
    const count = await redis.incr(k);
    if (count === 1) await redis.expire(k, 65);
    const remaining = Math.max(0, meta.ratePerMin - count);
    reply.header('x-ratelimit-limit',     String(meta.ratePerMin));
    reply.header('x-ratelimit-remaining', String(remaining));
    if (count > meta.ratePerMin) {
      const ttl = await redis.ttl(k);
      reply.header('retry-after', String(Math.max(1, ttl)));
      reply.code(429).send({ error: 'rate limit exceeded' });
      return;
    }
  } catch (err) {
    req.log.warn({ err }, 'rate-limit redis failed; failing open');
  }
}

/**
 * Increment the monthly quota and return whether it was within the cap.
 * Called explicitly from job-creation handlers so we don't burn quota on
 * non-creating requests.
 */
export async function consumeQuotaOrReject(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const p = req.principal as { kind: string; apiKeyId?: string } | undefined;
  if (p?.kind !== 'apiKey' || !p.apiKeyId) return true;
  const meta = await getKeyMeta(p.apiKeyId);
  if (!meta || !meta.monthlyQuota) return true;

  const k = currentMonthKey(meta.id);
  try {
    const count = await redis.incr(k);
    if (count === 1) await redis.expire(k, 60 * 60 * 24 * 35);
    reply.header('x-quota-limit',     String(meta.monthlyQuota));
    reply.header('x-quota-remaining', String(Math.max(0, meta.monthlyQuota - count)));
    if (count > meta.monthlyQuota) {
      reply.code(402).send({ error: 'monthly quota exceeded' });
      return false;
    }
    return true;
  } catch (err) {
    req.log.warn({ err }, 'quota redis failed; failing open');
    return true;
  }
}
