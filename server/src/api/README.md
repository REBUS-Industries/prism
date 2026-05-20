# `server/src/api/`

REST routes for the admin + convert SPAs (`/api/*`) and external callers
(`/v1/*`). Each file registers a Fastify plugin and is mounted from
`main.ts`.

| File | Mount | Purpose |
|---|---|---|
| `convert.ts` | `/api/convert` | Submit conversion jobs, prepare flow for layer pick |
| `jobs.ts` | `/api/jobs` | List, poll, delete, stream logs |
| `keys.ts` | `/api/keys` | API key CRUD (admin only) |
| `settings.ts` | `/api/settings` | ORBIT prod/dev creds, retention, maintenance flag |
| `workstations.ts` | `/api/workstations` | Pool CRUD + per-agent commands (cancel, etc.) |
| `layerPresets.ts` | `/api/layer-presets` | Save/load layer selections per project+model |
| `webhooks.ts` | `/api/webhooks` | Callback dispatcher (admin-managed targets) |
| `external.ts` | `/v1` | Public API surface, rate-limited, versioned |

All routes share the auth middleware in [`../auth/`](../auth/).
