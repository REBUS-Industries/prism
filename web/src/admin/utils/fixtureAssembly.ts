/**
 * Build a full GDTF fixture assembly as a Three.js group by walking the parsed
 * geometry tree, loading every linked model's GLB and applying the composed
 * parent→child transforms. Mirrors how the GDTF-Share fixture builder stacks
 * Base → Yoke → Head → Beam into the complete fixture.
 *
 * GDTF facts honoured here:
 *  - Geometry `Position` is a 4x4 transform (metres) relative to the parent;
 *    the parser normalises it to a THREE row-major `matrix4x4`.
 *  - Each Model's GLB is the geometry of THAT part only, authored in metres at
 *    the geometry origin — so placing it at the node's world transform assembles
 *    the fixture with no extra per-model offset.
 *  - GeometryReference nodes re-instance another geometry subtree at a new
 *    transform (e.g. repeated connectors).
 *  - GDTF is Z-up; the result root is rotated so it stands upright in Three's
 *    Y-up world (base at the bottom, beam pointing up).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { FixturePart, FixtureModel } from '../../shared/api';

export interface FixtureAssemblyInput {
  parts: FixturePart[];
  models: FixtureModel[];
  /** Resolve a fixture_media id to a same-origin GLB URL. */
  resolveUrl: (mediaId: string) => string;
}

export interface FixtureAssemblyResult {
  /** Up-axis-corrected group, ready to add to the scene. */
  root: THREE.Group;
  /** Number of model meshes actually placed. */
  meshCount: number;
}

function modelMediaId(model: FixtureModel | undefined): string | null {
  const id = (model?.metadata as { mediaId?: unknown } | undefined)?.mediaId;
  return typeof id === 'string' && id ? id : null;
}

function partMeta(part: FixturePart): { isGeometryReference?: boolean; referencedGeometryId?: string } {
  return (part.metadata ?? {}) as { isGeometryReference?: boolean; referencedGeometryId?: string };
}

function applyPartTransform(group: THREE.Object3D, part: FixturePart): void {
  const t = part.localTransform;
  const m = new THREE.Matrix4();
  const a = t?.matrix4x4;
  if (Array.isArray(a) && a.length === 16) {
    m.set(
      a[0], a[1], a[2], a[3],
      a[4], a[5], a[6], a[7],
      a[8], a[9], a[10], a[11],
      a[12], a[13], a[14], a[15],
    );
  } else if (t?.position) {
    const r = t.rotation ?? { x: 0, y: 0, z: 0 };
    m.makeRotationFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(r.x),
      THREE.MathUtils.degToRad(r.y),
      THREE.MathUtils.degToRad(r.z),
      'XYZ',
    ));
    m.setPosition(t.position.x, t.position.y, t.position.z);
  }
  m.decompose(group.position, group.quaternion, group.scale);
}

/** Deep-dispose geometries/materials of an assembled group (GPU cleanup). */
export function disposeAssembly(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
    else if (mat) mat.dispose();
  });
}

export async function buildFixtureAssembly(
  input: FixtureAssemblyInput,
): Promise<FixtureAssemblyResult> {
  const { parts, models } = input;
  const modelById = new Map(models.map((mm) => [mm.modelId, mm]));
  const loader = new GLTFLoader();

  // Load each GLB once; reuse across parts (and GeometryReference) via clone.
  const glbCache = new Map<string, Promise<THREE.Object3D | null>>();
  const loadGlb = (mediaId: string): Promise<THREE.Object3D | null> => {
    let p = glbCache.get(mediaId);
    if (!p) {
      p = loader.loadAsync(input.resolveUrl(mediaId))
        .then((g) => g.scene as THREE.Object3D)
        .catch(() => null);
      glbCache.set(mediaId, p);
    }
    return p;
  };

  // A group per part, transform applied, parented per the geometry tree.
  const partGroups = new Map<string, THREE.Group>();
  const byGeometryId = new Map<string, FixturePart>();
  for (const part of parts) {
    if (part.sourceGdtfGeometryId) byGeometryId.set(part.sourceGdtfGeometryId, part);
    const g = new THREE.Group();
    g.name = part.name ?? part.partId;
    applyPartTransform(g, part);
    partGroups.set(part.partId, g);
  }

  const contentRoot = new THREE.Group(); // GDTF (Z-up) space
  for (const part of parts) {
    const g = partGroups.get(part.partId)!;
    const parent = part.parentPartId ? partGroups.get(part.parentPartId) : null;
    (parent ?? contentRoot).add(g);
  }

  // Attach each part's own model GLB.
  let meshCount = 0;
  await Promise.all(parts.map(async (part) => {
    if (partMeta(part).isGeometryReference) return;
    const model = part.modelId ? modelById.get(part.modelId) : undefined;
    const mediaId = modelMediaId(model);
    if (!mediaId) return;
    const obj = await loadGlb(mediaId);
    if (!obj) return;
    partGroups.get(part.partId)!.add(obj.clone(true));
    meshCount += 1;
  }));

  // Resolve GeometryReference nodes by cloning the referenced subtree.
  for (const part of parts) {
    const meta = partMeta(part);
    if (!meta.isGeometryReference || !meta.referencedGeometryId) continue;
    const target = byGeometryId.get(meta.referencedGeometryId);
    const targetGroup = target ? partGroups.get(target.partId) : null;
    if (!targetGroup) continue;
    const clone = targetGroup.clone(true);
    // The reference node already carries the placement transform; neutralise the
    // cloned subtree root's own local transform so it inherits the ref's.
    clone.position.set(0, 0, 0);
    clone.quaternion.identity();
    clone.scale.set(1, 1, 1);
    partGroups.get(part.partId)!.add(clone);
    clone.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshCount += 1; });
  }

  // GDTF Z-up → Three Y-up (upright, base at the bottom).
  const root = new THREE.Group();
  root.rotation.x = Math.PI / 2;
  root.add(contentRoot);
  root.updateMatrixWorld(true);
  return { root, meshCount };
}
