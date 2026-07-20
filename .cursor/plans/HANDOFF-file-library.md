# Handoff: File Library Workstream (plan)

**Status:** Plan only — not yet implemented.  
**Proposed branch:** `feat/file-library` (REBUS-Industries/prism)  
**Proposed API polyrepo:** `REBUS-Industries/prism-files-service`  
**Pairs with:** `orbit-connectors` (Rhino / Vectorworks “Send to File Library” button)  
**Does not replace:** Orbit convert / Model Library / project-attachments (visualiser MVR/GDTF)

**Read first:** [AGENT-GIT-INSTRUCTIONS.md](./AGENT-GIT-INSTRUCTIONS.md) · [HANDOFF-overview.md](./HANDOFF-overview.md)

---

## 1. Product intent

A **File Library** is a Prism-owned archive of **source CAD / DCC files** uploaded by connectors (and optionally the admin UI). It is **not** an Orbit publish path.

| | File Library | Orbit / Model Library |
|---|---|---|
| Purpose | Keep the author’s native file (`.3dm`, `.vwx`, …) | Geometry versions for visualisation / Speckle |
| Who uploads | Connector “Send file” (or admin upload) | Convert pipeline / model-import |
| Typical payload | Rhino `.3dm`, Vectorworks `.vwx`, later `.dwg` / `.rvt` / zips | GLB / convert outputs |
| Storage | Configurable root (local volume **or** LAN file-server path) | Orbit project + optional local preview cache |

**Primary connector flow**

```
Rhino / Vectorworks
  → Save native file locally
  → Connector “Send to File Library” (new capability)
  → POST /api/files (multipart) with X-API-Key (files:write)
  → Prism files-service stores under configured root
  → Admin `#/files` lists / downloads / soft-deletes
```

Orbit upload remains a **separate** connector action (`send` / convert / model-import). Both can exist on the same toolbar without coupling.

---

## 2. Recommended architecture (mirror models/fixtures)

Prefer a **polyrepo microservice** so storage and auth scale independently of convert/Orbit:

| Layer | Choice |
|-------|--------|
| Service | `prism-files-service` |
| Port | **8772** (next free after permissions 8771) |
| Compose | `prism-files` in `infra/docker-compose.dev.yml` |
| Nginx | `/api/files` → `prism-files:8772` |
| CI | `files-image` (GHCR `prism-files-service`) |
| DB | Dedicated `prism_files` (metadata) + auth against shared `prism` via `POSTGRES_URL` |
| Scopes | `files:read` · `files:write` · `files:delete` |
| Admin tool | `PrismTool = 'files'` (Tool access + nav) |
| Branch | `feat/file-library` on monorepo for UI/docs/compose/scopes |

Bootstrap from `scaffold/prism-files-service/` (same pattern as `scaffold/prism-models-service/`).

**Why not put this on prism-server?** Possible for an MVP, but files will grow large and the storage root will often be a **host/LAN bind mount** — a dedicated service keeps convert/uploads/`DATA_DIR` libraries isolated and matches the split stack.

---

## 3. Storage model (settings-driven root)

### Settings tile (Admin → Settings)

New tile **File Library**:

| Key | Purpose |
|-----|---------|
| `file_library_root` | Absolute path **inside the container** where blobs are written (e.g. `/mnt/fileserver/prism-files`) |
| `file_library_max_bytes` (optional) | Upload size cap (default e.g. 2 GiB) |
| `file_library_allowed_exts` (optional) | Comma list; default `.3dm,.vwx` then expand |

Persist via existing `PUT /api/settings/:key` (shared `prism` settings table). Files-service reads the setting at request time (with env fallback `FILE_LIBRARY_ROOT`).

### Deployment on VM 212 + LAN file server

Today compose only uses Docker named volumes (`prism-data`). File Library needs a **bind mount** to the LAN share:

```yaml
# infra/docker-compose.dev.yml (sketch)
prism-files:
  image: ghcr.io/rebus-industries/prism-files-service:${PRISM_FILES_TAG:-latest}
  container_name: prism-files
  environment:
    PORT: 8772
    POSTGRES_URL: "postgres://…"
    FILES_POSTGRES_URL: "postgres://…/prism_files"
    FILE_LIBRARY_ROOT: "${FILE_LIBRARY_ROOT:-/mnt/fileserver/prism-files}"
    # optional override; Settings UI value wins when set
  volumes:
    - ${FILE_LIBRARY_HOST_PATH:-/mnt/fileserver/prism-files}:${FILE_LIBRARY_ROOT:-/mnt/fileserver/prism-files}
