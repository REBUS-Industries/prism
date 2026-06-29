import * as THREE from 'three';
import type { Transform4x4, Vec3 } from '../../shared/api';

export const MM_PER_M = 1000;

export function metresToMm(m: number): number {
  return m * MM_PER_M;
}

export function mmToMetres(mm: number): number {
  return mm / MM_PER_M;
}

/** Rebuild row-major GDTF matrix + position/rotation from editable values. */
export function buildTransform4x4(
  position: Vec3,
  rotation: Vec3,
  scale: Vec3 = { x: 1, y: 1, z: 1 },
): Transform4x4 {
  const m = new THREE.Matrix4();
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rotation.x),
    THREE.MathUtils.degToRad(rotation.y),
    THREE.MathUtils.degToRad(rotation.z),
    'XYZ',
  );
  m.compose(
    new THREE.Vector3(position.x, position.y, position.z),
    new THREE.Quaternion().setFromEuler(euler),
    new THREE.Vector3(scale.x, scale.y, scale.z),
  );
  const e = m.elements;
  return {
    position: { ...position },
    rotation: { ...rotation },
    scale: { ...scale },
    matrix4x4: [
      e[0], e[4], e[8], e[12],
      e[1], e[5], e[9], e[13],
      e[2], e[6], e[10], e[14],
      e[3], e[7], e[11], e[15],
    ],
  };
}

export function ensureTransform(t: Transform4x4 | undefined): Transform4x4 {
  if (t?.position && t.rotation && t.scale) {
    if (Array.isArray(t.matrix4x4) && t.matrix4x4.length === 16) return t;
    return buildTransform4x4(t.position, t.rotation, t.scale);
  }
  return buildTransform4x4(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 1, z: 1 },
  );
}

/**
 * Per-mesh placement offset for a fixture model, applied on top of the part's
 * GDTF `localTransform` WITHOUT changing it (so the pan/tilt pivot is preserved).
 * `position` is GDTF Z-up metres; `rotation` is degrees (intrinsic XYZ). The
 * offset is applied identically in the web viewer (fixtureAssembly) and in the
 * Orbit publish baker so the PRISM preview matches the published mesh.
 */
export interface MeshOffset {
  position: Vec3;
  rotation: Vec3;
}

function readVec3(raw: unknown): Vec3 {
  const b = (raw ?? {}) as Record<string, unknown>;
  return {
    x: typeof b.x === 'number' ? b.x : 0,
    y: typeof b.y === 'number' ? b.y : 0,
    z: typeof b.z === 'number' ? b.z : 0,
  };
}

export function meshOffsetIsZero(offset: MeshOffset | null | undefined): boolean {
  if (!offset) return true;
  const { position: p, rotation: r } = offset;
  return p.x === 0 && p.y === 0 && p.z === 0 && r.x === 0 && r.y === 0 && r.z === 0;
}

/** Read `metadata.meshOffset`, returning null when absent or all-zero. */
export function readMeshOffset(
  metadata: Record<string, unknown> | null | undefined,
): MeshOffset | null {
  const raw = (metadata ?? {})['meshOffset'];
  if (!raw || typeof raw !== 'object') return null;
  const bag = raw as Record<string, unknown>;
  const offset: MeshOffset = {
    position: readVec3(bag.position),
    rotation: readVec3(bag.rotation),
  };
  return meshOffsetIsZero(offset) ? null : offset;
}

/** Persist (or clear, when all-zero) `metadata.meshOffset` in place. */
export function writeMeshOffset(metadata: Record<string, unknown>, offset: MeshOffset): void {
  if (meshOffsetIsZero(offset)) {
    delete metadata.meshOffset;
    return;
  }
  metadata.meshOffset = {
    position: { ...offset.position },
    rotation: { ...offset.rotation },
  };
}
