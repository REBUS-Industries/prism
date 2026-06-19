# `.github/workflows/`

CI pipelines for PRISM.

| Workflow | Trigger | Deploy (VM 212) |
|---|---|---|
| `web-image` (`web.yml`) | push to `main` or `feat/permissions`, paths `web/**`; **PR:** `npm run build` only (no image push) | Builds + deploys `prism-web` (+ `prism-fixtures`, `prism-models`, `prism-router`) |
| `server-image` (`server.yml`) | push to `main`, paths `server/**` `shared/**` `agent/install/**` … | Builds + deploys `prism-server` (+ related services) |
| `permissions-image` (`permissions-image.yml`) | push to `main`, paths `scaffold/prism-permissions-service/**`; **manual:** `workflow_dispatch` | Builds `prism-permissions-service` image from the scaffold + deploys `prism-permissions` |
| `redeploy-prod` (`redeploy-prod.yml`) | **manual:** `workflow_dispatch`; **auto:** merge to `main` when this workflow file changes | Pull + restart selected VM 212 services (default: `prism-fixtures`, `prism-server`, `prism-materials`, `prism-router`) |
| `agent.yml` | tag matching `agent-v*` | — |
| `assimp.yml` | push to `main`, paths `assimp/**` | — |

**On merge to `main`:** each workflow runs independently when its path filter matches. A PR that touches both `web/**` and `server/**` triggers **both** workflows. The Slack merge bot waits for all triggered deploy workflows to finish before reporting success.

**`feat/permissions`:** pushes that touch `web/**` auto-build and deploy to VM 212 (same as `main`).

**`prism-permissions`:** builds on the self-hosted deploy runner and loads the image onto VM 212 via `docker save | ssh docker load` (GHCR push is blocked until org admins grant the `prism-permissions-service` package write access to this repo). Rollback: set `PRISM_PERMISSIONS_TAG` in `/opt/prism/.env` to the prior `sha-*` and `docker compose up -d prism-permissions`.

**Manual deploy of other feature branches:**
```powershell
gh workflow run web-image --repo REBUS-Industries/prism --ref <branch>
gh workflow run server-image --repo REBUS-Industries/prism --ref <branch>
```

**Redeploy polyrepo services without rebuilding monorepo images** (e.g. refresh `prism-fixtures-service:latest` on VM 212):

```powershell
gh workflow run redeploy-prod --repo REBUS-Industries/prism --ref main `
  -f services="prism-fixtures prism-server prism-materials prism-router"
```

Polyrepo pulls need org secret `GHCR_PULL_TOKEN` (`read:packages`) when `GITHUB_TOKEN` is repo-scoped only.

**GHCR pull on VM 212:** deploy jobs run `docker login ghcr.io` over SSH before
`docker compose pull` (see `.github/actions/ghcr-login-vm`). Optional org secret
`GHCR_PULL_TOKEN` (`read:packages`) covers polyrepo images when `GITHUB_TOKEN` is
repo-scoped only.

There is one PRISM environment — VM 212 (`prism.rebus.industries`); merges to `main` deploy there. `v*` tags / `workflow_dispatch` produce pinned release images. VM 211 is ORBIT-only (the tag-gated PRISM monolith there was decommissioned 2026-06-16).
