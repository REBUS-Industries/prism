/**
 * Build a full GDTF fixture assembly as a Three.js group by walking the parsed
 * geometry tree — matching the GDTF-Share fixture builder scene graph:
 *
 *  - Geometry node matrices applied directly in native GDTF Z-up space (metres).
 *  - Each linked model GLB is wrapped in a +90° X group scaled so its bounding
 *    box matches the Model's declared Length / Width / Height (metres).
 *  - Parts without a mesh file render as scaled unit primitives (box / cylinder).
 *  - A single −90° X rotation on the root presents the Z-up assembly in Three's
 *    Y-up viewer (fixture hangs downward like the builder).
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
  /** Number of model meshes / primitives actually placed. */
  meshCount: number;
  /**
   * World-space bounding box computed immediately after updateMatrixWorld
   * (before the root is re-parented into the scene graph).
   */
  box: THREE.Box3;
}

interface ModelDims {
  length?: number;
  width?: number;
  height?: number;
  primitiveType?: string;
}

const PRIMITIVE_MAT = new THREE.MeshStandardMaterial({
  color: 0x9ca3af,
  transparent: true,
  opacity: 0.55,
  metalness: 0.15,
  roughness: 0.75,
});

function modelMediaId(model: FixtureModel | undefined): string | null {
  const id = (model?.metadata as { mediaId?: unknown } | undefined)?.mediaId;
  return typeof id === 'string' && id ? id : null;
}

function modelDims(model: FixtureModel | undefined): ModelDims {
  const m = model?.metadata as Record<string, unknown> | undefined;
  return {
    length: typeof m?.length === 'number' && m.length > 0 ? m.length : undefined,
    width: typeof m?.width === 'number' && m.width > 0 ? m.width : undefined,
    height: typeof m?.height === 'number' && m.height > 0 ? m.height : undefined,
    primitiveType: typeof m?.primitiveType === 'string' ? m.primitiveType : undefined,
  };
}

function partMeta(part: FixturePart): { isGeometryReference?: boolean; referencedGeometryId?: string } {
  return (part.metadata ?? {}) as { isGeometryReference?: boolean; referencedGeometryId?: string };
}

/** Apply the GDTF geometry Position matrix directly (Z-up, metres). */
function applyPartTransform(group: THREE.Object3D, part: FixturePart): void {
  const t = part.localTransform;
  const a = t?.matrix4x4;
  if (Array.isArray(a) && a.length === 16) {
    const m = new THREE.Matrix4();
    m.set(
      a[0], a[1], a[2], a[3],
      a[4], a[5], a[6], a[7],
      a[8], a[9], a[10], a[11],
      a[12], a[13], a[14], a[15],
    );
    m.decompose(group.position, group.quaternion, group.scale);
  } else if (t?.position) {
    const r = t.rotation ?? { x: 0, y: 0, z: 0 };
    group.position.set(t.position.x, t.position.y, t.position.z);
    group.rotation.set(
      THREE.MathUtils.degToRad(r.x),
      THREE.MathUtils.degToRad(r.y),
      THREE.MathUtils.degToRad(r.z),
      'XYZ',
    );
    const s = t.scale ?? { x: 1, y: 1, z: 1 };
    group.scale.set(s.x, s.y, s.z);
  }
}

/**
 * Wrap a Y-up glTF mesh like the builder's inner `Scene` group:
 * +90° X rotation, then per-axis scale so the mesh bbox matches GDTF L×W×H.
 *
 * After +90° X: mesh local Y → world Z, local Z → world −Y.
 * Builder scale mapping (verified on Rivale Profile Base):
 *   scale.x = length / bbox.x
 *   scale.y = height / bbox.y
 *   scale.z = width  / bbox.z
 */
function wrapModelMesh(meshRoot: THREE.Object3D, dims: ModelDims): THREE.Group {
  const wrapper = new THREE.Group();
  wrapper.name = 'Scene';
  wrapper.rotation.x = Math.PI / 2;

  const bbox = new THREE.Box3().setFromObject(meshRoot);
  const size = bbox.getSize(new THREE.Vector3());
  if (
    dims.length != null && dims.width != null && dims.height != null
    && size.x > 1e-6 && size.y > 1e-6 && size.z > 1e-6
  ) {
    wrapper.scale.set(
      dims.length / size.x,
      dims.height / size.y,
      dims.width / size.z,
    );
  }

  wrapper.add(meshRoot);
  return wrapper;
}

