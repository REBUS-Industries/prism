# Publish-orbit motion rig wiring (`prism-fixtures-service`)

Wire this into the FixtureType serialiser used by `POST /api/fixtures/:id/publish-orbit`
after bumping `@rebus-industries/prism-shared` to **≥ 1.0.6**.

## Dependency

```bash
npm install @rebus-industries/prism-shared@1.0.6
```

Reference implementation (monorepo scaffold): `scaffold/prism-shared-library/src/orbit/motionRig.ts`

## Code change

In the publish-orbit handler (typically `src/orbit/publishFixtureType.ts` or similar),
**before** building the Orbit object graph:

```typescript
import {
  buildOrbitMotionSummary,
  normalizeMotionRigForOrbit,
} from '@rebus-industries/prism-shared/orbit';
import type { FixtureDefinition } from '@rebus-industries/prism-shared/contracts';

function motionPayload(definition: FixtureDefinition) {
  const motionRig = normalizeMotionRigForOrbit(
    definition.motionRig ?? [],
    definition.parts ?? [],
    definition.dmxMapping,
  );
  const motionSummary = buildOrbitMotionSummary(motionRig);
  return {
    motionRig,
    motionSummary,
    motionAxisCount: motionRig.length,
  };
}
```

## Emit on Orbit objects

| Target | Fields |
|--------|--------|
| `Orbit.Objects.Lighting.FixtureType` (top-level) | `motionRig` (full normalised array) |
| Root Collection `properties` | `motionRig`, `motionSummary`, `motionAxisCount` |

Keep existing `parts[]` rows with `motionAxisId` cross-links unchanged.

## Expected result after republish

For a typical yoke/head fixture (e.g. Ayrton Khamsin), each axis in Orbit should show:

- Yoke: `axisType: "PAN"`, `axisVector: { x: 0, y: 0, z: 1 }`, `controlledPartTag: "YOKE"`
- Head: `axisType: "TILT"`, `axisVector: { x: 1, y: 0, z: 0 }`, `controlledPartTag: "HEAD"`

Not `axisType: "OTHER"` with identical Z vectors for both.

## Deploy

```bash
gh workflow run fixtures-image --repo REBUS-Industries/prism-fixtures-service --ref <branch>
```

Republish a test fixture from the admin editor, then verify:

```bash
curl -sS "https://orbit.rebus.industries/objects/0f2893eb28/<FixtureTypeObjectId>" \
  | jq '.[0].motionRig[] | {axisType, axisVector, controlledPartTag}'
```

## Consumer docs

Pan/tilt control algorithm (unchanged): https://prism.rebus.industries/docs/fixture-assembly-and-motion
