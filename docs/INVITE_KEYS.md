# Collaborator invite keys (Connector Light)

Invite keys let an external **REBUS Connector Light** (Rhino) user authenticate without a
portal/Google account. Admin mints keys on **Permissions → Guest access (Connector Light)**.

Canonical contract: `REBUS-Industries/prism-permissions-service` → `docs/INVITE_KEYS.md`.

## Admin UI

| Action | Where |
|--------|--------|
| Create guest key (name + projects) | Permissions → **New guest key** |
| Copy plaintext key / redeem URL | Shown once after create |
| Rename / change project access | **Edit** on an active key (requires `PATCH /api/access/invite-keys/:id` on the permissions service) |
| Revoke | **Revoke** — ends key and active sessions |

## Connector usage

1. Paste the invite key in Connector Light, **or**
2. Open `redeemUrl` with `&redirect_uri=http://localhost:29364/`

The connector exchanges the key via `POST /api/access/session` for a scoped `ConnectorManifest`.

## Light default functions

Allowed: `send`, `create_model`, `create_version`, `list_models`, `list_versions`

Denied: `receive`, `create_project`

`orbitBlanketAccess` is always `false` for invite-key sessions.

## Admin API (admin cookie)

- `POST /api/access/invite-keys` — create (plaintext key in response, once)
- `GET /api/access/invite-keys` — list (no plaintext)
- `PATCH /api/access/invite-keys/:id` — update label / projects / functions (see scaffold patch)
- `POST /api/access/invite-keys/:id/revoke` — revoke key + sessions

## Permissions service patch

To enable **Edit** in the admin UI, apply
`scaffold/prism-permissions-service/patches/invite-keys-update-endpoint.patch` to
`prism-permissions-service`, merge, and redeploy `permissions-image`.
