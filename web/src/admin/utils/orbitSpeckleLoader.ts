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

/**
 * Loads an ORBIT version root object into a Speckle WorldTree via the PRISM
 * object proxy. Mirrors SpeckleLoader but uses ObjectLoader2Factory directly
 * so serverUrl can point at our proxy prefix.
 */
export class OrbitProxySpeckleLoader extends Loader {
  private loader: ObjectLoader2;
  private converter: SpeckleConverter;
  private tree: WorldTree;
  private isCancelled = false;
  private isFinished = false;

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

    const serverUrl = orbitViewerProxyBase(params.target);
    console.log(`${ORBIT_VIEWER_LOG} [${ts()}] loader:init`, {
      target: params.target,
      projectId: params.projectId,
      rootObjectId: `${params.rootObjectId.slice(0, 12)}…`,
      serverUrl,
      resourceLabel: label,
    });

    this.loader = ObjectLoader2Factory.createFromUrl({
      serverUrl,
      streamId: params.projectId,
      objectId: params.rootObjectId,
      token: '',
      options: {
        fetch: orbitViewerFetch,
        useCache: true,
      },
    });
    this.converter = new SpeckleConverter(this.loader, this.tree);
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

    let total = 0;
    try {
      total = await this.loader.getTotalObjectCount();
      console.log(`${ORBIT_VIEWER_LOG} [${ts()}] loader:object-count`, { total });

      for await (const obj of this.loader.getObjectIterator()) {
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
          finalize = this.converter.traverse(this.resource, obj as SpeckleObject, (count) => {
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
    void this.loader.disposeAsync();
    super.dispose();
  }
}
