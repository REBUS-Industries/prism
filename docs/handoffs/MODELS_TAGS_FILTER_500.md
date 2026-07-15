# Handoff: fix `GET /api/models?tags=` 500

**Repo:** `REBUS-Industries/prism-models-service`  
**Patch:** `scaffold/prism-models-service/patches/models-tags-filter-500.patch`  
**Symptom:** `GET /api/models?tags=clamp&limit=100` → **500 Internal Server Error**  
**Impact:** Fixture Editor clamp picker used `Promise.all([category, tags])`; the tags 500 aborted the whole load and showed an empty list even when category=`clamp` models exist.

## Root cause

```ts
sql`${modelTypes.tags} && ${tags}::text[]`
```

Drizzle does not turn a JS `string[]` into a Postgres `text[]` with that cast. Correct pattern (same as materials/textures in prism-server):

```ts
sql`${modelTypes.tags} && ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[]`
```

## Apply

```bash
git clone https://github.com/REBUS-Industries/prism-models-service.git
cd prism-models-service
git checkout -b cursor/fix-models-tags-filter-dd18
git apply /path/to/models-tags-filter-500.patch
# or edit src/api/models.ts list handler tags branch as above
git commit -am "fix: bind tags list filter as Postgres text array"
git push -u origin HEAD
# open PR → merge → models-image deploys (or):
gh workflow run models-image --repo REBUS-Industries/prism-models-service --ref main
```

## Verify

```bash
# authenticated
curl -sS -H "Authorization: Bearer $TOKEN" \
  'https://prism.rebus.industries/api/models?tags=clamp&limit=100'
# expect 200 + models array (not 500)
```

## Web mitigation (prism PR)

Fixture Editor no longer calls `?tags=` for the clamp picker; it uses `?category=clamp` only. That unblocks the UI before this API fix ships. Re-enable tags once this is deployed if desired.

**Note:** `prism-fixtures-service` list uses the same broken `${tags}::text[]` pattern — fix there when touching fixtures tags filter.
