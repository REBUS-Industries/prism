# Google Workspace linking

PRISM can link a Google Workspace domain so admins **import directory users** and
**assign ORBIT project permissions before anyone logs in**.

Two adapters work together:

| Adapter | Setting | Purpose |
|---------|---------|---------|
| Portal OAuth | `portal_adapter=google` | Direct `accounts.google.com` sign-in (no REBUS portal) |
| Directory sync | `workspace_adapter=google_admin_sdk` | Admin SDK user list via service account |

When `portal.rebus.industries` exists, flip `portal_adapter` to `real` without changing
provisioned users or workspace sync.

## Configuration

All integration variables live under **Admin → Settings → Portal & Google Workspace** (stored in
the PRISM `settings` table; env vars remain as bootstrap fallbacks). Secrets are write-only in the UI.

| Setting key | Purpose |
|-------------|---------|
| `portal_adapter` | `mock`, `google` (direct OAuth), or `real` (REBUS portal API) |
| `portal_base_url` | REBUS portal REST base (`real` adapter only) |
| `portal_api_key` | Service-to-portal bearer (`real` adapter only) |
| `portal_google_authorize_url` | Portal OAuth authorize URL (`real` adapter only) |
| `portal_mock_persona` | Dev mock-login persona |
| `workspace_adapter` | `mock` or `google_admin_sdk` |
| `workspace_domain` | Primary domain (e.g. `rebus.industries`) |
| `workspace_admin_email` | Super-admin email to impersonate for Admin SDK |
| `workspace_enforce_provisioned` | `1` = only provisioned users may sign in |
| `google_oauth_client_id` / `google_oauth_client_secret` | Google OAuth web client |
| `google_oauth_scopes` | OAuth scopes (default `openid email profile`) |
| `google_workspace_directory_refresh_token` | **Preferred** — super-admin OAuth refresh token for directory sync (no SA key) |
| `google_service_account_json` | Optional — service account key JSON when org policy allows key creation |
| `portal_admin_emails` | Legacy admin allowlist (comma-separated emails) |

Env fallbacks: `PORTAL_ADAPTER`, `WORKSPACE_ADAPTER`, `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_SCOPES`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_WORKSPACE_DIRECTORY_REFRESH_TOKEN`,
`GOOGLE_WORKSPACE_ADMIN_EMAIL`, `WORKSPACE_DOMAIN`, `WORKSPACE_ENFORCE_PROVISIONED`.

## Org policy: service account keys blocked

If Google Cloud returns **Enforced organisation policy IDs: `iam.disableServiceAccountKeyCreation`**, you
**cannot** download a service account JSON key. This is common on Workspace orgs with secure-by-default policies.

**What still works without SA keys:**

| Feature | Setup |
|---------|--------|
| Admin **Sign in with Google** | OAuth web client only (steps 1–2 below) |
| **Directory sync** | **Authorize directory sync** in Admin → Settings (stores a super-admin refresh token) |

**Optional:** ask your org policy admin for a project-level exception, or run directory sync from a GCP-hosted proxy with workload identity (not required for PRISM on VM).

## Google Cloud setup checklist

### 1. OAuth consent screen

1. Open [Google Cloud Console](https://console.cloud.google.com/) for the REBUS project.
2. **APIs & Services → OAuth consent screen** — configure as **Internal** (Workspace-only) or External with verified domain.
3. Add scopes: `openid`, `email`, `profile` (and any connector scopes later).

### 2. OAuth web client (user sign-in)

1. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
2. **Authorized redirect URIs** (must match exactly):
   - `https://prism.rebus.industries/admin/?portal_callback=1`
   - `https://prism-dev.rebus.industries/admin/?portal_callback=1`
   - `https://prism.rebus.industries/api/admin/directory-oauth/callback`
   - `https://prism-dev.rebus.industries/api/admin/directory-oauth/callback`
   - `http://localhost:29364/admin/?portal_callback=1` (local dev)
