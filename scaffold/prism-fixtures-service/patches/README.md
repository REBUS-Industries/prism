# prism-fixtures-service patches

Changes to the `prism-fixtures-service` polyrepo that pair with a monorepo
(`prism`) PR but cannot be pushed from the monorepo CI identity. Apply them in
the polyrepo and merge via the normal `/prism-merge prism-fixtures-service#N`
flow so `fixtures-image` redeploys.

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

- `POST /api/fixtures/:id/reset-gdtf` — re-import active GDTF revision/package
  with `carryEdits: false` (discards part transforms, custom meshes, materials,
  IES, placement, display name, etc.).
- `reimportFixtureMeshes(..., carryEdits?)` — optional third arg; `false`
  skips `carryForwardEdits` for uploaded/manual fixtures.
- Orbit bake: `metadata.replaced` models skip glTF→GDTF wrap/scale; mesh-offset
  rotation is ignored (translation only), matching the web viewer.

Apply together with (or after) `fixtures-mesh-offset.patch` if that patch is
not yet on `main`.

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

### Apply

```bash
cd prism-fixtures-service
git checkout -b cursor/fixture-reset-gdtf-custom-mesh-dd18
git am < /path/to/fixtures-reset-gdtf-custom-mesh.patch   # or: git apply
npm install && npm run build
git push -u origin cursor/fixture-reset-gdtf-custom-mesh-dd18
```