function isCylinderPrimitive(dims: ModelDims, part: FixturePart): boolean {
  const pt = (dims.primitiveType ?? '').toLowerCase();
  if (pt.includes('cylinder') || pt.includes('beam')) return true;
  const geoType = String((part.metadata as { geometryType?: string })?.geometryType ?? '').toLowerCase();
  if (geoType.includes('beam')) return true;
  return part.tag === 'BEAM';
}

/** Unit primitive scaled to GDTF model dimensions (metres), builder-style. */
function buildPrimitive(dims: ModelDims, part: FixturePart): THREE.Group | null {
  const length = dims.length ?? 0.1;
  const width = dims.width ?? 0.1;
  const height = dims.height ?? 0.1;
  if (length <= 0 || width <= 0 || height <= 0) return null;

  const wrapper = new THREE.Group();
  wrapper.name = 'Scene';
  wrapper.rotation.x = Math.PI / 2;
  wrapper.scale.set(length, height, width);

  let mesh: THREE.Mesh;
  if (isCylinderPrimitive(dims, part)) {
    mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 24), PRIMITIVE_MAT);
  } else {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), PRIMITIVE_MAT);
  }

  wrapper.add(mesh);
  return wrapper;
}

/** Deep-dispose geometries/materials of an assembled group (GPU cleanup). */
export function disposeAssembly(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
    else if (mat && mat !== PRIMITIVE_MAT) mat.dispose();
  });
}

export async function buildFixtureAssembly(
  input: FixtureAssemblyInput,
): Promise<FixtureAssemblyResult> {
  const { parts, models } = input;
  const modelById = new Map(models.map((mm) => [mm.modelId, mm]));
  const loader = new GLTFLoader();

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

  const partGroups = new Map<string, THREE.Group>();
  const byGeometryId = new Map<string, FixturePart>();
  for (const part of parts) {
    if (part.sourceGdtfGeometryId) byGeometryId.set(part.sourceGdtfGeometryId, part);
    const g = new THREE.Group();
    g.name = part.name ?? part.partId;
    applyPartTransform(g, part);
    partGroups.set(part.partId, g);
  }

  const contentRoot = new THREE.Group();
  contentRoot.name = 'Fixture';
  for (const part of parts) {
    const g = partGroups.get(part.partId)!;
    const parent = part.parentPartId ? partGroups.get(part.parentPartId) : null;
    (parent ?? contentRoot).add(g);
  }

  let meshCount = 0;

  await Promise.all(parts.map(async (part) => {
    if (partMeta(part).isGeometryReference) return;

    const model = part.modelId ? modelById.get(part.modelId) : undefined;
    const dims = modelDims(model);
    const mediaId = modelMediaId(model);
    const partGroup = partGroups.get(part.partId)!;

    if (mediaId) {
      const obj = await loadGlb(mediaId);
      if (obj) {
        partGroup.add(wrapModelMesh(obj.clone(true), dims));
        meshCount += 1;
        return;
      }
    }

    // No GLB — render a GDTF primitive (Beam cylinder, Pigtail box, etc.).
    if (model || dims.length || dims.width || dims.height) {
      const prim = buildPrimitive(dims, part);
      if (prim) {
        partGroup.add(prim);
        meshCount += 1;
      }
    }
  }));

  for (const part of parts) {
    const meta = partMeta(part);
    if (!meta.isGeometryReference || !meta.referencedGeometryId) continue;
    const target = byGeometryId.get(meta.referencedGeometryId);
    const targetGroup = target ? partGroups.get(target.partId) : null;
    if (!targetGroup) continue;
    const clone = targetGroup.clone(true);
    clone.position.set(0, 0, 0);
    clone.quaternion.identity();
    clone.scale.set(1, 1, 1);
    partGroups.get(part.partId)!.add(clone);
    clone.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshCount += 1; });
  }

  // Present Z-up GDTF assembly in the viewer's Y-up world (single root rotation).
  const presentation = new THREE.Group();
  presentation.name = 'Presentation';
  presentation.rotation.x = -Math.PI / 2;
  presentation.add(contentRoot);

  const root = new THREE.Group();
  root.add(presentation);

  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);

  return { root, meshCount, box };
}
