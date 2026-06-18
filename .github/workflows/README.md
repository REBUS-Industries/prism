# `.github/workflows/`

CI pipelines for PRISM.

| Workflow | Trigger | Deploy (VM 212) |
|---|---|---|
| `web-image` (`web.yml`) | push to `main` or `feat/permissions`, paths `web/**`; **PR:** `npm run build` only (no image push) | Builds + deploys `prism-web` (+ `prism-fixtures`, `prism-models`, `prism-router`) |
| `server-image` (`server.yml`) | push to `main`, paths `server/**` `shared/**` `agent/install/**` … | Builds + deploys `prism-server` (+ related services) |
| `permissions-image` (`permissions-image.yml`) | push to `main`, paths `scaffold/prism-permissions-service/**`; **manual:** `workflow_dispatch` | Builds `prism-permissions-service` image from the scaffold + deploys `prism-permissions` |
| `agent.yml` | tag matching `agent-v*` | — |
| `assimp.yml` | push to `main`, paths `assimp/**` | — |

**On merge to `main`:** each workflow runs independently when its path filter matches. A PR that touches both `web/**` and `server/**` triggers **both** workflows. The Slack merge bot waits for all triggered deploy workflows to finish before reporting success.

**`feat/permissions`:** pushes that touch `web/**` auto-build and deploy to VM 212 (same as `main`).

**`prism-permissions`:** the intended polyrepo `REBUS-Industries/prism-permissions-service` was never created, so `permissions-image` builds the service from `scaffold/prism-permissions-service/` in this monorepo and deploys it to VM 212. The **first** deploy is manual (`gh workflow run permissions-image --repo REBUS-Industries/prism`) since the running container predates this pipeline; afterwards scaffold changes auto-deploy. Rollback: set `PRISM_PERMISSIONS_TAG` in `/opt/prism/.env` to the prior `sha-*` and `docker compose up -d prism-permissions`.

**Manual deploy of other feature branches:**
```powershell
gh workflow run web-image --repo REBUS-Industries/prism --ref <branch>
gh workflow run server-image --repo REBUS-Industries/prism --ref <branch>
```

There is one PRISM environment — VM 212 (`prism.rebus.industries`); merges to `main` deploy there. `v*` tags / `workflow_dispatch` produce pinned release images. VM 211 is ORBIT-only (the tag-gated PRISM monolith there was decommissioned 2026-06-16).
