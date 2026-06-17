# prism-models-service — tool authorization follow-up

When implementing `prism-models-service`, copy the pattern from:

- `prism-fixtures-service/src/auth/toolAuth.ts`
- Prepend `requireTool('models')` to route guards alongside `requireScope('models:*')`

The permissions service resolves grants via portal role + `tool_grant` rows.
Set `PERMISSIONS_SERVICE_URL` and `PERMISSIONS_INTERNAL_KEY` on the models container (same as prism-server).
