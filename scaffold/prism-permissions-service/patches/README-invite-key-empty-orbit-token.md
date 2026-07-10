# Fix: invite-key login returns empty orbitToken

## Symptom

Lite connector accepts a minted invite key, then fails because the PRISM
manifest has `orbitToken: ""`.

## Root cause

`apiTokenCreate` on Orbit prod rejects the mint mutation PRISM was sending:

1. **`userId` is not a field** on `ApiTokenCreateInput` (only `name`, `scopes`,
   `lifespan`, `limitResources`)
2. **`limitResources[].type` must be `"project"`** (enum), not `"Project"`

Mint always failed. Portal / full-connector login still worked because it falls
back to the admin PAT. Invite keys set `forbidAdminFallback: true`, then
returned **HTTP 200 with an empty token**.

## Fix

Apply `invite-key-orbit-mint-empty-token.patch` (or copy
`invite-key-orbit-mint-src/*`) on `prism-permissions-service`, merge to `main`,
redeploy `permissions-image`.

- Mint mutation matches Orbit schema (no `userId`, `type: "project"`)
- Invite-key sessions return **503** if mint fails (never empty `orbitToken`)
- **Portal / full-connector path unchanged** — admin fallback still allowed

## Verify

```bash
# After redeploy, redeem an invite key (admin cookie not required):
curl -s -X POST https://prism.rebus.industries/api/access/session \
  -H 'content-type: application/json' \
  -d '{"inviteKey":"invite_…","orbitTarget":"prod"}' | jq '.manifest.orbitToken | length'
# expect: > 0  (not 0 / empty string)
```
