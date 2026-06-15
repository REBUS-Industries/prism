# PRISM Model Library

Generic 3D model assets (props, scenery, equipment meshes) managed by **`prism-models-service`**.

> **Status:** Scaffold only — infra wiring + handoff in place; feature development on `feat/model-library` + `prism-models-service`.

## Architecture

- **Service:** `prism-models-service` on port **8770**, routed via nginx at `/api/models`, `/api/model-import`.
- **Storage:** `${DATA_DIR}/models/` on the shared `prism-data` volume (meshes, thumbnails, metadata JSON).
- **Contracts:** Target `prism-shared/src/contracts/models.ts` + DB migration (mirror fixtures pattern).
- **Orbit upload:** TBD — model instances as ORBIT objects for connector placement workflows.

## Data model (target)

| Concept | Notes |
|---------|--------|
| **ModelDefinition** | Canonical asset: name, category, tags, mesh refs, materials slots, bounding box |
| **ModelInstance** | Placed instance in a project/scene; transform + reference to ModelDefinition |
| **Import bundle** | glTF/GLB (primary), optional textures sidecar |

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
