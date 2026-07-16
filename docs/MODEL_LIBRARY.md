# PRISM Model Library

Generic 3D model assets (props, scenery, equipment meshes) managed by **`prism-models-service`**.

> **Status:** Implemented — CRUD + convert-pipeline import on `prism-models-service`; admin library/editor/import UI on `feat/model-library`. Model instances (ORBIT placement) remain a later milestone.

## Architecture

- **Service:** `prism-models-service` on port **8770**, routed via nginx at `/api/models`, `/api/model-import`.
- **Database:** dedicated **`prism_models`** Postgres database, owned by the service (`src/db/schema.ts` + Drizzle migrations). Created automatically at boot (`runModelBootstrap`). Auth (`requireAuth`/`requireScope`) reuses `@rebus-industries/prism-shared` against the shared `prism` DB via `POSTGRES_URL`; the model store connects via `MODELS_POSTGRES_URL`.
- **Storage:** `${DATA_DIR}/models/{modelId}/` on the shared `prism-data` volume — original upload + cached preview GLB after convert completes. **Canonical geometry lives in Orbit** (Model Library Project); local files are a preview cache.
- **Import pipeline:** Same as [`/convert/`](https://prism.rebus.industries/convert/) — assimp pre-convert (when applicable) → PRISM agent (Rhino) → Orbit upload. Not the legacy assimp-only sidecar path (unless `MODEL_IMPORT_LEGACY_ASSIMP=1`).
- **Orbit project:** `ORBIT_MODEL_LIBRARY_PROJECT_ID` (default `e86589cc1e` — [Model Library Project](https://orbit.rebus.industries/projects/e86589cc1e)). Each import creates an Orbit model in that project; `definition.metadata.orbit` stores `{ projectId, modelId, versionId, resultUrl }`.
- **Contracts:** `prism-models-service/src/contracts/models.ts`, mirrored on the web in `web/src/shared/api.ts` (+ `web/src/admin/utils/modelTypes.ts`).

## Create with Meshy

Admin UI: `#/models/create` (nav: **Create model**). Credentials: **Settings → Meshy** (`meshy_api_key`, optional `meshy_api_base_url`).

```
Admin UI  →  prism-server /api/meshy/*  (Bearer key stays server-side)
    │         text-to-3d (preview [+ refine]) or image-to-3d
    │         poll until SUCCEEDED → model_urls.glb
    ▼
Transfer to library → download GLB via /api/meshy/download
    → POST /api/model-import  (same convert → Orbit pipeline as Import)
```

Meshy GLBs go through **assimp preconvert → OBJ zip → Rhino** like other glTF
uploads. Assimp prefixes UUID-shaped mesh group names so Rhino’s `FileObj.Read`
does not hit `ModelComponent.set_Id failed` (common on Meshy meshes). Agent
**v0.3.46+** also retries safer OBJ group/object mapping modes if the default
layers mapping fails.


## Import flow (new)

```
Admin UI  POST /api/model-import (file + metadata)
    │
    ├─► Create model_types row (importStatus=converting)
    ├─► createModel() in Orbit Model Library project
    ├─► POST /v1/convert/async (outputFormats=glb, callbackUrl=/api/model-import/webhook)
    │
    ▼
PRISM agent (Rhino) ──► Orbit version in Model Library project
    │
    ▼
Webhook POST /api/model-import/webhook (job.complete)
    ├─► Cache GLB from job outputs → model_media (preview)
    └─► Activate model_versions + definition.metadata.orbit
```

**Legacy flow** (`MODEL_IMPORT_LEGACY_ASSIMP=1`): direct assimp → local GLB only, no Orbit upload. Existing rows under `${DATA_DIR}/models/` remain valid; preview still served from cached GLB.

## Data model

- **model_types** — canonical asset: `name`, `category`, `tags`, `status` (draft/published), `origin` (upload/import/manual), `description`, `dimensions`, `boundingBox`, `definition` (jsonb: meshes + material slots + `metadata.orbit`), `previewModelId`, `activeVersionId`, soft delete.
- **model_media** — `MODEL_GLB | THUMBNAIL | TEXTURE_IMAGE | ORIGINAL_UPLOAD`, content hash, storage path, size.
- **model_versions** — import history (definition snapshot + source hash) with the active version tracked on `model_types`.
- **ModelInstance** — defined in contracts for the connector/ORBIT placement workflow (not yet exposed via CRUD).

Part/slot tags TBD — align with visualiser material resolution where models reuse PBR slots.

## API (scopes)

| Scope | Use |
|-------|-----|
| `models:read` | List / detail / preview |
| `models:write` | Create / edit metadata |
| `models:delete` | Soft-delete definitions |
| `models:import` | Upload / register meshes |

Scopes registered in `server/src/api/keys.ts`; enforced in `prism-models-service`.

## Environment (prism-models-service)

| Variable | Purpose |
|----------|---------|
| `ORBIT_MODEL_LIBRARY_PROJECT_ID` | Orbit project for imports (default `e86589cc1e`) |
| `ORBIT_MODEL_LIBRARY_TARGET` | `prod` or `dev` — which Orbit credentials from settings |
| `PRISM_SERVER_URL` | Internal URL to prism-server (convert + job outputs) |
| `PRISM_SERVICE_API_KEY` | X-API-Key for `/v1/convert/async` and GLB output download |
| `CONVERT_UPLOAD_DIR` | Shared upload dir (`/var/lib/prism/uploads`) when `prism-uploads` volume is mounted |
| `MODEL_IMPORT_LEGACY_ASSIMP` | Set `1` to disable convert/Orbit path (dev fallback) |

Orbit URL/token come from admin Settings (`orbit_server_url`, `orbit_token`) via prism-shared — same as `/convert/`.

## Admin UI

| Route | Purpose |
|-------|---------|
| `/models` | Browse / search library |
| `/models/library` | PRISM-curated editable subset (mirror `/fixtures/library`) |
| `/models/:id` | Editor (preview, metadata, LOD) |
| `/models/import` | Upload wizard (async convert + Orbit) |

## Comparison to other libraries

| | Fixtures | Materials | **Models** |
|---|----------|-----------|------------|
| Domain | GDTF lighting | PBR materials | Generic 3D assets |
| Service | prism-fixtures-service | prism-materials (monorepo entry) | **prism-models-service** |
| Port | 8769 | 8766 | **8770** |
| PR CI | No (post-merge image build) | No | **No** |

## Deploy (VM 212)

Split stack via `PRISM/infra/docker-compose.dev.yml` — `prism-models` service + nginx router block.

```yaml
# Env tag
PRISM_MODELS_TAG=latest
ORBIT_MODEL_LIBRARY_PROJECT_ID=e86589cc1e
PRISM_SERVICE_API_KEY=<service-key-from-admin>
```

Manual deploy:

```powershell
gh workflow run models-image --repo REBUS-Industries/prism-models-service --ref main
gh workflow run deploy-dev-service --repo REBUS-Industries/prism -f service=prism-models
```

## Migration notes (existing DATA_DIR models)

Imports before this change stored geometry only under `${DATA_DIR}/models/{id}/` with no Orbit reference. They continue to work — preview reads the local GLB. Re-import through `/models/import` to push a copy into the Orbit Model Library project and populate `definition.metadata.orbit`. No automatic backfill is planned in v1.

## Agent onboarding

Read `.cursor/plans/HANDOFF-model-library.md` before writing code.

Bootstrap polyrepo from `scaffold/prism-models-service/`.
