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
  {yyyy}/
    {mm}/
      {fileId}/
        original.{ext}          # bytes as uploaded
        meta.json               # optional sidecar (hash, original name)
```

DB holds the canonical metadata; disk is content-addressable-ish by `fileId` (UUID). Never trust client paths.

---

## 4. Data model (sketch)

**`file_objects`** (in `prism_files`):

| Column | Notes |
|--------|--------|
| `id` | UUID |
| `name` | Display name (default = original filename) |
| `original_filename` | As uploaded |
| `extension` | `.3dm`, `.vwx`, … |
| `content_type` | MIME if known |
| `size_bytes` | |
| `content_hash` | SHA-256 of body |
| `storage_path` | Relative to `file_library_root` |
| `source` | `connector` \| `admin` \| `api` |
| `source_app` | `rhino` \| `vectorworks` \| … (connector-supplied) |
| `project_id` | Optional Orbit/portal project id (string, not FK) |
| `tags` | `text[]` |
| `created_by_api_key_id` / `created_by_admin_id` | Provenance |
| `created_at` / `updated_at` / `deleted_at` | Soft delete |

No Orbit model/version linkage required for v1. Optional later: “linked Orbit model id” metadata only.

---

## 5. API (v1)

Base: `/api/files` · Auth: admin session **or** `X-API-Key` with scopes below.

| Method | Path | Scope | Behaviour |
|--------|------|-------|-----------|
| `GET` | `/api/files` | `files:read` | List (`q`, `ext`, `projectId`, `cursor`, `limit`) |
| `GET` | `/api/files/:id` | `files:read` | Metadata |
| `GET` | `/api/files/:id/download` | `files:read` | Stream bytes (`Content-Disposition: attachment`) |
| `POST` | `/api/files` | `files:write` | Multipart: `file` + optional `name`, `projectId`, `tags`, `sourceApp` |
| `PATCH` | `/api/files/:id` | `files:write` | Rename / tags |
| `DELETE` | `/api/files/:id` | `files:delete` | Soft-delete (+ optional async disk purge) |
| `GET` | `/api/files/status` | `files:read` | `{ configured, root, writable, freeBytes? }` for connector preflight |

**Upload response (connector-friendly):**

```json
{
  "file": {
    "id": "…",
    "name": "Auditorium.3dm",
    "extension": ".3dm",
    "sizeBytes": 12345678,
    "downloadUrl": "/api/files/{id}/download",
    "createdAt": "…"
  }
}
```

OpenAPI tag **File library** on prism-server’s docs gateway (same pattern as Meshy/Models) or files-service `/docs`.

---

## 6. Admin UI

| Route | Purpose |
|-------|---------|
| `#/files` | Grid/table: name, ext, size, source app, project, date; search + filter |
| `#/files/:id` | Detail: metadata, download, delete, tags |
| Optional `#/files/upload` | Manual admin upload (parity with connectors) |

**Nav:** new top-level **Files** under `showTool('files')` in `web/src/admin/App.vue` (announce — shared file).

**Settings:** tile **File Library** with `file_library_root` (+ optional caps). Show status from `GET /api/files/status` (writable / not configured).

---

## 7. Connector contract (`orbit-connectors`)

New capability distinct from Orbit send:

| Piece | Proposal |
|-------|----------|
| Permission / function | Prefer new `use_file_library` **or** reuse `use_library` with a Prism endpoint discriminator — **recommend new function** so invite keys can grant Orbit libraries without file archive access |
| UI | Toolbar / menu: **Send file to Prism File Library** (after Save, or Save+Send) |
| Rhino | Write current doc to temp `.3dm` → `POST /api/files` |
| Vectorworks | Export/save `.vwx` → same POST |
| Config | Connector settings: Prism base URL + API key (existing pattern) |
| Preflight | `GET /api/files/status` — fail fast if root not writable |

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
3. CRUD + upload/download against default `${DATA_DIR}/files`  
4. Admin `#/files` list/detail/upload  

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

---

## 13. Success criteria

- Rhino user clicks **Send file** → `.3dm` appears under `#/files` within seconds  
- Vectorworks same for `.vwx`  
- Files land on the **LAN file-server folder**, not the Docker named volume, when Settings root is configured  
- Orbit publish still works independently; File Library failure must not block Orbit send  
- API key without `files:write` cannot upload  

---

## 14. Next agent actions (when greenlit)

1. Confirm open decisions in §12 with the team  
2. Create `feat/file-library` + scaffold polyrepo  
3. Implement Phase A → B in Prism; Phase C in `orbit-connectors`  
4. Update this handoff from “plan” to “active” and add `.cursor/rules/file-library-workstream.mdc`
