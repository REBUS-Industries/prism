# PRISM Architecture

This document is the design contract for PRISM. Implementations in
[`server/`](server), [`web/`](web), and [`agent/`](agent) follow what's
written here; if the implementation diverges, update this file in the same
commit.

## Two layers, one wire format

PRISM separates the **orchestrator** (one TypeScript service on VM 211)
from the **workers** (N Windows machines running PRISM.Agent.exe with
Rhino 8). They talk over a single WebSocket connection per agent.

```text
+------- VM 211 ----------------+         +--- RB-DA2-PCxx (Windows) -------+
|                               |  WSS    |                                  |
|   PRISM Server (Fastify)      |<------->|   PRISM.Agent.exe                |
|     REST  /api/*  /v1/*       |         |     Rhino.Inside .NET 8          |
|     WS    /ws/agent           |         |     OrbitConnector.Rhino.Core    |
|     WS    /ws/admin           |         |     N worker slots               |
|                               |         |                                  |
|   Postgres (Drizzle)          |         +----------------+-----------------+
|   Redis (BullMQ)              |                          |
|                               |                          | HTTPS  (orbit objects + blobs)
|   Vue 3 admin + convert SPAs  |                          v
+--+-----------------+----------+                +------- orbit-server -----+
   |                 |                           |        (VM 211)          |
   |                 |                           +--------------------------+
   v                 v
admin user      convert user           
```

**Why one WS per agent rather than HTTP polling:**

- Real-time progress / log streaming (the Vue admin flow editor consumes
  the same events for live job particles).
- Server pushes work to idle agents instead of agents polling for it
  (lower latency, simpler dispatch).
- The agent can advertise capability changes (slot busy/free, supported
  formats) instantly.

**Why the agent uploads ORBIT objects directly:**

- PRISM never has to hold mesh data in memory. Converter output goes
  straight from Rhino on the workstation to `orbit-server`'s object
  endpoint — same code path the ORBIT Rhino Connector already uses.
- The user's ORBIT bearer token rides the job and is used by the agent;
  PRISM never sees or persists it.

## Repo + cross-repo dependencies

- This repo: [REBUS-ORBIT/prism](https://github.com/REBUS-ORBIT/prism).
- ORBIT SDK + Rhino-connector core: vendored as a git submodule at
  [`vendor/orbit-monorepo/`](vendor/orbit-monorepo), pinned to a specific
  commit of [REBUS-ORBIT/orbit-server](https://github.com/REBUS-ORBIT/orbit-server).
  PRISM's [`agent/PRISM.Agent.sln`](agent/PRISM.Agent.sln) references the
  C# projects under that submodule directly. Bump the submodule when the
  SDK / connector core moves.

## Wire format: agent <-> server

Defined in [`shared/contracts/agent-protocol.json`](shared/contracts/agent-protocol.json)
(JSON Schema). Both the TypeScript server and the C# agent generate their
types from this single source.

Message kinds (overview, see schema for shapes):

| Direction | Type | Purpose |
|---|---|---|
| agent -> server | `hello` | Agent identifies itself: name, machineId, slot count, supported formats, roles |
| agent -> server | `heartbeat` | Periodic liveness + slot state |
| server -> agent | `assign` | Dispatch a job to a specific slot |
| agent -> server | `progress` | Stage + percent + free-form message |
| agent -> server | `log` | Streaming log line for `/api/jobs/:id/stream` |
| agent -> server | `complete` | Job succeeded; payload includes ORBIT version URL |
| agent -> server | `fail` | Job failed; error + stack |
| server -> agent | `cancel` | Server-initiated cancel |
| server -> agent | `pollLayers` | Layer-inspection job (no conversion) |
| agent -> server | `layers` | Response to pollLayers: layer tree |

## Stable surfaces

- **REST**: `/api/*` for the admin + convert SPAs; `/v1/*` for external
  callers (rate-limited, versioned, never breaking-changed).
- **WS**: `/ws/agent`, `/ws/admin`.
- **DB**: Drizzle migrations are the schema source of truth. No
  hand-rolled SQL.

## Pipeline DAG

Declared in code at [`server/src/conversion/pipelines.ts`](server/src/conversion/pipelines.ts).
The same DAG drives both job dispatch (which steps run, in what order) and
the live flow editor in the admin SPA (the visible "nodes" the user sees).

Default pipeline:

```text
Ingest -> Validate -> Queue -> Dispatch -> Workstation -> Upload -> Notify
```

Optional steps (toggle from admin): `LayerInspect` (between Ingest and
Queue), `Preview` (after Upload, for the GLB preview link), `Webhook`
(after Notify).
