/**
 * ORBIT object graph helpers — download, locate meshes, re-hash after edits.
 */
import type { OrbitCreds } from './client.js';
import { computeObjectId } from './objectHash.js';

export type OrbitObjectJson = Record<string, unknown>;

const MESH_TYPE_SUFFIXES = ['Objects.Geometry.Mesh', 'Speckle.Core.Models.Geometry.Mesh'];

/** ORBIT/Speckle object ids are 32-char MD5 hex. Blob ids (in __closure) are shorter. */
const OBJECT_ID_RE = /^[0-9a-f]{32}$/i;

export function isObjectId(id: string): boolean {
  return OBJECT_ID_RE.test(id);
}

export function isMeshObject(obj: OrbitObjectJson): boolean {
  const t = obj.speckle_type ?? obj.type;
  if (typeof t !== 'string') return false;
  return MESH_TYPE_SUFFIXES.some((s) => t === s || t.endsWith('.Mesh'));
}

/** Collect every detached-child id referenced inside an object tree. */
export function collectReferencedIds(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (value == null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectReferencedIds(item, out);
    return out;
  }
  const rec = value as OrbitObjectJson;
  if (typeof rec.referencedId === 'string' && rec.speckle_type === 'reference') {
    out.add(rec.referencedId);
  }
  for (const [key, child] of Object.entries(rec)) {
    if (key === '__closure' || key === 'referencedId') continue;
    collectReferencedIds(child, out);
  }
  return out;
}

const BLOB_REF_RE = /^blob:(.+)$/;

/**
 * Collect every Speckle blob id referenced inside an object tree. Blob refs are
 * string property values of the form `blob:<blobId>` (e.g. RenderMaterial
 * texture fields). Their ids must appear in the version root __closure so the
 * blobs travel with the version and ORBIT serves them to its renderer.
 */
export function collectBlobIds(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (value == null) return out;
  if (typeof value === 'string') {
    const m = BLOB_REF_RE.exec(value);
    if (m && m[1]) out.add(m[1]);
    return out;
  }
  if (typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectBlobIds(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value as OrbitObjectJson)) {
    if (key === '__closure') continue;
    collectBlobIds(child, out);
  }
  return out;
}

function replaceReferencedId(value: unknown, oldId: string, newId: string): void {
  if (value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) replaceReferencedId(item, oldId, newId);
    return;
  }
  const rec = value as OrbitObjectJson;
  if (rec.referencedId === oldId) rec.referencedId = newId;
  for (const [key, child] of Object.entries(rec)) {
    if (key === '__closure') continue;
    replaceReferencedId(child, oldId, newId);
  }
}

function findRootId(objects: Map<string, OrbitObjectJson>): string {
  for (const [id, obj] of objects) {
    if (obj.__closure != null) return id;
  }
  throw new Error('root object with __closure not found in graph');
}

function buildClosure(rootId: string, objects: Map<string, OrbitObjectJson>): Record<string, number> {
  const closure: Record<string, number> = {};
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const seen = new Set<string>();

  while (queue.length) {
    const { id, depth } = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const obj = objects.get(id);
    if (!obj) continue;
    if (depth > 0) closure[id] = depth;

    // Blob references (e.g. RenderMaterial textures) become closure entries at
    // depth+1 so the version retains and serves them. Keep the minimum depth.
    for (const blobId of collectBlobIds(obj)) {
      const d = depth + 1;
      if (closure[blobId] === undefined || d < closure[blobId]) closure[blobId] = d;
    }

    const refs = collectReferencedIds(obj);
    for (const refId of refs) {
      if (!seen.has(refId)) queue.push({ id: refId, depth: depth + 1 });
    }
  }
  return closure;
}

