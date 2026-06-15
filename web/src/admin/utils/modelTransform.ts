import * as THREE from 'three';
import type { ModelTransform } from '../../shared/api';

export const DEFAULT_MODEL_TRANSFORM: ModelTransform = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};

export function ensureModelTransform(t?: ModelTransform | null): ModelTransform {
  if (!t?.position || !t.rotation || !t.scale) return { ...DEFAULT_MODEL_TRANSFORM };
  return {
    position: { ...t.position },
    rotation: { ...t.rotation },
    scale: { ...t.scale },
  };
}

export function applyModelTransform(obj: THREE.Object3D, t: ModelTransform): void {
  obj.position.set(t.position.x, t.position.y, t.position.z);
  obj.rotation.set(
    THREE.MathUtils.degToRad(t.rotation.x),
    THREE.MathUtils.degToRad(t.rotation.y),
    THREE.MathUtils.degToRad(t.rotation.z),
    'XYZ',
  );
  obj.scale.set(t.scale.x, t.scale.y, t.scale.z);
}

export function readModelTransform(obj: THREE.Object3D): ModelTransform {
  const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'XYZ');
  return {
    position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
    rotation: {
      x: THREE.MathUtils.radToDeg(e.x),
      y: THREE.MathUtils.radToDeg(e.y),
      z: THREE.MathUtils.radToDeg(e.z),
    },
    scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
  };
}

export function cloneModelTransform(t: ModelTransform): ModelTransform {
  return {
    position: { ...t.position },
    rotation: { ...t.rotation },
    scale: { ...t.scale },
  };
}

export function modelTransformKey(t: ModelTransform): string {
  const p = t.position;
  const r = t.rotation;
  const s = t.scale;
  return `${p.x},${p.y},${p.z}|${r.x},${r.y},${r.z}|${s.x},${s.y},${s.z}`;
}
