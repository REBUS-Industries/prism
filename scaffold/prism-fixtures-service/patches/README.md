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
