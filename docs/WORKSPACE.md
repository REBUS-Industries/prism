# Google Workspace linking

PRISM can link a Google Workspace domain so admins can **import directory users** and
**assign permissions before anyone logs in**.

## Configuration

All integration variables live under **Admin → Settings → Portal & Google Workspace** (stored in
the PRISM `settings` table; env vars remain as bootstrap fallbacks). Secrets are write-only in the UI.

| Setting key | Purpose |
|-------------|---------|
| `portal_adapter` | `mock` or `real` portal API |
| `portal_base_url` | REBUS portal REST base |
| `portal_api_key` | Service-to-portal bearer |
| `portal_google_authorize_url` | Production OAuth authorize URL |
| `portal_mock_persona` | Dev mock-login persona |
| `workspace_adapter` | `mock` or `google_admin_sdk` |
| `workspace_domain` | Default domain when linking |
| `workspace_enforce_provisioned` | `1` = only provisioned users may sign in |
| `google_oauth_client_id` / `google_oauth_client_secret` | Google OAuth web client |
| `google_service_account_json` | Admin SDK directory sync |
| `portal_admin_emails` / `portal_admin_username` | Legacy admin Google fallback |

## Flow

1. **Admin → Users** — link domain (e.g. `rebus.industries`).
2. **Sync directory** — imports users as `pending` rows (mock adapter on dev).
3. **Edit each user** — set ORBIT project access, policy `roleRefs`, and **PRISM admin** flag.
4. User signs in with Google (admin SPA) or **Sign in with REBUS** (connectors).
5. First login activates `pending` → `active` and applies pre-defined permissions.

## Effective access

```
connector access = provisioned project grants ∩ function policy graph
admin Google login = provisioned user with isPrismAdmin (or legacy PORTAL_ADMIN_EMAILS)
```

When a workspace is linked and `WORKSPACE_ENFORCE_PROVISIONED=1` (default), only
provisioned users may authenticate. Unlink or set `WORKSPACE_ENFORCE_PROVISIONED=0`
to fall back to portal-only grants during migration.

## Dev mock directory

Domain `rebus.industries` syncs:

| Email | Suggested use |
|-------|----------------|
| `alice@rebus.industries` | Admin + contributor projects |
| `bob@rebus.industries` | Viewer-only connector user |
| `charlie@rebus.industries` | Pending user awaiting permissions |

## Production

Set `WORKSPACE_ADAPTER=google_admin_sdk` and provide Google Admin SDK credentials
(service account with domain-wide delegation) — hook lands in `workspace/service.ts`
alongside the mock directory.

## API

See `scaffold/prism-permissions-service/README.md` — `/api/permissions/workspace/*`.
