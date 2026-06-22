# Fixture assembly and motion

**Audience:** portal developers, connector authors, and anyone rendering PRISM
fixture types from `GET /api/fixtures/:id` or connector export payloads.

**Canonical source:** `prism-fixtures-service/docs/fixture-assembly-and-motion.md`
— this copy is bundled into the PRISM server image and served at
[`/docs/fixture-assembly-and-motion`](https://prism.rebus.industries/docs/fixture-assembly-and-motion).

**Companion:** [Fixture library API guide](/docs/library-integration) ·
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
pull connector export JSON, or stream the assembled preview at
`GET /api/fixtures/:id/preview.glb`.

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

| Need | Endpoint |
|------|----------|
| Full definition + motion rig | `GET /api/fixtures/:id` |
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
