# REBUS portal contract (PRISM side)

PRISM defines the integration contract now; the portal team implements to match.

Canonical types: `shared/contracts/portal-access.ts` (+ `.json`).

## Portal â†’ PRISM (assumed REST)

### `GET /portal/me`

Bearer: portal user token (after OAuth).

```json
{
  "userId": "portal-user-123",
  "email": "alice@example.com",
  "googleSub": "google-oauth-sub",
  "displayName": "Alice",
  "roleId": "staffnew",
  "roleIds": ["staffnew"]
}
```

- `roleId` — the user's primary role **id**. **Must match a role `id` returned by `GET /portal/roles`** and the role keys used in PRISM tool grants (`grants.roles[id]`). Case-sensitive.
- `roleIds` — all role ids the user holds (PRISM unions them for grant resolution).
- The super-admin role id is `super-admin` (`SUPER_ADMIN_ROLE_ID`) and is always granted all PRISM tools.
- Legacy `role` / `customRoleId` are still accepted for older portal builds but are superseded by `roleId` / `roleIds`.

### `GET /portal/roles`

**New — required for the live role feed.** Bearer: **service API key** (the same key PRISM uses for other service-to-portal calls; not a user token).

Returns the portal's current, authoritative role list. PRISM mirrors this on the **Tool access** page so deleted/renamed roles never linger as stale grants.

```json
{
  "roles": [
    { "id": "super-admin", "name": "Super Admin", "system": true },
    { "id": "staffnew",    "name": "Staff",       "system": false }
  ]
}
```

- `id` (**required**) — canonical role id. This is what `PortalUser.roleId` / `roleIds` and PRISM tool-grant keys (`grants.roles[id]`) are matched against (case-sensitive). When a role is deleted in the portal it must disappear from this list; when renamed, change `name` but keep a stable `id` (or PRISM treats the new id as a new role).
- `name` (optional) — display label shown in PRISM.
- `system` (optional) — `true` for built-in portal roles.

If the portal has not implemented this endpoint, return **404** or **501** — PRISM degrades gracefully and falls back to deriving role nodes from existing grants (and surfaces a "live portal role feed unavailable" hint).

### `GET /portal/users/:userId/project-permissions`

Bearer: portal user token **or** service API key (TBD with portal team).

```json
{
  "projects": [
    { "orbitProjectId": "abc123", "level": "contributor", "projectName": "Demo" }
  ]
}
```

Levels: `viewer` | `contributor` | `owner` | `admin`.

### `POST /portal/oauth/token` (optional)

Exchange authorization code (when portal owns OAuth directly):

```json
{ "code": "â€¦", "redirectUri": "http://localhost:29364/", "grantType": "authorization_code" }
â†’ { "accessToken": "â€¦" }
```

## PRISM permissions service

### `POST /api/access/session`

```json
{
  "portalAuthCode": "mock:alice",
  "orbitTarget": "prod",
  "redirectUri": "http://localhost:29364/"
}
```

â†’ `{ "manifest": { â€¦ ConnectorManifest â€¦ } }`

See `ConnectorManifest` in `portal-access.ts`.

## Mock adapter

Set `PORTAL_ADAPTER=mock` (default on prism.rebus.industries). Accepts codes `mock:alice`, `mock:bob`.

## Identity mapping

Portal email is matched to ORBIT user email. Set `ORBIT_AUTO_INVITE=1` to send server invites when missing.

## Open items for portal team

- **Implement `GET /portal/roles`** (service-key auth) so PRISM mirrors the live role list. Until it exists, PRISM falls back to grant-derived roles and stale roles can linger.
- Ensure `GET /portal/me` returns `roleId` (and `roleIds`), with ids that match `GET /portal/roles`.
- When a role is deleted/renamed in the portal, also send a full-replace `PUT /api/permissions/tool-grants` so its tool grants are cleared (PRISM stores grants keyed by role id).
- OAuth client registration for connector localhost callback
- Service-to-portal auth model (user token vs service key for project-permissions)
- Production portal base URL + SLA for permission cache TTL
- **Bulk sync of project memberships** (for connector project access) — see handoff
  [`docs/handoffs/PORTAL_PROJECT_MEMBERSHIP_SYNC.md`](handoffs/PORTAL_PROJECT_MEMBERSHIP_SYNC.md)
