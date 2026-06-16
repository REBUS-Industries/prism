# prism

ORBIT-native file-conversion pipeline + Unreal visualiser. Monorepo for the
`REBUS-Industries/prism` repo.

**New agent session:** read `.cursor/plans/README.md` first (git, deploy, workstream handoff).

**Architecture:** `orbit-infra` repo → `systems/prism.md`. **Deploy:** `infra/runbooks/deploy-prism.md`.

## Layout
`server/` (TS Fastify + WS gateway) · `web/` (Vue 3 SPAs) · `agent/` (C# .NET 8 tray, Rhino.Inside; spawns the visualiser) · `assimp/` (Python FastAPI pre-converter) · `visualiser/` (.NET orchestrator → external UE 5.7 Pixel Streaming, NOT a UE project) · `shared/contracts/` · `infra/` · `vendor/orbit-monorepo/` (submodule → orbit-server).

## Key facts
- Prod (VM 212) on rolling `sha-*` deploy via self-hosted runner CT 261 (flaky — manual recovery in the runbook).
- Single environment: `prism-dev` retired (301 redirect). VM 211 is ORBIT-prod-only.
- coturn/TURN on VM 212 (`/home/rebus/coturn/`); config in `infra/coturn/`.
- First-party reuse only via `vendor/orbit-monorepo/`; CheekiSkrub/3DConvert are read-only reference.
