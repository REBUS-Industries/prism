# Fixture groups & position presets — ORBIT metadata reference

**Audience:** PRISM / ORBIT API documentation maintainers, viewer agents, and
any host that reads or writes fixture grouping or preset data on an ORBIT model.

**Canonical source:** [`orbit-connectors/docs/FIXTURE_GROUPS_POSITIONS_METADATA.md`](https://github.com/REBUS-Industries/orbit-connectors/blob/main/docs/FIXTURE_GROUPS_POSITIONS_METADATA.md)
— this copy is bundled into the PRISM server image and served at
[`/docs/fixture-groups-positions-metadata`](https://prism.rebus.industries/docs/fixture-groups-positions-metadata).

**Source of truth in code:** `RhinoConnectorMetadata.cs`, `RhinoFixtureAttributes.cs`,
`FixtureConnectorMetadataWire.cs` (Rhino connector v0.5.31+).

**Companion:** [Fixture assembly & motion](/docs/fixture-assembly-and-motion) ·
[Fixture library API guide](/docs/library-integration) ·
[OpenAPI spec](/docs)

---

## Overview

Fixture groups and position presets are **document-level metadata** that must
survive ORBIT send/receive round-trips.

| Layer | Where it lives | Purpose |
|---|---|---|
| **ORBIT wire** | Model root `properties` bag | Authoritative round-trip payload on send/receive |
| **Host local cache** | Host document string table (Rhino: `RhinoDoc.Strings`) | Fast local read/write between sessions |
| **Per-fixture stamps** | Each fixture instance `properties` / user strings | Group membership; stable identity for preset remapping |

Position presets store **pan/tilt angle maps** keyed by stable fixture identity
(`prism:applicationId`), not host object GUIDs (which change on receive).

---

## ORBIT wire properties (model root)

These keys live on the **root Collection** object's `properties` bag (alongside
existing keys like `source`, `fixtureTypeIds`, etc.).

| Property key | Type | Description |
|---|---|---|
| `orbit:fixtureGroups` | JSON string (array) | User-defined fixture groups and their members |
| `orbit:fixturePositionPresets` | JSON string (array) | Named pan/tilt snapshots for fixture sets |

Both values are **JSON arrays serialised as strings** (same pattern as other
connector metadata blobs).

### `orbit:fixtureGroups`

Array of group definitions. Members are referenced by **stable application id**,
not host object id.

```json
[
  {
    "id": "a1b2c3d4e5f6478990abcdef12345678",
    "name": "Front truss",
    "memberApplicationIds": [
      "fixture-app-id-101",
      "fixture-app-id-102"
    ]
  }
]
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Group UUID (hex, no dashes) |
| `name` | string | yes | Display name (unique per document) |
| `memberApplicationIds` | string[] | yes | `prism:applicationId` of each member fixture |

### `orbit:fixturePositionPresets`

Array of named pan/tilt presets. Each preset captures the motion-angle state of
one or more fixtures at save time.

```json
[
  {
    "id": "f9e8d7c6b5a4432109876543210fedcb",
    "name": "Home",
    "fixtures": [
      {
        "applicationId": "fixture-app-id-101",
        "motionAngles": "{\"Pan\":0,\"Tilt\":-45}"
      },
      {
        "applicationId": "fixture-app-id-102",
        "motionAngles": "{\"Pan\":15,\"Tilt\":0}"
      }
    ]
  }
]
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Preset UUID (hex, no dashes) |
| `name` | string | yes | Display name (unique per document) |
| `fixtures` | object[] | yes | Per-fixture angle snapshots |
| `fixtures[].applicationId` | string | yes | Stable fixture id (`prism:applicationId`) |
| `fixtures[].motionAngles` | string | yes | JSON object serialised as a string; keys are motion axis ids (e.g. `Pan`, `Tilt`, or multi-cell `motionAxisId` values); values are degrees |

**Notes on `motionAngles`:**

- Same format as per-instance `prism:motionAngles` (v0.5.0+ multi-axis map).
- Legacy single-cell fixtures may also carry `prism:panDegrees` / `prism:tiltDegrees`
  on instances, but presets always use the `motionAngles` map on the wire.
- On apply, the host resolves each `applicationId` to the live instance and
  re-poses geometry from the stored angle map.

---

## Per-fixture instance properties

These keys live on each **fixture instance** (`InstanceProxy` / placed block) in
its `properties` bag and round-trip with the instance.

| Property key | Type | Description |
|---|---|---|
| `prism:applicationId` | string | Stable fixture instance identity; used to remap groups/presets after receive |
| `prism:fixtureGroupId` | string | Id of the user group this fixture belongs to (matches `orbit:fixtureGroups[].id`) |
| `prism:motionAngles` | string | JSON map of axis id → degrees (current pan/tilt state) |

Related fixture instance keys (documented in
[Fixture assembly & motion](/docs/fixture-assembly-and-motion), included here
for context):

| Property key | Description |
|---|---|
| `prism:fixtureTypeId` | PRISM fixture type id |
| `prism:unitNumber` | Show unit / fixture id label |
| `prism:patchUniverse` | DMX universe |
| `prism:patchAddress` | DMX address |
| `prism:dmxMode` | Selected DMX mode name |
| `prism:panDegrees` | Legacy primary pan (degrees) |
| `prism:tiltDegrees` | Legacy primary tilt (degrees) |

---

## Host local cache (Rhino connector)

Rhino mirrors wire data into `RhinoDoc.Strings` for fast In File panel access.
Other hosts may use an equivalent local store.

| Section | Entry | Content |
|---|---|---|
| `orbit_connector` | `fixtureGroups` | `[{ "id", "name" }]` — catalog only; membership comes from `prism:fixtureGroupId` stamps |
| `orbit_connector` | `fixturePositionPresets` | Full preset array including `objectId` (local) + `applicationId` (stable) + `motionAngles` |

**Legacy migration:** reads also accept section `OrbitConnector` (v0.5.29 early
builds).

Local preset entry shape (Rhino-only superset):

```json
{
  "id": "f9e8d7c6b5a4432109876543210fedcb",
  "name": "Home",
  "fixtures": [
    {
      "objectId": "11111111-1111-1111-1111-111111111111",
      "applicationId": "fixture-app-id-101",
      "motionAngles": "{\"Pan\":0,\"Tilt\":-45}"
    }
  ]
}
```

`objectId` is the host runtime object id (Rhino GUID string). It is **not** sent
on the ORBIT wire; only `applicationId` is used for cross-session remapping.

---

## Send / receive behaviour

### Send

1. Host scans fixtures stamped with `prism:fixtureGroupId` and builds
   `orbit:fixtureGroups` (group catalog + `memberApplicationIds`).
2. Host reads local position presets and emits `orbit:fixturePositionPresets`
   using `applicationId` + `motionAngles` only.
3. Both keys are merged into the model root `properties` before upload.

### Receive

1. Host parses root `properties.orbit:fixtureGroups` and
   `properties.orbit:fixturePositionPresets`.
2. Writes catalogs to local doc string cache (`orbit_connector` section).
3. Re-stamps `prism:fixtureGroupId` on fixtures by matching
   `memberApplicationIds` → live instances via `prism:applicationId`.
4. Resolves preset `applicationId` entries to live instances for UI selection
   and apply.

---

## Notes for PRISM integrators

- Root-level `orbit:fixtureGroups` and `orbit:fixturePositionPresets` live on
  Collection `properties` — not in PRISM library fixture type definitions.
- Instance-level `prism:fixtureGroupId` is user-authored group membership on
  placed fixtures.
- `prism:applicationId` is the stable cross-version instance key (required for
  preset remapping after receive).
- `motionAngles` uses the same JSON map format as `prism:motionAngles` (see
  [Fixture assembly & motion](/docs/fixture-assembly-and-motion)).

---

## Version

| Connector version | Change |
|---|---|
| v0.5.29 | Initial fixture groups panel (local `OrbitConnector` doc strings only) |
| v0.5.31 | ORBIT wire round-trip via `orbit:fixtureGroups` / `orbit:fixturePositionPresets`; local cache moved to `orbit_connector` section |
