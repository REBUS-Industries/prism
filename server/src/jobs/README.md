# `server/src/jobs/`

Job queue + dispatcher. BullMQ holds the queue; the dispatcher decides
which agent gets which job based on capabilities (formats, roles, slot
availability).

| File | Purpose |
|---|---|
| `queue.ts` | BullMQ wrapper: enqueue, peek, drain, dead-letter |
| `dispatcher.ts` | Pop a job, find an eligible idle agent, push an `assign` WS message |
| `lateFinalize.ts` | Tolerates the race where a job times out on the server but the agent's WS `complete` arrives later — promotes `failed` -> `complete` |
| `progressBus.ts` | In-process bus that fans out progress events to `/ws/admin` subscribers and the SSE log endpoint |
