/**
 * Build a full GDTF fixture assembly as a Three.js group by walking the parsed
 * geometry tree — matching the GDTF-Share fixture builder scene graph:
 *
 *  - Geometry node matrices applied directly in native GDTF Z-up space (metres).
 *  - Each linked model GLB is wrapped in a +90° X group scaled so its bounding
 *    box matches the Model's declared Length / Width / Height (metres).
 *  - Parts without a mesh file render as scaled unit primitives (box / cylinder).
 *  - The assembly root stays in native GDTF Z-up space for the Z-up fixture viewer.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { FixturePart, FixtureModel, ModelMaterialSlot, ModelTransform } from '../../shared/api';
import { paintModelMaterialSlots, type SlotMaterialMaps } from './modelMaterialSlots';
import { applyModelTransform, ensureModelTransform } from './modelTransform';
import { isCustomReplacedModel } from './fixtureCustomMesh';
import { readFlipNormals, applyFlipNormals } from './fixtureFlipNormals';
import { readMeshOffset } from './fixtureTransform';
import { isModelLengthUnit, unitScaleToMetres } from './modelUnits';
import {
  REBUS_CLAMP_PART_ID,
  type ClampPlacement,
} from './fixturePlacement';
import { isRebusClampPart as isRebusClampPartShared } from './fixtureClamps';
import {
  collectReferencedGeometryIds,
  isLibraryGeometryPart,
} from './fixtureGeometryRefs';
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
  /**
   * @deprecated Legacy global clamp mirror/rotate — ignored. Placement is per
   * clamp part via `localTransform` (multi-clamp).
   */
  clampPlacement?: ClampPlacement;
  /**
   * Per clamp-model Model Library preview override (keyed by fixture modelId).
   * When present for a rebus clamp's model, loads this GLB instead of uploaded media.
   */
  clampLibraryByModelId?: Record<string, ClampLibraryOverride>;
  /**
   * @deprecated Use `clampLibraryByModelId`. Applied to every rebus clamp that
   * has no per-model override (legacy single-library pick).
   */
  clampModelUrl?: string;
  /**
   * @deprecated Use per-model override in `clampLibraryByModelId`.
   */
  clampMaterialSlots?: ModelMaterialSlot[];
  /** Built slot material maps for the deprecated single `clampModelUrl`. */
  clampSlotMaterialMaps?: SlotMaterialMaps;
  /**
   * @deprecated Use per-model override in `clampLibraryByModelId`.
   */
  clampModelTransform?: ModelTransform | null;
  /** @deprecated Use per-model override in `clampLibraryByModelId`. */
  clampSourceUnits?: string | null;
}

