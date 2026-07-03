# Fixture assembly and motion

**Audience:** portal developers, connector authors, third-party viewers, Rhino
plug-in authors, and anyone rendering PRISM fixture types from the REST API,
Orbit `FixtureType` objects, or connector export payloads.

**Canonical source:** `prism-fixtures-service/docs/fixture-assembly-and-motion.md`
— this copy is bundled into the PRISM server image and served at
[`/docs/fixture-assembly-and-motion`](https://prism.rebus.industries/docs/fixture-assembly-and-motion).

**Companion:** [Fixture library API guide](/docs/library-integration) ·
[Fixture groups & position presets](/docs/fixture-groups-positions-metadata) ·
[OpenAPI spec](/docs) (`Fixture library` tag)

---

## Overview

A PRISM **fixture type** is a parsed GDTF definition stored as JSON
(`FixtureDefinition`) plus binary media (GLB meshes, IES, wheel images). The
admin UI and preview GLB assemble that definition into a Three.js scene graph
that matches the GDTF-Share fixture builder:

- Geometry node **Position** matrices applied in native **GDTF Z-up** space (metres).
- Linked model GLBs scaled to each model's declared Length / Width / Height.
- **Pan** and **tilt** driven by the motion rig (or Yoke / Head tag fallback).
- **Beams** attached at lens / emission nodes and opened along **−Z**.

The same rules apply whether you consume the definition over the REST API,
read a published Orbit `FixtureType`, pull connector export JSON, or stream
the assembled preview at `GET /api/fixtures/:id/preview.glb`.

---

## Coordinate system

| Axis | GDTF / PRISM assembly | Notes |
|------|----------------------|-------|
| **Z** | Up (vertical) | Standard GDTF fixture orientation; pan rotates around **+Z**. |
| **X** | Horizontal in the yoke frame | Tilt rotates around **+X** in the head's local space. |
| **Y** | Lateral | Completes right-handed Z-up frame. |

All `part.localTransform` values and beam positions are in **metres**. The
preview viewer keeps the assembly in GDTF Z-up (no global Y-up flip on the
fixture root).

---

## Wire model (`FixtureDefinition`)

Returned on `GET /api/fixtures/:id` inside `{ fixture: { definition } }`:

| Block | Purpose |
|-------|---------|
| `fixtureInformation` | Manufacturer, name, revision, physical props, thumbnail ref |
| `parts[]` | Geometry hierarchy — one row per GDTF geometry node |
| `models[]` | GLB assets linked to parts (`modelId`, dimensions, media id in metadata) |
| `beams[]` | Photometric beams (angles, flux, IES, parent lens / cell) |
| `motionRig[]` | Parsed motion axes (`MotionAxis`) |
| `wheels[]` | Gobo / colour wheels |
| `dmxMapping` | Modes, channels, logical functions |
| `metadata` | PRISM extensions (clamp placement, Orbit publish ref, leg height, …) |

### Part tags

Standard GDTF part tags used by PRISM:

`ORIGIN` · `CLAMP` · `BASE` · `YOKE` · `HEAD` · `LENS` · `CELL` · `BEAM`

| Tag | Typical role |
|-----|----------------|
| `CLAMP` / `ORIGIN` | Hanging point — stays at the fixture origin when body is Z-dropped |
| `BASE` | Static base body |
| `YOKE` | Pan carrier (fallback when motion rig has no explicit PAN axis) |
| `HEAD` | Tilt carrier (fallback for TILT) |
| `LENS` / `BEAM` | Beam emission attach point |
| `CELL` | Multi-instance geometry reference host (pixel / aura cells) |

Each `FixturePart` carries:

- `localTransform` — GDTF Position as `{ position, rotation, scale, matrix4x4 }`
- `parentPartId` / `childPartIds` — geometry tree
- `modelId` — optional link into `models[]`
- `materialId` — optional REBUS material assignment
- `metadata` — parser flags (`isGeometryReference`, `referencedGeometryId`, …)

---

## Assembly scene graph

High-level build order (see `buildFixtureAssembly` in the admin SPA — same
logic as preview GLB generation in `prism-fixtures-service`):

```
Fixture (content root)
├── CLAMP / ORIGIN parts (optional Model Library clamp GLB)
└── BodyOffset (optional Z drop for leg height)
    └── BASE → YOKE → HEAD → … (geometry hierarchy)
        └── GLB meshes or GDTF primitives per part
```

1. **Create a group per part** — apply `localTransform` directly from GDTF.
2. **Link parent/child** — walk `parentPartId` / `childPartIds`.
3. **Load GLBs** — resolve `models[].metadata.mediaId` via
   `GET /api/fixtures/:id/media/:mediaId` (or preview export asset URLs).
4. **Scale meshes** — fit bounding box to model Length / Width / Height (metres).
5. **Geometry references** — clone referenced geometry subtrees; compose
   reference Position **with** the template root matrix (GDTF-Share behaviour).
6. **Library geometries** — shared templates referenced by `GeometryReference`
   nodes are built but not placed standalone (only instanced through references).
7. **DMX mode filter** — when a mode root geometry id is selected, only that
   top-level subtree is placed; sibling mode roots stay out of the scene but
   remain available for reference cloning.

Output handles for consumers:

| Field | Use |
|-------|-----|
| `panNode` / `tiltNode` | Rotate for pan / tilt preview |
| `beamPart` | Attach beam cone / IES viz |
| `partGroups` | Map `partId` → transform group (editor gizmo / picking) |

### Custom mesh offset (`models[].metadata.meshOffset`)

A part's GDTF `localTransform` (e.g. a `HEAD` at Z = -153 mm) is where the
pan/tilt pivot is derived, so it must **not** move when a custom/imported mesh
is swapped in. To align an imported mesh whose authored origin differs from the
GDTF node origin, set a per-model offset instead of pre-baking the inverse
transform into the source file:

```jsonc
// FixtureModel.metadata
"meshOffset": {
  "position": { "x": 0, "y": 0, "z": 0.153 },  // GDTF Z-up metres
  "rotation": { "x": 0, "y": 0, "z": 0 }         // degrees, intrinsic XYZ
}
```

The offset is applied in the **part-local GDTF frame**, between the part world
transform and the mesh wrap/scale, identically in the editor viewer and the
Orbit publish:

```
placed = partWorld · Translate(pos) · Rotate(rotXYZ) · wrap(+90°X) · scale(L/W/H) · meshVertex
```

- Web viewer: `buildFixtureAssembly` wraps the mesh `Scene` group in a
  `MeshOffset` group (`fixtureAssembly.ts`, helpers in `fixtureTransform.ts`).
- Orbit publish: `buildMeshesAtMatrix` places meshes at
  `world · meshOffsetMatrixRow(offset)` (`prism-fixtures-service`
  `fixtureGeometryOrbit.ts` + `fixtureTransformMatrix.ts`).

Because the part `localTransform`/`pivot` is untouched, pan/tilt is unaffected.
GeometryReference instances inherit the offset (it lives on the referenced
model). Edit it in the admin editor's Parts tab → part properties → **Mesh
offset**; the offset persists in the fixture definition (no DB migration) and
publishes to Orbit so Rhino / 3rd-party viewers match the PRISM preview. Scale
is handled separately by the Model Dimensions (L/W/H) fit for **GDTF** meshes;
**custom replaced** uploads skip per-axis dimension fit. When the linked model still
has GDTF **Length / Width / Height**, the preview applies a **uniform median scale**
so mm CAD exports land near nominal fixture size without axis stretching. Orbit
publish keeps authored vertex scale (`oneToOne`). Mesh-offset **translation** only
(rotation offset is ignored for custom meshes). Custom meshes default to their file
origin; captured `gdtfBounds` and mesh offset align them inside the part frame
without moving pivots. Iso camera near/far follow the assembly bbox.
Clamp models use their own placement controls.

### Flip normals (`metadata.flipNormals`)

Some meshes import with reversed face winding so materials appear on the wrong
side in Rhino / Orbit (fixable in Rhino with the **Flip** command). In the
fixture parts editor, enable **Flip normals** on a linked model to reverse
triangle winding for that mesh only. The toggle is stored on
`model.metadata.flipNormals`, applied in the PRISM preview immediately, and
baked into the published Orbit geometry on **Republish**.

---

## Custom replaced meshes (`models[].metadata.replaced`)

When a model mesh is swapped via Settings → **Replace**, PRISM stamps
`metadata.replaced: true` (and `replacedFilename`). Those meshes keep their
authored vertex scale on Orbit publish (`oneToOne`) but the **PRISM preview**
applies a uniform median scale when GDTF L/W/H exist so CAD exports at the wrong
unit (e.g. mm vertices interpreted as metres) still frame sensibly in the editor.
Per-axis L/W/H stretch is never applied to custom uploads.

### Origin and placement (default)

Custom meshes are placed at their **file origin** (zero mesh offset) by default.
The part `localTransform`, pivot, and datums are **never** changed by a mesh
swap — pan/tilt pivots stay on the GDTF geometry nodes.

**Recommended authoring:** export the replacement mesh with its local origin at
the same physical point the GDTF mesh used (mount point / pivot). Then no offset
is needed and asymmetric geometry is handled correctly.

### GDTF reference bounds (`metadata.gdtfBounds`)

On the first replace of a GDTF-native model, PRISM captures the wrapped GDTF
mesh bounding box (part-local metres) into `model.metadata.gdtfBounds` before
the upload overwrites the media file. The editor draws this box as a **green
wireframe overlay** on the selected part so you can align by eye.

Bounding-box alignment is only a **best-fit assist** (asymmetric meshes or
extra geometry can misalign). Use **Align to GDTF bounds** in part properties
with per-axis anchors (default: center X/Y, bottom Z) when helpful, then nudge
with mesh-offset translation sliders or the gizmo.

### Viewer and Orbit

- Web viewer: `wrapModelMesh` applies +90° X, then optional **uniform median**
  scale when L/W/H exist (no per-axis stretch); optional `meshOffset.position`
  translation aligns the mesh inside the part frame. Iso camera near/far are
  derived from the assembly bounding box.
- Orbit publish: `transformGlbMeshes(..., oneToOne: true)` applies the glTF→GDTF
  wrap matrix without dimension scale; mesh-offset rotation is ignored for
  replaced models. Translation offset is baked via `meshOffsetMatrixRow`.

GDTF-native meshes still use wrap + dimension fit described above.

---

## Motion rig (`motionRig[]`)

Each `MotionAxis` row:

```json
{
  "motionAxisId": "…",
  "axisType": "PAN",
  "controlledPartId": "<partId of Yoke>",
  "axisVector": { "x": 0, "y": 0, "z": 1 },
  "pivot": { "x": 0, "y": 0, "z": 0 },
  "minValue": -270,
  "maxValue": 270,
  "defaultValue": 0,
  "realFade": 0.5,
  "realAcceleration": 0.1
}
```

`axisType` is one of `PAN` | `TILT` | `ROLL` | `SPIN` | `OTHER`.

### Resolving pan and tilt nodes

First match wins:

1. **Explicit rig** — `motionRig` entry with `axisType === 'PAN'` or `'TILT'` and
   a `controlledPartId` that exists in `parts[]`.
2. **Tag fallback** — `YOKE` → pan, `HEAD` → tilt (common GDTF naming).

### Rotation axes (preview convention)

PRISM preview uses **type-based** axes (more reliable than raw `axisVector`
from some manufacturers):

| Motion | Axis vector (GDTF space) | Behaviour |
|--------|--------------------------|-----------|
| **PAN** | `(0, 0, 1)` — vertical Z | Rotates yoke; base static |
| **TILT** | `(1, 0, 0)` — horizontal X | Rotates head; tracks pan via hierarchy |

Apply rotation as:

```
quaternion = restQuaternion × axisAngle(axis, degrees × π/180)
```

Other axis types (`ROLL`, `SPIN`, `OTHER`) use `axisVector` from the rig entry.

### DMX physical range

For pan / tilt sliders in the admin debug UI, physical min/max are read from
the active DMX mode's logical channels (`Pan` / `Tilt` attributes) when
present; otherwise the rig's `minValue` / `maxValue` are used.

---

## IES profiles and Orbit publish

Photometric `.ies` files are stored as `IES_FILE` media on the fixture
(`PUT /api/fixtures/:id/ies`) and attached to beams via:

| Field | Purpose |
|-------|---------|
| `beams[].iesAssetId` | Legacy default profile (PRISM media id) |
| `beams[].iesProfiles[]` | Zoom-keyed profiles `{ zoomDmx, iesAssetId }` (typical DMX 0 / 128 / 255) |

**PRISM-only upload is not enough for Rhino or Orbit viewers.** On
`POST /api/fixtures/:id/publish-orbit`, `prism-fixtures-service`:

1. Collects all `IES_FILE` rows for the fixture
2. Uploads each file to Orbit as a blob
3. Embeds blob refs on the published `Orbit.Objects.Lighting.FixtureType`:

```json
{
  "assets": {
    "ies": [
      {
        "mediaId": "prism-media-uuid",
        "mediaType": "IES_FILE",
        "blobId": "orbit-blob-id",
        "fileName": "profile.ies",
        "fileSize": 12345
      }
    ]
  },
  "beams": [
    {
      "beamId": "...",
      "iesProfiles": [{ "zoomDmx": 128, "iesAssetId": "prism-media-uuid" }]
    }
  ]
}
```

Connectors and viewers join `beams[].iesProfiles[].iesAssetId` →
`assets.ies[].mediaId` → `blobId` to download the file bytes from Orbit.

After changing IES in the admin editor, **republish to Orbit** (the editor
auto-republishes when the fixture was already published). Unpublished fixtures
must use **Publish to Orbit** once geometry and metadata are complete.

---

## Building pan/tilt control

The pan/tilt algorithm is **the same** for PRISM admin preview, third-party
viewers, and Rhino plug-ins. There is no separate Orbit-specific motion model —
only the **source** of `parts[]` and `motionRig[]` differs (REST definition vs
published Orbit object).

### Step 1 — Build the static scene graph

Follow [Assembly scene graph](#assembly-scene-graph) above: one transform group
per `parts[]` row, parent/child links, meshes loaded and scaled. Keep the tree
in **GDTF Z-up** (metres). The yoke must be a parent (direct or indirect) of
the head so tilt tracks pan through the hierarchy.

**Orbit:** geometry lives on `Orbit.Objects.Lighting.FixtureType` — top-level
`parts[]`, `models[]`, and mesh objects referenced from the instance definition.
Part **tags** are on `FixtureType.parts[]`, not on individual mesh objects
(meshes are keyed by `applicationId` containing the part UUID).

### Step 2 — Resolve which parts pan and tilt

First match wins for each motion type:

1. **Explicit rig** — `motionRig` entry with effective type `PAN` or `TILT` and
   a `controlledPartId` present in `parts[]`.
2. **Tag fallback** — part with `tag === 'YOKE'` → pan; `tag === 'HEAD'` → tilt.

When GDTF (or Orbit) stores `axisType: "OTHER"`, resolve the effective type
before choosing an axis vector:

| Condition | Effective type |
|-----------|----------------|
| `axisType` is `PAN` or `TILT` | use as-is |
| `controlledPartTag` or part tag is `YOKE` | `PAN` |
| `controlledPartTag` or part tag is `HEAD` | `TILT` |
| `sourceGdtfGeometryId` contains `"pan"` (case-insensitive) | `PAN` |
| `sourceGdtfGeometryId` contains `"tilt"` | `TILT` |
| otherwise | keep declared `axisType` |

Orbit rows may include `controlledPartTag` (`YOKE` / `HEAD`) even when
`axisType` is still `"OTHER"` — use it in the table above.

Cross-check: `parts[].motionAxisId` on the yoke/head row should match
`motionRig[].motionAxisId` for that axis.

### Step 3 — Choose rotation axes

For effective types `PAN` and `TILT`, **ignore** the raw `axisVector` from GDTF
(many manufacturers emit `(0,0,1)` for both). Use type-based axes:

| Effective type | Axis vector (GDTF space) | Rotates |
|----------------|--------------------------|---------|
| **PAN** | `(0, 0, 1)` | Yoke (base stays fixed) |
| **TILT** | `(1, 0, 0)` | Head (follows pan via parent chain) |

`ROLL`, `SPIN`, and other `OTHER` axes use `axisVector` from the rig entry
(normalise to unit length; default to `(0,0,1)` if zero).

### Step 4 — Apply angles

Store the part group's rest orientation after the static assembly. For each
motion axis, keyed by `motionAxisId`:

```
θ = angleDegrees[motionAxisId] ?? defaultValue
quaternion = restQuaternion × axisAngle(axis, θ × π/180)
```

Apply the quaternion to the transform group for `controlledPartId`. Angles are
**degrees** between `minValue` and `maxValue` (prefer DMX physical range from
`dmxMapping` when implementing sliders; see above).

Optional timing: `realFade` and `realAcceleration` on the rig row are GDTF
seconds for a full move — use for interpolated preview, not for static posing.

### Data sources

| Source | Where to read `parts[]` / `motionRig[]` |
|--------|------------------------------------------|
| PRISM REST API | `GET /api/fixtures/:id` → `fixture.definition` |
| Orbit published type | `Orbit.Objects.Lighting.FixtureType` object (top-level fields) |
| Orbit collection summary | Root Collection `properties.motionRig` / `motionSummary` (same rig, condensed summary) |
| Connector export | `GET /api/fixtures/export/:id` payload |

List/detail rows expose `orbitUrl` when the type has been published — open the
model in Orbit or fetch the object graph via the Orbit objects API.

---

## Orbit published fixtures

Fixture types published via `POST /api/fixtures/:id/publish-orbit` are stored in
the Orbit Fixtures project (`ORBIT_FIXTURES_PROJECT_ID`, default `0f2893eb28`) as
`Orbit.Objects.Lighting.FixtureType` plus a root Collection summary.

Third-party consumers should implement [Building pan/tilt control](#building-pantilt-control)
using `FixtureType.motionRig[]` and `FixtureType.parts[]`. The Collection
`properties.motionSummary[]` rows are a compact index (`motionAxisId`, effective
type, `controlledPartId`, `controlledPartTag`, min/max) — useful for UI labels,
not a substitute for the full rig.

### Fields present on published types

| Field | Purpose |
|-------|---------|
| `motionRig[]` | Full motion axes — drive pan/tilt from here |
| `parts[]` | Geometry hierarchy, tags, `localTransform`, `motionAxisId` |
| `controlledPartId` | Part group to rotate for this axis |
| `controlledPartTag` | Denormalised tag (`YOKE` / `HEAD`) — use for effective-type resolution |
| `motionAxisId` | Stable key for runtime angle maps |
| `minValue` / `maxValue` | Physical range (degrees) |
| `dmxLinks` | Channel linkage when populated from GDTF |
| `realFade` / `realAcceleration` | Optional move timing (seconds) |

### Publish normalisation (PRISM service)

GDTF often stores both axes as `axisType: "OTHER"` with identical Z vectors.
PRISM admin preview applies the [effective-type rules](#step-2--resolve-which-parts-pan-and-tilt) at
runtime. The publish pipeline should emit normalised `axisType` (`PAN` / `TILT`)
and axis vectors so consumers do not need to duplicate heuristics — see
`normalizeMotionRigForOrbit` in `prism-shared` / monorepo scaffold. Until a
fixture is republished, Orbit may still carry `"OTHER"`; implement Step 2 above.

---

## Beams

`FixtureBeam` rows describe photometric output. Preview attaches a wireframe
frustum at:

1. `beam.parentPartId` (lens / cell), or
2. For geometry references — the cloned **Beam** child inside the referenced
   subtree (emission along local **−Z**).

Beam opens along **−Z** in GDTF space (cone tip at the lens). Zoom channels map
to `zoomMinAngle` / `zoomMaxAngle` on the beam row.

---

## Multi-mode fixtures

GDTF fixtures often ship one top-level geometry per DMX mode (e.g. `Base Yoke
M1` … `M6`). Rendering all mode roots at once stacks every mode in the same
scene.

Pass the active mode's root geometry id (from `dmxMapping.modes[].geometry`) as
`selectedModeGeometryId` when building assembly. Only that subtree is placed;
shared library geometries remain in memory for `GeometryReference` cloning.

---

## REBUS clamp and body offset

`definition.metadata` may include:

| Key | Effect |
|-----|--------|
| `clampModelLibraryId` | Load clamp GLB from Model Library instead of fixture media |
| `clampPlacement` | `{ mirrorZ, rotateZDeg }` — mirror / rotate clamp rig at origin |
| `fixtureZOffsetM` | Lower body geometry while keeping CLAMP / ORIGIN at hang point |
| `orbitFixtureRef` | Orbit publish target after `POST …/publish-orbit` |

---

## API surfaces

| Need | Endpoint / source |
|------|-------------------|
| Full definition + motion rig | `GET /api/fixtures/:id` |
| Published Orbit type | `orbitUrl` on list/detail → Orbit model; object type `Orbit.Objects.Lighting.FixtureType` |
| Assembled preview GLB | `GET /api/fixtures/:id/preview.glb` |
| Part mesh | `GET /api/fixtures/:id/media/:mediaId` |
| Connector payload + asset URLs | `GET /api/fixtures/export/:id` |

List/detail rows also expose `previewUrl`, `orbitUrl`, and `versions[]` — see
[Library integration guide](/docs/library-integration).

---

## See also

- [FIXTURE_LIBRARY.md](https://github.com/REBUS-Industries/prism/blob/main/docs/FIXTURE_LIBRARY.md) — service architecture
- [Library integration](/docs/library-integration) — auth, scopes, portal examples
- [OpenAPI — Fixture library](/docs) — machine-readable routes and schemas
