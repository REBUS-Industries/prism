/**
 * Speckle viewer loader that fetches ORBIT objects through the PRISM server
 * proxy (`/api/orbit/viewer/:target/...`) so the browser never sees the PAT.
 */
import { ObjectLoader2Factory } from '@speckle/objectloader2';
import type { ObjectLoader2 } from '@speckle/objectloader2';
import {
  Loader,
  LoaderEvent,
  SpeckleConverter,
  SpeckleGeometryConverter,
  type SpeckleObject,
} from '@speckle/viewer';
import type { WorldTree } from '@speckle/viewer';

export const ORBIT_VIEWER_LOG = '[OrbitViewer]';

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

/** Redact token-like query params before logging URLs. */
export function redactOrbitLogUrl(input: RequestInfo | URL): string {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input instanceof Request
        ? input.url
        : String(input);
  try {
    const u = new URL(raw, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    for (const key of ['token', 'access_token', 'pat', 'authorization']) {
      if (u.searchParams.has(key)) u.searchParams.set(key, '[REDACTED]');
    }
    return `${u.pathname}${u.search}`;
  } catch {
    return raw.replace(/(token|access_token|pat)=[^&]+/gi, '$1=[REDACTED]');
  }
}

function classifyProxyFetch(path: string): string {
  if (path.includes('/resolve')) return 'resolve';
  if (path.includes('/objects/') && path.includes('/single')) return 'single';
  if (path.includes('/objects/') && path.includes('/stream')) return 'object-stream';
  if (path.includes('/blob')) return 'blob';
  return 'other';
}

export function orbitViewerProxyBase(target: 'prod' | 'dev'): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/api/orbit/viewer/${target}`;
}

/** Custom fetch that forwards admin session cookies to the PRISM proxy. */
export function orbitViewerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = redactOrbitLogUrl(input);
  const kind = classifyProxyFetch(url);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const t0 = performance.now();
  console.log(`${ORBIT_VIEWER_LOG} [${ts()}] fetch:${kind} start`, { method, url });

  return fetch(input, { ...init, credentials: 'same-origin' }).then(async (res) => {
    const ms = Math.round(performance.now() - t0);
    const contentType = res.headers.get('content-type') ?? '';
    const contentLength = res.headers.get('content-length');
    let objectCount: number | undefined;
    let extra: Record<string, unknown> | undefined;

    if (res.ok && contentType.includes('application/json')) {
      try {
        const clone = res.clone();
        const body = await clone.json() as unknown;
        if (Array.isArray(body)) {
          objectCount = body.length;
        } else if (body && typeof body === 'object') {
          const record = body as Record<string, unknown>;
          if (typeof record.totalChildrenCount === 'number') {
            objectCount = record.totalChildrenCount;
          } else if (Array.isArray(record.closures)) {
            objectCount = record.closures.length;
          } else if (Array.isArray(record.objects)) {
            objectCount = record.objects.length;
          } else if (typeof record.id === 'string') {
            objectCount = 1;
            extra = { objectId: `${record.id.slice(0, 12)}…` };
          }
        }
      } catch {
        // Non-fatal: logging must not break loading.
      }
    }

    const logPayload = {
      method,
      url,
      status: res.status,
      ok: res.ok,
      ms,
      contentType: contentType || undefined,
      contentLength: contentLength ?? undefined,
      objectCount,
      ...extra,
    };

    if (!res.ok) {
      console.error(`${ORBIT_VIEWER_LOG} [${ts()}] fetch:${kind} failed`, logPayload);
    } else if (objectCount === 0 && (kind === 'single' || kind === 'object-stream')) {
      console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] fetch:${kind} empty payload`, logPayload);
    } else {
      console.log(`${ORBIT_VIEWER_LOG} [${ts()}] fetch:${kind} ok`, logPayload);
    }
    return res;
  }).catch((err) => {
    console.error(`${ORBIT_VIEWER_LOG} [${ts()}] fetch:${kind} error`, {
      method,
      url,
      ms: Math.round(performance.now() - t0),
      error: err,
    });
    throw err;
  });
}

function mapOrbitLoaderError(err: unknown): Error {
  const message = (err as Error)?.message ?? String(err);
  if (/do not have access|401|403|unauthor/i.test(message)) {
    return new Error(
      'ORBIT access denied — add a valid API token (PAT) in Settings for this environment.',
    );
  }
  if (/credentials not configured|412/i.test(message)) {
    return new Error('ORBIT URL + token not configured — set them in Settings.');
  }
  return err instanceof Error ? err : new Error(message);
}

