# Portal access & permissions

PRISM integrates with the external **REBUS portal** for Google identity and per-user
project membership. A dedicated microservice (`prism-permissions-service`) brokers
connector login, mints scoped ORBIT tokens, and stores the function-policy node graph.

## Effective permissions

```
effective = portal project grants âˆ© function policy graph
```

- **Portal** owns which ORBIT projects a user may access (`viewer` / `contributor` / `owner` / `admin`).
- **PRISM admin â†’ Permissions** owns which connector functions are allowed per role/user/project.

## Connector flow

1. Connector opens portal sign-in (or mock-login on PRISM prod).
2. Browser callback returns `code` on `http://localhost:29364/`.
3. Connector `POST /api/access/session` with `{ portalAuthCode, orbitTarget }`.
4. Service validates with portal, mints scoped ORBIT token, returns `{ manifest }`.
5. Connector stores token + manifest; UI disables disallowed actions; ORBIT enforces token ACL.

**orbit-cli** is excluded: it authenticates via OAuth/PAT only and is never manifest-gated.
Use `orbit-cli auth login --server <prod|dev>` for full token capabilities (automation, UE5 subprocess, PRISM agent).

## Admin login

**Admin â†’ Permissions** (`/admin/#/permissions`) â€” guest access graph for Connector Light invite keys (guest nodes â†’ ORBIT projects). Right-click a guest for functions, target, redemptions, and a project checkbox tree.

**Admin â†’ Tool access** (`/admin/#/permissions/tools`) â€” read-only portal roles â†’ PRISM admin tools. Linked from the sidebar under Permissions.

**Admin â†’ Users** (`/admin/#/users`) â€” link Google Workspace, sync directory users, and
pre-provision project access / PRISM admin flags before first sign-in.

**Admin login** â€” username/password (unchanged) or **Sign in with Google** when the user's
portal email is provisioned with `isPrismAdmin` (or listed in legacy `PORTAL_ADMIN_EMAILS`).
On prism-dev with the mock workspace, link domain `rebus.industries`, sync, then edit `alice@rebus.industries`.

**Admin â†’ Tool access** (`/admin/#/permissions/tools`) â€” role â†’ PRISM tool grants
(convert, visualiser, fixture/material/model libraries). Editable from the portal
under **Settings â†’ Integrations â†’ PRISM Access** via `GET/PUT /api/permissions/tool-grants`.

**Portal `/portal/me`** returns `roleId` and `roleIds` (role ids) for grant resolution; super-admin id is `super-admin`.
**Portal `/portal/roles`** returns the live role catalogue; PRISM proxies it at `GET /api/permissions/tool-grants`'s sibling `GET /api/permissions/portal-roles` so the Tool access page mirrors the portal's current roles (deleted/renamed roles never linger). When the portal role feed is supported, the permissions service **automatically prunes** role grants whose keys are no longer in that list. If the portal hasn't implemented `/portal/roles`, PRISM falls back to deriving roles from grants.

**Admin → Settings → Portal access key** — paste the portal's **service** API key here (stored as `portal_api_key`, masked; base URL as `portal_base_url`). PRISM sends it as `Authorization: Bearer …` on `<base>/portal/*`. This is the portal's own service key (same one used for `POST /portal/oauth/token`), **not** a PRISM `prism_…` key. The permissions service reads these live (no restart needed), and **Save & check connection** verifies it via `/api/permissions/portal-roles`.
**PRISM admin `/api/access/me`** returns effective tools for nav gating (portal bearer) or full access (local admin cookie).
**prism-server** enforces tool grants for API keys only; **local admin login always bypasses** tool checks.

### Local admin bypass

Users who sign in via **Admin â†’ Log in** (username/password, `prism_admin` cookie) always receive all tools in the UI and on the server. Tool grants apply to portal-authenticated users and API keys, not to local PRISM admins.

## Service

| Item | Value |
|------|-------|
| Compose service | `prism-permissions` |
| Port | 8771 |
| Routes | `/api/access/*`, `/api/permissions/*` |
| Polyrepo | `REBUS-Industries/prism-permissions-service` |
| Workflow | `permissions-image` |

## Dev mock login

```
GET https://prism.rebus.industries/api/access/mock-login?redirect_uri=http://localhost:29364/&persona=alice
POST /api/access/session { "portalAuthCode": "mock:alice", "orbitTarget": "dev" }
```

## API key scopes (PRISM server)

- `access:read` â€” read manifest / session metadata
- `access:admin` â€” manage policy graph

## Token minting

The service attempts Speckle `apiTokenCreate` with `limitResources` (project whitelist) and
function-derived scopes. Set `ORBIT_MINT_FALLBACK=0` to fail hard when minting is unavailable.

Audit rows live in `minted_token`; revoke via `POST /api/access/revoke`.
