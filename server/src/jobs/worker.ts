/**
 * BullMQ Worker that pops convert jobs and tries to dispatch them.
 *
 * Phase 3 behaviour:
 *   - dispatch attempt succeeds  -> mark job.status='dispatched', BullMQ
 *                                   job completes immediately (the actual
 *                                   conversion happens on the agent and
 *                                   reports back via WS).
 *   - dispatch fails (no agent)  -> throw so BullMQ retries with backoff.
 *
 * The retry policy here is configured in queue.ts (attempts:1 by default
 * because we want the *real* retry decision to live with PRISM, not the
 * queue). For Phase 3 we lift it locally to give a queued job a chance to
 * find an agent once the pool comes online.
 */
import { Worker, type Job as BullJob } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import { CONVERT_QUEUE, type ConvertJobPayload } from './queue.js';
import { bullConnection } from './redis.js';
import { tryDispatch } from './dispatcher.js';

const NO_AGENT_RETRY_MS = 30_000;
const MAX_NO_AGENT_RETRIES = 240;  // 240 * 30s = 2 hours

export function startConvertWorker(log: FastifyBaseLogger): Worker<ConvertJobPayload> {
  const worker = new Worker<ConvertJobPayload>(
    CONVERT_QUEUE,
    async (job: BullJob<ConvertJobPayload>) => {
      const noAgentAttempts = Number(job.data.noAgentAttempts ?? 0);
      const result = await tryDispatch(job.data.jobId, log);

      if (result.dispatched) {
        return { dispatched: true, nodeName: result.nodeName, agentSessionId: result.agentSessionId };
      }

      if (noAgentAttempts >= MAX_NO_AGENT_RETRIES) {
        // Give up — mark job failed (the agent protocol handler updates jobs.status
        // when an agent reports complete/fail; here we own the "never picked up" path).
        //
        // Guard the UPDATE with a non-terminal status filter. A stale BullMQ
        // retry chain can keep re-firing tryDispatch for a job that has ALREADY
        // reached a terminal state via the agent (observed: a `complete` job
        // whose `:retry:N` delayed entry kept looping for hours). Without this
        // WHERE guard the give-up branch would eventually clobber that finished
        // job back to `failed`, wiping result_url / outputs / completed_at.
        // Only fail jobs that are genuinely still waiting for an agent.
        const { db } = await import('../db/client.js');
        const { jobs } = await import('../db/schema.js');
        const { and, eq, inArray } = await import('drizzle-orm');
        const { broadcastJobUpdate } = await import('../ws/adminProtocol.js');
        const gaveUp = await db
          .update(jobs)
          .set({
            status: 'failed',
            error: `no eligible agent available after ${noAgentAttempts} attempts (${result.reason ?? 'unknown'})`,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(
            eq(jobs.id, job.data.jobId),
            inArray(jobs.status, ['queued', 'dispatched']),
          ))
          .returning({ id: jobs.id });
        if (gaveUp.length > 0) {
          broadcastJobUpdate(job.data.jobId, { status: 'failed', error: `no eligible agent` });
        }
        return { dispatched: false, gaveUp: gaveUp.length > 0 };
      }

      // Re-enqueue with backoff and a bumped attempt counter.
      const { convertQueue } = await import('./queue.js');
      await convertQueue.add(
        'convert',
        { ...job.data, noAgentAttempts: noAgentAttempts + 1 },
        { jobId: `${job.data.jobId}:retry:${noAgentAttempts + 1}`, delay: NO_AGENT_RETRY_MS },
      );
      return { dispatched: false, requeuedIn: NO_AGENT_RETRY_MS };
    },
    {
      connection: bullConnection,
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
      autorun: false,
    },
  );

  worker.on('failed', (job, err) => {
    log.error({ err, jobId: job?.data?.jobId }, 'convert worker job failed');
  });
  worker.on('error', (err) => {
    log.warn({ err }, 'convert worker error');
  });

  worker.run();
  return worker;
}

