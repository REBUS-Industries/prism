# Fix: invite-keys routes missing on prod ("Not Found")

Apply on `REBUS-Industries/prism-permissions-service` (branch off `main`), merge, and
confirm `permissions-image` deploy passes the invite-keys probe.

## Symptom

Admin UI mint/list shows **Not Found**. Live API:

```text
GET /api/access/invite-keys → {"message":"Route GET:/api/access/invite-keys not found","error":"Not Found","statusCode":404}
POST /api/access/session {} → {"error":"portalAuthCode required"}   # old build
# new build would say: "portalAuthCode or inviteKey required"
```

`GET /api/access/health` still works — the container is up but on a pre–invite-keys build
(or invite-keys never registered).

## Fix summary

1. Register invite-keys on the **root** Fastify `app` with `{ preHandler: requireAdmin }`
   (do not use nested `app.register` for these routes).
2. Add `PATCH /api/access/invite-keys/:id` + `updateInviteKey`.
3. Health: `{ features: { inviteKeys: true }, revision }`.
4. Deploy probe must **fail** if unauthenticated GET invite-keys returns 404 (expect 401).
5. Dockerfile `ARG/ENV GIT_SHA` + build-arg in workflow.

## Files to copy from this scaffold (after applying the patch below)

Canonical patched sources live next to this file once synced from the agent branch
`cursor/invite-keys-routes-fix-dd18` (local commit if push to polyrepo is denied):

- `src/api/access.ts`
- `src/access/inviteKeys.ts`
- `src/contracts/portal-access.ts`
- `Dockerfile`
- `.github/workflows/permissions-image.yml`

Or apply `invite-keys-routes-and-deploy-probe.patch` with:

```bash
cd prism-permissions-service
git apply ../prism/scaffold/prism-permissions-service/patches/invite-keys-routes-and-deploy-probe.patch
```

## Verify after deploy

```bash
curl -s https://prism.rebus.industries/api/access/health
# expect: "features":{"inviteKeys":true}

curl -s https://prism.rebus.industries/api/access/invite-keys
# expect: {"error":"Unauthorized"}  — NOT Route … not found
```
