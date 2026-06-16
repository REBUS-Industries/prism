/**
 * Speckle viewer loader that fetches ORBIT objects through the PRISM server
 * proxy (`/api/orbit/viewer/:target/...`) so the browser never sees the PAT.
 */
import { ObjectLoader2Factory } from '@speckle/objectloader2';
import type { ObjectLoader2 } from '@speckle/objectloader2';
import { Loader, LoaderEvent, SpeckleConverter, type SpeckleObject } from '@speckle/viewer';
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

type RawSpeckleObject = Record<string, unknown> & {
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
async function loadFullObjectClosure(
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
  if (root.__closure) for (const id of Object.keys(root.__closure)) pending.add(id);
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

  constructor(
    tree: WorldTree,
    params: {
      target: 'prod' | 'dev';
      projectId: string;
      rootObjectId: string;
      resourceLabel?: string;
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

    console.log(`${ORBIT_VIEWER_LOG} [${ts()}] loader:init`, {
      target: params.target,
      projectId: params.projectId,
      rootObjectId: `${params.rootObjectId.slice(0, 12)}…`,
      serverUrl: this.serverUrl,
      resourceLabel: label,
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
      const { objects, chunkCount } = await loadFullObjectClosure(
        this.serverUrl,
        this.projectId,
        this.rootObjectId,
      );
      console.log(`${ORBIT_VIEWER_LOG} [${ts()}] loader:closure-resolved`, {
        resource: this.resource,
        objectCount: objects.length,
        chunkCount,
        ms: Math.round(performance.now() - closureStart),
      });
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

    this.isFinished = true;
    // Emit a final 100% — the per-object progress uses (total + 1) as the
    // denominator so it tops out at ~98% even after every object is loaded.
    this.emit(LoaderEvent.LoadProgress, { progress: 1, id: this.resource });
    this.emit(LoaderEvent.Converted, { count: loaded });
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
