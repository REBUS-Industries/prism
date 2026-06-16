/**
 * Discover assignable material slot names from ORBIT geometry when
 * `definition.materialSlots` was not populated at import (common for
 * ORBIT-linked models whose meshes live in Orbit, not in a local GLB).
 */
import { orbitApi, type ModelMaterialSlot, type ModelOrbitRef } from '../../shared/api';
import {
  loadFullObjectClosure,
  orbitViewerProxyBase,
  shortSpeckleType,
} from './orbitSpeckleLoader';

type RawSpeckleObject = Record<string, unknown> & {
  id?: string;
  speckle_type?: string;
  name?: unknown;
};

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

function readRenderMaterialName(obj: RawSpeckleObject): string | null {
  const rm = obj.renderMaterial;
  if (!rm || typeof rm !== 'object') return null;
  const name = (rm as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
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
  const resolved = await orbitApi.resolveViewerVersion(
    ref.target,
    ref.projectId,
    ref.modelId,
    ref.versionId,
  );
  const serverUrl = orbitViewerProxyBase(ref.target);
  const { objects } = await loadFullObjectClosure(
    serverUrl,
    resolved.projectId,
    resolved.rootObjectId,
  );
  return objects;
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
