# Portal access & permissions

PRISM integrates with the external **REBUS portal** for Google identity and per-user
project membership. A dedicated microservice (`prism-permissions-service`) brokers
connector login, mints scoped ORBIT tokens, and stores the function-policy node graph.

## Effective permissions

```
effective = portal project grants ∩ function policy graph
```

- **Portal** owns which ORBIT projects a user may access (`viewer` / `contributor` / `owner` / `admin`).
- **PRISM admin → Permissions** owns which connector functions are allowed per role/user/project.

## Connector flow

1. Connector opens portal sign-in (or dev mock-login on prism-dev).
2. Browser callback returns `code` on `http://localhost:29364/`.
3. Connector `POST /api/access/session` with `{ portalAuthCode, orbitTarget }`.
4. Service validates with portal, mints scoped ORBIT token, returns `{ manifest }`.
5. Connector stores token + manifest; UI disables disallowed actions; ORBIT enforces token ACL.

**orbit-cli** is excluded: it authenticates via OAuth/PAT only and is never manifest-gated.
Use `orbit-cli auth login --server <prod|dev>` for full token capabilities (automation, UE5 subprocess, PRISM agent).

## Admin login

**Admin → Permissions** (`/admin/#/permissions`) — Vue Flow editor for the policy graph.

**Admin → Users** (`/admin/#/users`) — link Google Workspace, sync directory users, and
pre-provision project access / PRISM admin flags before first sign-in.

**Admin login** — username/password (unchanged) or **Sign in with Google** when the user's
portal email is provisioned with `isPrismAdmin` (or listed in legacy `PORTAL_ADMIN_EMAILS`).
On prism-dev with the mock workspace, link domain `rebus.industries`, sync, then edit `alice@rebus.industries`.

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
GET https://prism-dev.rebus.industries/api/access/mock-login?redirect_uri=http://localhost:29364/&persona=alice
POST /api/access/session { "portalAuthCode": "mock:alice", "orbitTarget": "dev" }
```

## API key scopes (PRISM server)

- `access:read` — read manifest / session metadata
- `access:admin` — manage policy graph

## Token minting

The service attempts Speckle `apiTokenCreate` with `limitResources` (project whitelist) and
function-derived scopes. Set `ORBIT_MINT_FALLBACK=0` to fail hard when minting is unavailable.

Audit rows live in `minted_token`; revoke via `POST /api/access/revoke`.
