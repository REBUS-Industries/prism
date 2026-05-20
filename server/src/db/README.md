# `server/src/db/`

Drizzle ORM schema + migrations. Schema is the source of truth — never
hand-edit DDL.

## Tables (Phase 1 will implement)

| Table | Purpose |
|---|---|
| `jobs` | Conversion jobs (id, status, format, ORBIT target, timestamps, result url) |
| `job_logs` | Streaming log lines per job (linked to `/api/jobs/:id/stream`) |
| `api_keys` | Hashed (SHA-256) keys for `/v1/*` callers; per-key quotas |
| `settings` | Key/value: ORBIT prod/dev URLs + tokens, retention hours, maintenance flag |
| `layer_presets` | Per project + model saved layer selection |
| `admin_users` | Local admin accounts (bcrypt-hashed passwords) |
| `workstations` | Persistent agent identities (machine ID + display name + roles) |
| `agent_sessions` | Live WS connections — populated on `hello`, dropped on disconnect |
| `webhooks` | Admin-configured callback targets |

## Commands

```bash
npm run db:generate    # diff schema -> new SQL migration file
npm run db:migrate     # apply pending migrations against $POSTGRES_URL
```
