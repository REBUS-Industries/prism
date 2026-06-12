# External materials (Fab, Poly Haven, ambientCG)

Unified browse/import for the materials editor: `GET /api/external-materials/search`,
provider-specific import routes, and Admin → Settings → External materials.

## Fab + Cloudflare

Fab search and asset detail requests run **on the PRISM server** (VM 211 prod, VM 212 dev),
not in the user's browser. Epic's marketplace sits behind Cloudflare, which commonly blocks
datacenter egress IPs.

| Mechanism | Purpose |
|---|---|
| `FAB_EPIC_REFRESH_TOKEN` | OAuth for **import** (download owned assets). Does **not** bypass Cloudflare for search/detail. |
| **FlareSolverr** | Primary fix: PRISM calls FlareSolverr to solve Cloudflare and inject `cf_clearance` cookies into Fab HTTP requests. |
| `FAB_HTTP_PROXY` | Optional shared egress when VM IP + FlareSolverr is insufficient (residential proxy). |

### FlareSolverr on the PRISM VM

1. Run on the same host as `prism-server` / `prism-materials` (port **8191**):

   ```bash
   docker run -d --name flaresolverr --restart unless-stopped \
     -p 8191:8191 \
     -e LOG_LEVEL=info \
     ghcr.io/flaresolverr/flaresolverr:latest
   ```

   Image: [ghcr.io/flaresolverr/flaresolverr](https://ghcr.io/flaresolverr/flaresolverr)

2. Set the FlareSolverr API URL (default when co-located):

   ```env
   FAB_FLARESOLVERR_URL=http://127.0.0.1:8191/v1
   ```

   Or configure **Admin → Settings → External materials → FlareSolverr URL** (DB overrides env).

3. Verify with **Test search API** in that settings panel (`/api/external-materials/search?q=brick&sources=fab`).

**Important:** Completing a Cloudflare challenge in a browser on a workstation does **not**
replace FlareSolverr. Clearance cookies are bound to egress IP, User-Agent, and fingerprint;
they cannot be copied from a PC session to unblock server-side Fab calls.

If Fab uses an HTTP proxy, FlareSolverr must use the same egress (PRISM forwards the Fab proxy
to FlareSolverr automatically).

See also `infra/.env.example` and `server/src/fab/flaresolverr.ts`.

## Other providers

- **Poly Haven** — public API, no auth; `POLYHAVEN_ENABLED` / User-Agent in `.env.example`.
- **ambientCG** — public API v3; `AMBIENTCG_ENABLED` in `.env.example`.
