# Handoff: Prism File Library → orbit-connectors

**Status:** Prism MVP API + admin UI shipping; connector UI **not started**.  
**Prism branch / PR:** `cursor/file-library-mvp-dd18` (monorepo `REBUS-Industries/prism`)  
**Connector repo:** `REBUS-Industries/orbit-connectors` (feature branches off `main`)  
**Do not implement connector changes inside the prism monorepo.**

**Read in prism:** [LIBRARY_INTEGRATION.md § File library](../LIBRARY_INTEGRATION.md#file-library) · OpenAPI tag **File library** at `/docs` · plan [HANDOFF-file-library.md](../../.cursor/plans/HANDOFF-file-library.md)

**Read in orbit-connectors workspace:** `.cursor/plans/README.md`, `AGENT-GIT-INSTRUCTIONS.md`, `HANDOFF-connectors.md`, then this document (copy or link).

---

## Product intent

Add a connector action **Send file to Prism File Library** that uploads the
author’s native CAD file (Rhino `.3dm`, Vectorworks `.vwx`) to Prism’s file
archive. This is **separate** from Orbit send / convert / model-import.

| | File Library | Orbit send |
|---|---|---|
| Payload | Native `.3dm` / `.vwx` (source archive) | Geometry for visualisation / Speckle |
| Endpoint | `POST /api/files` | Existing Orbit / Prism convert paths |
| Versioning | Same filename → new immutable version | Orbit model versions |

Both actions can live on the same toolbar without coupling.

---

## Prism API contract (live once MVP merges)

Base URL: Prism origin (e.g. `https://prism.rebus.industries`).  
Auth: `X-API-Key` with scopes **`files:read`** + **`files:write`** (mint in Admin → API keys).

| Method | Path | Scope | Purpose |
|--------|------|-------|---------|
| `GET` | `/api/files/status` | `files:read` | Preflight: `writable`, `allowedExts`, `maxBytes`, `root` |
| `POST` | `/api/files` | `files:write` | Multipart upload (new doc or new version) |
| `GET` | `/api/files` | `files:read` | List documents |
| `GET` | `/api/files/{id}` | `files:read` | Detail + all versions (`uploadedBy`, `createdAt`) |
| `GET` | `/api/files/{id}/download` | `files:read` | Latest bytes |
| `GET` | `/api/files/{id}/versions/{versionId}/download` | `files:read` | Specific version |

### Upload form fields

| Field | Required | Notes |
|-------|----------|-------|
| `file` | yes | Binary body |
| `uploadedBy` | strongly recommended | OS / Rhino / VW user display name (shown in admin UI) |
| `sourceApp` | recommended | `rhino` or `vectorworks` |
| `name` | optional | Defaults to multipart filename |
| `projectId` | **required** | Orbit project id — must have a File Library folder set in Admin → Settings → File Library |
| `tags` | optional | Comma-separated |

Missing / unconfigured `projectId` → `400` with `code: project_folder_required` (file is **not** written).

### Example

```bash
curl -sS -X POST -H "X-API-Key: $PRISM_KEY" \
  -F "file=@./Auditorium.3dm" \
  -F "projectId=$ORBIT_PROJECT_ID" \
  -F "uploadedBy=jsmith" \
  -F "sourceApp=rhino" \
  https://prism.rebus.industries/api/files
```

**201 response (shape):**

```json
{
  "document": {
    "id": "…",
    "name": "Auditorium.3dm",
    "extension": ".3dm",
    "versionCount": 3,
    "latestVersion": { "versionNumber": 3, "uploadedBy": "jsmith", "createdAt": "…" }
  },
  "version": {
    "id": "…",
    "versionNumber": 3,
    "uploadedBy": "jsmith",
    "sourceApp": "rhino",
    "createdAt": "2026-07-20T09:45:00.000Z",
    "downloadUrl": "/api/files/{documentId}/versions/{versionId}/download"
  }
}
```

Toast: **`Uploaded v{versionNumber}`**. Never assume overwrite — same name always appends.

### Preflight

```http
GET /api/files/status
→ { "writable": true, "allowedExts": [".3dm", …], "maxBytes": 2147483648, "root": "…" }
```

Fail fast with a clear error if `writable` is false (ops: Settings → File Library / bind mount).

---

## Connector implementation checklist

1. **Permission / function** — Prefer new connector function **`use_file_library`** (do **not** overload `use_library`). Gate the menu item on the portal manifest when permissions-service supports it; until then, gate on presence of a Prism API key with `files:write` (or a connector setting flag).
2. **Config** — Reuse Prism base URL + API key settings; document that the key needs `files:read` + `files:write`.
3. **Rhino** — Save/export current doc to temp `.3dm` → `POST /api/files` with `sourceApp=rhino` + `uploadedBy` (Windows / Rhino user).
4. **Vectorworks** — Save/export `.vwx` → same POST with `sourceApp=vectorworks`.
5. **UX** — Label: **Send file to Prism File Library**. After success show version number; offer “Open in Prism” deep-link `https://{prism}/admin/#/files/{documentId}` when useful.
6. **Errors** — Surface 400 (extension), 413 (too large), 403 (scope), and status `writable: false` clearly.
7. **Tests** — Mock Prism `/api/files` + `/status`; assert multipart fields and version toast.

---

## Permissions follow-ups (coordinate)

| Change | Where |
|--------|-------|
| Add `use_file_library` to `ConnectorFunction` enum + policy UI | `prism` `shared/contracts/portal-access.ts`, `web` api types, **prism-permissions-service** |
| Invite keys can grant File Library without Orbit library | invite-key defaults / LIGHT functions |
| Tool grant `files` already on Prism admin Tool access | prism MVP |

Do **not** block the connector UI on permissions-service if a dedicated Prism API key path works for v1.

---

## Explicit non-goals for connector v1

- No Orbit publish as part of this button
- No in-connector CAD preview of library files
- No delete-from-library UI in the connector (admin SPA only)
- No automatic overwrite / “replace latest”

---

## Acceptance criteria

- [x] Connector function `use_file_library` + Upload File button (gated) in shared panel
- [ ] Rhino: Send file uploads `.3dm`; admin `#/files` shows new/updated document with uploader + timestamp; re-send same name → version N+1
- [ ] Vectorworks: same for `.vwx`
- [ ] Preflight fails clearly when library root not writable
- [ ] Toast shows version number from API response
- [ ] Orbit send path unchanged

---

## Deploy notes (Prism side)

After prism PR merges: **web-image** + **server-image** (migration `0014_file_library`). Confirm `/docs` shows **File library** tag and `/api/files/status` returns 200 with a valid key.
