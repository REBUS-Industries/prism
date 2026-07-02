import * as THREE from 'three';

/** Read `model.metadata.flipNormals` (Rhino Flip equivalent for Orbit publish). */
export function readFlipNormals(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return (metadata ?? {}).flipNormals === true;
}

/** Persist or clear `model.metadata.flipNormals`. */
export function writeFlipNormals(metadata: Record<string, unknown>, flip: boolean): void {
  if (flip) metadata.flipNormals = true;
  else delete metadata.flipNormals;
}

/** Reverse triangle winding on a BufferGeometry (swap two indices per triangle). */
function flipGeometryWinding(geo: THREE.BufferGeometry): void {
  const index = geo.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      index.setX(i + 1, c);
      index.setX(i + 2, b);
    }
    index.needsUpdate = true;
  } else {
    const pos = geo.getAttribute('position');
    if (!pos || pos.count < 3) return;
    const arr = pos.array as ArrayLike<number>;
    const stride = pos.itemSize;
    for (let tri = 0; tri + 2 < pos.count; tri += 3) {
      for (let j = 0; j < stride; j++) {
        const i1 = (tri + 1) * stride + j;
        const i2 = (tri + 2) * stride + j;
        const tmp = arr[i1]!;
        (pos.array as Float32Array)[i1] = arr[i2]!;
        (pos.array as Float32Array)[i2] = tmp;
      }
    }
    pos.needsUpdate = true;
  }
  geo.computeVertexNormals();
}

/** Reverse normals on all meshes under `root` (matches Rhino Flip / Orbit user toggle). */
export function applyFlipNormals(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    flipGeometryWinding(mesh.geometry as THREE.BufferGeometry);
  });
}
