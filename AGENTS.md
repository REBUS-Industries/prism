# prism

ORBIT-native file-conversion pipeline + Unreal visualiser. Monorepo for the
`REBUS-Industries/prism` repo.

**Architecture:** `orbit-infra` repo → `systems/prism.md`. **Deploy:** `infra/runbooks/deploy-prism.md`.

## Layout
`server/` (TS Fastify + WS gateway) · `web/` (Vue 3 SPAs) · `agent/` (C# .NET 8 tray, Rhino.Inside; spawns the visualiser) · `assimp/` (Python FastAPI pre-converter) · `visualiser/` (.NET orchestrator → external UE 5.7 Pixel Streaming, NOT a UE project) · `shared/contracts/` · `infra/` · `vendor/orbit-monorepo/` (submodule → orbit-server).

## Key facts
- Prod (VM 211) on rolling `sha-*` deploy via self-hosted runner CT 261 (flaky — manual recovery in the runbook).
- Versions at HEAD: agent `v0.3.16` (PC01 live `v0.3.15`), server `v0.3.0`, visualiser `v0.5.14`.
- Do NOT commit `visualiser/publish-*/` (build artefacts — gitignore them).
- coturn config: `infra/coturn/` (commit the working copy from the repo-root `TURN/` folder).
- First-party reuse only via `vendor/orbit-monorepo/`; CheekiSkrub/3DConvert are read-only reference.
