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

### Portal card fields (fixtures + models)

List and detail JSON for **fixtures** and **models** includes everything a
portal needs to render a library grid without fetching each asset's detail:

| Field | Fixtures | Models |
|-------|----------|--------|
| `previewUrl` | Relative path to the active preview GLB | Same |
| `orbitUrl` | Orbit viewer link when published | Orbit Model Library link after import |
| `versions[]` | Stored revisions with `downloadedAt` + `previewUrl` | Import history with `createdAt` + `previewUrl` + `orbitUrl` |

OpenAPI schemas: **`FixtureListItem`**, **`FixtureVersionSummary`**,
**`ModelListItem`**, **`ModelVersionSummary`** on [`/docs`](https://prism.rebus.industries/docs).
Materials/textures use the same `previewUrl` pattern for 2D thumbnails — see
[Texture previews](#texture-previews) below.

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
| `{lib}:read` | List, detail, preview GLB, connector export | List, detail, preview GLB | List, detail, texture preview, material ZIP export |
| `{lib}:write` | Create, edit definition, categories, IES | Create, edit metadata; **Meshy generate** (`/api/meshy/*` create) | Create, edit, slot assign, duplicate, branch |
| `{lib}:delete` | Soft-delete fixture types | Soft-delete models | Soft-delete materials / textures |
| `{lib}:import` | GDTF / GDTF-Share / MVR import | `/api/model-import` upload (incl. Meshy transfer) | `/api/materials/import` ZIP |

Where `{lib}` is `fixtures`, `models`, or `materials`.

Meshy status / poll / download also need `models:read`. See
[Generate with Meshy](#generate-with-meshy-connectors--portals).

**Examples**

- Portal browse-only widget: `fixtures:read`, `models:read`, `materials:read`
- Portal editor (view + edit): add `fixtures:write`, `models:write`, `materials:write`
- Portal with import wizards: also `fixtures:import`, `models:import`
- Portal / connector **Meshy → library**: `models:read`, `models:write`, `models:import`

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

Narrative companion for assembly, pan/tilt motion, and the GDTF scene graph:
[`/docs/fixture-assembly-and-motion`](https://prism.rebus.industries/docs/fixture-assembly-and-motion).

### List/detail fields (portal cards)

List and detail responses include **`previewUrl`**, **`orbitUrl`**, and a
**`versions`** array so portals can render library cards without N+1 detail
calls:

| Field | Meaning |
|-------|---------|
| `previewUrl` | Relative path to the active version preview (`/api/fixtures/{id}/preview.glb` or `/media/{mediaId}`) |
| `orbitUrl` | Orbit viewer link when the fixture was published (`definition.metadata.orbitFixtureRef`) |
| `versions[]` | Stored GDTF revisions with `downloadedAt`, `previewUrl`, and `isActive` |

Example list item (truncated):

```json
{
  "id": "65906ae4-284e-4cb3-9c88-3a02b95163a8",
  "name": "MAC Aura XB",
  "hasPreview": true,
  "previewUrl": "/api/fixtures/65906ae4-284e-4cb3-9c88-3a02b95163a8/preview.glb",
  "orbitUrl": "https://orbit.rebus.industries/projects/0f2893eb28/models/abc@def",
  "versions": [
    {
      "id": "…",
      "revision": "1.0",
      "downloadedAt": "2026-06-18T10:15:00.000Z",
      "isActive": true,
      "previewUrl": "/api/fixtures/65906ae4-284e-4cb3-9c88-3a02b95163a8/preview.glb"
    }
  ]
}
```

Stream the preview mesh with the same `X-API-Key` used for JSON (proxy through
your portal backend for `<img>` / WebGL embeds — browser requests cannot send
`X-API-Key`).

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

### List/detail fields (portal cards)

Same pattern as fixtures — each model row includes **`previewUrl`**,
**`orbitUrl`**, and **`versions[]`** with per-version **`createdAt`** and
**`previewUrl`**:

| Field | Meaning |
|-------|---------|
| `previewUrl` | Relative path to cached preview GLB for the active version |
| `orbitUrl` | Orbit Model Library viewer URL from `definition.metadata.orbit` |
| `versions[]` | Import history with `createdAt`, `previewUrl`, `orbitUrl`, `isActive` |

Example list item (truncated):

```json
{
  "id": "a1b2c3d4-…",
  "name": "Stage prop",
  "hasPreview": true,
  "previewUrl": "/api/models/a1b2c3d4-…/preview.glb",
  "orbitUrl": "https://orbit.rebus.industries/projects/e86589cc1e/models/xyz@ver",
  "versions": [
    {
      "id": "…",
      "createdAt": "2026-06-18T09:00:00.000Z",
      "isActive": true,
      "previewUrl": "/api/models/a1b2c3d4-…/preview.glb",
      "orbitUrl": "https://orbit.rebus.industries/projects/e86589cc1e/models/xyz@ver"
    }
  ]
}
```

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
ready, or poll `GET /api/models/{id}` until `importStatus` is `complete`
(or `hasPreview` is true).

Architecture reference: [`docs/MODEL_LIBRARY.md`](MODEL_LIBRARY.md)

### Generate with Meshy (connectors & portals)

PRISM can generate meshes via [Meshy.ai](https://docs.meshy.ai/en/api/quick-start)
and land them in the **Model Library** (convert pipeline → Orbit Model Library
project). This is the same path as **Admin → Model Library → Create with Meshy**
(`#/models/create`).

**Who holds the Meshy credentials?** PRISM does — not your connector or portal.

1. An admin pastes the Meshy API key in **Admin → Settings → Meshy**
   (`meshy_api_key`; optional `meshy_api_base_url`, default `https://api.meshy.ai`).
2. Your **ORBIT connector** or **third-party portal** calls PRISM’s proxied
   `/api/meshy/*` routes with a normal `X-API-Key`. The Meshy Bearer token never
   leaves the PRISM server (same pattern as ORBIT / Fab proxies).
3. When generation succeeds, download the GLB through PRISM and
   `POST /api/model-import` to publish into the library.

```
Your connector / portal
        │  X-API-Key (models:read|write|import)
        ▼
PRISM /api/meshy/*  ──Bearer meshy_api_key──►  api.meshy.ai
        │
        │  model_urls.glb (signed)
        ▼
GET /api/meshy/download?url=…  →  GLB bytes
        │
        ▼
POST /api/model-import  →  convert pipeline → Orbit Model Library
        │
        ▼
GET /api/models/{id} until importStatus=complete / hasPreview
```

**Scopes**

| Step | Scope |
|------|--------|
| `GET /api/meshy/status`, poll task, download GLB | `models:read` |
| `POST /api/meshy/text-to-3d`, `image-to-3d`, `retexture`, `remesh` | `models:write` |
| `POST /api/model-import` (transfer into library) | `models:import` |

**Prerequisite:** Settings → Meshy must be configured. Otherwise create/test
return `412` with a “Set the Meshy API key…” message.

#### End-to-end example (text → library)

```bash
export PRISM_KEY=prism_xyz
export PRISM=https://prism.rebus.industries

# 0. Confirm Meshy is configured on this PRISM
curl -sS -H "X-API-Key: $PRISM_KEY" "$PRISM/api/meshy/status"
# → { "configured": true }

# 1. Create a Text-to-3D preview task
TASK=$(curl -sS -X POST -H "X-API-Key: $PRISM_KEY" -H "Content-Type: application/json" \
  -d '{"mode":"preview","prompt":"a stage clamp for a lighting pipe, dark steel","should_remesh":true}' \
  "$PRISM/api/meshy/text-to-3d" | jq -r .result)

# 2. Poll until SUCCEEDED (or FAILED)
while true; do
  STATUS=$(curl -sS -H "X-API-Key: $PRISM_KEY" "$PRISM/api/meshy/text-to-3d/$TASK")
  echo "$STATUS" | jq '{status,progress}'
  echo "$STATUS" | jq -e '.status=="SUCCEEDED" or .status=="FAILED"' >/dev/null && break
  sleep 5
done

# 3. Optional: refine (texture) from the preview task id
REFINE=$(curl -sS -X POST -H "X-API-Key: $PRISM_KEY" -H "Content-Type: application/json" \
  -d "{\"mode\":\"refine\",\"preview_task_id\":\"$TASK\",\"enable_pbr\":true}" \
  "$PRISM/api/meshy/text-to-3d" | jq -r .result)
# …poll /api/meshy/text-to-3d/$REFINE the same way…

# 4. Download GLB via PRISM proxy (CORS-safe; allowlists Meshy asset hosts)
GLB_URL=$(curl -sS -H "X-API-Key: $PRISM_KEY" "$PRISM/api/meshy/text-to-3d/$REFINE" | jq -r .model_urls.glb)
curl -sS -H "X-API-Key: $PRISM_KEY" -o meshy-model.glb \
  "$PRISM/api/meshy/download?url=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$GLB_URL")"

# 5. Transfer into the Model Library (same as file import)
IMPORT=$(curl -sS -X POST -H "X-API-Key: $PRISM_KEY" \
  -F "file=@meshy-model.glb" \
  -F "name=Stage clamp" \
  -F "category=clamp" \
  -F "tags=meshy,generated" \
  "$PRISM/api/model-import")
MODEL_ID=$(echo "$IMPORT" | jq -r '.modelId // .model.id')

# 6. Wait for convert → Orbit
while true; do
  M=$(curl -sS -H "X-API-Key: $PRISM_KEY" "$PRISM/api/models/$MODEL_ID")
  echo "$M" | jq '{importStatus,hasPreview,orbitUrl}'
  echo "$M" | jq -e '.hasPreview==true or .importStatus=="complete" or .importStatus=="failed"' >/dev/null && break
  sleep 3
done
```

#### Image-to-3D

`POST /api/meshy/image-to-3d` accepts Meshy’s body shape. Pass either a public
`image_url` or a `data:image/jpeg;base64,…` / `data:image/png;base64,…` data URI
(same as the admin UI). Poll `GET /api/meshy/image-to-3d/{id}`, then download +
`/api/model-import` as above.

#### Connector vs third-party portal

| Caller | Auth | Typical use |
|--------|------|-------------|
| **ORBIT connector** | `X-API-Key` with `models:*` (minted in Admin → API keys) | In-app “Generate with Meshy” that writes into the shared Prism Model Library project |
| **Third-party portal** | Same `X-API-Key` pattern | Portal UX that generates assets and lists them via `GET /api/models` / `previewUrl` |
| **Admin SPA** | Session cookie | `#/models/create` — same backend routes |

Do **not** put the Meshy API key in connector config or portal env. Store it
only in PRISM Settings so rotation and audit stay centralised. If Meshy is
unconfigured, show operators a link to Settings → Meshy (or fail with `412`).

OpenAPI tag: **Meshy** on [`/docs`](https://prism.rebus.industries/docs).
Upstream Meshy reference: [Meshy API quick start](https://docs.meshy.ai/en/api/quick-start).

---

## Material library

**Admin mirror:** `/admin/#/materials` — shared PBR materials + texture slots.

Materials reference rows in the texture library (`/api/textures/*`). Most
portals need both read scopes.

### Texture previews

List and detail responses include a **`previewUrl`** path you can stream with
the same `X-API-Key` used for JSON calls:

| Response | `previewUrl` |
|----------|----------------|
| `GET /api/textures`, `GET /api/textures/{id}` | On every texture row |
| `GET /api/materials` | On each material when `thumbnailTextureId` is set |
| `GET /api/materials/{id}` | On the material **and** each `slots[].texture` |

Example list item:

```json
{
  "id": "a1b2c3d4-…",
  "displayName": "Concrete albedo",
  "contentType": "image/png",
  "previewUrl": "/api/textures/a1b2c3d4-…/preview"
}
```

Stream the image:

```bash
# Preferred embed route (inline, cache-friendly)
curl -sS -H "X-API-Key: $PRISM_KEY" -o preview.png \
  "https://prism.rebus.industries/api/textures/{texture-id}/preview"

# Same bytes — attachment-friendly alias
curl -sS -H "X-API-Key: $PRISM_KEY" -o texture.png \
  "https://prism.rebus.industries/api/textures/{texture-id}/download"
```

**Portal UI note:** browser `<img src="…">` cannot send `X-API-Key`. Proxy
preview bytes through your portal backend, or embed the PRISM admin UI with
cookie auth. For headless sync, fetch `previewUrl` server-side and cache locally.

Material card thumbnails use `material.previewUrl` (captured preview or albedo
thumbnail). Slot textures use `slots[].texture.previewUrl` for per-channel
thumbnails in custom editors.

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

### Related endpoints

| Path | Purpose |
|------|---------|
| `GET /api/textures/{id}/preview` | Inline texture image for thumbnails |
| `GET /api/textures/{id}/download` | Stream texture body (same bytes as preview) |
| `GET /api/materials/{id}/download` | Export material ZIP (textures + manifest) |
| `GET/POST/PUT/DELETE /api/material-groups` | Organise materials in the library UI |

See also external provider browse/import: [`docs/EXTERNAL_MATERIALS.md`](EXTERNAL_MATERIALS.md)

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

- OpenAPI spec: [`https://prism.rebus.industries/docs`](https://prism.rebus.industries/docs) (**Meshy** tag)
- Generate with Meshy: [above](#generate-with-meshy-connectors--portals)
- Fixture assembly & motion: [`/docs/fixture-assembly-and-motion`](https://prism.rebus.industries/docs/fixture-assembly-and-motion)
- Fixture groups & position presets: [`/docs/fixture-groups-positions-metadata`](https://prism.rebus.industries/docs/fixture-groups-positions-metadata)
- Visualiser portal guide: [`/docs/portal-integration`](https://prism.rebus.industries/docs/portal-integration)
- Permissions / tool grants: [`docs/PERMISSIONS.md`](PERMISSIONS.md)
- Portal contract (identity): [`docs/PORTAL_CONTRACT.md`](PORTAL_CONTRACT.md)
- Model library architecture: [`docs/MODEL_LIBRARY.md`](MODEL_LIBRARY.md)
