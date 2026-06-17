// Same three.js instance as @speckle/viewer (r140) — not the app-wide r184 copy.
import * as THREE from '@speckle-compat/three';
import { ObjectLayers, type Viewer } from '@speckle/viewer';
import type { ResolvedTheme } from '../../shared/theme';

const HELPER_LAYER = ObjectLayers.OVERLAY;

function setOverlayLayer(obj: THREE.Object3D): void {
  obj.layers.set(HELPER_LAYER);
  obj.traverse((child) => {
    child.layers.set(HELPER_LAYER);
  });
}

function gridColors(theme: ResolvedTheme): [number, number] {
  return theme === 'dark'
    ? [0x6a6f78, 0x42454d]
    : [0x9aa3b0, 0xc8ced8];
}

/** Pick a grid cell size in model units for the loaded scene span. */
function gridStepForSpan(span: number): number {
  if (span <= 20) return 1;
  if (span <= 100) return 2;
  if (span <= 500) return 5;
  return 10;
}

function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose?.();
  });
}

/** Minimum scene span used before geometry is loaded. */
const DEFAULT_SPAN_M = 20;

/**
 * Ground grid + RGB axes at world (0, 0, 0) for the Speckle ORBIT viewer.
 * Objects render on {@link ObjectLayers.OVERLAY} so they appear in the viewer pipeline.
 */
export class OrbitWorldHelpers {
  private root = new THREE.Group();
  private grid: THREE.GridHelper | null = null;
  private axes: THREE.AxesHelper | null = null;
  private span = DEFAULT_SPAN_M;
  private attachedViewer: Viewer | null = null;

  constructor() {
    this.root.name = 'orbit-world-helpers';
    setOverlayLayer(this.root);
  }

  attach(v: Viewer): void {
    if (this.attachedViewer === v) return;
    this.detach();
    v.getRenderer().scene.add(this.root);
    v.getRenderer().enableLayers([ObjectLayers.OVERLAY], true);
    this.attachedViewer = v;
  }

  detach(): void {
    if (!this.attachedViewer) return;
    this.attachedViewer.getRenderer().scene.remove(this.root);
    this.attachedViewer = null;
  }

  dispose(): void {
    this.detach();
    this.clearChildren();
  }

  private clearChildren(): void {
    while (this.root.children.length) {
      const child = this.root.children[0];
      this.root.remove(child);
      disposeObject3D(child);
    }
    this.grid = null;
    this.axes = null;
  }

  /** Rebuild grid + axes sized to the loaded scene. Safe to call repeatedly. */
  rebuild(span: number, theme: ResolvedTheme): void {
    this.span = Math.max(span, DEFAULT_SPAN_M);
    this.clearChildren();

    const step = gridStepForSpan(this.span);
    const size = Math.max(step * 10, Math.ceil((this.span * 2) / step) * step);
    const divisions = Math.max(1, Math.round(size / step));
    const [centerLine, gridColor] = gridColors(theme);

    this.grid = new THREE.GridHelper(size, divisions, centerLine, gridColor);
    setOverlayLayer(this.grid);

    const axisLen = Math.max(this.span * 0.08, this.span * 1e-4);
    this.axes = new THREE.AxesHelper(axisLen);
    setOverlayLayer(this.axes);

    this.root.add(this.grid, this.axes);
  }

  syncTheme(theme: ResolvedTheme): void {
    if (!this.grid) {
      this.rebuild(this.span, theme);
      return;
    }
    const [centerLine, gridColor] = gridColors(theme);
    const mats = this.grid.material;
    const gridMats = Array.isArray(mats) ? mats : [mats];
    if (gridMats[0]) (gridMats[0] as THREE.LineBasicMaterial).color.setHex(centerLine);
    if (gridMats[1]) (gridMats[1] as THREE.LineBasicMaterial).color.setHex(gridColor);
  }
}

/** Scene span in model units for sizing the ground grid from loaded ORBIT geometry. */
export function sceneSpanFromViewer(v: Viewer): number {
  const box = v.getRenderer().sceneBox;
  if (!box || box.isEmpty()) return DEFAULT_SPAN_M;
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const centerDist = box.getCenter(new THREE.Vector3()).length();
  return Math.max(maxDim, centerDist + maxDim * 0.5, DEFAULT_SPAN_M);
}
