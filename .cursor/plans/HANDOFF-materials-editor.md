# Handoff: Materials Editor Workstream

**Branch:** `feat/materials-editor` (REBUS-Industries/prism)
**Owned by:** Main dev machine.
**Pairs with:** `feat/fixture-builder` (colleague PC) · `orbit-connectors-repo` (separate repo, separate dev)

---

## 1. Workspace setup

The main dev machine already has the repo checked out at `D:\Documents\Claude\REBUS System\ORBIT\PRISM`.

```powershell
# Switch to this workstream's branch
cd "D:\Documents\Claude\REBUS System\ORBIT\PRISM"
git checkout feat/materials-editor

# (Already installed — skip if deps are current)
cd web; npm install
```

**If starting fresh on a new PC:**
```powershell
git clone https://github.com/REBUS-Industries/prism.git
cd prism
git checkout feat/materials-editor
cd web; npm install; npm run dev
```

---

## 2. What this workstream owns

| File | Role |
|---|---|
| `web/src/admin/pages/MaterialEditor.vue` | Main material editor page — layout, slot + param state, persistence debounce |
| `web/src/admin/components/PbrNodeGraph.vue` | Vue Flow canvas — texture nodes, output node, param nodes, palette panel |
| `web/src/admin/components/ParamNode.vue` | Addable extension blocks (clearCoat, transmission, sheen, etc.) |
| `web/src/admin/components/GlbViewer.vue` | Three.js PBR preview sphere/cube/plane |
| `web/src/admin/components/TextureNode.vue` | Individual slot node (upload, pick, per-slot params) |
| `web/src/admin/components/MaterialOutputNode.vue` | Central output node in the graph |
| `web/src/admin/components/TexturePickerModal.vue` | Library picker modal |
| `web/src/admin/components/ParamSlider.vue` | Shared drag-slider control |
| `web/src/admin/components/ParamColor.vue` | Shared colour picker control |
| `web/src/admin/components/ExternalMaterialsModal.vue` | Unified Fab + Poly Haven browse/import modal |
| `server/src/materials/` | Server-side parameter schema + slot logic |
| `server/src/external-materials/` | Provider abstraction + Poly Haven / Fab adapters |
| `server/src/api/externalMaterials.ts` | Unified `/api/external-materials/*` routes |
| `server/src/db/migrations/0010_materials_store.sql` + `0011_material_parameters.sql` | DB schema |

Do NOT edit fixture viewer / assembly files; those belong to the fixture-builder workstream.

---

## 3. Current state (as of `9f4ed58` on main)

### Done
- **Node graph** (`feat/materials-editor` starts at this state):
  - Texture slot nodes in a vertical column, wired to MaterialOutputNode
  - Drag positions persist to localStorage per material ID; Reset layout remounts Vue Flow cleanly
  - Pan mode / Select mode toggle; drag handles on node headers only
- **Param blocks (ADD BLOCK palette)**:
  - Addable: Texture UV, Alpha, Clear Coat, Transmission, IOR, Specular, Sheen, Volume, Anisotropy, Emissive Strength, Iridescence, Dispersion, Unlit
  - Displacement removed (controls already on texture slot node)
  - IOR, Volume, Dispersion, Emissive Strength show prerequisite hints
  - Each block wires to `MaterialParameters` via `onParamChange` → debounced `PUT /parameters`
- **GlbViewer** (`2821144`): upgraded to `MeshPhysicalMaterial`; all 14 extension blocks now affect the 3D preview live
- **Persistence**: `PUT /api/materials/:id/parameters` with partial patch, debounced 350 ms; full round-trip tested

