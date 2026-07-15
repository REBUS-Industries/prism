# Handoff — Orbit reuses GDTF mesh after custom replace (applicationId dedupe)

**Repo to change:** `REBUS-Industries/prism-fixtures-service`  
**Patch:** `fixture-orbit-custom-mesh-appid.patch` (this folder)  
**Companion web PR:** same branch `cursor/fix-orbit-custom-mesh-appid-dd18` on `prism`  
**This agent cannot push to `prism-fixtures-service` (403 for `cursor[bot]`).**

## Symptom

Fixture e.g. `abe7d96a-f6c4-4a21-b8dc-edfd19d0ae2c`: head + base have custom
meshes in PRISM, but **Orbit publish still shows the GDTF head** and wrong XYZ.

## Root cause (fixtures-service)

Orbit dedupes `Objects.Geometry.Mesh` by `applicationId`. Publish used stable ids:

```text
${fixtureId}:${partId}:0
```

After Settings → Replace, the custom GLB was uploaded and baked, but Orbit kept
resolving the **previous GDTF mesh object** with the same applicationId.

Secondary issues from today's dim/merge flip-flop (#95–#101):

- Stale `meshOffset` after slot-dim heal (authored-size → GDTF fit) → wrong XYZ
- Merge preferred the **entire** stored model when mediaIds differed (dropped
  client meshOffset edits)
- `carryForwardEdits` did not preserve custom replaced meshes on reimport
- PUT updated working definition only (active version could still hold GDTF media)

## Fix (in the patch)

1. Stamp **mediaId** into mesh `applicationId` / `prismPartKey`
2. Custom meshes: translation-only meshOffset (match web preview)
3. Merge: keep stored replacement **media**, keep client offsets/dims
4. Slot-dim heal: clear stale `meshOffset` / `ignoreImportedMeshDatum`
5. Carry-forward: preserve `replaced` media + offset across reimport
6. PUT: sync definition to the active version row

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

1. Open fixture with custom head/base → Republish to Orbit.
2. Orbit must show the **custom** head mesh (not GDTF), coherent XYZ with PRISM.
3. Replace one mesh again → republish → Orbit updates that part only.
4. Reimport / quality switch must keep custom replaced media.
