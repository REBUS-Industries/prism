# HANDOFF â€” Portal permissions workstream

## Branch / repos

| Repo | Branch | Notes |
|------|--------|-------|
| `REBUS-Industries/prism` | `feat/permissions` | Admin UI, infra, contracts, docs |
| `REBUS-Industries/prism-permissions-service` | `main` | Push from `PRISM/scaffold/prism-permissions-service/` |
| `REBUS-Industries/orbit-connectors` | feature branch | Portal login + manifest gating |

## Owned files (prism monorepo)

- `shared/contracts/portal-access.ts` / `.json`
- `scaffold/prism-permissions-service/**`
- `web/src/admin/pages/Permissions.vue`, `web/src/admin/components/permissions/**`
- `web/src/shared/api.ts` â€” `permissionsApi` block
- `web/src/admin/main.ts`, `web/src/admin/App.vue` â€” route + nav
- `infra/docker-compose.dev.yml`, `infra/nginx.router.conf`, `infra/merge-bot/index.js`
- `.github/workflows/web.yml`, `deploy-service.yml`, `deploy-on-package.yml`
- `server/src/api/keys.ts` â€” `access:*` scopes
- `docs/PERMISSIONS.md`, `docs/PORTAL_CONTRACT.md`

## Deploy

1. Create `prism-permissions-service` repo; set `PRISM_DISPATCH_TOKEN` org secret.
2. Merge permissions-service to `main` â†’ `permissions-image` builds + dispatches deploy.
3. Merge prism `feat/permissions` â†’ `web-image` pulls `prism-permissions` + reloads router.
4. Verify on https://prism.rebus.industries:
   - `GET /api/access/health`
   - `POST /api/access/session` with `mock:alice`
   - Admin â†’ Permissions saves graph

## Connector smoke test

Rhino panel â†’ **Sign in with REBUS** (uses mock-login on PRISM prod).

## Workspace smoke test

1. Admin â†’ **Users** â†’ link `rebus.industries` â†’ **Sync directory**
2. Edit `alice@rebus.industries` â€” enable **PRISM admin**, set project `mock-project-1` / contributor
3. **Sign in with Google** on admin login (mock persona alice)
4. Connector session with `mock:alice` receives provisioned project grants

CLI: `orbit-cli auth login --server dev` (OAuth â€” full access, not portal-scoped)

## Risks

- ORBIT `apiTokenCreate` may need orbit-server patch â€” service falls back to admin token unless `ORBIT_MINT_FALLBACK=0`.
- Live portal OAuth URLs not final â€” swap mock-login for real portal authorize URL when ready.
