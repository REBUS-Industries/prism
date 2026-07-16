# Collaborator invite keys

Invite keys let an external **REBUS Connector** user authenticate without a
portal/Google account. Admins manage them on **Permissions** as a guest → project graph.

There is **no separate Lite/Light connector binary**. Connector edition
(send-only vs send+receive UI) is driven by the invite key's
`allowedFunctions` on the shared `ConnectorManifest`.

Canonical API contract: `REBUS-Industries/prism-permissions-service` → `docs/INVITE_KEYS.md`.

## Two Permissions pages

| Route | Purpose |
|-------|---------|
| `/admin/#/permissions` | **Guest access** — invite keys as guest nodes, ORBIT projects as project nodes, edges = project grants |
| `/admin/#/permissions/tools` | **Tool access** — read-only portal roles → PRISM admin tools (Convert, Visualiser, libraries) |

## Guest graph UX

1. **Add guest** — creates a draft guest node and opens properties.
2. **Draw lines** guest → project (or check projects in the properties tree).
3. **Right-click** a guest (or use Properties) for name, ORBIT target, functions, max redemptions, expiry, model access, and a **project checkbox tree** (grouped by name prefix before ` - `).
4. **Save** mints the key (plaintext shown once) or updates via `PATCH`.
5. **Double-click an edge** to unlink a project (save to persist).
6. **Revoke** ends the key and active sessions.

## "Not Found" when minting

If the UI shows **Not Found** / `Route GET:/api/access/invite-keys not found`, the running
`prism-permissions` container is an older build without invite-keys routes. Redeploy
`prism-permissions-service` from `main` (`permissions-image` workflow). A healthy deploy
must report `features.inviteKeys: true` on `GET /api/access/health` and return **401**
(not 404) for unauthenticated `GET /api/access/invite-keys`.

## Empty orbitToken on invite login

If the key is accepted but the connector reports an empty Orbit token, the permissions
service was minting with an invalid `apiTokenCreate` payload (`userId` + `type: "Project"`).
Apply `scaffold/prism-permissions-service/patches/invite-key-orbit-mint-empty-token.patch`
and redeploy. Invite-key sessions then fail with HTTP 503 on mint errors instead of
returning `orbitToken: ""`. Portal login is unchanged.

## Model access (guest properties)

Guest invite keys support three model-visibility modes (permissions-service + admin UI):

| Mode | Meaning |
|------|---------|
| `all` | Every model in the granted projects |
| `selected` | Only `selectedModelIds` (picked in the model checkbox tree) |
| `authored` | Models whose Orbit property `userId` equals `manifest.userId` (`invite:<keyId>`) |

Manifest carries `modelAccess`, `selectedModelIds`, and `authoredProperty: "userId"`.
The connector must filter `list_models` by mode and bake `userId = manifest.userId` on upload for authored guests.

## Default functions (Light / send-only preset)

When creating a key without choosing functions, the default is:

Allowed: `send`, `create_model`, `create_version`, `list_models`, `list_versions`

Admins may grant **any** connector function, including `receive`, `create_project`,
and `list_projects`. Granting `receive` unlocks Receive / Library / In File in the
single connector binary without reinstall.

`orbitBlanketAccess` is always `false` for invite-key sessions.

### Function → connector UI

| Capability | Derived from |
|------------|--------------|
| `canSend` | `Allows("send")` |
| `canReceive` / Library / In File | `Allows("receive")` |
| `canOpenOrbitLinks` | `authMethod != "invite_key"` |

## Admin API (admin cookie)

- `POST /api/access/invite-keys` — create (plaintext key in response, once)
- `GET /api/access/invite-keys` — list (no plaintext)
- `PATCH /api/access/invite-keys/:id` — update label / projects / functions
- `POST /api/access/invite-keys/:id/revoke` — revoke key + sessions
