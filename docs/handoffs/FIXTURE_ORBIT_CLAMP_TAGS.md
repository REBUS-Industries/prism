# Handoff — Orbit clamp tags + connector with/without clamps

**Repos**
- `REBUS-Industries/prism-fixtures-service` — stamp clamps on Orbit publish  
  Patch: `fixture-orbit-clamp-tags.patch` (this folder) · also  
  `scaffold/prism-fixtures-service/patches/fixtures-orbit-clamp-tags.patch`
- `REBUS-Industries/orbit-connectors` — import UI + mesh filter  
  Patch: `orbit-connectors-fixture-clamp-import.patch` /  
  `orbit-connectors/orbit-connectors-fixture-clamp-import.patch`

**This agent cannot push either polyrepo (403 for `cursor[bot]`).**

## Goal

When a fixture has clamp geometry, Orbit publish must tag those meshes so the
Rhino connector can offer:

- **With clamps** → include clamp meshes
- **Without clamps** → ignore clamp geometry

## Publish (fixtures-service)

Already stamps `partTag: "CLAMP"` on clamp meshes. This patch adds:

| Surface | Fields |
|---------|--------|
| Mesh / part collection | `isClamp: true` when `partTag === "CLAMP"` |
| Root `properties` + `FixtureType` | `hasClamps`, `clampPartIds`, `clampPartCount` |
| Docs | `fixture-assembly-and-motion.md` § clamp filter |

Clamps stay **shared** (`modeGeometryIds: []`) so every DMX mode still sees them
when “with clamps” is selected.

### Apply

```bash
cd prism-fixtures-service
git fetch origin main && git checkout main && git pull
git checkout -b cursor/fixture-orbit-clamp-tags-dd18
git apply /path/to/fixture-orbit-clamp-tags.patch
npm ci && npm run build
node dist/orbit/glbParser.test.js
node dist/orbit/fixturePublish.test.js
git push -u origin HEAD
```

Deploy **fixtures-image**. Republish fixtures that have clamps so Orbit versions
carry `isClamp` / `hasClamps`.

## Connector (orbit-connectors)

| Change | Role |
|--------|------|
| `FixtureClampHelper` | `IsClampMesh` / `MeshVisibleForClamps` / `FixtureHasClamps` |
| Import prompt UI | “With clamps” / “Without clamps” when `hasClamps` |
| `RhinoReceivePipeline` | Skip clamp meshes when `includeClamps: false` |
| Block cache / definition name | Separate `…:noclamps` variants |

### Apply

```bash
cd orbit-connectors
git fetch origin main && git checkout main && git pull
git checkout -b cursor/fixture-orbit-clamp-import-dd18
git apply /path/to/orbit-connectors-fixture-clamp-import.patch
# build / test Rhino connector per repo README
git push -u origin HEAD
```

## Verify

1. Fixture with clamps → Publish to Orbit
2. In Rhino library Place: prompt shows **Clamps** → With / Without
3. With clamps → clamp meshes present in block
4. Without clamps → body only; clamp `partTag` / `isClamp` meshes absent
5. Block cache: placing both variants does not reuse the wrong definition

## Companion

Pairs with multi-clamp editor work (`cursor/fixture-multi-clamp-dd18` / PR #306)
and `ensureClampSlot` multi-part sync (`FIXTURE_MULTI_CLAMP.md`).