export type RawSpeckleObject = Record<string, unknown> & {
  id?: string;
  speckle_type?: string;
  __closure?: Record<string, number>;
};

/**
 * Recursively collect every detached-child id (`{ referencedId }` stub) inside
 * an object body. Mesh `vertices`/`faces` are stored as arrays of these stubs
 * pointing at `Speckle.Core.Models.DataChunk` objects, so this is how we
 * discover the chunk ids that the converter must dereference.
 *
 * Arrays of primitives (e.g. a DataChunk's numeric `data`) are skipped cheaply
 * because only object entries are recursed into.
 */
function collectReferencedIds(value: unknown, into: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') collectReferencedIds(item, into);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  const ref = obj.referencedId;
  if (typeof ref === 'string' && ref) into.add(ref);
  for (const key in obj) {
    // __closure is a flat id→depth map handled explicitly on the root; skip it
    // here so we don't re-walk the (possibly incomplete) closure as references.
    if (key === '__closure' || key === 'referencedId') continue;
    const v = obj[key];
    if (v && typeof v === 'object') collectReferencedIds(v, into);
  }
}

/**
 * ORBIT/Speckle object ids are 32-char MD5 hex. A version `__closure` can also
 * contain shorter blob ids (e.g. RenderMaterial texture references); those are
 * NOT fetchable as objects and must be skipped when seeding the download queue.
 */
const OBJECT_ID_RE = /^[0-9a-f]{32}$/i;

export function isOrbitObjectId(id: string): boolean {
  return OBJECT_ID_RE.test(id);
}

/** Last path segment of a (possibly chain-encoded) speckle_type. */
export function shortSpeckleType(t: unknown): string {
  if (typeof t !== 'string' || !t) return 'unknown';
  // ORBIT chains are colon-separated ("A:B"); the converter keys off the last
  // dot-segment of each, so mirror that to get the renderer's view of the type.
  const tail = t.split(':').pop() ?? t;
  return tail.split('.').pop() ?? tail;
}

/**
 * Describe the on-the-wire shape of a value the stock SpeckleConverter cares
 * about (vertices/faces/displayValue). Distinguishes the cases that decide
 * whether `MeshToNode` will early-return:
 *   - `number[]`  — inline geometry (what ORBIT's serialiser emits)
 *   - `ref[]`     — detached `{ referencedId }` chunk/mesh stubs
 *   - `chunk[]`   — already-dechunked `{ data:[…] }` wrappers
 *   - `empty[]`   — present but zero-length (→ "no vertex position data")
 *   - `missing`   — field absent entirely
 */
function describeGeomField(v: unknown): { kind: string; length: number; sample?: unknown } {
  if (v === undefined || v === null) return { kind: 'missing', length: 0 };
  if (Array.isArray(v)) {
    if (v.length === 0) return { kind: 'empty[]', length: 0 };
    const first = v[0] as unknown;
    if (typeof first === 'number') {
      return { kind: 'number[]', length: v.length, sample: v.slice(0, 6) };
    }
    if (first && typeof first === 'object') {
      const f = first as Record<string, unknown>;
      if (typeof f.referencedId === 'string') return { kind: 'ref[]', length: v.length, sample: f };
      if (Array.isArray(f.data)) return { kind: 'chunk[]', length: v.length };
      return { kind: `${typeof first}[]`, length: v.length, sample: first };
    }
    return { kind: `${typeof first}[]`, length: v.length };
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.referencedId === 'string') return { kind: 'ref', length: 1, sample: o };
    return { kind: 'object', length: 1 };
  }
  return { kind: typeof v, length: 0 };
}

/**
 * One-shot geometry diagnostic. The stock @speckle/viewer 2.31 SpeckleConverter
 * routes `Objects.Geometry.Mesh` → `MeshToNode`, traverses `displayValue` on
 * wrapper objects (incl. `Objects.Data.*:…RhinoObject`), and `dechunk()` accepts
 * inline `number[]` vertices — so a black screen with `Mesh > 0` nodes but
 * `batchCount: 0` can only mean the meshes reaching the converter carry
 * empty/absent `vertices`/`faces`. This dumps the ACTUAL wire shape of a real
 * Mesh + RhinoObject (and aggregate counts) so we can tell a producer problem
 * (headless tessellation emitted empty display meshes; ORBIT renders the native
 * `rawEncoding` instead) from a loader/normalisation problem (geometry present
 * but stored under a shape the converter rejects).
 */
