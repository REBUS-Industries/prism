# Handoff: Fixture Builder Workstream

**Branch:** `feat/fixture-builder` (REBUS-Industries/prism)
**Owned by:** Colleague PC â€” do NOT push this branch from the main dev machine.
**Pairs with:** `feat/materials-editor` (separate dev) Â· `orbit-connectors-repo` (separate repo, separate dev)

**Read first:** `.cursor/plans/AGENT-GIT-INSTRUCTIONS.md` â€” merge via `/prism-merge <PR#>` in #prism-dev; confirm deploy workflows finished before testing on prism.rebus.industries.

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
```

Also clone the fixtures API repo when you need backend changes:

```powershell
git clone https://github.com/REBUS-Industries/prism-fixtures-service.git
```

Open the `prism` folder in Cursor as the workspace root. The `.cursor/rules/` files auto-load context for Cursor agents.

**Server:**
- PRISM (VM 212): https://prism.rebus.industries â€” single environment, auto-deploys from `main` on merge
- VM 211 is ORBIT-only â€” don't touch.

**Deploy this branch to dev for review** (see also `AGENT-GIT-INSTRUCTIONS.md`):

```powershell
# Web/UI changes (every prism PR for this workstream)
gh workflow run web-image --repo REBUS-Industries/prism --ref feat/fixture-builder

# prism monorepo server/** â€” rare; do NOT edit (materials-editor owns server/)
gh workflow run server-image --repo REBUS-Industries/prism --ref feat/fixture-builder

