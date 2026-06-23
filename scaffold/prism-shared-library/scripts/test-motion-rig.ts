import assert from 'node:assert/strict';
import {
  axisVectorForMotionType,
  buildOrbitMotionSummary,
  effectiveMotionAxisType,
  normalizeMotionRigForOrbit,
} from '../src/orbit/motionRig.js';
import type { FixturePart, MotionAxis } from '../src/contracts/fixtures.js';

const yokeId = 'ac3c50df-b46f-4d9e-9fa7-b9cf1ec469ab';
const headId = 'b2de8d96-5fb0-416f-82f3-69654248c30f';

const parts: FixturePart[] = [
  {
    partId: yokeId,
    name: 'Yoke',
    tag: 'YOKE',
    childPartIds: [headId],
    dmxLinks: [],
    metadata: {},
    localTransform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      matrix4x4: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  },
  {
    partId: headId,
    name: 'Head',
    tag: 'HEAD',
    parentPartId: yokeId,
    childPartIds: [],
    dmxLinks: [],
    metadata: {},
    localTransform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      matrix4x4: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  },
];

const rawRig: MotionAxis[] = [
  {
    motionAxisId: '5171a915-9ddb-4136-8ad2-ae13a146d8b0',
    sourceGdtfGeometryId: 'Yoke',
    controlledPartId: yokeId,
    axisType: 'OTHER',
    axisVector: { x: 0, y: 0, z: 1 },
    pivot: { x: 0, y: 0, z: 0 },
    minValue: -270,
    maxValue: 270,
    defaultValue: 0,
    dmxLinks: [],
  },
  {
    motionAxisId: '0690819d-1b27-4ca2-bd91-1bdee47413f0',
    sourceGdtfGeometryId: 'Head',
    controlledPartId: headId,
    axisType: 'OTHER',
    axisVector: { x: 0, y: 0, z: 1 },
    pivot: { x: 0, y: 0, z: 0 },
    minValue: -270,
    maxValue: 270,
    defaultValue: 0,
    dmxLinks: [],
  },
];

assert.equal(effectiveMotionAxisType(rawRig[0], parts), 'PAN');
assert.equal(effectiveMotionAxisType(rawRig[1], parts), 'TILT');

const normalised = normalizeMotionRigForOrbit(rawRig, parts);
assert.equal(normalised[0].axisType, 'PAN');
assert.equal(normalised[1].axisType, 'TILT');
assert.deepEqual(normalised[0].axisVector, axisVectorForMotionType('PAN'));
assert.deepEqual(normalised[1].axisVector, axisVectorForMotionType('TILT'));
assert.equal(normalised[0].controlledPartTag, 'YOKE');
assert.equal(normalised[1].controlledPartTag, 'HEAD');

const summary = buildOrbitMotionSummary(normalised);
assert.equal(summary.length, 2);
assert.equal(summary[0].axisType, 'PAN');
assert.equal(summary[1].axisType, 'TILT');

console.log('motionRig normalisation: ok');
