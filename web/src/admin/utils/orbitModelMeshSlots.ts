/**
 * Discover assignable material slot names from ORBIT geometry when
 * `definition.materialSlots` was not populated at import (common for
 * ORBIT-linked models whose meshes live in Orbit, not in a local GLB).
 */
import { type ModelMaterialSlot, type ModelMaterialSlotKind, type ModelOrbitRef } from '../../shared/api';
import { shortSpeckleType } from './orbitSpeckleLoader';
import { fetchOrbitViewerSession } from './orbitViewerSession';

type RawSpeckleObject = Record<string, unknown> & {
  id?: string;
  speckle_type?: string;
  name?: unknown;
  applicationId?: unknown;
};

export interface OrbitMeshTarget {
  objectId: string;
  applicationId?: string | null;
}

export interface OrbitMaterialSlotMap {
  meshByName: Map<string, OrbitMeshTarget[]>;
  meshesBySourceMaterial: Map<string, string[]>;
}

export interface OrbitMaterialSwapAssignment {
  objectId: string;
  applicationId?: string;
  prismMaterialId: string;
}

function readObjectName(obj: RawSpeckleObject): string | null {
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  return name || null;
}

function meshHasGeometry(obj: RawSpeckleObject): boolean {
  const vertices = obj.vertices;
  return Array.isArray(vertices) && vertices.length > 0 && typeof vertices[0] === 'number';
}

/** Objects that represent user-visible parts (Rhino layers/blocks, not raw chunks). */
function isOrbitPartObject(obj: RawSpeckleObject): boolean {
  const short = shortSpeckleType(obj.speckle_type);
  if (short === 'Mesh') return meshHasGeometry(obj);

  const stLower = typeof obj.speckle_type === 'string' ? obj.speckle_type.toLowerCase() : '';
  const hasDisplay = obj.displayValue !== undefined || obj['@displayValue'] !== undefined;
  return short === 'RhinoObject'
    || stLower.includes('objects.data')
    || (hasDisplay && short !== 'Mesh');
}

function readRenderMaterialName(obj: RawSpeckleObject): string | null {
  const rm = obj.renderMaterial;
  if (!rm || typeof rm !== 'object') return null;
  const name = (rm as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function buildObjectIndex(objects: RawSpeckleObject[]): Map<string, RawSpeckleObject> {
  const byId = new Map<string, RawSpeckleObject>();
  for (const o of objects) {
    if (typeof o.id === 'string') byId.set(o.id, o);
  }
  return byId;
}

function resolveReferenced(
  entry: unknown,
  byId: Map<string, RawSpeckleObject>,
): RawSpeckleObject | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.referencedId === 'string') return byId.get(e.referencedId) ?? null;
  if (typeof e.speckle_type === 'string') return e as RawSpeckleObject;
  return null;
}

/** Resolve a part or mesh object to drawable Mesh targets (for material swap). */
function resolveMeshTargets(
  obj: RawSpeckleObject,
  byId: Map<string, RawSpeckleObject>,
): OrbitMeshTarget[] {
  const short = shortSpeckleType(obj.speckle_type);
  if (short === 'Mesh' && meshHasGeometry(obj) && typeof obj.id === 'string') {
    const appId = typeof obj.applicationId === 'string' ? obj.applicationId : undefined;
    return [{ objectId: obj.id, applicationId: appId ?? null }];
  }

  const dvRaw = obj.displayValue ?? obj['@displayValue'];
  const entries = Array.isArray(dvRaw) ? dvRaw : dvRaw ? [dvRaw] : [];
  const targets: OrbitMeshTarget[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const resolved = resolveReferenced(entry, byId);
    if (!resolved || shortSpeckleType(resolved.speckle_type) !== 'Mesh') continue;
    if (!meshHasGeometry(resolved) || typeof resolved.id !== 'string') continue;
    if (seen.has(resolved.id)) continue;
    seen.add(resolved.id);
    const appId = typeof resolved.applicationId === 'string' ? resolved.applicationId : undefined;
    targets.push({ objectId: resolved.id, applicationId: appId ?? null });
  }

  return targets;
}

/** Map slot names to ORBIT mesh object ids from a downloaded closure. */
export function buildOrbitMaterialSlotMap(objects: RawSpeckleObject[]): OrbitMaterialSlotMap {
  const byId = buildObjectIndex(objects);
  const meshByName = new Map<string, OrbitMeshTarget[]>();
  const meshesBySourceMaterial = new Map<string, string[]>();

  const pushMeshName = (name: string, targets: OrbitMeshTarget[]): void => {
    if (!targets.length) return;
    const existing = meshByName.get(name) ?? [];
    const seen = new Set(existing.map((t) => t.objectId));
    for (const t of targets) {
      if (seen.has(t.objectId)) continue;
      seen.add(t.objectId);
      existing.push(t);
    }
    meshByName.set(name, existing);
  };

  for (const obj of objects) {
    if (!isOrbitPartObject(obj)) continue;
    const name = readObjectName(obj);
    if (!name) continue;
    pushMeshName(name, resolveMeshTargets(obj, byId));
  }

  if (meshByName.size === 0) {
    let meshIndex = 0;
    for (const obj of objects) {
      if (shortSpeckleType(obj.speckle_type) !== 'Mesh' || !meshHasGeometry(obj)) continue;
      if (typeof obj.id !== 'string') continue;
      meshIndex += 1;
      const label = readObjectName(obj) ?? `Mesh ${meshIndex}`;
      pushMeshName(label, resolveMeshTargets(obj, byId));
    }
  }

  for (const obj of objects) {
    if (shortSpeckleType(obj.speckle_type) !== 'Mesh' || !meshHasGeometry(obj)) continue;
    if (typeof obj.id !== 'string') continue;
    const matName = readRenderMaterialName(obj);
    if (!matName) continue;
    const ids = meshesBySourceMaterial.get(matName) ?? [];
    if (!ids.includes(obj.id)) ids.push(obj.id);
    meshesBySourceMaterial.set(matName, ids);
  }

  return { meshByName, meshesBySourceMaterial };
}

