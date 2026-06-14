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
import {
  REBUS_CLAMP_PART_ID,
  type ClampPlacement,
} from './fixturePlacement';

/** Minimal motion axis descriptor passed from FixtureDefinition.motionRig. */
interface MotionAxisRef {
  axisType: string;
  controlledPartId?: string | null;
}

export interface FixtureAssemblyInput {
  parts: FixturePart[];
  models: FixtureModel[];
  /** Resolve a fixture_media id to a same-origin GLB URL. */
  resolveUrl: (mediaId: string) => string;
  /**
   * Optional motion rig entries. When provided, buildFixtureAssembly will
   * return panNode / tiltNode references for FixtureViewer to use instead of
   * the legacy whole-assembly panGroup/tiltGroup wrappers.
   */
  motionAxes?: MotionAxisRef[];
  /**
   * GDTF geometry name of the DMX mode root to render. Multi-mode fixtures ship
   * one top-level geometry per mode (e.g. "Base Yoke M1".."M6"); rendering all
   * of them stacks every mode at once. When set, only the matching top-level
   * geometry subtree is rendered — sibling mode roots and shared library
   * geometries stay built so GeometryReferences still resolve, but they are not
   * placed in the scene standalone. Falls back to rendering all top-level
   * geometries when null or when no top-level part matches the id.
   */
  selectedModeGeometryId?: string | null;
  /**
   * REBUS materials (built Three.js materials) keyed by material id. When a part
   * has a resolved `materialId`, its own mesh is painted with this material.
   */
  materialsById?: Map<string, THREE.Material>;
  /**
   * Metres to lower the fixture body (GDTF Z-up) while keeping CLAMP and ORIGIN
   * at the hanging point. Positive values shift base/yoke/head/motion downward.
   */
  fixtureZOffsetM?: number;
  /** REBUS clamp mirror + Z rotation (GDTF space, through fixture origin). */
  clampPlacement?: ClampPlacement;
}

/** A reference to the Three.js object that represents a motion axis node. */
export interface MotionNode {
  obj: THREE.Object3D;
  /**
   * Rotation axis in the group's parent coordinate space (GDTF Z-up).
   * PAN = {0,0,1} (GDTF vertical Z); TILT = {1,0,0} (GDTF horizontal X,
   * which automatically tracks the yoke pan via the parent-child hierarchy).
   */
  axis: THREE.Vector3;
  /** Quaternion at rest pose (before any pan/tilt is applied). */
  restQuaternion: THREE.Quaternion;
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
  /**
   * The geometry node that drives pan (typically Yoke). Rotate this around
   * its axis to pan the fixture; Base stays static.
   */
  panNode?: MotionNode;
  /**
   * The geometry node that drives tilt (typically Head). Rotate this around
   * its axis to tilt the fixture; Base and Yoke stay static. The tilt axis
   * automatically tracks the current pan angle because Head is a child of Yoke
   * in the Three.js hierarchy.
   */
  tiltNode?: MotionNode;
  /** BEAM geometry node when present — preferred attach point for beam viz. */
  beamPart?: THREE.Object3D;
  /**
   * Map of partId → the Three.js group that carries that part's GDTF local
   * transform. Used by the editor to attach a transform gizmo to a selected
   * part and to resolve raycast hits back to a partId. The group's local
   * position/quaternion/scale ARE the part's GDTF transform (Z-up, metres),
   * so reading them back after a gizmo edit yields the new GDTF transform.
   */
  partGroups: Map<string, THREE.Group>;
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

function partMeta(part: FixturePart): {
  isGeometryReference?: boolean;
  referencedGeometryId?: string;
  rebusSlot?: boolean;
  isGeometryTemplate?: boolean;
} {
  return (part.metadata ?? {}) as {
    isGeometryReference?: boolean;
    referencedGeometryId?: string;
    rebusSlot?: boolean;
    isGeometryTemplate?: boolean;
  };
}

function isRebusClampPart(part: FixturePart): boolean {
  return part.partId === REBUS_CLAMP_PART_ID
    || (part.tag === 'CLAMP' && partMeta(part).rebusSlot === true);
}

/** Place one or two (Y-mirrored) clamp meshes, rotated around GDTF Z at the origin. */
function attachClampMeshes(
  partGroup: THREE.Group,
  mesh: THREE.Object3D,
  placement: ClampPlacement,
): number {
  const rig = new THREE.Group();
  rig.name = 'ClampRig';
  rig.rotation.z = THREE.MathUtils.degToRad(placement.rotateZDeg);
  partGroup.add(rig);

  const primary = mesh.clone(true);
  primary.name = 'Clamp';
  rig.add(primary);
  let count = 1;

  if (placement.mirrorY) {
    const mirrored = mesh.clone(true);
    mirrored.name = 'ClampMirror';
    mirrored.scale.y *= -1;
    rig.add(mirrored);
    count += 1;
  }
  return count;
}

/** Apply the GDTF geometry Position matrix directly (Z-up, metres). */
export function applyPartTransform(group: THREE.Object3D, part: FixturePart): void {
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
 * After +90° X: mesh local Y → world Z, local Z → world −Y. Builder scale
 * mapping (verified on Rivale Profile Base): x = length/bbox.x,
 * y = height/bbox.y, z = width/bbox.z.
 *
 * The mesh is placed at its own authored origin — both GDTF model files and
 * uploaded replacements are trusted to carry the correct geometry origin (we no
 * longer derive a bounding-box centre, which random sticking-out geometry threw
 * off; alignment is handled at import time / in the source 3D file instead).
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
    // Tag so raycast hits can be resolved to a partId (picking) and so the
    // editor can attach a gizmo to the selected part's group.
    g.userData.partId = part.partId;
    applyPartTransform(g, part);
    partGroups.set(part.partId, g);
  }

