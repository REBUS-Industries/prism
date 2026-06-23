/**
 * Reference wiring for `POST /api/fixtures/:id/publish-orbit`.
 *
 * Upstream into `prism-fixtures-service` (Orbit FixtureType serialiser):
 *
 *   import {
 *     buildOrbitMotionSummary,
 *     normalizeMotionRigForOrbit,
 *   } from '@rebus-industries/prism-shared/orbit';
 *
 *   const motionRig = normalizeMotionRigForOrbit(
 *     definition.motionRig ?? [],
 *     definition.parts ?? [],
 *     definition.dmxMapping,
 *   );
 *   const motionSummary = buildOrbitMotionSummary(motionRig);
 *
 * Emit on `Orbit.Objects.Lighting.FixtureType` (top-level) and on the root
 * Collection `properties.motionRig`. Emit `motionSummary` + `motionAxisCount`
 * on the Collection only.
 *
 * Each `parts[]` row must keep `motionAxisId` linked to its rig entry.
 * Do not pass through raw GDTF `axisType: "OTHER"` with identical Z vectors
 * for pan and tilt — third-party viewers use normalised PAN/TILT + axis vectors.
 */