### Fab marketplace import (2026-06)
- Admin **Materials** page: **Import from Fab** opens search → preview → import modal.
- Server routes: `GET /api/fab/search`, `GET /api/fab/assets/:id`, `POST /api/fab/assets/:id/import`.
- Search/preview use Fab public API on the **server** (VM 211/212). Cloudflare blocks datacenter IPs — run **FlareSolverr** on the VM (`FAB_FLARESOLVERR_URL=http://127.0.0.1:8191/v1` or Admin → External materials). Browser challenges on a PC do not replace FlareSolverr.
- Import needs `FAB_EPIC_REFRESH_TOKEN` (Epic OAuth refresh token for an account that owns the material); bearer auth does not bypass Cloudflare for search.
- See `docs/EXTERNAL_MATERIALS.md`, `infra/.env.example`, and `server/src/fab/`.
- Material presets / template library (save/load a parameter set)
- Batch-apply material to multiple fixtures at once
- Texture tiling preview toggle (show grid lines in GlbViewer at current tiling)
- Colour space indicator on texture thumbnails (sRGB vs linear)
- Search / filter in the texture picker modal
- HDRI environment selector in GlbViewer (currently uses RoomEnvironment only)
- Export improvements: include parameter JSON in the ZIP
- Drag-and-drop texture upload directly onto a slot node
- Node minimap toggle (Vue Flow minimap)

---

## 4. Key architecture notes

**Parameter flow:**
```
ParamNode / TextureNode slider
  → onParamChange({ key, value })
  → PbrNodeGraph emits 'param-change'
  → MaterialEditor: parameters.value[key] = value (reactive)
                    pendingPatch[key] = value
                    debounce 350ms → PUT /api/materials/:id/parameters
  → GlbViewer: watch(() => props.parameters, deep) → applyParameters()
```
The `parameters` ref in `MaterialEditor.vue` is the single reactive source of truth for both the graph and the viewer.

**Slot flow:**
```
TextureNode upload/pick → PbrNodeGraph emits 'assign'
  → MaterialEditor: optimistic local update + PUT /api/materials/:id/slots/:slot
  → sources computed (slot → textureApi.downloadUrl) → GlbViewer.applySources()
```

**Material/unlit swap:** `GlbViewer.ensureMaterialKind()` swaps between `MeshPhysicalMaterial` and `MeshBasicMaterial` when the `unlit` param flips. All texture maps are re-assigned after the swap.

**Param blocks:** `activeExtensions: string[]` inside `MaterialParameters` drives which `ParamNode` instances render. Adding/removing a block patches this array. The filter in `activeParamExtensions` (PbrNodeGraph) strips retired ids (`base`, `displacement`) so old stored data never resurrects dead nodes.

---

## 5. Shared-file protocol

`web/src/shared/api.ts` is shared with the fixture-builder workstream. The `MaterialParameters` interface and `DEFAULT_MATERIAL_PARAMETERS` constant are in this file.

**Convention:** Add new material-related fields at the bottom of `MaterialParameters` (inside the appropriate comment block), mirror the same default in `DEFAULT_MATERIAL_PARAMETERS`, and mirror on the server in `server/src/materials/parameters.ts`. Coordinate with the fixture-builder dev before merging any `api.ts` change — they must rebase to pick it up.

---

## 6. Git workflow

See **`AGENT-GIT-INSTRUCTIONS.md`** for daily sync, merge bot, and deploy details.

```powershell
# Stay current with main
git fetch origin
git merge origin/main

# Commit and push to your branch
git add .
git commit -m "feat(web): <description>"
git push

# Open PR when ready
gh pr create --base main --title "feat(web): <feature>" --body "..."
```

**Deploy your branch to dev:**

| Changed | Command |
|---|---|
| `web/**` only | `gh workflow run web-image --repo REBUS-Industries/prism --ref feat/materials-editor` |
| `server/**` (API, migrations, etc.) | `gh workflow run server-image --repo REBUS-Industries/prism --ref feat/materials-editor` |
| Both | Run **both** workflows; wait for both `deploy-dev` jobs |

If CT 261 runner cancels, re-trigger after 2 min. Hard-refresh prism-dev after deploy completes.