function dumpOrbitGeometryDiagnostics(objects: RawSpeckleObject[]): void {
  const byId = new Map<string, RawSpeckleObject>();
  for (const o of objects) if (o.id) byId.set(o.id, o);

  const resolve = (entry: unknown): RawSpeckleObject | null => {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.referencedId === 'string') return byId.get(e.referencedId) ?? null;
    if (typeof e.speckle_type === 'string') return e as RawSpeckleObject;
    return null;
  };

  let meshTotal = 0;
  let meshWithVerts = 0;
  let meshWithFaces = 0;
  let firstMesh: RawSpeckleObject | null = null;
  let firstWrapper: RawSpeckleObject | null = null;
  const typeTally: Record<string, number> = {};

  for (const obj of objects) {
    const short = shortSpeckleType(obj.speckle_type);
    typeTally[short] = (typeTally[short] ?? 0) + 1;

    if (short === 'Mesh') {
      meshTotal += 1;
      const vKind = describeGeomField(obj.vertices);
      const fKind = describeGeomField(obj.faces);
      if (vKind.kind === 'number[]' && vKind.length > 0) meshWithVerts += 1;
      if (fKind.kind === 'number[]' && fKind.length > 0) meshWithFaces += 1;
      if (!firstMesh) firstMesh = obj;
    }

    const stLower = typeof obj.speckle_type === 'string' ? obj.speckle_type.toLowerCase() : '';
    const hasDisplay = obj.displayValue !== undefined || obj['@displayValue'] !== undefined;
    if (!firstWrapper && (short === 'RhinoObject' || stLower.includes('objects.data') || (hasDisplay && short !== 'Mesh'))) {
      firstWrapper = obj;
    }
  }

  console.log(`${ORBIT_VIEWER_LOG} [${ts()}] diag:orbit-geometry summary`, {
    objectCount: objects.length,
    typeTally,
    meshTotal,
    meshWithNonEmptyVertices: meshWithVerts,
    meshWithNonEmptyFaces: meshWithFaces,
    verdict: meshTotal === 0
      ? 'no-mesh-objects'
      : meshWithVerts === 0
        ? 'meshes-present-but-EMPTY-geometry (producer/convert-pipeline issue: display meshes have no vertices)'
        : meshWithVerts < meshTotal
          ? 'partial-geometry'
          : 'meshes-have-geometry (investigate converter/units/build, not vertex presence)',
  });

  if (firstMesh) {
    console.log(`${ORBIT_VIEWER_LOG} [${ts()}] diag:mesh-sample`, {
      id: firstMesh.id,
      speckle_type: firstMesh.speckle_type,
      keys: Object.keys(firstMesh),
      units: firstMesh.units,
      vertices: describeGeomField(firstMesh.vertices),
      faces: describeGeomField(firstMesh.faces),
      vertexNormals: describeGeomField(firstMesh.vertexNormals),
      colors: describeGeomField(firstMesh.colors),
      hasRenderMaterial: firstMesh.renderMaterial !== undefined,
    });
  }

  if (firstWrapper) {
    const dvRaw = (firstWrapper.displayValue ?? firstWrapper['@displayValue']) as unknown;
    const dv = describeGeomField(dvRaw);
    const dvEntries = Array.isArray(dvRaw) ? dvRaw : dvRaw ? [dvRaw] : [];
    const sampleMesh = dvEntries.length ? resolve(dvEntries[0]) : null;
    console.log(`${ORBIT_VIEWER_LOG} [${ts()}] diag:rhinoobject-sample`, {
      id: firstWrapper.id,
      speckle_type: firstWrapper.speckle_type,
      keys: Object.keys(firstWrapper),
      units: firstWrapper.units,
      displayValue: dv,
      displayValueResolvedMesh: sampleMesh
        ? {
            id: sampleMesh.id,
            speckle_type: sampleMesh.speckle_type,
            vertices: describeGeomField(sampleMesh.vertices),
            faces: describeGeomField(sampleMesh.faces),
          }
        : '(unresolved or none)',
      hasRawEncoding: firstWrapper.rawEncoding !== undefined || firstWrapper['@rawEncoding'] !== undefined,
    });
  }
}

const CLOSURE_BATCH_SIZE = 500;
const CLOSURE_MAX_DEPTH = 64;

