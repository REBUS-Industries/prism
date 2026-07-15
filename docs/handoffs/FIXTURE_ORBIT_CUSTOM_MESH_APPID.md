# Handoff — Orbit custom mesh: applicationId dedupe + 1:1 scale

**Repo to change:** `REBUS-Industries/prism-fixtures-service`  
**Patch:** `fixture-orbit-custom-mesh-appid.patch` (this folder)  
**Also:** `scaffold/prism-fixtures-service/patches/fixtures-orbit-custom-mesh-appid.patch`  
**Companion web PR:** `cursor/fix-orbit-custom-mesh-appid-dd18` on `prism` (#305)  
**This agent cannot push to `prism-fixtures-service` (403 for `cursor[bot]`).**

## Symptoms

1. Custom head/base in PRISM, but Orbit still shows the **GDTF head** (wrong mesh).
2. Custom uploads are **squashed** — height/width/depth altered to fill the GDTF
   L×W×H slot instead of staying 1:1 (uniform unit conversion only).

## Root causes

1. Orbit dedupes `Objects.Geometry.Mesh` by `applicationId`. Stable ids
   `${fixture}:${part}:0` reused the prior GDTF mesh after Settings → Replace.
2. PRs #99/#101 + web #303 forced **per-axis** fit of custom meshes into the
   GDTF slot — that anisotropically changes proportions.

## Fix (in the patch)

1. Stamp **mediaId** into mesh `applicationId` / `prismPartKey`
2. Custom meshes: **uniform** scale; measure authored metre dims on replace
   (mm→m when needed); stop restoring GDTF slot dims over custom uploads
3. Translation-only meshOffset for custom (match web)
4. Merge: keep stored replacement **media**, keep client offsets/dims
5. Carry-forward: preserve custom replaced meshes + measured dims
6. PUT: sync definition to the active version row

## Web companion (already in prism PR)

- Preview: uniform scale for `metadata.replaced` models
- Re-fetch after save so healed measured dims match publish

## Apply

```bash
cd prism-fixtures-service
git checkout main && git pull
git checkout -b cursor/fix-orbit-custom-mesh-appid-dd18
git am path/to/fixture-orbit-custom-mesh-appid.patch   # or: git apply
npm ci && npm test
git push -u origin HEAD
# open PR → merge → fixtures-image deploy
```

## Verify

1. Replace a part with a mm CAD mesh that is already correct real-world size.
2. Preview: proportions match the file (green GDTF box may not be filled).
3. Republish to Orbit: **custom** mesh (not GDTF), same proportions/XYZ as PRISM.
4. Re-replace / quality switch keeps the custom media.
