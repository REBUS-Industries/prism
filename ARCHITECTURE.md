# PRISM — architecture

PRISM is an ORBIT-native, node-based conversion pipeline. It's split
across two repos and three deploy targets:

- **`REBUS-Industries/prism`** — this repo: server, web SPAs, agent, contracts
- **`REBUS-Industries/orbit-server`** (submodule at `vendor/orbit-monorepo/`)
  — the shared C# SDK and the Rhino connector core, reused by the agent
- **PRISM Server (VM 211)** + **`orbit-server` (VM 211)** + **Rhino
  workstations (RB-DA2-PCxx)**

## Component split

```
External callers
  Convert SPA      Public Convert UI (web/src/convert)
  Admin SPA        Internal Admin UI (web/src/admin)
  ORBIT Rhino      C# plugin pushing direct to orbit-server (not via PRISM)
  /v1/*            REST callers with X-API-Key
       │
       ▼
Caddy (prism.rebus.industries) ──► PRISM Server (Node + Fastify, VM 211)
                                        │
                                        ├── Postgres (jobs, keys, settings, ...)
                                        ├── Redis    (BullMQ queue + SSE fan-out)
                                        └── WS gateway (admin + agent)
                                                  │
                                                  ▼
                                          PRISM.Agent.exe (Windows service)
                                          on each Rhino workstation
                                                  │
                                                  ├── Rhino.Inside (Rhino 8)
                                                  └── OrbitConnector.Rhino.Core
                                                          │
                                                          ▼
                                                  orbit-server (VM 211)
                                                  + MinIO blob store
```

## Source policy

3DConvert (the legacy Python service on the Speckle prod VM) and the
`CheekiSkrub/*` Speckle fork repos are **read-only reference material**.
They taught us what features the team relies on; every line of PRISM
was written fresh against that capability checklist.

The only first-party reuse comes from the ORBIT monorepo, via the
git submodule at `vendor/orbit-monorepo/`:

- `SDK/src/Orbit.Objects` — geometry types
- `SDK/src/Orbit.Sdk`     — transport + auth client
- `Connectors/src/OrbitConnector.Rhino` — the Rhino send / receive
  pipeline. Phase 3 compile-includes the converter source until the
  monorepo extracts `OrbitConnector.Rhino.Core`, at which point this
  becomes a plain `ProjectReference`.

## Server (TypeScript / Fastify)

Source: `server/src/`

- `main.ts`              app bootstrap (cookie, cors, multipart, websocket, static)
- `bootstrap.ts`         on-boot migrations + admin seed
- `db/`                  Drizzle schema + migrations (Postgres)
- `auth/`                api-key, ORBIT bearer, admin session middleware
- `api/`                 internal `/api/*` REST surface (convert / jobs /
                         workstations / keys / settings / receive / pipelines / webhooks)
- `v1/`                  public `/v1/*` external API + per-key rate
                         limit + monthly quota
- `webhooks/`            terminal-event dispatcher (per-job callback +
                         admin-managed subscribers; HMAC-SHA256 signed)
- `ws/`                  WS gateway, agent + admin protocols, session registry
- `jobs/`                BullMQ wrapper (queue + worker + dispatcher)
- `conversion/`          static pipeline DAG used by both dispatcher + flow editor
- `webStatic.ts`         serves the built Vue SPAs from `WEB_DIST_DIR`

## Web (Vue 3)

Two SPAs sharing one Vite project + design system. Both use
`createWebHashHistory` so all client-side routing is fragment-based —
no SPA-fallback config needed at the web server.

- `web/src/shared/`      design tokens, typed API client, admin WS client
- `web/src/admin/`       admin SPA (Dashboard, Workstations, Pipeline,
                         API keys, Webhooks, Settings, Users, Analytics)
- `web/src/convert/`     public convert UI (upload + ORBIT target +
                         progress with SSE live updates)

The Pipeline page renders the static topology from
`server/src/conversion/pipelines.ts` via `@vue-flow/core`, overlaid
with live workstation nodes and animated job particles.

## Agent (C# .NET 8)

Source: `agent/src/PRISM.Agent/`

- `Program.cs`           Generic Host, DI wiring, AgentService
- `Config/AgentConfig.cs`  reads `agent-config.json` + auto-resolves machineId
- `Ws/WsClient.cs`       auto-reconnecting WS client
- `Ws/AgentMessageDispatcher.cs`  routes server frames (welcome/assign/cancel)
- `Pipeline/WorkerSlotPool.cs`    N-slot concurrent job processor
- `Pipeline/ConvertJob.cs`        the actual conversion or receive job
- `Rhino/RhinoHost.cs`            singleton Rhino.Inside host
- `Rhino/RhinoFileOpener.cs`      format → import strategy

A single PRISM.Agent.exe process exposes N worker slots. Slots share
the same in-process Rhino (Rhino is not reentrant, so they serialise
on the Rhino-side but overlap download + upload).

## Cross-language contracts

`shared/contracts/agent-protocol.json` is the canonical wire format
(JSON Schema). Hand-maintained typed mirrors live at:

- `shared/contracts/agent-protocol.ts` (TypeScript)
- `shared/contracts/AgentProtocol.cs`  (C#)

`server/scripts/codegen-contracts.mjs` validates all three stay in
sync — wired into CI as the `schemas` job.

## Deployment

- `.github/workflows/server.yml` — builds + pushes
  `ghcr.io/rebus-industries/prism-server` on every push to `main` and tag
- `.github/workflows/agent.yml`  — builds the C# agent as a self-contained
  single-file Windows publish, signs it (when CODE_SIGN_* secrets are set),
  and attaches the zip to a GH Release on tag push
- `.github/workflows/deploy.yml` — SSHes to VM 211 / 212, pulls the new
  image, runs `docker compose up -d`
- `infra/docker-compose.yml`     — production compose: prism-server +
  postgres + redis
- `infra/Caddyfile.snippet`      — proxy config for the LXC proxy pair

See `DEPLOY.md` and `AGENT_INSTALL.md` for runbook detail.
