# Handoff: Model Library Workstream

**Branch:** `feat/model-library` (REBUS-Industries/prism)
**Owned by:** Dedicated agent seat — coordinate with fixture-builder and materials-editor devs on shared files.
**Pairs with:** `feat/fixture-builder` · `feat/materials-editor` · **`prism-models-service`** polyrepo

**Read first:** `.cursor/plans/AGENT-GIT-INSTRUCTIONS.md` — merge via `/prism-merge <PR#>` in #prism-dev; confirm deploy workflows finished before testing on dev.

---

## 1. Workspace setup (new PC)

```powershell
# PRISM monorepo (admin UI)
git clone https://github.com/REBUS-Industries/prism.git
cd prism
git checkout feat/model-library
cd web && npm install

# Models API polyrepo (backend)
git clone https://github.com/REBUS-Industries/prism-models-service.git
# If repo does not exist yet, bootstrap from:
#   prism/scaffold/prism-models-service/README.md
```

Open the `prism` folder in Cursor. Rule file: `.cursor/rules/model-library-workstream.mdc`.

**Prod/dev servers:**
- Dev (VM 212): https://prism-dev.rebus.industries
- Prod (VM 211): tag-gated — don't touch.

**Deploy this branch to dev for review:**

```powershell
# Web/UI changes (every prism PR for this workstream)
gh workflow run web-image --repo REBUS-Industries/prism --ref feat/model-library

# Models API backend (separate repo)
gh workflow run models-image --repo REBUS-Industries/prism-models-service --ref <branch>
```

Do **not** edit `prism/server/**` except `server/src/api/keys.ts` for API key scopes (coordinate with materials-editor if needed).

---

## 2. Architecture (mirror fixture library)

| Layer | Fixture library | Model library |
|-------|-----------------|---------------|
| **Polyrepo** | `prism-fixtures-service` | **`prism-models-service`** |
| **Port** | 8769 | **8770** |
| **CI workflow** | `fixtures-image` | **`models-image`** |
| **Compose service** | `prism-fixtures` | **`prism-models`** |
| **Nginx routes** | `/api/fixtures`, `/api/gdtf-share`, `/api/mvr-import` | **`/api/models`**, **`/api/model-import`** |
| **Storage** | `${DATA_DIR}/fixtures/` | **`${DATA_DIR}/models/`** |
| **Admin UI** | `/fixtures`, `/fixtures/library`, `/fixtures/:id` | **`/models`**, **`/models/library`**, **`/models/:id`**, **`/models/import`** |
| **Contracts** | `prism-shared/.../fixtures.ts` | **`prism-shared/.../models.ts`** (create) |
| **API scopes** | `fixtures:read/write/delete/import` | **`models:read/write/delete/import`** |

See **`docs/MODEL_LIBRARY.md`** for data model and API design targets.

**Routing:** Model API is **not** in `prism-server`. Nginx on VM 212 forwards model paths to `prism-models:8770` (same split-stack as fixtures).

---

## 3. What this workstream owns

### PRISM monorepo (`feat/model-library`)

| Area | Files (create / edit) |
|------|------------------------|
| Admin pages | `web/src/admin/pages/Models.vue`, `ModelEditor.vue`, `ModelImport.vue`, `PrismModelLibrary.vue` |
| Components | `web/src/admin/components/ModelViewer.vue`, tree/preview helpers under `components/` + `utils/` |
| Routes | `web/src/admin/main.ts` |
| Nav | `web/src/admin/App.vue` |
| Client API | `web/src/shared/api.ts` — `modelsApi` block at end |
| Types | `web/src/admin/utils/modelTypes.ts` |
| Docs | `docs/MODEL_LIBRARY.md` |
| Scopes | `server/src/api/keys.ts` — `models:*` scopes only |

### Polyrepo (`prism-models-service`)

| Path | Role |
|------|------|
| `src/api/models.ts` | CRUD, list, search |
| `src/api/model-import.ts` | Upload / register meshes (glTF, FBX, etc.) |
| `src/import/` | Parsers, asset registration, LOD selection (mirror fixtures import layout) |
| `src/db/` or shared migration | Model store schema (coordinate via `prism-shared`) |
| `Dockerfile`, `.github/workflows/models-image.yml` | Build + deploy |

**Bootstrap:** `scaffold/prism-models-service/` in the monorepo until the GitHub repo is created.

---

## 4. Do not edit (other workstreams)

| Owner | Avoid |
|-------|--------|
| **Materials editor** | `web/src/admin/pages/Material*.vue`, `server/src/materials/**`, materials migrations |
| **Fixture builder** | `Fixture*.vue`, `fixtureAssembly.ts`, `prism-fixtures-service/**` |
| **Core server** | `server/src/main.ts`, jobs, visualiser routes |

---

## 5. Shared-file protocol

| File | Protocol |
|------|----------|
| `web/src/shared/api.ts` | Add `modelsApi` at **end** of file; announce before merge |
| `web/src/admin/App.vue` | Add nav entries in Models section; announce |
| `server/src/db/schema.ts` | Materials-editor owns core schema; model tables via **`prism-shared` migration** + fixtures-style polyrepo DB access |

---

## 6. First implementation milestones

1. **Infra** — merge monorepo PR with compose + nginx + merge-bot + deploy wiring (scaffold PR on `feat/model-library`).
2. **Create `prism-models-service` repo** — push `scaffold/prism-models-service/`; set `PRISM_DISPATCH_TOKEN` secret.
3. **Contracts** — define `ModelDefinition`, `ModelInstance`, storage layout in `prism-shared` (or monorepo mirror types like fixtures).
4. **API** — `GET/POST /api/models`, `GET/PUT/DELETE /api/models/:id`, import endpoint.
5. **UI** — library grid + editor shell (reuse patterns from `Materials.vue` / `PrismLibrary.vue`).
6. **Connectors** — later: ORBIT object types for placed model instances (see `docs/FIXTURE_LIBRARY.md` connector section).

---

## 7. Git workflow

```powershell
git fetch origin
git rebase origin/main

# prism monorepo
git commit -m "feat(web): <description>"
git push

# polyrepo
git commit -m "feat: <description>"
git push

gh pr create --base main --title "feat(web): model library grid" --body "..."
```

Merge polyrepo PRs with: `/prism-merge prism-models-service#1`

---

## 8. Deploy — web + models API must stay in sync

| What changed | Repo | Workflow | Deploys |
|---|---|---|---|
| `web/**` only | `prism` | `web-image` | `prism-web`, `prism-router` |
| Models API / import | `prism-models-service` | `models-image` | `prism-models` |
| Infra (`infra/**`) | `prism` | `web-image` (paths include compose/nginx) | router + new service |

**Rule:** UI calling new `/api/models` routes requires **both** web PR and models-service PR merged + deployed.

```powershell
gh workflow run web-image --repo REBUS-Industries/prism --ref feat/model-library
gh workflow run models-image --repo REBUS-Industries/prism-models-service --ref <branch>
```

After `/prism-merge`, wait for **web-image** and **models-image** (+ **deploy-dev-service**) before testing on prism-dev.

---

## 9. PR checklist

- [ ] `cd web && npm run build` passes (prism)
- [ ] If `api.ts` changed: announce in team chat
- [ ] If UI calls new/changed `/api/models` routes: **prism-models-service PR merged + `models-image` green**
- [ ] PR body lists verify steps on https://prism-dev.rebus.industries
- [ ] After merge: `git fetch origin && git rebase origin/main`
