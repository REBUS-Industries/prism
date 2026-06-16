/**
 * Speckle viewer loader that fetches ORBIT objects through the PRISM server
 * proxy (`/api/orbit/viewer/:target/...`) so the browser never sees the PAT.
 */
import { ObjectLoader2Factory } from '@speckle/objectloader2';
import type { ObjectLoader2 } from '@speckle/objectloader2';
import { Loader, LoaderEvent, SpeckleConverter, type SpeckleObject } from '@speckle/viewer';
import type { WorldTree } from '@speckle/viewer';

export function orbitViewerProxyBase(target: 'prod' | 'dev'): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/api/orbit/viewer/${target}`;
}

/** Custom fetch that forwards admin session cookies to the PRISM proxy. */
export function orbitViewerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, credentials: 'same-origin' });
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
    this.loader = ObjectLoader2Factory.createFromUrl({
      serverUrl: orbitViewerProxyBase(params.target),
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

    const total = await this.loader.getTotalObjectCount();
    for await (const obj of this.loader.getObjectIterator()) {
      if (this.isCancelled) {
        this.emit(LoaderEvent.LoadCancelled, this.resource);
        return false;
      }
      if (first) {
        finalize = this.converter.traverse(this.resource, obj as SpeckleObject, (count) => {
          this.emit(LoaderEvent.Traversed, { count });
        });
        first = false;
      }
      loaded += 1;
      this.emit(LoaderEvent.LoadProgress, {
        progress: loaded / (total + 1),
        id: this.resource,
      });
    }

    if (finalize) await finalize;
    if (loaded === 0) {
      this.emit(LoaderEvent.LoadWarning, { message: 'No renderable geometry in ORBIT version.' });
    }
    this.isFinished = true;
    this.emit(LoaderEvent.Converted, { count: loaded });
    if (import.meta.env.DEV) {
      console.debug(
        `[OrbitProxySpeckleLoader] converted ${this.resource} in ${((performance.now() - started) / 1000).toFixed(1)}s`,
      );
    }
    return true;
  }

  cancel(): void {
    this.isCancelled = true;
  }

  override dispose(): void {
    void this.loader.disposeAsync();
    super.dispose();
  }
}
