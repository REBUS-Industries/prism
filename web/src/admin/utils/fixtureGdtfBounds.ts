import * as THREE from 'three';
import type { Vec3 } from '../../shared/api';

/** Captured GDTF mesh bounds in part-local space (metres, Z-up), before custom replace. */
export interface GdtfReferenceBounds {
  min: Vec3;
  max: Vec3;
}

function readVec3(raw: unknown): Vec3 | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.x !== 'number' || typeof b.y !== 'number' || typeof b.z !== 'number') return null;
  return { x: b.x, y: b.y, z: b.z };
}

/** Read `model.metadata.gdtfBounds`; null when absent or invalid. */
export function readGdtfBounds(
  metadata: Record<string, unknown> | null | undefined,
): GdtfReferenceBounds | null {
  const raw = (metadata ?? {})['gdtfBounds'];
  if (!raw || typeof raw !== 'object') return null;
  const bag = raw as Record<string, unknown>;
  const min = readVec3(bag.min);
  const max = readVec3(bag.max);
  if (!min || !max) return null;
  if (min.x > max.x || min.y > max.y || min.z > max.z) return null;
  return { min, max };
}

export function writeGdtfBounds(
  metadata: Record<string, unknown>,
  bounds: GdtfReferenceBounds,
): void {
  metadata.gdtfBounds = {
    min: { ...bounds.min },
    max: { ...bounds.max },
  };
}

export function box3FromGdtfBounds(bounds: GdtfReferenceBounds): THREE.Box3 {
  return new THREE.Box3(
    new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
  );
}

/** Serialize a non-empty Box3 to storable bounds; null when empty. */
export function gdtfBoundsFromBox3(box: THREE.Box3): GdtfReferenceBounds | null {
  if (box.isEmpty()) return null;
  const { min, max } = box;
  return {
    min: { x: min.x, y: min.y, z: min.z },
    max: { x: max.x, y: max.y, z: max.z },
  };
}