/**
 * Fetch the COMPLETE object closure for an ORBIT version root via the PRISM
 * proxy, BFS-walking `{ referencedId }` stubs until every descendant — including
 * deeply-detached `DataChunk` vertices/faces — has been downloaded.
 *
 * Why we don't lean on ObjectLoader2's built-in closure download: it derives the
 * child set solely from the root object's `__closure` map. ORBIT payloads can
 * ship an incomplete closure (it omits the leaf DataChunks), so the bulk
 * download never fetches the chunk geometry and the converter's `dechunk()`
 * resolves vertices/faces to nothing → meshes with no render views → 0 batches
 * → black screen. The ORBIT 3rd-party-viewer guide explicitly recommends
 * reference-walking ("more resilient when closure is missing on older
 * payloads"), which is what the canonical PRISM Visualiser pipeline does.
 *
 * We hand the full object set to `ObjectLoader2Factory.createFromObjects`, so
 * the converter resolves every chunk from memory with no closure dependency and
 * no download-pipeline teardown race.
 */
export async function loadFullObjectClosure(
  serverUrl: string,
  projectId: string,
  rootObjectId: string,
): Promise<{ objects: RawSpeckleObject[]; chunkCount: number }> {
  const objects = new Map<string, RawSpeckleObject>();

  const rootUrl = `${serverUrl}/objects/${encodeURIComponent(projectId)}/${encodeURIComponent(rootObjectId)}/single`;
  const rootRes = await orbitViewerFetch(rootUrl);
  if (!rootRes.ok) {
    throw new Error(`ORBIT root object fetch failed: ${rootRes.status} ${rootRes.statusText}`);
  }
  const root = JSON.parse(await rootRes.text()) as RawSpeckleObject;
  if (!root.id) root.id = rootObjectId;
  objects.set(root.id, root);

  // Seed the frontier from both the (possibly partial) closure and any inline
  // reference stubs on the root.
  let pending = new Set<string>();
  if (root.__closure) {
    for (const id of Object.keys(root.__closure)) {
      // Skip blob ids in the closure — only objects are fetchable via
      // object-stream; blob ids would 404 and fail the whole batch.
      if (isOrbitObjectId(id)) pending.add(id);
    }
  }
  collectReferencedIds(root, pending);
  pending.delete(root.id);

  const streamUrl = `${serverUrl}/api/v2/projects/${encodeURIComponent(projectId)}/object-stream/`;
  let chunkCount = 0;

  for (let depth = 1; pending.size > 0 && depth <= CLOSURE_MAX_DEPTH; depth += 1) {
    const ids = [...pending].filter((id) => !objects.has(id));
    pending = new Set<string>();
    if (!ids.length) break;

    for (let i = 0; i < ids.length; i += CLOSURE_BATCH_SIZE) {
      const slice = ids.slice(i, i + CLOSURE_BATCH_SIZE);
      const res = await orbitViewerFetch(streamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objectIds: slice }),
      });
      if (!res.ok) {
        throw new Error(`ORBIT object-stream batch failed: ${res.status} ${res.statusText}`);
      }
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (!line) continue;
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        const id = line.slice(0, tab);
        let obj: RawSpeckleObject;
        try {
          obj = JSON.parse(line.slice(tab + 1)) as RawSpeckleObject;
        } catch {
          continue;
        }
        if (!obj.id) obj.id = id;
        if (typeof obj.speckle_type === 'string' && obj.speckle_type.includes('DataChunk')) {
          chunkCount += 1;
        }
        objects.set(id, obj);
        const refs = new Set<string>();
        collectReferencedIds(obj, refs);
        for (const r of refs) if (!objects.has(r)) pending.add(r);
      }
    }
  }

  // Rebuild the root closure to the complete id set so ObjectLoader2's iterator
  // (and our progress reporting) accounts for every object we downloaded.
  const fullClosure: Record<string, number> = {};
  for (const id of objects.keys()) if (id !== root.id) fullClosure[id] = 1;
  root.__closure = fullClosure;

  // Root must be first — createFromObjects treats objects[0] as the root.
  const ordered: RawSpeckleObject[] = [root];
  for (const [id, obj] of objects) if (id !== root.id) ordered.push(obj);
  return { objects: ordered, chunkCount };
}

/**
 * Loads an ORBIT version root object into a Speckle WorldTree via the PRISM
 * object proxy. Mirrors SpeckleLoader but uses ObjectLoader2Factory directly
 * so serverUrl can point at our proxy prefix.
 */
