# Collaborator invite keys (Connector Light)

Invite keys let an external **REBUS Connector Light** (Rhino) user authenticate without a
portal/Google account. Admins manage them on **Permissions** as a guest → project graph.

Canonical API contract: `REBUS-Industries/prism-permissions-service` → `docs/INVITE_KEYS.md`.

## Two Permissions pages

| Route | Purpose |
|-------|---------|
| `/admin/#/permissions` | **Guest access** — invite keys as guest nodes, ORBIT projects as project nodes, edges = project grants |
| `/admin/#/permissions/tools` | **Tool access** — read-only portal roles → PRISM admin tools (Convert, Visualiser, libraries) |

## Guest graph UX

1. **Add guest** — creates a draft guest node and opens properties.
2. **Draw lines** guest → project (or check projects in the properties tree).
3. **Right-click** a guest (or use Properties) for name, ORBIT target, functions, max redemptions, expiry, and a **project checkbox tree** (grouped by name prefix before ` - `).
4. **Save** mints the key (plaintext shown once) or updates via `PATCH`.
5. **Double-click an edge** to unlink a project (save to persist).
6. **Revoke** ends the key and active sessions.

## "Not Found" when minting

If the UI shows **Not Found** / `Route GET:/api/access/invite-keys not found`, the running
`prism-permissions` container is an older build without invite-keys routes. Redeploy
`prism-permissions-service` from `main` (`permissions-image` workflow). A healthy deploy
must report `features.inviteKeys: true` on `GET /api/access/health` and return **401**
(not 404) for unauthenticated `GET /api/access/invite-keys`.

## Light default functions

Allowed: `send`, `create_model`, `create_version`, `list_models`, `list_versions`

Denied: `receive`, `create_project`

`orbitBlanketAccess` is always `false` for invite-key sessions.

## Admin API (admin cookie)

- `POST /api/access/invite-keys` — create (plaintext key in response, once)
- `GET /api/access/invite-keys` — list (no plaintext)
- `PATCH /api/access/invite-keys/:id` — update label / projects / functions
- `POST /api/access/invite-keys/:id/revoke` — revoke key + sessions
