# Handoff: Fixture preview — custom mesh scale

**Scope:** Prism admin web — fixture editor 3D preview (`FixtureViewer`, quad views).  
**Backend:** none (preview-only; Orbit publish unchanged).  
**Pairs with:** PR #274 (axis wrap), PR #275 (camera clip + reload key).

---

## Problem

Custom replaced meshes (`models[].metadata.replaced: true`) skip per-axis GDTF
L/W/H dimension fit so Orbit publish stays at authored vertex scale (`oneToOne`).

CAD exports often store vertices in **millimetres** while the glTF loader treats
values as **metres**, producing bounding boxes thousands of units across. Even
after PR #275 (dynamic iso camera near/far), the preview can show a tiny speck
or mis-sized mesh relative to the rest of the fixture.

## Fix

When a custom replaced model still has GDTF **Length / Width / Height** on its
model row, apply a **single uniform median scale** in `wrapModelMeshInternal`
(preview assembly only):

```
median = median(L/bbox.x, H/bbox.y, W/bbox.z)   // after +90° X wrap setup
```

- Preserves mesh proportions (no per-axis stretch)
- Lands mm-as-metre exports near nominal GDTF size in the editor
- Orbit `transformGlbMeshes(..., oneToOne: true)` is **unchanged**

## Files

| File | Change |
|---|---|
| `web/src/admin/utils/fixtureAssembly.ts` | `uniformMedianScaleForDims()`; apply in `oneToOne` branch |
| `docs/fixture-assembly-and-motion.md` | Document preview vs Orbit scale behaviour |

## Apply

```bash
cd prism
git checkout main && git pull
git apply docs/handoffs/fixture-preview-custom-mesh-scale.patch
cd web && npm run build
```

Or merge branch `cursor/fix-custom-mesh-preview-scale-dd18`.

## Deploy

```bash
gh workflow run web-image --repo REBUS-Industries/prism --ref main
```

## Verify

1. Open a fixture with a custom replaced mesh (Settings → Replace).
2. Quad + assembly preview should show the mesh at sensible size relative to
   other parts (not a sub-pixel dot or clipped giant).
3. **Republish to Orbit** — mesh should still match pre-change Orbit sizing
   (authored vertices, not preview median scale).
