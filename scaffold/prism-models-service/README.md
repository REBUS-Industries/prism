# prism-models-service

Polyrepo microservice for the **PRISM Model Library** — same split-stack pattern as `prism-fixtures-service`.

## Create the GitHub repo (once)

From this directory:

```powershell
gh repo create REBUS-Industries/prism-models-service --private --source=. --remote=origin --push
```

If the repo already exists:

```powershell
git init
git remote add origin https://github.com/REBUS-Industries/prism-models-service.git
git checkout -b main
git add .
git commit -m "chore: bootstrap models service scaffold"
git push -u origin main
```

## Secrets

| Secret | Purpose |
|--------|---------|
| `PRISM_DISPATCH_TOKEN` | PAT with `repo` scope — triggers `deploy-dev-service` on `REBUS-Industries/prism` after image push |

## CI

- Workflow name: **`models-image`** (merge-bot watches this)
- Image: `ghcr.io/rebus-industries/prism-models-service`
- On merge to `main`: build → push GHCR → `repository_dispatch` → restart `prism-models` on VM 212

## Dev stack

- Container: `prism-models`
- Port: **8770**
- Nginx routes: `/api/models`, `/api/model-import` (see `PRISM/infra/nginx.router.conf`)
- Storage: `${DATA_DIR}/models/` on shared `prism-data` volume

## Related PRISM monorepo work

- Branch: `feat/model-library`
- Handoff: `PRISM/.cursor/plans/HANDOFF-model-library.md`
- Architecture: `PRISM/docs/MODEL_LIBRARY.md`
