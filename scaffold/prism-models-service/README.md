# prism-models-service

Polyrepo microservice for the **PRISM Model Library** — same split-stack pattern as `prism-fixtures-service`.

**Live repo:** https://github.com/REBUS-Industries/prism-models-service

```powershell
git clone https://github.com/REBUS-Industries/prism-models-service.git
```

This folder in the PRISM monorepo (`scaffold/prism-models-service/`) is a reference copy; develop in the polyrepo checkout.

## Secrets

| Secret | Purpose |
|--------|---------|
| `PRISM_DISPATCH_TOKEN` | PAT with `repo` scope — triggers `deploy-dev-service` on `REBUS-Industries/prism` after image push (configured) |

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