export class OrbitProxySpeckleLoader extends Loader {
  private loader: ObjectLoader2 | null = null;
  private converter: SpeckleConverter | null = null;
  private tree: WorldTree;
  private isCancelled = false;
  private isFinished = false;
  private readonly target: 'prod' | 'dev';
  private readonly projectId: string;
  private readonly rootObjectId: string;
  private readonly serverUrl: string;
  private readonly preloadedObjects: RawSpeckleObject[] | null;

  constructor(
    tree: WorldTree,
    params: {
      target: 'prod' | 'dev';
      projectId: string;
      rootObjectId: string;
      resourceLabel?: string;
      /** When set, skip network closure download (quad-view shared session). */
      preloadedObjects?: RawSpeckleObject[];
    },
  ) {
    const label = params.resourceLabel
      ?? `${params.projectId}/${params.rootObjectId.slice(0, 8)}`;
    super(label);
    this.tree = tree;
    this._resource = label;
    this.target = params.target;
    this.projectId = params.projectId;
    this.rootObjectId = params.rootObjectId;
    this.serverUrl = orbitViewerProxyBase(params.target);
    this.preloadedObjects = params.preloadedObjects ?? null;

    console.log(`${ORBIT_VIEWER_LOG} [${ts()}] loader:init`, {
      target: params.target,
      projectId: params.projectId,
      rootObjectId: `${params.rootObjectId.slice(0, 12)}…`,
      serverUrl: this.serverUrl,
      resourceLabel: label,
      preloaded: Boolean(this.preloadedObjects),
    });
  }

  get resource(): string {
    return this._resource;
  }

  get finished(): boolean {
    return this.isFinished;
  }

