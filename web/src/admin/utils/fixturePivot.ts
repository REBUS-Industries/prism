/**
 * Move a part's pan/tilt pivot (its `localTransform` origin) without shifting
 * the mesh or child geometry in world space.
 *
 * The fixture viewer and Orbit consumers rotate the part group about its
 * origin — that origin is the pivot. To relocate it we:
 *  1. Translate `localTransform.position` by `deltaParent` (parent space)
 *  2. Compensate `meshOffset` and direct child part positions by the inverse
 *     delta in part-local space so visuals stay put
 */
import * as THREE from 'three';
import type { FixtureDefinition, FixturePart, Vec3 } from '../../shared/api';
import {
  buildTransform4x4,
  ensureTransform,
  readMeshOffset,
  writeMeshOffset,
  type MeshOffset,
} from './fixtureTransform';

const ZERO_OFFSET: MeshOffset = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
};

function partQuaternion(part: FixturePart): THREE.Quaternion {
  const t = ensureTransform(part.localTransform);
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(t.rotation.x),
      THREE.MathUtils.degToRad(t.rotation.y),
      THREE.MathUtils.degToRad(t.rotation.z),
      'XYZ',
    ),
  );
}

/** Convert a parent-space delta into the part's local frame. */
export function parentDeltaToLocal(part: FixturePart, deltaParent: Vec3): Vec3 {
  const v = new THREE.Vector3(deltaParent.x, deltaParent.y, deltaParent.z);
  v.applyQuaternion(partQuaternion(part).invert());
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * Apply a parent-space pivot translation to `partId`, compensating mesh offset
 * and direct children so the assembly does not visually jump.
 */
export function applyPivotDelta(
  definition: FixtureDefinition,
  partId: string,
  deltaParent: Vec3,
): boolean {
  if (deltaParent.x === 0 && deltaParent.y === 0 && deltaParent.z === 0) return false;
  const part = definition.parts.find((p) => p.partId === partId);
  if (!part) return false;

  const t = ensureTransform(part.localTransform);
  const deltaLocal = parentDeltaToLocal(part, deltaParent);

  part.localTransform = buildTransform4x4(
    {
      x: t.position.x + deltaParent.x,
      y: t.position.y + deltaParent.y,
      z: t.position.z + deltaParent.z,
    },
    t.rotation,
    t.scale,
  );

  if (part.modelId) {
    const model = definition.models.find((m) => m.modelId === part.modelId);
    if (model) {
      if (!model.metadata || typeof model.metadata !== 'object') model.metadata = {};
      const meta = model.metadata as Record<string, unknown>;
      const cur = readMeshOffset(meta) ?? { ...ZERO_OFFSET, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
      writeMeshOffset(meta, {
        position: {
          x: cur.position.x - deltaLocal.x,
          y: cur.position.y - deltaLocal.y,
          z: cur.position.z - deltaLocal.z,
        },
        rotation: { ...cur.rotation },
      });
    }
  }

  for (const child of definition.parts) {
    if (child.parentPartId !== partId) continue;
    const ct = ensureTransform(child.localTransform);
    child.localTransform = buildTransform4x4(
      {
        x: ct.position.x - deltaLocal.x,
        y: ct.position.y - deltaLocal.y,
        z: ct.position.z - deltaLocal.z,
      },
      ct.rotation,
      ct.scale,
    );
  }

  // Keep MotionAxis.pivot at the group origin (rotation centre) for consumers
  // that read it — the origin moved, so the local pivot offset is zero.
  for (const axis of definition.motionRig ?? []) {
    if (axis.controlledPartId !== partId) continue;
    axis.pivot = { x: 0, y: 0, z: 0 };
  }

  return true;
}

/** Set the controlled part's pivot position (parent-space metres). */
export function setPartPivotPosition(
  definition: FixtureDefinition,
  partId: string,
  positionMetres: Vec3,
): boolean {
  const part = definition.parts.find((p) => p.partId === partId);
  if (!part) return false;
  const t = ensureTransform(part.localTransform);
  return applyPivotDelta(definition, partId, {
    x: positionMetres.x - t.position.x,
    y: positionMetres.y - t.position.y,
    z: positionMetres.z - t.position.z,
  });
}
