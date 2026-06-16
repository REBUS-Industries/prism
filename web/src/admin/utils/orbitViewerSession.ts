/**
 * Shared ORBIT viewer load session — dedupe version resolve + object closure
 * fetch across quad panes (and remounts) so we don't download the same graph 4×.
 */
import { orbitApi, type ModelOrbitRef } from '../../shared/api';
import {
  loadFullObjectClosure,
  orbitViewerProxyBase,
  type RawSpeckleObject,
} from './orbitSpeckleLoader';

export interface OrbitViewerResolvedVersion {
  target: 'prod' | 'dev';
  projectId: string;
  modelId: string;
  versionId: string;
  rootObjectId: string;
}

export interface OrbitViewerSession {
  resolved: OrbitViewerResolvedVersion;
  objects: RawSpeckleObject[];
  chunkCount: number;
}

function resolveCacheKey(ref: ModelOrbitRef): string {
  return `${ref.target}:${ref.projectId}:${ref.modelId}:${ref.versionId ?? ''}`;
}

function closureCacheKey(target: 'prod' | 'dev', projectId: string, rootObjectId: string): string {
  return `${target}:${projectId}:${rootObjectId}`;
}

const resolveInflight = new Map<string, Promise<OrbitViewerResolvedVersion>>();
const closureInflight = new Map<string, Promise<{ objects: RawSpeckleObject[]; chunkCount: number }>>();

function fetchResolvedVersion(ref: ModelOrbitRef): Promise<OrbitViewerResolvedVersion> {
  const key = resolveCacheKey(ref);
  let pending = resolveInflight.get(key);
  if (!pending) {
    pending = orbitApi.resolveViewerVersion(
      ref.target,
      ref.projectId,
      ref.modelId,
      ref.versionId,
    ).then((r) => ({
      target: r.target as 'prod' | 'dev',
      projectId: r.projectId,
      modelId: r.modelId,
      versionId: r.versionId,
      rootObjectId: r.rootObjectId,
    }));
    resolveInflight.set(key, pending);
    void pending.finally(() => {
      if (resolveInflight.get(key) === pending) resolveInflight.delete(key);
    });
  }
  return pending;
}

function fetchObjectClosure(
  target: 'prod' | 'dev',
  projectId: string,
  rootObjectId: string,
): Promise<{ objects: RawSpeckleObject[]; chunkCount: number }> {
  const key = closureCacheKey(target, projectId, rootObjectId);
  let pending = closureInflight.get(key);
  if (!pending) {
    const serverUrl = orbitViewerProxyBase(target);
    pending = loadFullObjectClosure(serverUrl, projectId, rootObjectId);
    closureInflight.set(key, pending);
    void pending.finally(() => {
      if (closureInflight.get(key) === pending) closureInflight.delete(key);
    });
  }
  return pending;
}

/** Resolve version + download full object closure once (shared by quad panes). */
export async function fetchOrbitViewerSession(ref: ModelOrbitRef): Promise<OrbitViewerSession> {
  const resolved = await fetchResolvedVersion(ref);
  const { objects, chunkCount } = await fetchObjectClosure(
    resolved.target,
    resolved.projectId,
    resolved.rootObjectId,
  );
  return { resolved, objects, chunkCount };
}

/** Drop cached inflight entries when orbit ref changes (e.g. after material sync). */
export function invalidateOrbitViewerSession(ref: ModelOrbitRef): void {
  resolveInflight.delete(resolveCacheKey(ref));
}