  const contentRoot = new THREE.Group();
  contentRoot.name = 'Fixture';
  const zDrop = input.fixtureZOffsetM ?? 0;
  const bodyRoot = new THREE.Group();
  bodyRoot.name = 'BodyOffset';
  if (zDrop > 0) bodyRoot.position.z = -zDrop;
  contentRoot.add(bodyRoot);

  const hangsAtOrigin = (tag: string): boolean => tag === 'CLAMP' || tag === 'ORIGIN';

  // When a DMX mode root is selected, only that top-level geometry subtree is
  // placed in the scene. Other top-level geometries (sibling mode roots, shared
  // library geometries) remain in partGroups so GeometryReferences inside the
  // selected subtree still clone correctly — they just don't render standalone.
  const selectedRoot = input.selectedModeGeometryId ?? null;
  const hasSelectedRoot = selectedRoot != null
    && parts.some((p) => !p.parentPartId && p.sourceGdtfGeometryId === selectedRoot);
  for (const part of parts) {
    const g = partGroups.get(part.partId)!;
    const parent = part.parentPartId ? partGroups.get(part.parentPartId) : null;
    if (parent) {
      parent.add(g);
      continue;
    }
    if (partMeta(part).isGeometryTemplate) continue;
    if (hasSelectedRoot && !hangsAtOrigin(part.tag) && part.sourceGdtfGeometryId !== selectedRoot) continue;
    (hangsAtOrigin(part.tag) ? contentRoot : bodyRoot).add(g);
  }

  let meshCount = 0;

  // Paint a part's own mesh with its assigned REBUS material (by tag/materialId).
  const paintMaterial = (obj: THREE.Object3D, part: FixturePart): void => {
    const mat = part.materialId ? input.materialsById?.get(part.materialId) : undefined;
    if (!mat) return;
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.material = mat;
    });
  };

  await Promise.all(parts.map(async (part) => {
    if (partMeta(part).isGeometryReference) return;

    const model = part.modelId ? modelById.get(part.modelId) : undefined;
    const dims = modelDims(model);
    const mediaId = modelMediaId(model);
    const partGroup = partGroups.get(part.partId)!;

    if (mediaId) {
      const obj = await loadGlb(mediaId);
      if (obj) {
        const wrapped = wrapModelMesh(obj.clone(true), dims);
        paintMaterial(wrapped, part);
        if (isRebusClampPart(part)) {
          const placement = input.clampPlacement ?? { mirrorY: false, rotateZDeg: 0 };
          meshCount += attachClampMeshes(partGroup, wrapped, placement);
        } else {
          partGroup.add(wrapped);
          meshCount += 1;
        }
        return;
      }
    }

    // No GLB — render a GDTF primitive (Beam cylinder, Pigtail box, etc.).
    if (model || dims.length || dims.width || dims.height) {
      const prim = buildPrimitive(dims, part);
      if (prim) {
        paintMaterial(prim, part);
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
    // Strip copied partId tags so picking inside a referenced instance resolves
    // to the reference part group (walk-up), not the cloned source part.
    clone.traverse((o) => { delete o.userData.partId; });
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

  // Resolve PAN and TILT motion nodes.
  // Strategy (first match wins):
  //   1. motionAxes entry with axisType === 'PAN'/'TILT' and a known controlledPartId
  //      (works for fixtures that name their axes "Pan"/"Tilt" explicitly)
  //   2. Part-tag fallback: tag === 'YOKE' → PAN, tag === 'HEAD' → TILT
  //      (covers the common Yoke/Head naming convention used by most GDTF files)
  // Rotation axes follow GDTF convention:
  //   PAN  → {0,0,1} (GDTF Z = vertical, standard Yoke pan axis)
  //   TILT → {1,0,0} (GDTF X = horizontal in the Yoke's local frame; tracks
  //                   pan automatically because Head is a Three.js child of Yoke)
  const makeMotionNode = (obj: THREE.Object3D, type: string): MotionNode => ({
    obj,
    axis: type === 'PAN' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0),
    restQuaternion: obj.quaternion.clone(),
  });

  const findMotionNode = (type: string): MotionNode | undefined => {
    // 1. Explicit motion rig entry
    const entry = input.motionAxes?.find(m => m.axisType === type && m.controlledPartId);
    if (entry?.controlledPartId) {
      const obj = partGroups.get(entry.controlledPartId);
      if (obj) return makeMotionNode(obj, type);
    }
    // 2. Tag-based fallback (YOKE = pan, HEAD = tilt)
    const fallbackTag = type === 'PAN' ? 'YOKE' : 'HEAD';
    const fallbackPart = parts.find(p => p.tag === fallbackTag);
    if (fallbackPart) {
      const obj = partGroups.get(fallbackPart.partId);
      if (obj) return makeMotionNode(obj, type);
    }
    return undefined;
  };

  // GDTF Beam geometry now maps to the LENS part (its model is the lens); keep
  // accepting legacy BEAM-tagged parts so the beam viz attaches either way.
  const beamTagged = parts.find((p) => p.tag === 'BEAM' || p.tag === 'LENS');
  const beamPart = beamTagged ? partGroups.get(beamTagged.partId) : undefined;

  return {
    root,
    meshCount,
    box,
    panNode: findMotionNode('PAN'),
    tiltNode: findMotionNode('TILT'),
    beamPart,
    partGroups,
  };
}
