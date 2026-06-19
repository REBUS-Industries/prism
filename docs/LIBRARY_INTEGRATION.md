# PRISM libraries — Portal integration guide

**Audience:** third-party portal developers embedding or synchronising PRISM's
fixture, model, and material libraries.
**Companion:** machine-readable contract at
[`https://prism.rebus.industries/docs`](https://prism.rebus.industries/docs)
(Redoc-rendered OpenAPI 3.1 — **Fixture library**, **Model library**, and
**Materials library** tags).

---

## Overview

PRISM hosts three editable asset libraries behind the admin UI:

| Admin UI | Base path | Service |
|----------|-----------|---------|
| [Fixture library](https://prism.rebus.industries/admin/#/fixtures/library) | `/api/fixtures/*` | `prism-fixtures-service` |
| [Model library](https://prism.rebus.industries/admin/#/models) | `/api/models/*`, `/api/model-import` | `prism-models-service` |
| [Material library](https://prism.rebus.industries/admin/#/materials) | `/api/materials/*`, `/api/textures/*` | `prism-materials` |

Your portal integrates via **REST + `X-API-Key`**, not via the admin SPA
routes (`/admin/#/…`). The admin pages are a reference for what the APIs
manage; all list/create/edit/delete operations are available programmatically.

---

## Authentication

```http
X-API-Key: prism_<base64url>
```

Mint keys in **Admin → API keys** (`https://prism.rebus.industries/admin/#/api-keys`).
Each key carries an explicit scope set. Assign the minimum scopes your portal
needs (read-only browse vs full edit).

### Scope matrix

| Scope | Fixture library | Model library | Material library |
|-------|-----------------|---------------|------------------|
| `{lib}:read` | List, detail, preview GLB, connector export | List, detail, preview GLB | List, detail, download ZIP, texture download |
| `{lib}:write` | Create, edit definition, categories, IES | Create, edit metadata | Create, edit, slot assign, duplicate, branch |
| `{lib}:delete` | Soft-delete fixture types | Soft-delete models | Soft-delete materials / textures |
| `{lib}:import` | GDTF / GDTF-Share / MVR import | `/api/model-import` upload | `/api/materials/import` ZIP |

Where `{lib}` is `fixtures`, `models`, or `materials`.

**Examples**

- Portal browse-only widget: `fixtures:read`, `models:read`, `materials:read`
- Portal editor (view + edit): add `fixtures:write`, `models:write`, `materials:write`
- Portal with import wizards: also `fixtures:import`, `models:import`

Keys without an explicit scope set behave as legacy full-access keys (avoid
for portal integrations).

Admin session cookies and ORBIT bearer tokens bypass scope checks — those are
for the PRISM admin SPA and internal tooling, not third-party portals.

### Portal role grants (UI access)

Separately from API keys, **Admin → Tool access** maps portal roles to PRISM
tools (`fixtures`, `models`, `materials`). That gates which admin nav items
portal-authenticated users see. Programmatic library access always uses
**API keys** with the scopes above.

---

## Fixture library

**Admin mirror:** `/admin/#/fixtures/library` — the PRISM-owned, editable fixture
catalogue (downloaded from GDTF Share or uploaded directly).

### Read (connector / browse)

```bash
export PRISM_KEY=prism_xyz

# List fixtures (paginated)
curl -sS -H "X-API-Key: $PRISM_KEY" \
  'https://prism.rebus.industries/api/fixtures?limit=50'

# Detail
curl -sS -H "X-API-Key: $PRISM_KEY" \
  "https://prism.rebus.industries/api/fixtures/{id}"

# Connector export list (published fixtures only)
curl -sS -H "X-API-Key: $PRISM_KEY" \
  'https://prism.rebus.industries/api/fixtures/export'

# Self-contained connector payload (definition + asset URLs)
curl -sS -H "X-API-Key: $PRISM_KEY" \
  "https://prism.rebus.industries/api/fixtures/export/{id}"

# Preview mesh (GLB)
curl -sS -H "X-API-Key: $PRISM_KEY" -o preview.glb \
  "https://prism.rebus.industries/api/fixtures/{id}/preview.glb"
```

**Scopes:** `fixtures:read`

### Write / import

```bash
# Create blank fixture
curl -sS -X POST -H "X-API-Key: $PRISM_KEY" -H "Content-Type: application/json" \
  -d '{"name":"My fixture"}' \
  https://prism.rebus.industries/api/fixtures

# Update metadata / definition
curl -sS -X PUT -H "X-API-Key: $PRISM_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Renamed","status":"published","tags":["moving-head"]}' \
  "https://prism.rebus.industries/api/fixtures/{id}"

# Import GDTF file
curl -sS -X POST -H "X-API-Key: $PRISM_KEY" \
  -F "file=@fixture.gdtf" \
  https://prism.rebus.industries/api/fixtures/import/gdtf

# Soft-delete
curl -sS -X DELETE -H "X-API-Key: $PRISM_KEY" \
  "https://prism.rebus.industries/api/fixtures/{id}"
```

**Scopes:** `fixtures:write` (create/edit), `fixtures:delete` (delete),
`fixtures:import` (GDTF / GDTF-Share / MVR paths).

### Related endpoints

| Path | Purpose |
|------|---------|
| `GET/POST/PUT/DELETE /api/fixtures/categories` | Category palette |
| `GET/PUT /api/fixtures/tag-materials` | Global REBUS-tag → material ID map |
| `POST /api/fixtures/{id}/publish-orbit` | Publish fixture type to ORBIT |
| `GET /api/gdtf-share/catalog` | Browse upstream GDTF Share (before download) |

Architecture reference: [`docs/FIXTURE_LIBRARY.md`](FIXTURE_LIBRARY.md)

---

## Model library

**Admin mirror:** `/admin/#/models` — generic 3D props / scenery meshes.

### Read

```bash
# List models
curl -sS -H "X-API-Key: $PRISM_KEY" \
  'https://prism.rebus.industries/api/models?limit=50'

# Detail (metadata, Orbit ref, versions)
curl -sS -H "X-API-Key: $PRISM_KEY" \
  "https://prism.rebus.industries/api/models/{id}"

# Preview GLB (cached after import completes)
curl -sS -H "X-API-Key: $PRISM_KEY" -o preview.glb \
  "https://prism.rebus.industries/api/models/{id}/preview.glb"
```

**Scope:** `models:read`

### Write / import

```bash
# Create blank model
curl -sS -X POST -H "X-API-Key: $PRISM_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Stage prop","category":"scenery"}' \
  https://prism.rebus.industries/api/models

# Update metadata / status
curl -sS -X PUT -H "X-API-Key: $PRISM_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Renamed","status":"published"}' \
  "https://prism.rebus.industries/api/models/{id}"

# Import mesh (async convert → Orbit Model Library project)
curl -sS -X POST -H "X-API-Key: $PRISM_KEY" \
  -F "file=@prop.fbx" -F "name=Prop A" \
  https://prism.rebus.industries/api/model-import

# Soft-delete
curl -sS -X DELETE -H "X-API-Key: $PRISM_KEY" \
  "https://prism.rebus.industries/api/models/{id}"
```

**Scopes:** `models:write`, `models:delete`, `models:import`

Import runs the same convert pipeline as `/convert/` — poll the returned
`jobId` via `GET /v1/jobs/{jobId}` if you need to block until preview GLB is
ready, or poll `GET /api/models/{id}` until `importStatus` is `ready`.

Architecture reference: [`docs/MODEL_LIBRARY.md`](MODEL_LIBRARY.md)

---

## Material library

**Admin mirror:** `/admin/#/materials` — shared PBR materials + texture slots.

Materials reference rows in the texture library (`/api/textures/*`). Most
portals need both read scopes.

### Read

```bash
# List materials (search, tags, cursor pagination)
curl -sS -H "X-API-Key: $PRISM_KEY" \
  'https://prism.rebus.industries/api/materials?limit=50'

# Full detail (slots, textures, PBR parameters)
curl -sS -H "X-API-Key: $PRISM_KEY" \
  "https://prism.rebus.industries/api/materials/{id}"

# Export ZIP (textures + manifest)
curl -sS -H "X-API-Key: $PRISM_KEY" -o material.zip \
  "https://prism.rebus.industries/api/materials/{id}/download"

# List textures
curl -sS -H "X-API-Key: $PRISM_KEY" \
  'https://prism.rebus.industries/api/textures?limit=50'
```

**Scope:** `materials:read`

### Write / import

```bash
# Create blank material
curl -sS -X POST -H "X-API-Key: $PRISM_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Concrete A","tags":["archviz"]}' \
  https://prism.rebus.industries/api/materials

# Rename / retag / merge PBR parameters
curl -sS -X PUT -H "X-API-Key: $PRISM_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Concrete B","parameters":{"roughness":0.85}}' \
  "https://prism.rebus.industries/api/materials/{id}"

# Assign texture to slot
curl -sS -X PUT -H "X-API-Key: $PRISM_KEY" -H "Content-Type: application/json" \
  -d '{"textureId":"{texture-uuid}"}' \
  "https://prism.rebus.industries/api/materials/{id}/slots/albedo"

# Import Megascans / glTF ZIP
curl -sS -X POST -H "X-API-Key: $PRISM_KEY" \
  -F "file=@material.zip" \
  https://prism.rebus.industries/api/materials/import

# Soft-delete
curl -sS -X DELETE -H "X-API-Key: $PRISM_KEY" \
  "https://prism.rebus.industries/api/materials/{id}"
```

**Scopes:** `materials:write`, `materials:delete`

Material groups (`/api/material-groups`) organise the library UI; use the
same scopes.

---

## Error responses

| Status | Meaning |
|--------|---------|
| `401` | Missing or invalid `X-API-Key` |
| `403` | Key lacks the route's scope (body includes `{ "error": "forbidden", "scope": "fixtures:read" }`) |
| `404` | Asset not found (or soft-deleted) |
| `429` | Rate limit — honour `X-RateLimit-Reset` |

---

## Embedding the admin UI (optional)

If your portal prefers iframe embed over native API integration, deep-link
authenticated users who already hold a PRISM admin session:

- Fixtures: `https://prism.rebus.industries/admin/#/fixtures/library`
- Models: `https://prism.rebus.industries/admin/#/models`
- Materials: `https://prism.rebus.industries/admin/#/materials`

That path depends on shared cookie auth and portal role → tool grants. For
headless or cross-origin portals, use the REST API with scoped API keys
(described above).

---

## See also

- OpenAPI spec: [`https://prism.rebus.industries/docs`](https://prism.rebus.industries/docs)
- Visualiser portal guide: [`/docs/portal-integration`](https://prism.rebus.industries/docs/portal-integration)
- Permissions / tool grants: [`docs/PERMISSIONS.md`](PERMISSIONS.md)
- Portal contract (identity): [`docs/PORTAL_CONTRACT.md`](PORTAL_CONTRACT.md)
