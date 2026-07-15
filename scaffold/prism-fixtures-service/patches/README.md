# prism-fixtures-service patches

Changes to the `prism-fixtures-service` polyrepo that pair with a monorepo
(`prism`) PR but cannot be pushed from the monorepo CI identity. Apply them in
the polyrepo and merge via the normal `/prism-merge prism-fixtures-service#N`
flow so `fixtures-image` redeploys.

## fixtures-multi-clamp-ensure-slot.patch

Pairs with monorepo **multi-clamp** (`cursor/fixture-multi-clamp-dd18`): N clamp
parts with per-part `localTransform`, add/remove in Settings + Parts.

`ensureClampSlot` must keep the shared `rebus-clamp` **model** but must **not**
re-create `rebus-clamp-part` after the user deletes all clamps. Syncs
`assignedPartIds` to existing rebus clamp parts only.

Also in `docs/handoffs/FIXTURE_MULTI_CLAMP.md`.

### Apply

```bash
cd prism-fixtures-service
git fetch origin main && git checkout main && git pull
git checkout -b cursor/fixture-multi-clamp-dd18
git apply /path/to/fixtures-multi-clamp-ensure-slot.patch
npm ci && npm run build
git push -u origin HEAD
```

Deploy **fixtures-image** with monorepo `web-image`.

## fixtures-orbit-custom-mesh-appid.patch

