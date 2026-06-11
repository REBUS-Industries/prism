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
