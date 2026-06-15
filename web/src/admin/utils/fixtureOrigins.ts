/**
 * Compute the origin point (and rotation) of every mesh in a GDTF fixture in
 * native GDTF coordinates — Z-up, metres — so the per-mesh placements can be
 * exported and used to line the same meshes up in external 3D software.
 *
 * We rebuild the geometry hierarchy exactly like the viewer assembly (parent
 * transforms + GeometryReference expansion) but WITHOUT loading any GLBs and
 * WITHOUT the viewer's −90° X presentation flip, so the reported transforms are
 * the raw GDTF placements. Each emitted row is one mesh occurrence: a directly
 * placed part, or a cloned instance produced by a GeometryReference.
 */
import * as THREE from 'three';
import type { FixturePart, FixtureModel } from '../../shared/api';
import { applyPartTransform } from './fixtureAssembly';
import {
  collectReferencedGeometryIds,
  isLibraryGeometryPart,
} from './fixtureGeometryRefs';
import {
  REBUS_CLAMP_PART_ID,
  type ClampPlacement,
  readClampPlacement,
} from './fixturePlacement';

export interface MeshOrigin {
  partId: string;
  name: string;
  tag: string;
  /** Source model file (or model id) of the mesh, when known. */
  model: string;
  /** When this row is a GeometryReference instance, the reference part's name. */
  instanceOf?: string;
  /** Origin in GDTF metres (Z-up): x = length/right, y = depth, z = up. */
  x: number;
  y: number;
  z: number;
  /** World rotation in degrees (GDTF Z-up frame, intrinsic XYZ). */
  rotX: number;
  rotY: number;
  rotZ: number;
}

function refMeta(part: FixturePart): {
  isGeometryReference?: boolean;
  referencedGeometryId?: string;
  isGeometryTemplate?: boolean;
} {
  return (part.metadata ?? {}) as {
    isGeometryReference?: boolean;
    referencedGeometryId?: string;
    isGeometryTemplate?: boolean;
  };
}