**Critical:** (1) Orbit kept the GDTF head after Settings → Replace because mesh
`applicationId` stayed `${fixture}:${part}:0`. (2) Custom uploads were
**anisotropically squashed** into the GDTF L×W×H slot (#99/#101) instead of
staying 1:1 with uniform mm→m unit conversion.

- Stamp **mediaId** into mesh `applicationId` / `prismPartKey`
- Custom meshes: measure authored metre dims on replace; **uniform** scale only
- Stop healing custom dims back to the GDTF slot
- Translation-only meshOffset for custom (match web)
- Merge / carry-forward / PUT active-version sync for replacement media

Also in `docs/handoffs/FIXTURE_ORBIT_CUSTOM_MESH_APPID.md`.

### Apply

```bash
cd prism-fixtures-service
git fetch origin main && git checkout main && git pull
git checkout -b cursor/fix-orbit-custom-mesh-appid-dd18
git am < /path/to/fixtures-orbit-custom-mesh-appid.patch   # or: git apply
npm ci && npm run build && node dist/orbit/fixtureCustomMeshScale.test.js
git push -u origin HEAD
```

Deploy **fixtures-image** (required) with monorepo `web-image` from prism #305.

## fixtures-mesh-offset.patch

Pairs with the monorepo per-mesh offset feature (`model.metadata.meshOffset`).
The web viewer applies the offset live; this patch applies the **same** offset
when baking the Orbit mesh so the published model (and Rhino / 3rd-party
viewers) matches the PRISM GLB viewer.

- `src/orbit/fixtureTransformMatrix.ts` - add `MeshOffset`, `readMeshOffset`,
  `meshOffsetMatrixRow` (row-major Translate . Rotate XYZ, reusing
  `composeMatrixFromTrs`).
- `src/orbit/fixtureGeometryOrbit.ts` - in `buildMeshesAtMatrix`, place meshes
  at `world . meshOffsetMatrixRow(offset)` when the resolved model carries a
  `meshOffset` (matches the web composition `partWorld . offset . wrap . scale`).
- `src/orbit/fixtureTransformMatrix.test.ts` - offset read/compose assertions.

No DB migration: `meshOffset` lives in the existing `model.metadata` jsonb.

### Apply

```bash
git clone https://github.com/REBUS-Industries/prism-fixtures-service.git
cd prism-fixtures-service
git checkout -b cursor/fixture-mesh-offset-dd18
git am < /path/to/fixtures-mesh-offset.patch   # or: git apply
npm install && npm run build && node dist/orbit/fixtureTransformMatrix.test.js
git push -u origin cursor/fixture-mesh-offset-dd18
```

### Deploy ordering

Deploy `fixtures-image` (this patch) together with the monorepo `web-image` so
the editor preview and the published Orbit mesh stay in sync.

## fixtures-reset-gdtf-custom-mesh.patch

Pairs with the monorepo **Reset to GDTF** button and **1:1 custom mesh**
viewer rules.

**Note:** `POST /api/fixtures/:id/reset-gdtf` is already on `main` (PR #89).
This patch adds the **full reset** behaviour — re-parse and overwrite even when
the GDTF version row already exists, and strip custom mesh metadata.

- `importGdtfBytes` no longer short-circuits when `carryEdits: false` — forces
  a full re-parse and overwrites the working fixture + version snapshot.
- `definitionAfterGdtfReset()` strips `replaced`, `meshOffset`, `displayName`, etc.
- `registerGdtfAssets(..., { cleanModelMetadata: true })` — replace model metadata
  without spreading user flags.
- `reimportFixtureMeshes(..., carryEdits?)` — when `false`, skip
  `carryForwardEdits` and overwrite both version + fixture rows with the reset
  definition.

Apply on top of current `main` (includes reset route from PR #89).

## fixtures-flip-normals.patch

Pairs with the monorepo **Flip normals** toggle (`model.metadata.flipNormals`).
Reverses triangle winding when baking Orbit geometry so Rhino / Orbit material
display matches the PRISM viewer (equivalent to Rhino **Flip**).

- `src/orbit/fixtureTransformMatrix.ts` — `readFlipNormals`
- `src/orbit/fixtureGeometryOrbit.ts` — flip placed mesh faces when toggle is on
- `src/orbit/fixtureTransformMatrix.test.ts` — read assertions

No DB migration: `flipNormals` lives in existing `model.metadata` jsonb.

### Apply

```bash
cd prism-fixtures-service
git checkout -b cursor/fixture-flip-normals-dd18
git am < /path/to/fixtures-flip-normals.patch   # or: git apply
npm install && npm run build && node dist/orbit/fixtureTransformMatrix.test.js
git push -u origin cursor/fixture-flip-normals-dd18
```

Deploy `fixtures-image` together with monorepo `web-image`.

## fixtures-list-orbit-url.patch

Pairs with the monorepo PRISM library **on Orbit** stat and **Republish all**
button. List/detail `toSummary` previously omitted `orbitUrl`, so the admin UI
always showed **0 on Orbit** even when fixtures had
`definition.metadata.orbitFixtureRef`.

- `src/fixtures/fixtureOrbitUrl.ts` — derive `orbitUrl` from stored Orbit ref
- `src/api/fixtures.ts` — include `orbitUrl` and `previewUrl` on list/detail rows

### Apply

```bash
cd prism-fixtures-service
git checkout -b cursor/fixture-list-orbit-url-dd18
git am < /path/to/fixtures-list-orbit-url.patch   # or: git apply
npm install && npm run build && node dist/fixtures/fixtureOrbitUrl.test.js
git push -u origin cursor/fixture-list-orbit-url-dd18
```

Deploy `fixtures-image` before or with monorepo `web-image` so the library stat
is correct on load.

## fixtures-list-custom-mesh-flag.patch

Pairs with the PRISM Library row icons for **custom mesh** and **IES profiles**
(`hasCustomMeshes` / `hasIesProfiles` on `GET /api/fixtures` list/detail summaries).

- `src/fixtures/fixtureCustomMesh.ts` — `fixtureHasCustomMeshes(definition)` (`metadata.replaced`)
- `src/fixtures/fixtureIesProfiles.ts` — `fixtureHasIesProfiles(definition)` (beam IES uploads)
- `src/api/fixtures.ts` — include both flags in `toSummary`

Deploy `fixtures-image` with monorepo `web-image`. Without the API fields, the web
UI falls back to batched detail fetches to detect custom meshes and IES profiles.

### Apply

```bash
cd prism-fixtures-service
git fetch origin main && git checkout main && git pull
git checkout -b cursor/fixture-list-custom-mesh-flag-dd18
git apply /path/to/fixtures-list-custom-mesh-flag.patch
npm ci && npm run build && node dist/fixtures/fixtureCustomMesh.test.js && node dist/fixtures/fixtureIesProfiles.test.js
git push -u origin cursor/fixture-list-custom-mesh-flag-dd18
```

### Apply

```bash
cd prism-fixtures-service
git fetch origin main && git checkout main && git pull
git checkout -b cursor/fixture-reset-gdtf-custom-mesh-dd18
git apply /path/to/fixtures-reset-gdtf-custom-mesh.patch
npm ci && npm run build
git push -u origin cursor/fixture-reset-gdtf-custom-mesh-dd18
```

Open PR and merge, then:

```bash
gh workflow run fixtures-image --repo REBUS-Industries/prism-fixtures-service --ref main
```

**Required for Reset to GDTF** on uploaded/manual fixtures (without this route, `POST /api/fixtures/:id/reset-gdtf` returns **404**).
