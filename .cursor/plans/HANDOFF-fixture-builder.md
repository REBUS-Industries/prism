# Handoff: Fixture Builder Workstream

**Branch:** `feat/fixture-builder` (REBUS-Industries/prism)
**Owned by:** Colleague PC — do NOT push this branch from the main dev machine.
**Pairs with:** `feat/materials-editor` (separate dev) · `orbit-connectors-repo` (separate repo, separate dev)

---

## 1. Workspace setup (new PC)

```powershell
# Clone the repo
git clone https://github.com/REBUS-Industries/prism.git
cd prism

# Check out this workstream's branch
git checkout feat/fixture-builder

# Install web deps
cd web
npm install
npm run dev   # local dev server at http://localhost:5173
```

Open the cloned folder in Cursor as the workspace root. The `.cursor/rules/` files auto-load context for Cursor agents.

**Prod/dev servers:**
- Dev (VM 212): https://prism-dev.rebus.industries — auto-deploys from `main` on merge
- Prod (VM 211): tag-gated — don't touch.

**Deploy this branch to dev for review** (see also `AGENT-GIT-INSTRUCTIONS.md`):
```powershell
# This workstream is web-only — web-image is usually enough
gh workflow run web-image --repo REBUS-Industries/prism --ref feat/fixture-builder

# Only if you changed server/** (unusual for this stream):
gh workflow run server-image --repo REBUS-Industries/prism --ref feat/fixture-builder
```

---

## 2. What this workstream owns

| File | Role |
|---|---|
| `web/src/admin/pages/FixtureEditor.vue` | Main fixture editor page (tabs: Overview, DMX, Parts, IES, Settings) |
| `web/src/admin/components/FixtureViewer.vue` | Three.js 3D viewport (assembly render, orbit controls, gizmo) |
| `web/src/admin/components/FixturePartProperties.vue` | Right-panel numeric property editor (position mm, rotation °, model dims) |
| `web/src/admin/components/FixturePartTree.vue` | Left-panel geometry hierarchy tree |
| `web/src/admin/components/FixtureQuadPreview.vue` | Top/Front/Side/ISO quad overview |
| `web/src/admin/components/DatumEditor.vue` | Pivot point editor |
| `web/src/admin/components/DmxModePanel.vue` | DMX tab |
| `web/src/admin/components/IesUploader.vue` | IES tab |
| `web/src/admin/utils/fixtureAssembly.ts` | Three.js scene graph builder from GDTF geometry tree |
| `web/src/admin/utils/fixtureTransform.ts` | mm↔m conversion, matrix rebuild helpers |
| `web/src/admin/pages/FixtureDebug.vue` | Debug GDTF 3D view (read-only) |

**Backend (separate repo — `prism-fixtures-service`):**
- `src/import/gdtfFixtureParser.ts` — GDTF XML → definition
- `src/import/gdtfAssetRegistrar.ts` — mesh selection (now prefers `models/gltf_high`)
- `src/import/modelEntrySelection.ts` — LOD ranking logic

Do NOT edit server/materials files; those belong to the materials-editor workstream.

---

## 3. Current state (as of `5130272` on main)

### Done
- Full GDTF geometry assembly (Base → Yoke → Head → Beam) matching GDTF-Share builder scene graph
- Pan/tilt motion: Yoke rotates on pan (GDTF Z), Head rotates on tilt (GDTF X, tracks pan via hierarchy)
- Beam wireframe overlay parented to BEAM geometry node
- Geometry property editing: position (mm), rotation (°), linked model, model dimensions — all write back to `part.localTransform` and save via `PUT /api/fixtures/:id`
- **Gumball / TransformControls** (`5130272`): click-to-select in viewport, Move/Rotate/Scale toolbar, LOCAL/WORLD space toggle, live writeback to `part.localTransform`
- High-res mesh import: `prism-fixtures-service` commit `4ac623b` now prefers `models/gltf_high` meshes — re-import fixtures to get high-res
- Pivot/datum markers in viewport (orange spheres, draggable for coarse placement)

### Known gaps / next steps (suggestions)
- Snap-to-grid while dragging gizmo
- Coordinate readout overlay (show live X/Y/Z mm while dragging)
- Add / remove geometry nodes from the tree (currently read-only hierarchy)
- Copy / paste geometry nodes
- Undo/redo for gizmo drags (currently only committed on drag-end + Save)
- Multiselect in tree + batch move
- Ground plane grid overlay in viewport

---

## 4. Key architecture notes

**GDTF coordinate system:** Z-up (fixture hangs downward). The assembly applies a single `−90° X` on the presentation root so the Three.js Y-up viewer sees the fixture correctly. All `localTransform` values stored in GDTF Z-up metres. The `fixtureTransform.ts` helpers convert mm↔m for the UI.

**TransformControls gizmo:** `FixtureViewer` accepts `editable`, `selectedPartId`, `gizmoMode`, `gizmoSpace` props and emits `selectPart` / `transformPart`. `FixtureEditor` owns the selection state and writes gizmo results back to `fixture.value.definition.parts[n].localTransform`. The assembly is NOT rebuilt mid-drag (too expensive); it rebuilds on `assemblyRevision` bump which happens after drag-end.

**Part groups:** `fixtureAssembly.ts` tags every Three.js group with `userData.partId` so the raycaster click-picker can resolve a screen click → partId.

**Save:** `PUT /api/fixtures/:id` with the full `definition` object. The whole definition serialises as JSON — no incremental patch. Always call Save after editing transforms.

---

## 5. Git workflow

```powershell
# Daily: pull latest from main into your branch to stay current
git fetch origin
git merge origin/main   # or: git rebase origin/main

# Work on feat/fixture-builder
git add .
git commit -m "feat(web): <description>"
git push

# Open a PR when a logical feature is complete
gh pr create --base main --title "feat(web): <feature>" --body "..."

# After PR merge: rebase next feature on updated main
git fetch origin
git rebase origin/main
```

**Shared-file protocol:** If you need to add types to `web/src/shared/api.ts`, coordinate with the materials-editor dev (Discord/Slack) before merging — that's the only file both streams write to. Add types in a clearly named block at the bottom and resolve conflicts before the PR merges.

---

## 6. Deploy your branch to dev for review

See `AGENT-GIT-INSTRUCTIONS.md` for full merge + deploy workflow.

```powershell
# Web/UI changes (normal for this workstream)
gh workflow run web-image --repo REBUS-Industries/prism --ref feat/fixture-builder

# Server changes only — rare on this branch; run in addition to web-image if both changed
gh workflow run server-image --repo REBUS-Industries/prism --ref feat/fixture-builder
```

Check both if unsure:
```powershell
gh run list --repo REBUS-Industries/prism --workflow=web-image --limit 3
gh run list --repo REBUS-Industries/prism --workflow=server-image --limit 3
```

If the CT 261 runner cancels (low disk / concurrency), wait 2 min and re-run. The image build usually succeeds even when deploy-dev is flaky.