/** Build batch material-swap assignments from editor slot rows + ORBIT closure. */
export async function buildOrbitMaterialSwapAssignments(
  ref: ModelOrbitRef,
  slots: ModelMaterialSlot[],
  kind: ModelMaterialSlotKind,
): Promise<{ assignments: OrbitMaterialSwapAssignment[]; unresolved: string[] }> {
  const assigned = slots.filter((s) => s.materialId);
  if (!assigned.length) return { assignments: [], unresolved: [] };

  const objects = await fetchOrbitObjects(ref);
  const map = buildOrbitMaterialSlotMap(objects);
  const assignments: OrbitMaterialSwapAssignment[] = [];
  const unresolved: string[] = [];

  for (const slot of assigned) {
    if (!slot.materialId) continue;

    if (kind === 'mesh') {
      const targets = map.meshByName.get(slot.name);
      if (!targets?.length) {
        unresolved.push(slot.name);
        continue;
      }
      for (const target of targets) {
        assignments.push({
          objectId: target.objectId,
          ...(target.applicationId ? { applicationId: target.applicationId } : {}),
          prismMaterialId: slot.materialId,
        });
      }
    } else {
      const objectIds = map.meshesBySourceMaterial.get(slot.name);
      if (!objectIds?.length) {
        unresolved.push(slot.name);
        continue;
      }
      for (const objectId of objectIds) {
        assignments.push({ objectId, prismMaterialId: slot.materialId });
      }
    }
  }

  // Last assignment wins when the same mesh appears more than once.
  const deduped = new Map<string, OrbitMaterialSwapAssignment>();
  for (const a of assignments) deduped.set(a.objectId, a);

  return { assignments: [...deduped.values()], unresolved };
}

/** Extract unique, stable slot names from a resolved ORBIT object closure. */
export function extractOrbitMaterialSlotNames(objects: RawSpeckleObject[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string | null): void => {
    if (!raw || seen.has(raw)) return;
    seen.add(raw);
    names.push(raw);
  };

  for (const obj of objects) {
    if (!isOrbitPartObject(obj)) continue;
    push(readObjectName(obj));
  }

  if (names.length) return names;

  let meshIndex = 0;
  for (const obj of objects) {
    if (shortSpeckleType(obj.speckle_type) !== 'Mesh' || !meshHasGeometry(obj)) continue;
    meshIndex += 1;
    push(readObjectName(obj) ?? `Mesh ${meshIndex}`);
  }

  return names;
}

/** Unique ORBIT renderMaterial names from mesh geometry in a closure. */
export function extractOrbitSourceMaterialNames(objects: RawSpeckleObject[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string | null): void => {
    if (!raw || seen.has(raw)) return;
    seen.add(raw);
    names.push(raw);
  };

  for (const obj of objects) {
    if (shortSpeckleType(obj.speckle_type) !== 'Mesh' || !meshHasGeometry(obj)) continue;
    push(readRenderMaterialName(obj));
  }

  return names;
}

export function orbitObjectsToMaterialSlots(
  names: string[],
  kind: ModelMaterialSlot['kind'] = 'mesh',
): ModelMaterialSlot[] {
  return names.map((name) => ({ name, materialId: null, kind }));
}

async function fetchOrbitObjects(ref: ModelOrbitRef): Promise<RawSpeckleObject[]> {
  const session = await fetchOrbitViewerSession(ref);
  return session.objects as RawSpeckleObject[];
}

/** Resolve ORBIT version + download closure, return mesh-part slot stubs. */
export async function fetchOrbitMaterialSlots(ref: ModelOrbitRef): Promise<ModelMaterialSlot[]> {
  const objects = await fetchOrbitObjects(ref);
  return orbitObjectsToMaterialSlots(extractOrbitMaterialSlotNames(objects), 'mesh');
}

/** Resolve ORBIT closure, return source renderMaterial slot stubs. */
export async function fetchOrbitSourceMaterialSlots(ref: ModelOrbitRef): Promise<ModelMaterialSlot[]> {
  const objects = await fetchOrbitObjects(ref);
  return orbitObjectsToMaterialSlots(extractOrbitSourceMaterialNames(objects), 'sourceMaterial');
}

/** Preserve saved materialId assignments when refreshing slot names from ORBIT. */
export function mergeMaterialSlots(
  persisted: ModelMaterialSlot[],
  discovered: ModelMaterialSlot[],
): ModelMaterialSlot[] {
  const kind = discovered[0]?.kind ?? 'mesh';
  const byName = new Map(
    persisted
      .filter((s) => (s.kind ?? 'mesh') === kind)
      .map((s) => [s.name, s.materialId ?? null]),
  );
  return discovered.map((slot) => ({
    name: slot.name,
    materialId: byName.get(slot.name) ?? null,
    kind: slot.kind ?? kind,
  }));
}
