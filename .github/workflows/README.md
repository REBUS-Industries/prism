# `.github/workflows/`

CI pipelines for PRISM. Phase 0 leaves these as documented placeholders;
Phase 8 fills in the actual job definitions.

| Workflow | Trigger | Purpose |
|---|---|---|
| `server.yml` | push to `main`, paths `server/**` `shared/**` | Build + push `ghcr.io/rebus-orbit/prism-server:latest` (multi-arch) |
| `web.yml` | push to `main`, paths `web/**` | Build the admin + convert SPAs; assets are baked into the server image |
| `agent.yml` | tag matching `agent-v*` | Build + sign the Windows `.msi`, attach to GitHub Release |
| `deploy.yml` | push to `main` after `server.yml` succeeds, OR manual `workflow_dispatch` | SSH to VM 211 -> `git pull && docker compose pull && docker compose up -d` |

## Required secrets (set in repo settings)

| Secret | Used by |
|---|---|
| `GHCR_PAT` | `server.yml` to push to GHCR |
| `VM211_SSH_KEY` | `deploy.yml` to SSH into VM 211 |
| `VM211_SSH_HOST` | `deploy.yml` (`10.0.200.211`) |
| `VM211_SSH_USER` | `deploy.yml` (`rebus`) |
| `CODESIGN_PFX_BASE64` | `agent.yml` for Authenticode signing |
| `CODESIGN_PFX_PASSWORD` | `agent.yml` |
