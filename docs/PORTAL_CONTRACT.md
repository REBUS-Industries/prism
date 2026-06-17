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
  "displayName": "Alice"
}
```

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

- OAuth client registration for connector localhost callback
- Service-to-portal auth model (user token vs service key for project-permissions)
- Production portal base URL + SLA for permission cache TTL
