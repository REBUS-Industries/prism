# Handoff: Portal → Prism project membership sync

**Audience:** portal agent / portal app team  
**Status:** Portal feed implemented (portal agent). Prism ingest live — login prefers portal memberships, persists onto provisioned users, and Admin → Permissions has **Sync portal projects** (`GET /portal/project-permissions`). Scoped connector access still requires **`workspace_grant_all_projects=0`**.  
**Goal:** Keep Prism (and connectors) in sync with the ORBIT projects each portal user is added to, so connector project access can be scoped without manual Users-page edits.

**Do not implement this inside `orbit-connectors`.** Portal owns membership; Prism brokers connector sessions.

---

## Read first (Prism repo)

| Doc | Why |
|-----|-----|
| [`docs/PORTAL_CONTRACT.md`](../PORTAL_CONTRACT.md) | Portal REST surface Prism already expects |
| [`docs/PERMISSIONS.md`](../PERMISSIONS.md) | Effective permissions model + admin UI gaps |
| [`docs/WORKSPACE.md`](../WORKSPACE.md) | Google Workspace sync vs provisioned users |
| [`shared/contracts/portal-access.ts`](../../shared/contracts/portal-access.ts) | Canonical types (`PortalProjectPermission`, `ConnectorManifest`) |
| [`.cursor/plans/HANDOFF-permissions.md`](../../.cursor/plans/HANDOFF-permissions.md) | Permissions workstream (Prism seat) |

**Repos:** portal app (external) · Prism permissions polyrepo `REBUS-Industries/prism-permissions-service` · monorepo docs/contracts as needed.

---

## Product intent

When an admin adds (or removes) a user on an ORBIT project in the **portal**, that membership must drive **connector project access**:

```
portal project memberships
  → Prism permissions service
  → ConnectorManifest.projects[] (+ Orbit token ACL)
  → connector project picker / send / receive
```

Today the intended formula is:

```
effective = portal project grants ∩ function policy graph
```

| Owner | Responsibility |
|-------|----------------|
| **Portal** | Which ORBIT projects a user may access + level (`viewer` / `contributor` / `owner` / `admin`) |
| **Prism admin → Permissions** | Which connector **functions** are allowed (send, receive, list_*, …) per role/user/project |
| **Connector** | Consumes `ConnectorManifest`; does not invent project lists |

Without a reliable portal membership feed, Prism falls back to:

1. Manual `projectPermissions` on Admin → Users (painful, drifts), and/or  
2. **Blanket** access (`workspace_grant_all_projects`) — connectors see all projects, which defeats scoped access.

This handoff is specifically about making **portal project membership** the source of truth for the project half of that formula.

---

## What Prism already does

| Capability | Status |
|------------|--------|
| Contract for `GET /portal/users/:userId/project-permissions` | Defined in `PORTAL_CONTRACT.md` |
| Login-time fetch for the signing-in user (`RealPortalAdapter`) | Implemented in permissions service |
| Build `ConnectorManifest.projects[]` with `allowedFunctions` = level defaults ∩ policy graph | Implemented (when blanket is **off**) |
| Cache row at login (`project_permission_cache`) | Implemented — **not** used as admin SoT |
| Google Workspace **user directory** sync | Implemented — imports users with **empty** `projectPermissions` |
| Manual project assign on Admin → Users | Implemented |
| Invite-key guest → project graph | Separate path — **out of scope** for this handoff |

### Connector session (already live)

1. Connector → `GET /api/access/login?redirect_uri=http://localhost:29364/`
2. Portal OAuth → code on loopback
3. Connector → `POST /api/access/session` `{ portalAuthCode, orbitTarget }`
4. Prism returns `{ manifest }` (`ConnectorManifest`)
5. Refresh → `GET /api/access/manifest?sessionId=…`

**Manifest fields that matter for project access:**

```ts
{
  orbitBlanketAccess: boolean;           // true → projects: [] (all projects)
  projects: [{
    orbitProjectId: string;
    projectName?: string | null;
    level: 'viewer' | 'contributor' | 'owner' | 'admin';
    allowedFunctions: ConnectorFunction[];  // what the connector may do on that project
  }];
  globalAllowedFunctions: ConnectorFunction[];
}
```

Level → base functions (before policy ∩):

