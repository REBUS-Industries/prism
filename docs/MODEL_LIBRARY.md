# PRISM Model Library

Generic 3D model assets (props, scenery, equipment meshes) managed by **`prism-models-service`**.

> **Status:** Implemented (v1) — CRUD + mesh import on `prism-models-service`; admin library/editor/import UI on `feat/model-library`. Model instances (ORBIT placement) remain a later milestone.

## Architecture

- **Service:** `prism-models-service` on port **8770**, routed via nginx at `/api/models`, `/api/model-import`.
- **Database:** dedicated **`prism_models`** Postgres database, owned by the service (`src/db/schema.ts` + Drizzle migrations). Created automatically at boot (`runModelBootstrap`). Auth (`requireAuth`/`requireScope`) reuses `@rebus-industries/prism-shared` against the shared `prism` DB via `POSTGRES_URL`; the model store connects via `MODELS_POSTGRES_URL`.
- **Storage:** `${DATA_DIR}/models/{modelId}/` on the shared `prism-data` volume (`original/` upload + converted `{mediaId}.glb`). Non-GLB meshes are converted via the assimp sidecar.
- **Contracts:** `prism-models-service/src/contracts/models.ts`, mirrored on the web in `web/src/shared/api.ts` (+ `web/src/admin/utils/modelTypes.ts`).
- **Orbit upload:** TBD — model instances as ORBIT objects for connector placement workflows.

## Data model

- **model_types** — canonical asset: `name`, `category`, `tags`, `status` (draft/published), `origin` (upload/import/manual), `description`, `dimensions`, `boundingBox`, `definition` (jsonb: meshes + material slots), `previewModelId`, `activeVersionId`, soft delete.
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

## Admin UI (target)

| Route | Purpose |
|-------|---------|
| `/models` | Browse / search library |
| `/models/library` | PRISM-curated editable subset (mirror `/fixtures/library`) |
| `/models/:id` | Editor (preview, metadata, LOD) |
| `/models/import` | Upload wizard |

## Comparison to other libraries

| | Fixtures | Materials | **Models** |
|---|----------|-----------|------------|
| Domain | GDTF lighting | PBR materials | Generic 3D assets |
| Service | prism-fixtures-service | prism-materials (monorepo entry) | **prism-models-service** |
| Port | 8769 | 8766 | **8770** |
| PR CI | No (post-merge image build) | No | **No** |

## Deploy (dev VM 212)

Split stack via `PRISM/infra/docker-compose.dev.yml` — `prism-models` service + nginx router block.

```yaml
# Env tag
PRISM_MODELS_TAG=latest
```

Manual deploy:

```powershell
gh workflow run models-image --repo REBUS-Industries/prism-models-service --ref main
gh workflow run deploy-dev-service --repo REBUS-Industries/prism -f service=prism-models
```

## Agent onboarding

Read `.cursor/plans/HANDOFF-model-library.md` before writing code.

Bootstrap polyrepo from `scaffold/prism-models-service/`.