```

**Operator steps (once):**

1. On the file server / VM host, export or mount the share (NFS/SMB/CIFS → e.g. `/mnt/fileserver/prism-files`).
2. Ensure the path is writable by the container UID.
3. Set `FILE_LIBRARY_HOST_PATH` in `/opt/prism/.env` to that host path.
4. In Admin → Settings → File Library, set `file_library_root` to the **in-container** mount path (usually the same string).

If the setting is empty, fall back to `${DATA_DIR}/files/` on the existing `prism-data` volume (dev-friendly default; **not** preferred for prod CAD dumps).

### On-disk layout

```
{file_library_root}/
  {documentId}/
    v{n}/
      original.{ext}            # one immutable blob per upload
```

Each upload creates a **new version**; same filename never overwrites prior bytes. DB is authoritative for grouping/version numbers.

---

## 4. Data model (sketch) — filename versions

Uploads with the **same filename** (case-insensitive, basename only) stack as versions under one library document. Re-sending `Auditorium.3dm` from Rhino does **not** replace the previous file; it adds version N+1.

**Grouping key (v1):** `normalize(original_filename)` → lowercased basename  
Optional later: also scope by `project_id` so two projects can both have `model.3dm` without colliding.

### `file_documents` (logical file / name group)

| Column | Notes |
|--------|--------|
| `id` | UUID |
| `name` | Display name (usually the original filename) |
| `normalized_name` | Unique key for version stacking (`auditorium.3dm`) |
| `extension` | `.3dm`, `.vwx`, … |
| `project_id` | Optional Orbit/portal project id |
| `tags` | `text[]` |
| `latest_version_id` | FK → current tip version |
| `version_count` | Denormalised count of non-deleted versions |
| `created_at` / `updated_at` / `deleted_at` | Soft-delete whole document |

### `file_versions` (each upload)

| Column | Notes |
|--------|--------|
| `id` | UUID |
| `document_id` | FK → `file_documents` |
| `version_number` | Monotonic per document (1, 2, 3, …) |
| `original_filename` | As uploaded (preserve client casing) |
| `content_type` | MIME if known |
| `size_bytes` | |
| `content_hash` | SHA-256 of body |
| `storage_path` | Relative to `file_library_root` |
| `source` | `connector` \| `admin` \| `api` |
| `source_app` | `rhino` \| `vectorworks` \| … |
| **`uploaded_by_label`** | Human-readable who uploaded — see below |
| `created_by_api_key_id` | FK/id of API key when connector/API upload |
| `created_by_admin_id` | Admin user id when uploaded from Prism UI |
| `created_at` | Upload timestamp (UTC, shown localised in UI) |
| `deleted_at` | Soft-delete this version only |

**`uploaded_by_label` resolution (store at write time):**

| Upload path | Label to store / show |
|-------------|------------------------|
| Admin session | Admin username (e.g. `admin`) |
| API key | Key **name** if set, else truncated key id (`api:…`) |
| Connector (same API key) | Prefer connector-supplied `uploadedBy` (e.g. OS/Rhino user) when present; else API key name |

Connectors should send optional form fields: `uploadedBy` (display string), `sourceApp`.

No Orbit model/version linkage required for v1.

---

## 5. API (v1)

Base: `/api/files` · Auth: admin session **or** `X-API-Key` with scopes below.

| Method | Path | Scope | Behaviour |
|--------|------|-------|-----------|
| `GET` | `/api/files` | `files:read` | List **documents** (`q`, `ext`, `projectId`, `cursor`) — each row includes latest version summary + `versionCount` |
| `GET` | `/api/files/:documentId` | `files:read` | Document + **all versions** (newest first): uploader, `createdAt`, size, sourceApp |
| `GET` | `/api/files/:documentId/versions/:versionId/download` | `files:read` | Stream that version’s bytes |
| `GET` | `/api/files/:documentId/download` | `files:read` | Convenience: download **latest** version |
| `POST` | `/api/files` | `files:write` | Multipart upload — find-or-create document by normalised filename, append version |
| `PATCH` | `/api/files/:documentId` | `files:write` | Rename display name / tags (does not rename version stack key unless explicit) |
| `DELETE` | `/api/files/:documentId` | `files:delete` | Soft-delete document (+ versions) |
| `DELETE` | `/api/files/:documentId/versions/:versionId` | `files:delete` | Soft-delete one version |
| `GET` | `/api/files/status` | `files:read` | `{ configured, root, writable, freeBytes? }` |

**Upload behaviour:** same filename → new `file_versions` row with `version_number = max+1`; response includes document id, version number, uploader, timestamp.

**Upload response (connector-friendly):**

```json
{
  "document": {
    "id": "…",
    "name": "Auditorium.3dm",
    "versionCount": 3
  },
  "version": {
    "id": "…",
    "versionNumber": 3,
    "sizeBytes": 12345678,
    "uploadedBy": "jsmith (Rhino)",
    "sourceApp": "rhino",
    "createdAt": "2026-07-20T09:45:00.000Z",
    "downloadUrl": "/api/files/{documentId}/versions/{versionId}/download"
  }
}
```

**Document detail (admin):**

```json
{
  "document": {
    "id": "…",
    "name": "Auditorium.3dm",
    "extension": ".3dm",
    "versionCount": 3,
    "versions": [
      {
        "id": "…",
        "versionNumber": 3,
        "uploadedBy": "jsmith (Rhino)",
        "sourceApp": "rhino",
        "sizeBytes": 12345678,
        "createdAt": "2026-07-20T09:45:00.000Z"
      },
      {
        "id": "…",
        "versionNumber": 2,
        "uploadedBy": "admin",
        "sourceApp": null,
        "sizeBytes": 12000000,
        "createdAt": "2026-07-19T14:02:11.000Z"
      }
    ]
  }
}
```

OpenAPI tag **File library** on prism-server’s docs gateway (same pattern as Meshy/Models) or files-service `/docs`.

---

## 6. Admin UI

| Route | Purpose |
|-------|---------|
| `#/files` | Table of **documents** (one row per filename): name, ext, latest size, **latest uploaded by**, **latest date/time**, version count badge, source app |
| `#/files/:id` | Document detail: expandable / table of **all versions** — version #, **uploaded by**, **date & time**, size, source app, download / delete version |
| Optional `#/files/upload` | Manual admin upload (parity with connectors); stacks as a new version when filename matches |