# Fixtures API backend (separate repo â€” required when API/import logic changed)
gh workflow run fixtures-image --repo REBUS-Industries/prism-fixtures-service --ref <branch>
```

---

## 2. What this workstream owns

| File | Role |
|---|---|
| `web/src/admin/pages/FixtureEditor.vue` | Main fixture editor page (tabs: Overview, DMX, Parts, IES, Settings) |
| `web/src/admin/components/FixtureViewer.vue` | Three.js 3D viewport (assembly render, orbit controls, gizmo) |
| `web/src/admin/components/FixturePartProperties.vue` | Right-panel numeric property editor (position mm, rotation Â°, model dims) |
| `web/src/admin/components/FixturePartTree.vue` | Left-panel geometry hierarchy tree |
| `web/src/admin/components/FixtureQuadPreview.vue` | Top/Front/Side/ISO quad overview |
| `web/src/admin/components/DatumEditor.vue` | Pivot point editor |
| `web/src/admin/components/DmxModePanel.vue` | DMX tab |
| `web/src/admin/components/IesUploader.vue` | IES tab |
| `web/src/admin/utils/fixtureAssembly.ts` | Three.js scene graph builder from GDTF geometry tree |
| `web/src/admin/utils/fixtureTransform.ts` | mmâ†”m conversion, matrix rebuild helpers |
| `web/src/admin/pages/FixtureGdtfDebug.vue` | Debug GDTF 3D view (read-only) |

**Backend (separate repo â€” `prism-fixtures-service`):**
- `src/api/fixtures.ts`, `src/api/gdtf-share.ts` â€” fixture library REST API
- `src/import/gdtfFixtureParser.ts` â€” GDTF XML â†’ definition
- `src/import/gdtfAssetRegistrar.ts` â€” mesh registration
- `src/import/modelEntrySelection.ts` â€” LOD ranking logic

Do NOT edit `prism/server/**` or materials-editor files; those belong to the materials-editor workstream.

---

## 3. Current state (as of `5130272` on main)

### Done
- Full GDTF geometry assembly (Base â†’ Yoke â†’ Head â†’ Beam) matching GDTF-Share builder scene graph
- Pan/tilt motion: Yoke rotates on pan (GDTF Z), Head rotates on tilt (GDTF X, tracks pan via hierarchy)
- Beam wireframe overlay parented to BEAM geometry node
- Geometry property editing: position (mm), rotation (Â°), linked model, model dimensions â€” all write back to `part.localTransform` and save via `PUT /api/fixtures/:id`
- **Gumball / TransformControls** (`5130272`): click-to-select in viewport, Move/Rotate/Scale toolbar, LOCAL/WORLD space toggle, live writeback to `part.localTransform`
- High-res mesh import: `prism-fixtures-service` now prefers `models/gltf_high` meshes when no LOD preference is set
- Pivot/datum markers in viewport (orange spheres, draggable for coarse placement)
- **Model quality picker** â€” choose high/default/low glTF LOD at import; change later in editor Settings (requires `prism-fixtures-service` deployed)

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

**GDTF coordinate system:** Z-up (fixture hangs downward). The assembly applies a single `âˆ’90Â° X` on the presentation root so the Three.js Y-up viewer sees the fixture correctly. All `localTransform` values stored in GDTF Z-up metres. The `fixtureTransform.ts` helpers convert mmâ†”m for the UI.

**TransformControls gizmo:** `FixtureViewer` accepts `editable`, `selectedPartId`, `gizmoMode`, `gizmoSpace` props and emits `selectPart` / `transformPart`. `FixtureEditor` owns the selection state and writes gizmo results back to `fixture.value.definition.parts[n].localTransform`. The assembly is NOT rebuilt mid-drag (too expensive); it rebuilds on `assemblyRevision` bump which happens after drag-end.

**Part groups:** `fixtureAssembly.ts` tags every Three.js group with `userData.partId` so the raycaster click-picker can resolve a screen click â†’ partId.

**Save:** `PUT /api/fixtures/:id` with the full `definition` object. The whole definition serialises as JSON â€” no incremental patch. Always call Save after editing transforms.

**Fixture API routing:** `/api/fixtures`, `/api/gdtf-share`, `/api/mvr-import` are served by **`prism-fixtures-service`** (container `prism-fixtures` on VM 212), not `prism-server`.

---

## 5. Git workflow

```powershell
# Daily: pull latest from main into your branch to stay current
git fetch origin
git rebase origin/main

# Work on feat/fixture-builder (prism) and/or a branch in prism-fixtures-service
git add .
git commit -m "feat(web): <description>"
git push

# Open a PR when a logical feature is complete
gh pr create --base main --title "feat(web): <feature>" --body "..."

# After PR merge: rebase next feature on updated main
git fetch origin
git rebase origin/main
```

**Shared-file protocol:** If you need to add types to `web/src/shared/api.ts`, coordinate with the materials-editor dev before merging â€” add types at the end of the relevant block.

---

## 6. Deploy â€” web + fixtures API must stay in sync

See `AGENT-GIT-INSTRUCTIONS.md` for merge bot and full workflow.

| What changed | Repo | Workflow | Deploys |
|---|---|---|---|
| `web/**` only | `prism` | `web-image` | `prism-web` |
| `server/**` in prism | `prism` | `server-image` | `prism-server` (rare â€” don't edit) |
| Fixtures API / import | `prism-fixtures-service` | `fixtures-image` | `prism-fixtures` |

**Rule:** If the feature adds or changes API endpoints the UI calls, merge and deploy **both** the `prism` web PR and the `prism-fixtures-service` PR. Merging web alone leaves 404s on dev until `fixtures-image` completes.

```powershell
# Web/UI (prism)
gh workflow run web-image --repo REBUS-Industries/prism --ref feat/fixture-builder
gh run list --repo REBUS-Industries/prism --workflow=web-image --limit 3

# Fixtures API backend
gh workflow run fixtures-image --repo REBUS-Industries/prism-fixtures-service --ref <branch>
gh run list --repo REBUS-Industries/prism-fixtures-service --workflow=fixtures-image --limit 3
```

On merge to `main`, GitHub auto-runs matching workflows. After `/prism-merge`, wait for **all** triggered deploys (`web-image`, `server-image` if applicable, `fixtures-image` if backend merged) before assuming dev is up to date.

If `deploy-dev` is cancelled (flaky CT 261 runner), wait 2 min and re-trigger.

---

## 7. PR checklist (fixture builder)

- [ ] `cd web && npm run build` passes (prism)
- [ ] If `api.ts` changed: announce in team chat
- [ ] If UI calls new/changed `/api/fixtures` or `/api/gdtf-share` routes: **prism-fixtures-service PR merged + `fixtures-image` deploy-dev green**
- [ ] PR body lists how to verify on https://prism.rebus.industries
- [ ] After merge: `git fetch origin && git rebase origin/main`
