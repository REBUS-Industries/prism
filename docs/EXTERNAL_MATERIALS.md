# External materials (Fab, Poly Haven, ambientCG)



Unified browse/import for the materials editor: `GET /api/external-materials/search`,

provider-specific import routes, and Admin → Settings → External materials.



## Fab + Cloudflare



Fab search and asset detail requests run **on the PRISM server** (VM 212 prod),

not in the user's browser. Epic's marketplace sits behind Cloudflare, which commonly blocks

datacenter egress IPs.



| Mechanism | Purpose |

|---|---|

| `FAB_EPIC_REFRESH_TOKEN` | OAuth for **import** (download owned assets). Does **not** bypass Cloudflare for search/detail. |

| **FlareSolverr** | Primary fix: PRISM calls FlareSolverr to solve Cloudflare and inject `cf_clearance` cookies into Fab HTTP requests. |

| `FAB_HTTP_PROXY` | Optional shared egress when VM IP + FlareSolverr is insufficient (residential proxy). |



### FlareSolverr on the PRISM VM



**Dev split stack (`infra/docker-compose.dev.yml`, VM 212):** FlareSolverr is included as a

compose service. `prism-materials` defaults to:



```env

FAB_FLARESOLVERR_URL=http://flaresolverr:8191/v1

```



Clear any DB override in Admin → Settings → External materials that still points at

`http://127.0.0.1:8191/v1` — inside a container, `127.0.0.1` is the container itself, not

the VM host.



**Prod / host-run FlareSolverr:**



1. Run on the same host as `prism-server` / `prism-materials` (port **8191**):



   ```bash

   docker run -d --name flaresolverr --restart unless-stopped \

     -p 8191:8191 \

     -e LOG_LEVEL=info \

     ghcr.io/flaresolverr/flaresolverr:latest

   ```



   Image: [ghcr.io/flaresolverr/flaresolverr](https://ghcr.io/flaresolverr/flaresolverr)



2. Set the FlareSolverr API URL depending on how PRISM runs:



   | PRISM runtime | FlareSolverr URL |

   |---|---|

   | `docker-compose.dev.yml` (in-network service) | `http://flaresolverr:8191/v1` |

   | PRISM in Docker, FlareSolverr on VM host (Windows/Mac Docker Desktop) | `http://host.docker.internal:8191/v1` |

   | PRISM in Docker, FlareSolverr on VM host (Linux) | `http://172.17.0.1:8191/v1` or the Docker bridge gateway IP |

   | PRISM and FlareSolverr both on host (no container network) | `http://127.0.0.1:8191/v1` |



   Configure via `FAB_FLARESOLVERR_URL` in `.env` or **Admin → Settings → External materials → FlareSolverr URL** (DB overrides env).



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