  async load(): Promise<boolean> {
    const started = performance.now();
    let first = true;
    let finalize: Promise<void> | null = null;
    let loaded = 0;

    console.log(`${ORBIT_VIEWER_LOG} [${ts()}] loader:load start`, { resource: this.resource });

    // Resolve the FULL object closure (incl. detached DataChunk vertices/faces)
    // up front, then drive the converter from an in-memory loader. This avoids
    // ObjectLoader2's closure-only child download, which misses chunks ORBIT
    // omits from `__closure` and leaves meshes geometry-less (0 batches).
    try {
      const closureStart = performance.now();
      let objects: RawSpeckleObject[];
      let chunkCount = 0;
      if (this.preloadedObjects) {
        objects = this.preloadedObjects;
        chunkCount = objects.filter(
          (o) => typeof o.speckle_type === 'string' && o.speckle_type.includes('DataChunk'),
        ).length;
        console.log(`${ORBIT_VIEWER_LOG} [${ts()}] loader:closure-preloaded`, {
          resource: this.resource,
          objectCount: objects.length,
          chunkCount,
        });
      } else {
        const closure = await loadFullObjectClosure(
          this.serverUrl,
          this.projectId,
          this.rootObjectId,
        );
        objects = closure.objects;
        chunkCount = closure.chunkCount;
      }
      console.log(`${ORBIT_VIEWER_LOG} [${ts()}] loader:closure-resolved`, {
        resource: this.resource,
        objectCount: objects.length,
        chunkCount,
        ms: Math.round(performance.now() - closureStart),
      });
      // Decisive evidence dump: prints the real wire shape of a Mesh +
      // RhinoObject and whether any mesh actually carries vertices/faces. This
      // is what tells us if the black screen is empty producer geometry vs a
      // converter/normalisation mismatch (see fn docstring).
      try {
        dumpOrbitGeometryDiagnostics(objects);
      } catch (diagErr) {
        console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] diag:orbit-geometry failed`, diagErr);
      }
      if (objects.length === 0 || !objects[0]?.id) {
        throw new Error('ORBIT version root object could not be resolved.');
      }
      this.loader = ObjectLoader2Factory.createFromObjects(
        objects as unknown as Parameters<typeof ObjectLoader2Factory.createFromObjects>[0],
      );
      this.converter = new SpeckleConverter(this.loader, this.tree);
    } catch (err) {
      console.error(`${ORBIT_VIEWER_LOG} [${ts()}] loader:closure error`, {
        resource: this.resource,
        error: err,
      });
      throw mapOrbitLoaderError(err);
    }

    const loader = this.loader;
    const converter = this.converter;
    if (!loader || !converter) {
      throw new Error('ORBIT loader failed to initialize.');
    }

    let total = 0;
    try {
      total = await loader.getTotalObjectCount();
      console.log(`${ORBIT_VIEWER_LOG} [${ts()}] loader:object-count`, { total });

      for await (const obj of loader.getObjectIterator()) {
        if (this.isCancelled) {
          console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] loader:cancelled`, { loaded });
          this.emit(LoaderEvent.LoadCancelled, this.resource);
          return false;
        }
        if (first) {
          const rootType = (obj as SpeckleObject)?.speckle_type ?? (obj as SpeckleObject)?.type ?? 'unknown';
          console.log(`${ORBIT_VIEWER_LOG} [${ts()}] converter:traverse start`, {
            resource: this.resource,
            rootType,
          });
          finalize = converter.traverse(this.resource, obj as SpeckleObject, (count) => {
            this.emit(LoaderEvent.Traversed, { count });
          });
          first = false;
        }
        loaded += 1;
        if (loaded === 1 || loaded % 50 === 0 || loaded === total) {
          console.log(`${ORBIT_VIEWER_LOG} [${ts()}] loader:progress`, {
            loaded,
            total,
            pct: total > 0 ? Math.round((loaded / total) * 100) : 0,
          });
        }
        this.emit(LoaderEvent.LoadProgress, {
          progress: loaded / (total + 1),
          id: this.resource,
        });
      }
    } catch (err) {
      console.error(`${ORBIT_VIEWER_LOG} [${ts()}] loader:load error`, {
        resource: this.resource,
        loaded,
        error: err,
      });
      throw mapOrbitLoaderError(err);
    }

    if (finalize) {
      console.log(`${ORBIT_VIEWER_LOG} [${ts()}] converter:traverse finalize`);
      await finalize;
    }

    if (loaded === 0) {
      console.error(`${ORBIT_VIEWER_LOG} [${ts()}] loader:empty-geometry`, {
        resource: this.resource,
        totalReported: total,
      });
      throw new Error(
        'No renderable geometry in this ORBIT version. Confirm the model has a published version and your Settings token can read it.',
      );
    }

    // `converter.traverse` only populates the WorldTree (nodes + dechunked
    // geometry on `node.model.raw`). It does NOT create render views — that is
    // a SEPARATE post-traverse pass the stock SpeckleLoader runs and which this
    // loader was missing entirely. Without it, every node's `renderView` stays
    // null, so `Viewer.loadObject` → `speckleRenderer.addRenderTree` builds 0
    // batches and the canvas is black even though the mesh geometry is valid
    // (diag:orbit-geometry confirmed all 12 meshes carry vertices/faces, yet
    // diag:scene reported batchCount 0 / nodesWithRenderView 0). Mirror the
    // stock loader: resolve instances + materials, then build the render tree
    // through SpeckleGeometryConverter, which sets `renderView` on each node.
    try {
      await converter.convertInstances();
      await converter.applyMaterials();
      await converter.handleDuplicates();

      const renderTree = this.tree.getRenderTree(this.resource);
      if (!renderTree) {
        throw new Error('ORBIT render tree could not be resolved for the loaded resource.');
      }
      const geometryConverter = new SpeckleGeometryConverter();
      let renderNodeCount = 0;
      await renderTree.buildRenderTree(geometryConverter, (count) => {
        renderNodeCount = count;
        // Converted is the event Viewer/extensions expect once render views
        // exist; the stock loader emits it from this same callback.
        this.emit(LoaderEvent.Converted, { count });
      });
      console.log(`${ORBIT_VIEWER_LOG} [${ts()}] loader:render-tree built`, {
        resource: this.resource,
        renderNodeCount,
      });
    } catch (err) {
      console.error(`${ORBIT_VIEWER_LOG} [${ts()}] loader:render-tree error`, {
        resource: this.resource,
        error: err,
      });
      throw mapOrbitLoaderError(err);
    }

    this.isFinished = true;
    // Emit a final 100% — the per-object progress uses (total + 1) as the
    // denominator so it tops out at ~98% even after every object is loaded.
    this.emit(LoaderEvent.LoadProgress, { progress: 1, id: this.resource });
    console.log(`${ORBIT_VIEWER_LOG} [${ts()}] loader:load complete`, {
      resource: this.resource,
      objects: loaded,
      ms: Math.round(performance.now() - started),
    });
    return true;
  }

  cancel(): void {
    console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] loader:cancel requested`, { resource: this.resource });
    this.isCancelled = true;
  }

  override dispose(): void {
    console.log(`${ORBIT_VIEWER_LOG} [${ts()}] loader:dispose`, { resource: this.resource });
    void this.loader?.disposeAsync();
    this.loader = null;
    this.converter = null;
    super.dispose();
  }
}