| Level | Base functions |
|-------|----------------|
| `viewer` | `list_projects`, `list_models`, `list_versions`, `receive` |
| `contributor` | + `send`, `create_version` |
| `owner` / `admin` | all grantable connector functions |

---

## Gap (why this handoff exists)

Documented in `PERMISSIONS.md` / Permissions UI:

> Portal project memberships are **not bulk-synced** yet. Login uses `GET /portal/users/:id/project-permissions` for that one user; there is **no admin feed of every user’s portal projects**.

Additional Prism-side snag (permissions seat — coordinate, don’t ignore):

- Once a user exists as `provisioned_user` (normal after Workspace sync), session resolution may prefer **manual** `provisioned_user.projectPermissions` over the portal list.
- Prod often runs with **`workspace_grant_all_projects=1`**, which empties `projects[]` and grants blanket Orbit access — scoped sync has no effect until that is turned off for the target env.

**Portal agent owns the membership API + change feed. Prism permissions agent owns ingest / SoT merge / blanket flip.**

---

## What the portal agent must implement

### 1. Authoritative per-user project permissions (required)

Already in the contract — make it production-solid:

```http
GET /portal/users/:userId/project-permissions
Authorization: Bearer <user token | service key — see § Auth>
```

```json
{
  "projects": [
    {
      "orbitProjectId": "abc123",
      "level": "contributor",
      "projectName": "Demo Auditorium"
    }
  ]
}
```

**Rules**

- `orbitProjectId` — ORBIT project id string Prism/Orbit already use (not an internal portal UUID unless they are the same).
- `level` — one of `viewer` | `contributor` | `owner` | `admin`.
- `projectName` — optional but strongly preferred (connector picker + admin UI).
- Return **only active memberships**; removed projects must disappear from the list (full replace semantics).
- Empty list `[]` is valid (user has no project access).

### 2. Service-key auth for bulk / server sync (required decision)

Contract currently says user token **or** service key — **TBD**. For connector-scoped sync we need:

| Caller | Auth | Use |
|--------|------|-----|
| Connector login (Prism, acting as user) | User bearer from OAuth | Single-user fetch at session exchange |
| Prism bulk sync / admin refresh | **Portal service API key** (`portal_api_key` already stored in Prism Settings) | Pull many users without impersonation |

**Ask / decide with Prism:** allow the same service key used for `GET /portal/roles` and `POST /portal/oauth/token` on:

```http
GET /portal/users/:userId/project-permissions
Authorization: Bearer <portal_service_api_key>
```

If the portal cannot expose that, provide an equivalent **service-only** bulk endpoint (next section).

### 3. Bulk membership feed (required for admin sync)

Prism needs a way to refresh **all** (or domain-scoped) memberships without N× interactive logins.

**Preferred (pick one; document the choice):**

**Option A — list endpoint (pull)**

```http
GET /portal/project-permissions
  ?cursor=…
  &limit=200
  &domain=rebus.industries          # optional filter
Authorization: Bearer <portal_service_api_key>
```

```json
{
  "users": [
    {
      "userId": "portal-user-123",
      "email": "alice@example.com",
      "projects": [
        { "orbitProjectId": "abc123", "level": "contributor", "projectName": "Demo" }
      ]
    }
  ],
  "nextCursor": null
}
```

**Option B — webhook / push (eventual consistency)**

On membership add/remove/level-change, POST to a Prism webhook (to be added by permissions seat), e.g.:

```json
{
  "type": "portal.user.project_permissions.changed",
  "userId": "portal-user-123",
  "email": "alice@example.com",
  "projects": [ /* full replace list for that user */ ],
  "changedAt": "2026-07-20T10:00:00.000Z"
}
```

Pull (A) is enough for v1; push (B) is nice for low latency.

### 4. Keep identity + roles aligned (already open items)

These block clean grant resolution — finish if not done:

- [`GET /portal/me`](../PORTAL_CONTRACT.md) returns `roleId` / `roleIds` matching [`GET /portal/roles`](../PORTAL_CONTRACT.md)
- [`GET /portal/roles`](../PORTAL_CONTRACT.md) with **service-key** auth (live role catalogue for Tool access)
- Stable role `id`s; deleted roles disappear from `/portal/roles`

### 5. Document ops contract

