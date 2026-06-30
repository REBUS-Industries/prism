import * as THREE from 'three';
import type { Vec3 } from '../../shared/api';

export type BboxAnchor = 'min' | 'center' | 'max';

export interface BboxAnchors {
  x: BboxAnchor;
  y: BboxAnchor;
  z: BboxAnchor;
}

/** Default: center X/Y, bottom (min Z) — stable floor plane for bases. */
export const DEFAULT_BBOX_ANCHORS: BboxAnchors = {
  x: 'center',
  y: 'center',
  z: 'min',
};

export function anchorCoord(
  box: THREE.Box3,
  axis: 'x' | 'y' | 'z',
  anchor: BboxAnchor,
): number {
  const min = box.min[axis];
  const max = box.max[axis];
  if (anchor === 'min') return min;
  if (anchor === 'max') return max;
  return (min + max) / 2;
}

/**
 * Translation-only offset (GDTF Z-up metres) that maps `custom` bbox anchors
 * onto `gdtf` bbox anchors in the part-local frame.
 */
export function alignOffset(
  gdtf: THREE.Box3,
  custom: THREE.Box3,
  anchors: BboxAnchors = DEFAULT_BBOX_ANCHORS,
): Vec3 {
  return {
    x: anchorCoord(gdtf, 'x', anchors.x) - anchorCoord(custom, 'x', anchors.x),
    y: anchorCoord(gdtf, 'y', anchors.y) - anchorCoord(custom, 'y', anchors.y),
    z: anchorCoord(gdtf, 'z', anchors.z) - anchorCoord(custom, 'z', anchors.z),
  };
}
