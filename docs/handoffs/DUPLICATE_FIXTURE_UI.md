# Handoff: Duplicate fixture UI

**Scope:** Prism admin web (`feat/fixture-builder`) — fixture library + editor.  
**Backend:** `POST /api/fixtures/:id/duplicate` on **`prism-fixtures-service`** (merged PR #87, v1.4.0+).  
**Auth:** `fixtures:write` (same as create / edit).

---

## API contract

### `POST /api/fixtures/:id/duplicate`

Deep-copies a library fixture into a new, independent row. Media blobs are shared (content-addressed); media **ids** in the definition are remapped. The copy is always **`status: draft`**, detached from GDTF-Share identity and from the source's Orbit model.

**Request body** — all fields optional:

| Field | Type | Notes |
|---|---|---|
| `name` | string (1–256) | Canonical row name. Default: `{source.name} (Copy)` (or unchanged if source already ends with `(copy)`). |
| `manufacturer` | string (≤256) | Default: copy source. |
| `fixtureName` | string (≤256) | Default: copy source. |
| `revision` | string \| null (≤128) | Default: copy source. |
| `displayName` | string \| null (≤256) | Custom label in `definition.metadata.displayName`. Default: copy source metadata. |

**Success — `201`**

```json
{
  "fixture": {
    "id": "<new-uuid>",
    "name": "Martin MAC Aura (Copy)",
    "displayName": null,
    "manufacturer": "Martin",
    "fixtureName": "MAC Aura",
    "revision": "1.0",
    "status": "draft",
    "importSource": "duplicate",
    "origin": "manual",
    "gdtfShareUuid": null,
    "updateAvailable": false,
    "definition": { "...": "..." }
  }
}
```

**Route using `fixture.id`** — navigate to `/fixtures/:id` (fixture editor). The new id is the only stable handle for the copy.

**Errors**

| Code | When |
|---|---|
| `404` | `{ "error": "not found" }` — source missing or soft-deleted. |
| `400` | `{ "error": "invalid body", "issues": [...] }` — Zod validation (field length, etc.). |
| `401` / `403` | Auth / missing `fixtures:write`. |

### Chained endpoints (post-duplicate workflow)

| Step | Endpoint | Purpose |
|---|---|---|
| Edit identity | `PUT /api/fixtures/:id` | Update `name`, `manufacturer`, `fixtureName`, `revision`, `displayName`, `tags`, `status`, `definition`. |
| Publish to Orbit | `POST /api/fixtures/:id/publish-orbit` | Creates a **new** Orbit model for the copy (see gotchas). Body: `{ "orbitTarget"?: "prod" \| "dev" }`. |

---

## Suggested UX

```
[Duplicate] ──► (optional dialog: name / mfr / fixture / revision / displayName)
                    │
                    ▼
              POST …/duplicate  ──► 201 { fixture }
                    │
                    ▼
         Navigate to /fixtures/{fixture.id}
                    │
                    ▼
         Edit identity (Settings) ──► PUT …/id
                    │
                    ▼
         Publish to Orbit ──► POST …/publish-orbit
```

### Variants

1. **One-click** — `POST` with empty body (server defaults). Shift+click the duplicate icon in the library detail panel, or call `fixturesApi.duplicate(id)` with no body.
2. **Dialog** — Click duplicate (no Shift); pre-fill from source; user adjusts manufacturer / fixture name before creating.

### Client helper

```ts
async function duplicateFixture(
  sourceId: string,
  overrides: {
    name?: string;
    manufacturer?: string;
    fixtureName?: string;
    revision?: string | null;
    displayName?: string | null;
  } = {},
): Promise<FixtureDetail> {
  const res = await fetch(`/api/fixtures/${sourceId}/duplicate`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(overrides),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `duplicate failed (${res.status})`);
  }
  const { fixture } = await res.json();
  return fixture;
}
```

Prefer `fixturesApi.duplicate()` in `web/src/shared/api.ts` (typed, shared error handling).

### Key behaviours

- **Success feedback** — brief notice (“Created draft copy”) then route to editor; prepend copy to local library list.
- **Refresh list** — `upsertLocalFixture(created.fixture)` so the copy appears without full reload.
- **Draft badge** — copy arrives as `status: draft`; show in library detail / editor header.
- **Publish** — first publish on the copy creates its **own** Orbit model; it does not republish the source.

---

## Gotchas

| Topic | Detail |
|---|---|
| Orbit link | Source `definition.metadata.orbitFixtureRef` is **stripped** server-side. UI must not show “Open in Orbit” from the source on the copy until after publish. |
| GDTF updates | Copies have `gdtfShareUuid: null` and `importSource: "duplicate"`. Hide “Check for updates” / “Update available” for these rows. |
| Auth | Duplicate button only when the session has `fixtures:write` (API enforces; UI can hide if scope gating is added later). |
| Media | Independent media **ids**, shared blob files — deleting the copy does not delete the source's blobs. |
| Identity | Orbit publish requires `definition.fixtureInformation.manufacturer` and `fixtureName`; keep row columns and definition in sync on save. |

---

## Files to touch

| File | Change |
|---|---|
| `web/src/shared/api.ts` | `FixtureListItem.displayName`, `importSource: 'duplicate'`, `fixturesApi.duplicate()`, widen `update` body. |
| `web/src/admin/pages/Fixtures.vue` | Duplicate actions, optional modal, list upsert + navigate. |
| `web/src/admin/components/FixtureLibraryDetail.vue` | Duplicate icon, draft badge, suppress GDTF update UI when no Share uuid. |
| `web/src/admin/pages/FixtureEditor.vue` | Identity fields in Settings, duplicate hint banner, suppress update UI on copies. |
| `web/src/admin/utils/fixtureLabel.ts` | `displayName ?? name` helper for labels. |

**Deploy:** web-only — `gh workflow run web-image --repo REBUS-Industries/prism --ref feat/fixture-builder`.  
Fixtures API already on main (v1.4.0+); no fixtures-image needed for UI-only work.