Publish for Prism ops:

| Item | Needed |
|------|--------|
| Production portal base URL | e.g. `https://portal.rebus.industries` |
| Service key scopes | roles + project-permissions (+ oauth if portal-owned) |
| Cache / freshness SLA | Prism caches ~5 min today (`PORTAL_CACHE_TTL_MS`); say how fast membership changes become visible |
| Rate limits | For bulk pull |

---

## What Prism will do next (permissions seat — not portal agent)

Do **not** block portal API work on these, but sync is useless for connectors until they land:

1. **Ingest** bulk/webhook memberships into Prism (update `provisioned_user.projectPermissions` **or** treat portal as SoT and stop discarding portal lists for provisioned users).
2. Fix `resolveProvisionedAccess` so provisioned users **merge or prefer portal** grants instead of ignoring them.
3. Admin Permissions graph: show live portal project edges (remove “not bulk-synced” caveat).
4. Turn **`workspace_grant_all_projects` off** for the env that should use scoped connector access.
5. Optional: Admin button **“Sync portal projects”** calling the bulk endpoint.

Coordinate via `#prism-dev` / permissions handoff before flipping blanket off in prod.

---

## How this facilitates connector project access

End state with blanket **off** and sync live:

1. Portal admin adds `alice@…` to Orbit project `abc123` as `contributor`.
2. Sync / next login → Prism sees `{ orbitProjectId: "abc123", level: "contributor" }`.
3. Alice signs into Rhino/VW connector → manifest includes that project with `allowedFunctions` including `send`, `list_projects`, …
4. Connector project picker shows **only** her portal projects; Orbit token is scoped the same way.
5. Remove her from the project in portal → after sync/login she can no longer see/send to it.

Invite-key guests remain a **separate** graph (Admin → Permissions → Guests). This handoff is for **portal/Workspace users**.

---

## Implementation checklist (portal agent)

- [ ] Harden `GET /portal/users/:userId/project-permissions` (correct ids, levels, names, full-replace)
- [ ] Allow **service API key** on that route (or ship bulk Option A with service key)
- [ ] Ship bulk list **or** webhook for membership changes
- [ ] Confirm `/portal/me` + `/portal/roles` role ids
- [ ] Write short portal-side API notes (auth, SLA, rate limits) and link back here
- [ ] Provide 2–3 test accounts with known project sets for Prism QA
- [ ] Notify Prism permissions seat when ready so ingest + blanket-off can land

---

## Acceptance criteria

- [ ] Given a portal user with known memberships, `GET …/project-permissions` returns the same `orbitProjectId` + `level` set as the portal UI
- [ ] Service key can fetch that data without a user interactive session (for Prism sync)
- [ ] Add/remove project in portal → reflected via bulk feed or webhook within agreed SLA
- [ ] With Prism blanket **off** and ingest live: connector `manifest.projects[]` matches portal membership for that user
- [ ] User with zero projects gets `projects: []` and cannot list/send (not silent blanket)

---

## Explicit non-goals (portal agent v1)

- Invite-key guest graph / guest UI
- Function-policy graph (`send` / `receive` edges) — Prism admin
- Orbit token minting / connector UI
- File Library / model library scopes
- Changing ORBIT server ACLs beyond what Prism already mints from the project id list

---

## Suggested test matrix

| Case | Portal setup | Expected Prism/connector |
|------|--------------|---------------------------|
| Contributor on 1 project | alice → project A, contributor | Manifest 1 project; can send + list |
| Viewer only | bob → project A, viewer | No `send`; can list/receive |
| Two projects | alice → A + B | Both ids in `projects[]` |
| Removed | alice removed from A | A gone after sync/login |
| None | new synced workspace user | Empty projects (not all projects) |

Mock reference today: Prism `PORTAL_ADAPTER=mock` personas `alice` / `bob` with hardcoded projects — real portal should replace that for prod.

---

## Coordination / reply back

When implementing, reply in the Prism thread (or PR comment) with:

1. Chosen auth model (service key on per-user route vs bulk-only)
2. Chosen feed (pull list vs webhook vs both)
3. Example response payloads from staging
4. Base URL + any header quirks beyond `Authorization: Bearer …`

Prism permissions agent will then wire ingest + turn off blanket for the target environment.