function modelLabel(model: FixtureModel | undefined): string {
  if (!model) return '';
  const meta = model.metadata as { fileName?: unknown; mediaId?: unknown } | undefined;
  if (typeof meta?.fileName === 'string' && meta.fileName) return meta.fileName;
  if (model.sourceFile) return model.sourceFile;
  if (model.sourceGdtfModel) return model.sourceGdtfModel;
  return model.modelId;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

function isRebusClampPart(part: FixturePart): boolean {
  return part.partId === REBUS_CLAMP_PART_ID
    || (part.tag === 'CLAMP' && (part.metadata as { rebusSlot?: boolean })?.rebusSlot === true);
}

function modelHasMesh(model: FixtureModel | undefined): boolean {
  const id = (model?.metadata as { mediaId?: unknown } | undefined)?.mediaId;
  return typeof id === 'string' && id.length > 0;
}

/** Origin placeholders matching the clamp rig in buildFixtureAssembly. */
function attachClampOriginRig(
  partGroup: THREE.Group,
  partId: string,
  placement: ClampPlacement,
): void {
  delete partGroup.userData.partId;
  const rig = new THREE.Group();
  rig.rotation.z = THREE.MathUtils.degToRad(placement.rotateZDeg);

  const primary = new THREE.Group();
  primary.userData.partId = partId;
  rig.add(primary);

  if (placement.mirrorZ) {
    const mirrored = new THREE.Group();
    mirrored.scale.z = -1;
    mirrored.userData.partId = partId;
    mirrored.userData.instanceOf = 'Z mirror';
    rig.add(mirrored);
  }

  partGroup.add(rig);
}

/**
 * Build per-mesh origins for a fixture in GDTF Z-up metres. Only parts that
 * carry a real model (mesh) are emitted; GDTF primitives are skipped.
 */
export function computeMeshOrigins(
  parts: FixturePart[],
  models: FixtureModel[],
  fixtureZOffsetM = 0,
  metadata?: Record<string, unknown>,
): MeshOrigin[] {
  const partById = new Map(parts.map((p) => [p.partId, p]));
  const modelById = new Map(models.map((m) => [m.modelId, m]));
  const referencedGeomIds = collectReferencedGeometryIds(parts);
  const byGeometryId = new Map<string, FixturePart>();

  const groups = new Map<string, THREE.Group>();
  for (const part of parts) {
    const g = new THREE.Group();
    g.userData.partId = part.partId;
    applyPartTransform(g, part);
    groups.set(part.partId, g);
    if (part.sourceGdtfGeometryId) byGeometryId.set(part.sourceGdtfGeometryId, part);
  }

  // GDTF Z-up root (no presentation flip → raw GDTF coordinates). Every part —
  // including GeometryReference hosts — is placed by its parent transform.
  const root = new THREE.Group();
  const hangsAtOrigin = (tag: string): boolean => tag === 'CLAMP' || tag === 'ORIGIN';
  const bodyRoot = new THREE.Group();
  if (fixtureZOffsetM > 0) bodyRoot.position.z = -fixtureZOffsetM;
  root.add(bodyRoot);

  for (const part of parts) {
    const g = groups.get(part.partId)!;
    if (isLibraryGeometryPart(part, referencedGeomIds)) continue;
    const parent = part.parentPartId ? groups.get(part.parentPartId) : null;
    if (parent) {
      parent.add(g);
      continue;
    }
    if (isLibraryGeometryPart(part, referencedGeomIds)) continue;
    (hangsAtOrigin(part.tag) ? root : bodyRoot).add(g);
  }

  // Expand GeometryReferences: clone the referenced subtree under each reference
  // part, tagging cloned nodes with the reference name so instances are labelled.
  for (const part of parts) {
    const meta = refMeta(part);
    if (!meta.isGeometryReference || !meta.referencedGeometryId) continue;
    const target = byGeometryId.get(meta.referencedGeometryId);
    const targetGroup = target ? groups.get(target.partId) : null;
    const host = groups.get(part.partId);
    if (!targetGroup || !host) continue;
    const clone = targetGroup.clone(true);
    clone.traverse((o) => { o.userData.instanceOf = part.name; });
    host.add(clone);
  }

  const clampPlacement = readClampPlacement(metadata);
  for (const part of parts) {
    if (!isRebusClampPart(part) || !part.modelId) continue;
    if (!modelHasMesh(modelById.get(part.modelId))) continue;
    attachClampOriginRig(groups.get(part.partId)!, part.partId, clampPlacement);
  }

  root.updateMatrixWorld(true);

  const out: MeshOrigin[] = [];
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const euler = new THREE.Euler();
  root.traverse((obj) => {
    const partId = obj.userData.partId as string | undefined;
    if (!partId) return;
    const part = partById.get(partId);
    if (!part || !part.modelId) return; // meshes only
    obj.matrixWorld.decompose(pos, quat, scl);
    euler.setFromQuaternion(quat, 'XYZ');
    out.push({
      partId,
      name: part.name ?? partId,
      tag: part.tag,
      model: modelLabel(modelById.get(part.modelId)),
      instanceOf: typeof obj.userData.instanceOf === 'string' ? obj.userData.instanceOf : undefined,
      x: round(pos.x),
      y: round(pos.y),
      z: round(pos.z),
      rotX: round(THREE.MathUtils.radToDeg(euler.x)),
      rotY: round(THREE.MathUtils.radToDeg(euler.y)),
      rotZ: round(THREE.MathUtils.radToDeg(euler.z)),
    });
  });
  return out;
}

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Serialise mesh origins to CSV. Coordinates are GDTF Z-up metres (x = length,
 * y = depth, z = up); rotations are degrees (intrinsic XYZ).
 */
export function meshOriginsToCsv(origins: MeshOrigin[]): string {
  const header = ['name', 'tag', 'model', 'instance_of', 'x_m', 'y_m', 'z_m', 'rotX_deg', 'rotY_deg', 'rotZ_deg'];
  const rows = origins.map((o) => [
    o.name, o.tag, o.model, o.instanceOf ?? '',
    o.x, o.y, o.z, o.rotX, o.rotY, o.rotZ,
  ].map(csvCell).join(','));
  return [header.join(','), ...rows].join('\r\n');
}

/** Trigger a browser download of `content` as `filename`. */
export function downloadTextFile(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