/** Download every object reachable from the version root (via __closure + reference walk). */
export async function downloadObjectGraph(
  creds: OrbitCreds,
  projectId: string,
  rootObjectId: string,
): Promise<Map<string, OrbitObjectJson>> {
  const objects = new Map<string, OrbitObjectJson>();
  const pending = new Set<string>([rootObjectId]);

  while (pending.size) {
    const id = pending.values().next().value as string;
    pending.delete(id);
    if (objects.has(id)) continue;

    const json = await fetchObjectJsonWithCreds(creds, projectId, id);
    const obj = JSON.parse(json) as OrbitObjectJson;
    if (typeof obj.id !== 'string') obj.id = id;
    objects.set(id, obj);

    if (obj.__closure && typeof obj.__closure === 'object') {
      for (const childId of Object.keys(obj.__closure as Record<string, unknown>)) {
        // Skip blob ids — closure mixes detached object ids with blob ids, but
        // only objects are fetchable via /objects/.../single (blobs would 404).
        if (isObjectId(childId)) pending.add(childId);
      }
    }
    for (const refId of collectReferencedIds(obj)) pending.add(refId);
  }

  return objects;
}

async function fetchObjectJsonWithCreds(
  creds: OrbitCreds,
  projectId: string,
  objectId: string,
): Promise<string> {
  const res = await fetch(
    `${creds.url}/objects/${encodeURIComponent(projectId)}/${encodeURIComponent(objectId)}/single`,
    { headers: { authorization: `Bearer ${creds.token}` } },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ORBIT GET object ${objectId} returned ${res.status}: ${text}`);
  }
  return res.text();
}

export function findMeshInGraph(
  objects: Map<string, OrbitObjectJson>,
  opts: { objectId?: string; applicationId?: string },
): { objectId: string; mesh: OrbitObjectJson } {
  if (opts.objectId) {
    const mesh = objects.get(opts.objectId);
    if (!mesh) throw new Error(`object ${opts.objectId} not found in version graph`);
    if (!isMeshObject(mesh)) throw new Error(`object ${opts.objectId} is not a Mesh`);
    return { objectId: opts.objectId, mesh };
  }

  if (opts.applicationId) {
    for (const [id, obj] of objects) {
      if (obj.applicationId === opts.applicationId && isMeshObject(obj)) {
        return { objectId: id, mesh: obj };
      }
    }
    throw new Error(`no Mesh with applicationId ${opts.applicationId} found in version graph`);
  }

  throw new Error('objectId or applicationId is required');
}

/**
 * After mutating one object, re-hash the entire graph deepest-first, rebuild
 * root __closure, and return objects that need uploading (new content hashes).
 */
export function rehashGraphAfterMutation(
  objects: Map<string, OrbitObjectJson>,
  originalIds: Set<string>,
): { rootObjectId: string; toUpload: OrbitObjectJson[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const rootIdBefore = findRootId(objects);
  const oldClosure = (objects.get(rootIdBefore)?.__closure ?? {}) as Record<string, number>;

  const sortDepth = (id: string): number => {
    if (id === rootIdBefore) return 0;
    return oldClosure[id] ?? 999;
  };

  const sortedIds = [...objects.keys()].sort((a, b) => sortDepth(b) - sortDepth(a));

  for (const oldId of sortedIds) {
    const obj = objects.get(oldId);
    if (!obj) continue;
    const newId = computeObjectId(obj);
    if (newId === oldId) continue;

    idMap.set(oldId, newId);
    objects.delete(oldId);
    obj.id = newId;
    objects.set(newId, obj);

    for (const other of objects.values()) {
      replaceReferencedId(other, oldId, newId);
    }
  }

  const rootId = findRootId(objects);
  const root = objects.get(rootId)!;
  root.__closure = buildClosure(rootId, objects);
  const finalRootId = computeObjectId(root);
  if (finalRootId !== rootId) {
    idMap.set(rootId, finalRootId);
    objects.delete(rootId);
    root.id = finalRootId;
    objects.set(finalRootId, root);
  }

  const toUpload = [...objects.values()].filter((o) => {
    const id = o.id as string;
    return !originalIds.has(id);
  });

  return { rootObjectId: finalRootId, toUpload, idMap };
}