/** Model Library preview payload for one clamp model instance. */
export interface ClampLibraryOverride {
  url: string;
  transform?: ModelTransform | null;
  sourceUnits?: string | null;
  materialSlots?: ModelMaterialSlot[];
  slotMaterialMaps?: SlotMaterialMaps;
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

/** Resolve the fixture media id for a model (for GLB URL construction). */
export function getModelMediaId(model: FixtureModel | undefined): string | null {
  return modelMediaId(model);
}

export function exportModelDims(model: FixtureModel | undefined): ModelDims {
  return modelDims(model);
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

/**
 * For CELL GeometryReference hosts, find the cloned GDTF Beam child group inside
 * the instanced subtree. Beams emit along that node's local −Z, not the reference
 * root (which may be offset from the lens / filament).
 */
export function findGeometryReferenceEmissionNode(
  refPartId: string,
  parts: FixturePart[],
  refHost: THREE.Object3D,
): THREE.Object3D {
  const refPart = parts.find((p) => p.partId === refPartId);
  if (!refPart) return refHost;
  const meta = partMeta(refPart);
  if (!meta.isGeometryReference || !meta.referencedGeometryId) return refHost;

  const templateRoot = parts.find((p) => p.sourceGdtfGeometryId === meta.referencedGeometryId);
  if (!templateRoot) return refHost;

  let emitPart: FixturePart | undefined;
  let lensPart: FixturePart | undefined;
  const walk = (partId: string): void => {
    if (emitPart) return;
    const parent = parts.find((p) => p.partId === partId);
    if (!parent) return;
    for (const childId of parent.childPartIds) {
      const child = parts.find((p) => p.partId === childId);
      if (!child) continue;
      const nodeType = (child.metadata as { geometryNodeType?: string }).geometryNodeType;
      if (nodeType === 'Beam') {
        emitPart = child;
        return;
      }
      if (!lensPart && child.modelId && (child.tag === 'LENS' || child.tag === 'CELL')) {
        lensPart = child;
      }
      walk(childId);
    }
  };
  walk(templateRoot.partId);
  if (!emitPart) emitPart = lensPart;
  if (!emitPart) return refHost;

  let found: THREE.Object3D | undefined;
  const instanceRoot = refHost.children.length === 1 ? refHost.children[0]! : refHost;
  instanceRoot.traverse((o) => {
    if (found || o === instanceRoot) return;
    if (o.name === emitPart!.name) found = o;
  });
  return found ?? instanceRoot;
}

function isRebusClampPart(part: FixturePart): boolean {
  return isRebusClampPartShared(part)
    || part.partId === REBUS_CLAMP_PART_ID
    || (part.tag === 'CLAMP' && partMeta(part).rebusSlot === true);
}

/**
 * Wrap a placed mesh in a per-model offset group (GDTF Z-up metres + degrees
 * XYZ). Always creates the group (identity when no offset) so live slider edits
 * can update translation/rotation without rebuilding the assembly. Composition
 * matches the Orbit baker: partWorld · offset · wrap(+90°X) · scale.
 */
function applyMeshOffset(wrapped: THREE.Object3D, model: FixtureModel | undefined): THREE.Object3D {
  const offset = readMeshOffset(model?.metadata as Record<string, unknown> | undefined)
    ?? { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
  const offsetGroup = new THREE.Group();
  offsetGroup.name = 'MeshOffset';
  offsetGroup.position.set(offset.position.x, offset.position.y, offset.position.z);
  if (!isCustomReplacedModel(model)) {
    offsetGroup.rotation.set(
      THREE.MathUtils.degToRad(offset.rotation.x),
      THREE.MathUtils.degToRad(offset.rotation.y),
      THREE.MathUtils.degToRad(offset.rotation.z),
      'XYZ',
    );
  }
  offsetGroup.add(wrapped);
  return offsetGroup;
}

/**
 * Push current `metadata.meshOffset` values onto live MeshOffset groups without
 * a full assembly rebuild (used by transformRevision sync).
 */
export function syncMeshOffsetGroups(
  partGroups: Map<string, THREE.Object3D>,
  parts: FixturePart[],
  models: FixtureModel[],
): void {
  const byId = new Map(models.map((m) => [m.modelId, m]));
  for (const part of parts) {
    const group = partGroups.get(part.partId);
    if (!group || !part.modelId) continue;
    const model = byId.get(part.modelId);
    const offsetGroup = group.children.find((c) => c.name === 'MeshOffset');
    if (!offsetGroup) continue;
    const offset = readMeshOffset(model?.metadata as Record<string, unknown> | undefined)
      ?? { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
    offsetGroup.position.set(offset.position.x, offset.position.y, offset.position.z);
    if (isCustomReplacedModel(model)) {
      offsetGroup.rotation.set(0, 0, 0);
    } else {
      offsetGroup.rotation.set(
        THREE.MathUtils.degToRad(offset.rotation.x),
        THREE.MathUtils.degToRad(offset.rotation.y),
        THREE.MathUtils.degToRad(offset.rotation.z),
        'XYZ',
      );
    }
  }
}

/** Apply optional user flip-normals toggle, then mesh-offset translation. */
function finalizeModelMesh(wrapped: THREE.Object3D, model: FixtureModel | undefined): THREE.Object3D {
  if (readFlipNormals(model?.metadata as Record<string, unknown> | undefined)) {
    applyFlipNormals(wrapped);
  }
  return applyMeshOffset(wrapped, model);
}

/**
 * Place one clamp mesh under its part group. Placement (position / rotation /
 * mirror scale) comes from `part.localTransform` — multi-clamp fixtures use
 * one part per clamp instead of the legacy ClampRig mirror flag.
 */
function attachClampMesh(partGroup: THREE.Group, mesh: THREE.Object3D): number {
  const primary = mesh.clone(true);
  primary.name = 'Clamp';
  partGroup.add(primary);
  return 1;
}

/**
 * Orient a Model Library clamp GLB like ModelViewer, then apply the stored root
 * transform. Order (inner → outer): GLB → unit scale → +90° X wrap → model transform.
 * Fixture part localTransform is applied by the part group.
 */
function wrapLibraryClampMesh(
  meshRoot: THREE.Object3D,
  dims: ModelDims,
  transform?: ModelTransform | null,
  sourceUnits?: string | null,
): THREE.Object3D {
  let mesh: THREE.Object3D = meshRoot;
  if (sourceUnits && isModelLengthUnit(sourceUnits) && sourceUnits !== 'm') {
    const scaleGroup = new THREE.Group();
    scaleGroup.name = 'ClampUnitScale';
    scaleGroup.scale.setScalar(unitScaleToMetres(sourceUnits));
    scaleGroup.add(meshRoot);
    mesh = scaleGroup;
  }
  const oriented = wrapModelMesh(mesh, dims);
  if (!transform) return oriented;
  const root = new THREE.Group();
  root.name = 'ClampModelRoot';
  applyModelTransform(root, ensureModelTransform(transform));
  root.add(oriented);
  return root;
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
 * +90° X rotation, then scale so the mesh bbox matches model L×W×H (metres).
 *
 * - Stock GDTF meshes: per-axis fit to the GDTF slot (may be non-uniform).
 * - Custom replaced uploads: **uniform** scale only (preserve authored
 *   proportions). Dims are the measured metre bbox after mm→m conversion, so
 *   this is effectively a unit conversion — we do not squash height/width/depth
 *   into the GDTF reference box.
 */
function wrapModelMeshInternal(
  meshRoot: THREE.Object3D,
  dims: ModelDims,
  uniform = false,
): THREE.Group {
  const wrapper = new THREE.Group();
  wrapper.name = 'Scene';
  wrapper.rotation.x = Math.PI / 2;

  const bbox = new THREE.Box3().setFromObject(meshRoot);
  const size = bbox.getSize(new THREE.Vector3());

  if (
    dims.length != null && dims.width != null && dims.height != null
    && size.x > 1e-6 && size.y > 1e-6 && size.z > 1e-6
  ) {
    const sx = dims.length / size.x;
    const sy = dims.height / size.y;
    const sz = dims.width / size.z;
    if (uniform) {
      const ratios = [sx, sy, sz].sort((a, b) => a - b);
      const s = ratios[1]!;
      wrapper.scale.setScalar(s);
    } else {
      // GDTF mapping (verified on Rivale Profile Base):
      // x = length/bbox.x, y = height/bbox.y, z = width/bbox.z.
      wrapper.scale.set(sx, sy, sz);
    }
  }

  wrapper.add(meshRoot);
  return wrapper;
}

/**
 * Wrap a Y-up glTF mesh. Custom replaced models use uniform scale (1:1
 * proportions); stock GDTF models use per-axis slot fit.
 */
function wrapModelMesh(
  meshRoot: THREE.Object3D,
  dims: ModelDims,
  model?: FixtureModel,
): THREE.Group {
  return wrapModelMeshInternal(meshRoot, dims, isCustomReplacedModel(model));
}

/** Load a fixture model GLB from a same-origin URL. */
export async function loadFixtureModelGlb(url: string): Promise<THREE.Object3D | null> {
  const loader = new GLTFLoader();
  try {
    const gltf = await loader.loadAsync(url);
    return gltf.scene as THREE.Object3D;
  } catch (err) {
    console.warn('[fixtureAssembly] failed to load model GLB', url, err);
    return null;
  }
}

/**
 * Part-local bounding box for a model GLB after wrap (+90° X and L/W/H fit).
 * Does not include mesh-offset translation.
 */
export function computeModelPartLocalBounds(
  meshRoot: THREE.Object3D,
  model: FixtureModel | undefined,
  _oneToOne?: boolean,
): THREE.Box3 {
  const dims = modelDims(model);
  const wrapped = wrapModelMeshInternal(
    meshRoot.clone(true),
    dims,
    isCustomReplacedModel(model),
  );
  wrapped.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(wrapped);
  disposeAssembly(wrapped);
  return box;
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
  const referencedGeomIds = collectReferencedGeometryIds(parts);
  const modelById = new Map(models.map((mm) => [mm.modelId, mm]));
  const loader = new GLTFLoader();

  const glbCache = new Map<string, Promise<THREE.Object3D | null>>();
  const loadGlbUrl = (url: string): Promise<THREE.Object3D | null> => {
    let p = glbCache.get(url);
    if (!p) {
      p = loader.loadAsync(url)
        .then((g) => g.scene as THREE.Object3D)
        .catch((err) => {
          console.warn('[fixtureAssembly] failed to load model GLB', url, err);
          return null;
        });
      glbCache.set(url, p);
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
    if (isLibraryGeometryPart(part, referencedGeomIds)) continue;
    const parent = part.parentPartId ? partGroups.get(part.parentPartId) : null;
    if (parent) {
      parent.add(g);
      continue;
    }
    if (isLibraryGeometryPart(part, referencedGeomIds)) continue;
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

    const perModelLib = isRebusClampPart(part) && part.modelId
      ? input.clampLibraryByModelId?.[part.modelId]
      : undefined;
    const legacyLibUrl = isRebusClampPart(part) && !perModelLib ? input.clampModelUrl : undefined;
    const clampLib = perModelLib ?? (legacyLibUrl
      ? {
        url: legacyLibUrl,
        transform: input.clampModelTransform,
        sourceUnits: input.clampSourceUnits,
        materialSlots: input.clampMaterialSlots,
        slotMaterialMaps: input.clampSlotMaterialMaps,
      }
      : undefined);
    const meshUrl = clampLib?.url ?? (mediaId ? input.resolveUrl(mediaId) : null);
    if (meshUrl) {
      const obj = await loadGlbUrl(meshUrl);
      if (obj) {
        const wrapped = clampLib
          ? wrapLibraryClampMesh(
            obj.clone(true),
            dims,
            clampLib.transform,
            clampLib.sourceUnits,
          )
          : wrapModelMesh(obj.clone(true), dims, model);
        if (
          isRebusClampPart(part) && clampLib
          && clampLib.materialSlots?.length
          && clampLib.slotMaterialMaps
          && (
            clampLib.slotMaterialMaps.byMeshName.size
            || clampLib.slotMaterialMaps.bySourceMaterialName.size
            || clampLib.slotMaterialMaps.byLegacyName.size
          )
        ) {
          paintModelMaterialSlots(wrapped, clampLib.materialSlots, clampLib.slotMaterialMaps);
        } else {
          paintMaterial(wrapped, part);
        }
        if (isRebusClampPart(part)) {
          if (readFlipNormals(model?.metadata as Record<string, unknown> | undefined)) {
            applyFlipNormals(wrapped);
          }
          meshCount += attachClampMesh(partGroup, wrapped);
        } else {
          partGroup.add(finalizeModelMesh(wrapped, model));
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
    // GDTF Builder (what GDTF-Share renders with) COMPOSES the reference Position
    // with the referenced geometry's own root matrix — it does not replace it.
    // Resetting to identity twisted asymmetric instances (Mac Aura aura filaments)
    // while circular pixels looked unaffected; keep the referenced root transform.
    // Strip copied partId tags so picking inside a referenced instance resolves
    // to the reference part group (walk-up), not the cloned source part.
    clone.traverse((o) => { delete o.userData.partId; });
    partGroups.get(part.partId)!.add(clone);
    clone.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshCount += 1; });
  }

  const root = contentRoot;

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
