# Handoff: Orbit deletions → Prism model library prune

## Problem
Models deleted in the Orbit Model Library project still appeared in `#/models` because:
1. Admin **Sync from Orbit** did not pass `?prune=1`
2. Even with prune, only `importSource === 'orbit-connector'` rows were soft-deleted — Prism/Meshy imports with an Orbit ref were kept

## Fix (prism-models-service)
**cursor[bot] cannot push this repo** — apply the patch from a machine with write access:

```bash
cd prism-models-service
git checkout main && git pull
git checkout -b cursor/model-orbit-prune-deletes-dd18
git apply ../prism/scaffold/prism-models-service/patches/orbit-prune-deletes.patch
# or copy mirrored files from scaffold/prism-models-service/src/import/
npm test
git add -A && git commit -m "fix: prune Orbit-deleted models from Prism library"
git push -u origin HEAD
gh pr create --base main --title "fix: prune Orbit-deleted models from Prism library" \
  --body "See docs/handoffs/MODEL_ORBIT_PRUNE_DELETES.md in prism monorepo."
```

Behaviour change: `planOrbitSync({ prune: true })` soft-deletes **any** non-deleted row linked to a missing Orbit modelId for the Model Library project (not only `orbit-connector`). Rows without an Orbit ref are never pruned.

Mirrored sources: `scaffold/prism-models-service/src/import/orbitSync.ts` (+ test + orbitConfig).
Patch: `scaffold/prism-models-service/patches/orbit-prune-deletes.patch`.

## Fix (prism monorepo)
- `Models.vue` calls `syncFromOrbit({ prune: true })`
- Compose sets `ORBIT_SYNC_PRUNE=1` for the background poller
- Docs updated in `docs/MODEL_LIBRARY.md`

## Deploy
1. Merge/deploy `prism-models-service` → `models-image` (**required** for prune of Prism/Meshy imports)
2. Merge/deploy prism `web-image` (+ compose sync so `ORBIT_SYNC_PRUNE=1` lands)
3. On `#/models`, click **Sync from Orbit** — summary should include `N removed (deleted in Orbit)`