**List UX:** clicking a row opens the version history. Show relative time + absolute timestamp (e.g. `20 Jul 2026, 09:45`). Never hide older uploads when the name matches.

**Nav:** new top-level **Files** under `showTool('files')` in `web/src/admin/App.vue` (announce — shared file).

**Settings:** tile **File Library** with `file_library_root` (+ optional caps). Show status from `GET /api/files/status` (writable / not configured).

---

## 7. Connector contract (`orbit-connectors`)

New capability distinct from Orbit send:

| Piece | Proposal |
|-------|----------|
| Permission / function | Prefer new `use_file_library` **or** reuse `use_library` with a Prism endpoint discriminator — **recommend new function** so invite keys can grant Orbit libraries without file archive access |
| UI | Toolbar / menu: **Send file to Prism File Library** (after Save, or Save+Send); toast should show version number (`Uploaded v3`) |
| Rhino | Write current doc to temp `.3dm` → `POST /api/files` with `uploadedBy` (Rhino/Windows user) + `sourceApp=rhino` |
| Vectorworks | Export/save `.vwx` → same POST with `uploadedBy` + `sourceApp=vectorworks` |
| Config | Connector settings: Prism base URL + API key (existing pattern) |
| Preflight | `GET /api/files/status` — fail fast if root not writable |
| Versioning | Same filename always appends a version — connectors must not assume overwrite |

Document in `docs/LIBRARY_INTEGRATION.md` (new **File library** section) and connectors handoff.

**Scopes on API keys:** `files:read|write|delete` added to `server/src/api/keys.ts` `KNOWN_SCOPES` and key mint UI.