3. On the OAuth consent screen, add scope `https://www.googleapis.com/auth/admin.directory.user.readonly` (directory sync).
4. Copy **Client ID** and **Client secret** into PRISM Settings (`google_oauth_client_id`, `google_oauth_client_secret`).

### 3. Directory sync authorization (recommended — no SA key)

1. In PRISM **Admin → Settings → Portal & Google Workspace**, save OAuth client ID + secret.
2. Click **Authorize directory sync** and sign in as a Workspace **super-admin**.
3. PRISM stores `google_workspace_directory_refresh_token` — Admin SDK sync works without service account keys.

### 4. Service account (optional — when keys are allowed)

Skip this section if `iam.disableServiceAccountKeyCreation` is enforced.

1. **IAM & Admin → Service accounts → Create** (e.g. `prism-workspace-sync@…`).
2. Enable **Domain-wide delegation** on the service account.
3. **Keys → Add key → JSON** — paste full JSON into `google_service_account_json` in Settings.
4. Note the service account **Client ID** (numeric).

### 5. Workspace admin delegation (service account path only)

1. In [Google Admin](https://admin.google.com/) → **Security → Access and data control → API controls → Domain-wide delegation**.
2. Add the service account Client ID with scope:
   ```
   https://www.googleapis.com/auth/admin.directory.user.readonly
   ```
3. Set `workspace_admin_email` to a super-admin account (e.g. `admin@rebus.industries`) — the service account impersonates this user for directory reads.

### 6. Enable Admin SDK API

In Cloud Console: **APIs & Services → Library → Admin SDK API → Enable**.

### 7. PRISM settings (production)

```
portal_adapter=google
workspace_adapter=google_admin_sdk
workspace_domain=rebus.industries
workspace_admin_email=admin@rebus.industries
workspace_enforce_provisioned=1
google_oauth_scopes=openid email profile
```

Fill OAuth client ID/secret via the Settings UI, then **Authorize directory sync** (or paste SA JSON if allowed).

## Flow

1. **Admin → Settings** — configure Google OAuth + service account (see checklist above).
2. **Admin → Users** — link domain (e.g. `rebus.industries`).
3. **Sync directory** — imports users as `pending` rows (`google_admin_sdk` calls Admin SDK; dev uses mock data).
4. **Edit each user** — set ORBIT project access, policy `roleRefs`, and **PRISM admin** flag.
5. User signs in with Google (admin SPA) or **Sign in with REBUS** (connectors, when portal exists).
6. First login activates `pending` → `active` and applies pre-defined permissions.

## Identity model

- **`provisioned_user`** — canonical identity; manual `projectPermissions` on the Users page.
- **`admin_users`** — cookie session rows: break-glass password admin + auto-upserted rows for Google admin sign-in (passwordless, keyed by email).
- Google admin sign-in: user must be provisioned with **PRISM admin** (or listed in legacy `portal_admin_emails`).

## Effective access

```
connector access = provisioned project grants ∩ function policy graph
admin Google login = provisioned user with isPrismAdmin (or legacy PORTAL_ADMIN_EMAILS)
```

When a workspace is linked and `workspace_enforce_provisioned=1` (default), only
provisioned users may authenticate. Unlink or set `workspace_enforce_provisioned=0`
to fall back to portal-only grants during migration.

## Dev mock directory

With `workspace_adapter=mock`, domain `rebus.industries` syncs:

| Email | Suggested use |
|-------|----------------|
| `alice@rebus.industries` | Admin + contributor projects |
| `bob@rebus.industries` | Viewer-only connector user |
| `charlie@rebus.industries` | Pending user awaiting permissions |

Use `portal_adapter=mock` and `/api/access/mock-login` for local admin sign-in without Google.

## API

See `scaffold/prism-permissions-service/README.md` — `/api/permissions/workspace/*` and `/api/access/*`.

## Polyrepo deploy

After merging scaffold changes, sync `REBUS-Industries/prism-permissions-service` from
`scaffold/prism-permissions-service/` and run the `permissions-image` workflow before
testing Google sign-in or directory sync in dev/prod.
