# `server/src/auth/`

Three auth strategies share the same Fastify request decorator
(`request.principal`) so route handlers don't care which method was used.

| Strategy | Where it applies |
|---|---|
| **API key** (`X-API-Key`, SHA-256 hash compared against `api_keys`) | External `/v1/*` |
| **ORBIT bearer** (`Authorization: Bearer ...`, validated against `orbit-server` via `{ activeUser { id } }` GraphQL query, 5-min positive cache) | `/api/*` from the SPAs or the connector |
| **Admin session** (httponly cookie, signed) | `/api/admin/*`, the admin SPA assets |

Maintenance mode (`settings.maintenance_mode = "1"`) short-circuits every
auth handler with a 503 response.
