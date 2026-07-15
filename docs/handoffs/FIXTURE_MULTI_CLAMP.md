# Handoff — Multi-clamp: ensureClampSlot must not force a single part

**Repo to change:** `REBUS-Industries/prism-fixtures-service`  
**Patch:** `fixture-multi-clamp-ensure-slot.patch` (this folder)  
**Also:** `scaffold/prism-fixtures-service/patches/fixtures-multi-clamp-ensure-slot.patch`  
**Companion web PR:** `cursor/fixture-multi-clamp-dd18` on `prism`  
**This agent cannot push to `prism-fixtures-service` (403 for `cursor[bot]`).**

## Why

The fixture editor now supports **N clamp instances** (`rebus-clamp-part`,
`rebus-clamp-part-2`, …). Position/rotation live on each part’s
`localTransform` (Parts panel). Users can delete every clamp.

`prepareDefinitionForServe` → `ensureClampSlot` previously **always**
re-created `rebus-clamp-part` on GET when missing. That undoes “Remove clamp”
after reload and fights multi-clamp (extra primary part comes back).

## Fix

`ensureClampSlot` only:

1. Ensures the shared `rebus-clamp` **model** row exists
2. Syncs `assignedPartIds` to whatever rebus clamp parts are present
3. Does **not** invent a clamp part when the user removed all of them

## Apply

```bash
cd prism-fixtures-service
git fetch origin main && git checkout main && git pull
git checkout -b cursor/fixture-multi-clamp-dd18
git apply /path/to/fixture-multi-clamp-ensure-slot.patch
# or: git apply scaffold/prism-fixtures-service/patches/fixtures-multi-clamp-ensure-slot.patch
npm ci && npm run build
git push -u origin HEAD
```

Deploy **fixtures-image** with monorepo **web-image** from the multi-clamp PR so
delete-all-clamps survives reload.
