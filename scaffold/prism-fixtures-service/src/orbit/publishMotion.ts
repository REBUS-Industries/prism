/**
 * Reference wiring for `POST /api/fixtures/:id/publish-orbit`.
 *
 * Full checklist: `scaffold/prism-fixtures-service/PUBLISH_ORBIT_MOTION.md`
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
 */
