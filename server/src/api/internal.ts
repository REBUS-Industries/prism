/**
 * /internal/* — privileged endpoints used by PRISM.Agent only.
 *
 * - GET /internal/files/:jobId?token=...  Streams the staged upload file
 *   to the agent. Tokens are one-shot, signed with SESSION_SECRET, and
 *   bound to a specific jobId + expiry. The dispatcher mints one per
 *   `assign`.
 *
 * - GET /internal/health                  Simple ping; the agent uses
 *   this to confirm connectivity before retrying a job.
 *
 * Not registered under /api so it doesn't go through requireAuth — the
 * file token is the auth.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { redis } from '../jobs/redis.js';

const TOKEN_TTL_SECONDS = 30 * 60;  // 30 min — generous for big uploads on slow links

function getSecret(): string {
  return process.env.SESSION_SECRET ?? 'unsafe-dev-only-do-not-use-in-prod';
}

function sign(payload: string): string {
  return createHmac('sha256', getSecret()).update(payload).digest('hex');
}

/** Mint a one-shot download token bound to (jobId, nonce, expiry). */
export async function issueDownloadToken(jobId: string): Promise<string> {
  const nonce = randomBytes(12).toString('base64url');
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = `${jobId}.${nonce}.${expiresAt}`;
  const sig = sign(payload);
  const token = `${payload}.${sig}`;
  // Remember the nonce in Redis so we can revoke after use.
  await redis.set(`prism:dl:${jobId}:${nonce}`, '1', 'EX', TOKEN_TTL_SECONDS);
  return token;
}

function verifyDownloadToken(jobId: string, token: string): { ok: boolean; nonce?: string; reason?: string } {
  const parts = token.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed token' };
  const [tokenJobId, nonce, expiresAtStr, sig] = parts as [string, string, string, string];
  if (tokenJobId !== jobId) return { ok: false, reason: 'jobId mismatch' };
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'bad expiry' };
  if (expiresAt < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  const expected = sign(`${tokenJobId}.${nonce}.${expiresAtStr}`);
  if (expected !== sig) return { ok: false, reason: 'bad signature' };
  return { ok: true, nonce };
}

const plugin: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({ status: 'ok', service: 'prism-server-internal' }));

  app.get<{ Params: { jobId: string }; Querystring: { token?: string } }>('/files/:jobId', async (req, reply) => {
    const token = req.query.token;
    if (typeof token !== 'string') return reply.code(401).send({ error: 'token required' });
    const v = verifyDownloadToken(req.params.jobId, token);
    if (!v.ok) return reply.code(401).send({ error: v.reason });

    // Revoke the nonce so the URL can only be used once.
    if (v.nonce) await redis.del(`prism:dl:${req.params.jobId}:${v.nonce}`);

    const job = await db.query.jobs.findFirst({ where: eq(jobs.id, req.params.jobId) });
    if (!job) return reply.code(404).send({ error: 'job not found' });

    let stats;
    try {
      stats = await stat(job.filePath);
    } catch {
      return reply.code(410).send({ error: 'file gone' });
    }

    reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(stats.size))
      .header('content-disposition', `attachment; filename="${encodeURIComponent(job.fileName)}"`);
    return reply.send(createReadStream(job.filePath));
  });
};

export default plugin;