**Tool grants:** extend `PrismTool` with `'files'` in `shared/contracts/portal-access.ts` + permissions service if needed.

---

## 8. Explicit non-goals (v1)

- Not a Speckle/Orbit version store
- Not a replacement for project-attachments (visualiser MVR/GDTF)
- Not a general object store with S3 API (LAN path first; S3 can be a later backend)
- No in-browser CAD preview of `.3dm`/`.vwx` (download only)
- No automatic sync/delete from file server outside Prism soft-delete

---

## 9. Security / ops notes

- Validate extension allowlist + max size before writing.
- Reject path traversal; store only under resolved `file_library_root` (realpath check).
- Soft-delete in DB; disk purge job optional (keep tombstones for audit).
- Virus scanning: out of scope v1; note for later if fileserver policy requires it.
- Quotas per API key / project: later.
- Backup = file-server backup policy, not Prism Postgres dumps alone.

---

## 10. Implementation phases

### Phase A — Skeleton (Prism)
1. Scaffold `prism-files-service` + compose + nginx + `files-image` workflow  
2. Settings keys + Settings tile + `files:*` scopes + `PrismTool 'files'`  
3. Document + **version** tables; upload stacks by normalised filename  
4. Admin `#/files` list (latest + version count) + detail (**all versions** with uploader + date/time) + upload  

### Phase B — LAN root
1. Compose bind-mount + `FILE_LIBRARY_HOST_PATH`  
2. Settings `file_library_root` honored with writability check  
3. Status endpoint for ops/connectors  

### Phase C — Connectors
1. `use_file_library` (or agreed function) in permissions / invite keys  
2. Rhino + Vectorworks **Send file** actions in `orbit-connectors`  
3. LIBRARY_INTEGRATION + OpenAPI docs  

### Phase D — Hardening
1. Project filter, tags, bulk delete  
2. Retention / purge policy  
3. Optional link metadata to Orbit model id (display only)  

---

## 11. Shared-file coordination

Announce before editing:

| File | Change |
|------|--------|
| `web/src/shared/api.ts` | Append `filesApi` block |
| `web/src/admin/App.vue` | Nav + tool gate |
| `web/src/admin/main.ts` | Routes |
| `server/src/api/keys.ts` | `files:*` scopes |
| `shared/contracts/portal-access.ts` | `PrismTool` + maybe `ConnectorFunction` |
| `infra/docker-compose.dev.yml` / `nginx.router.conf` | Service + route |
| `docs/LIBRARY_INTEGRATION.md` | New section |

Do **not** edit fixture/model/materials owned files.

---

## 12. Open decisions (resolve before Phase A coding)

1. **Connector function name:** new `use_file_library` vs overload `use_library`?  
   → Recommendation: **`use_file_library`**.
2. **Default prod root:** require Settings path before accepting uploads, or silently use `${DATA_DIR}/files`?  
   → Recommendation: **accept local default**, warn in Settings status until LAN path configured.
3. **Soft-delete disk policy:** keep bytes until hard-purge job vs unlink immediately?  
   → Recommendation: **soft-delete DB + keep bytes N days** (configurable).
4. **Project association:** free-string Orbit project id from connector, or Prism-side project picker only?  
   → Recommendation: **optional string from connector** in v1.
5. **Version grouping scope:** global by filename, or `(project_id, filename)`?  
   → Recommendation: **global by normalised filename** in v1; add project scope if collisions hurt.

---

## 13. Success criteria

- Rhino user clicks **Send file** → `.3dm` appears under `#/files` within seconds  
- Vectorworks same for `.vwx`  
- Re-uploading the **same filename** lists as a new version (v1, v2, …); older versions remain downloadable  
- Each version shows **who uploaded it** and **date/time**  
- Files land on the **LAN file-server folder**, not the Docker named volume, when Settings root is configured  
- Orbit publish still works independently; File Library failure must not block Orbit send  
- API key without `files:write` cannot upload  

---

## 14. Next agent actions (when greenlit)

1. Confirm open decisions in §12 with the team  
2. Create `feat/file-library` + scaffold polyrepo  
3. Implement Phase A → B in Prism; Phase C in `orbit-connectors`  
4. Update this handoff from “plan” to “active” and add `.cursor/rules/file-library-workstream.mdc`
