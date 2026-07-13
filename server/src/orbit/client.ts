/**
 * Minimal ORBIT GraphQL client.
 *
 * Used by the admin Settings page (to verify a token works) and the public
 * Convert SPA (to populate project/model dropdowns). We hold the credentials
 * server-side — clients never see the token, they just see results.
 *
 * The schema we target is standard Speckle V2 (ORBIT is a fork of Speckle).
 * If ORBIT ever diverges, only this file needs to change.
 */
import { getSetting } from '../db/settings.js';

export type OrbitTarget = 'prod' | 'dev';

export interface OrbitCreds {
  url: string;
  token: string;
}

export interface OrbitServerInfo {
  name: string;
  version: string;
  company?: string | null;
}

export interface OrbitUser {
  id: string;
  name: string;
  email?: string | null;
  role?: string | null;
}

export interface OrbitProjectSummary {
  id: string;
  name: string;
  description?: string | null;
  role?: string | null;
  visibility?: string | null;
  updatedAt?: string | null;
}

export interface OrbitModelSummary {
  id: string;
  name: string;
  displayName?: string | null;
  description?: string | null;
  previewUrl?: string | null;
  updatedAt?: string | null;
}

export interface OrbitVersionSummary {
  id: string;
  message?: string | null;
  createdAt: string;
  sourceApplication?: string | null;
  referencedObject?: string | null;
  authorName?: string | null;
}

export class OrbitClientError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
    this.name = 'OrbitClientError';
  }
}

/**
 * Resolve credentials for the requested target. Returns `null` when the
 * admin hasn't configured a URL or token — callers should surface that to
 * the UI rather than treating it as an error.
 */
export async function getOrbitCreds(_target: OrbitTarget = 'prod'): Promise<OrbitCreds | null> {
  // ORBIT dev/staging was retired — every target resolves to the single
  // production server (`orbit_server_url` / `orbit_token`).
  const url   = (await getSetting('orbit_server_url'))?.trim();
  const token = (await getSetting('orbit_token'))?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

async function gql<T>(creds: OrbitCreds, query: string, variables?: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${creds.url}/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${creds.token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new OrbitClientError(0, `cannot reach ORBIT at ${creds.url}: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OrbitClientError(res.status, `ORBIT returned ${res.status}`, text);
  }

  let json: { data?: T; errors?: Array<{ message: string }> };
  try {
    json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  } catch {
    throw new OrbitClientError(502, 'ORBIT returned non-JSON');
  }

  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join('; ');
    // First GraphQL error usually tells us if auth was rejected.
    const isAuth = /not authoriz|forbidden|token|unauthor/i.test(msg);
    throw new OrbitClientError(isAuth ? 401 : 400, msg, json.errors);
  }
  if (!json.data) throw new OrbitClientError(502, 'ORBIT response missing data');
  return json.data;
}

const TEST_QUERY = `query Test {
  activeUser { id name email role }
  serverInfo { name version company }
}`;

interface TestResult {
  activeUser: OrbitUser | null;
  serverInfo: OrbitServerInfo;
}

/**
 * Verify that the configured token works for the given target. Returns the
 * authenticated user + serverInfo on success. Throws `OrbitClientError`
 * with a useful status code on any failure.
 */
export async function testConnection(target: OrbitTarget): Promise<{
  ok: true;
  user: OrbitUser;
  serverInfo: OrbitServerInfo;
} | {
  ok: false;
  reason: 'no-creds' | 'no-user';
  serverInfo?: OrbitServerInfo;
}> {
  const creds = await getOrbitCreds(target);
  if (!creds) return { ok: false, reason: 'no-creds' };

  const data = await gql<TestResult>(creds, TEST_QUERY);
  if (!data.activeUser) {
    return { ok: false, reason: 'no-user', serverInfo: data.serverInfo };
  }
  return { ok: true, user: data.activeUser, serverInfo: data.serverInfo };
}

const PROJECTS_QUERY = `query Projects($limit: Int!, $cursor: String) {
  activeUser {
    projects(limit: $limit, cursor: $cursor) {
      totalCount
      cursor
      items { id name description updatedAt role visibility }
    }
  }
}`;

interface ProjectsResult {
  activeUser: { projects: { totalCount: number; cursor: string | null; items: OrbitProjectSummary[] } } | null;
}

/**
 * List projects visible to the configured token's user.
 *
 * The Speckle/ORBIT GraphQL API paginates with cursors. We pull up to
 * `limit` (default 100) projects in a single page; callers that need
 * more can pass an explicit cursor.
 */
export async function listProjects(target: OrbitTarget, opts: { limit?: number; cursor?: string } = {}): Promise<{
  totalCount: number;
  cursor: string | null;
  items: OrbitProjectSummary[];
}> {
  const creds = await getOrbitCreds(target);
  if (!creds) throw new OrbitClientError(412, `ORBIT ${target} credentials not configured`);

  const data = await gql<ProjectsResult>(creds, PROJECTS_QUERY, {
    limit: opts.limit ?? 100,
    cursor: opts.cursor ?? null,
  });
  if (!data.activeUser) throw new OrbitClientError(401, 'ORBIT token has no active user');
  return data.activeUser.projects;
}

const MODELS_QUERY = `query Models($projectId: String!, $limit: Int!, $cursor: String) {
  project(id: $projectId) {
    id
    name
    models(limit: $limit, cursor: $cursor) {
      totalCount
      cursor
      items { id name displayName description previewUrl updatedAt }
    }
  }
}`;

interface ModelsResult {
  project: {
    id: string;
    name: string;
    models: { totalCount: number; cursor: string | null; items: OrbitModelSummary[] };
  } | null;
}

export async function listModels(target: OrbitTarget, projectId: string, opts: { limit?: number; cursor?: string } = {}): Promise<{
  projectName: string;
  totalCount: number;
  cursor: string | null;
  items: OrbitModelSummary[];
}> {
  const creds = await getOrbitCreds(target);
  if (!creds) throw new OrbitClientError(412, `ORBIT ${target} credentials not configured`);

  const data = await gql<ModelsResult>(creds, MODELS_QUERY, {
    projectId,
    limit: opts.limit ?? 200,
    cursor: opts.cursor ?? null,
  });
  if (!data.project) throw new OrbitClientError(404, `project ${projectId} not found`);
  return {
    projectName: data.project.name,
    totalCount: data.project.models.totalCount,
    cursor: data.project.models.cursor,
    items: data.project.models.items,
  };
}

/* -------------------------------------------------------------------------- */
/* Version resolution                                                          */
/* -------------------------------------------------------------------------- */

const LATEST_VERSION_QUERY = `query LatestVersion($projectId: String!, $modelId: String!) {
  project(id: $projectId) {
    model(id: $modelId) {
      versions(limit: 1) {
        items { id referencedObject }
      }
    }
  }
}`;

interface LatestVersionResult {
  project: {
    model: {
      versions: { items: Array<{ id: string; referencedObject: string | null }> };
    } | null;
  } | null;
}

/**
 * Resolve the most recent version id for a model. Used by the visualiser
 * dispatcher to fill in `run.versionId` when the caller omitted it
 * (meaning "use the latest version"). Returns `null` when the model has
 * no versions yet.
 */
export async function getLatestVersionId(
  target: OrbitTarget,
  projectId: string,
  modelId: string,
): Promise<string | null> {
  const latest = await getLatestVersionDescriptor(target, projectId, modelId);
  return latest?.versionId ?? null;
}

const VERSION_QUERY = `query Version($projectId: String!, $versionId: String!) {
  project(id: $projectId) {
    version(id: $versionId) {
      id
      referencedObject
      model { id }
    }
  }
}`;

interface VersionResult {
  project: {
    version: {
      id: string;
      referencedObject: string | null;
      model: { id: string } | null;
    } | null;
  } | null;
}

export interface OrbitVersionDescriptor {
  projectId: string;
  modelId: string;
  versionId: string;
  rootObjectId: string;
}

async function getLatestVersionDescriptor(
  target: OrbitTarget,
  projectId: string,
  modelId: string,
): Promise<OrbitVersionDescriptor | null> {
  const creds = await getOrbitCreds(target);
  if (!creds) throw new OrbitClientError(412, `ORBIT ${target} credentials not configured`);

  const data = await gql<LatestVersionResult>(creds, LATEST_VERSION_QUERY, {
    projectId,
    modelId,
  });
  if (!data.project) throw new OrbitClientError(404, `project ${projectId} not found`);
  if (!data.project.model) throw new OrbitClientError(404, `model ${modelId} not found in project ${projectId}`);
  const item = data.project.model.versions.items[0];
  if (!item?.id || !item.referencedObject) return null;
  return {
    projectId,
    modelId,
    versionId: item.id,
    rootObjectId: item.referencedObject,
  };
}

/**
 * Resolve a model version to its root object hash for third-party viewers.
 * When `versionId` is omitted, uses the latest commit on the model.
 */
const MODEL_VERSIONS_QUERY = `query ModelVersions($projectId: String!, $modelId: String!, $limit: Int!, $cursor: String) {
  project(id: $projectId) {
    model(id: $modelId) {
      id
      name
      versions(limit: $limit, cursor: $cursor) {
        totalCount
        cursor
        items {
          id
          message
          createdAt
          sourceApplication
          referencedObject
          authorUser { name }
        }
      }
    }
  }
}`;

interface ModelVersionsResult {
  project: {
    model: {
      id: string;
      name: string;
      versions: {
        totalCount: number;
        cursor: string | null;
        items: Array<{
          id: string;
          message?: string | null;
          createdAt: string;
          sourceApplication?: string | null;
          referencedObject?: string | null;
          authorUser?: { name?: string | null } | null;
        }>;
      };
    } | null;
  } | null;
}

/** List versions for a model (newest first). */
export async function listModelVersions(
  target: OrbitTarget,
  projectId: string,
  modelId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{
  modelName: string;
  totalCount: number;
  cursor: string | null;
  items: OrbitVersionSummary[];
}> {
  const creds = await getOrbitCreds(target);
  if (!creds) throw new OrbitClientError(412, `ORBIT ${target} credentials not configured`);

  const data = await gql<ModelVersionsResult>(creds, MODEL_VERSIONS_QUERY, {
    projectId,
    modelId,
    limit: opts.limit ?? 100,
    cursor: opts.cursor ?? null,
  });
  if (!data.project) throw new OrbitClientError(404, `project ${projectId} not found`);
  if (!data.project.model) throw new OrbitClientError(404, `model ${modelId} not found in project ${projectId}`);
  const versions = data.project.model.versions;
  return {
    modelName: data.project.model.name,
    totalCount: versions.totalCount,
    cursor: versions.cursor,
    items: versions.items.map((v) => ({
      id: v.id,
      message: v.message ?? null,
      createdAt: v.createdAt,
      sourceApplication: v.sourceApplication ?? null,
      referencedObject: v.referencedObject ?? null,
      authorName: v.authorUser?.name ?? null,
    })),
  };
}

export async function resolveModelVersion(
  target: OrbitTarget,
  projectId: string,
  modelId: string,
  versionId?: string,
): Promise<OrbitVersionDescriptor> {
  if (!versionId) {
    const latest = await getLatestVersionDescriptor(target, projectId, modelId);
    if (!latest) {
      throw new OrbitClientError(404, `model ${modelId} has no versions on ORBIT ${target}`);
    }
    return latest;
  }

  const creds = await getOrbitCreds(target);
  if (!creds) throw new OrbitClientError(412, `ORBIT ${target} credentials not configured`);

  const data = await gql<VersionResult>(creds, VERSION_QUERY, { projectId, versionId });
  const node = data.project?.version;
  if (!node?.referencedObject) {
    throw new OrbitClientError(404, `version ${versionId} not found in project ${projectId}`);
  }
  return {
    projectId,
    modelId: node.model?.id ?? modelId,
    versionId: node.id,
    rootObjectId: node.referencedObject,
  };
}

/* -------------------------------------------------------------------------- */
/* Object + blob fetch (3rd-party viewer proxy)                                */
/* -------------------------------------------------------------------------- */

async function orbitFetch(creds: OrbitCreds, path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${creds.url}/${path.replace(/^\/+/, '')}`, {
      ...init,
      headers: {
        authorization: `Bearer ${creds.token}`,
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new OrbitClientError(0, `cannot reach ORBIT at ${creds.url}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const isAuth = res.status === 401 || res.status === 403;
    throw new OrbitClientError(
      isAuth ? 401 : res.status || 502,
      `ORBIT GET ${path} returned ${res.status}`,
      text,
    );
  }
  return res;
}

/** Download one object JSON body (`GET /objects/{projectId}/{id}/single`). */
export async function fetchObjectJson(
  target: OrbitTarget,
  projectId: string,
  objectId: string,
): Promise<string> {
  const creds = await getOrbitCreds(target);
  if (!creds) throw new OrbitClientError(412, `ORBIT ${target} credentials not configured`);
  const res = await orbitFetch(
    creds,
    `objects/${encodeURIComponent(projectId)}/${encodeURIComponent(objectId)}/single`,
  );
  return res.text();
}

/** Download a texture/attachment blob (`GET /api/stream/{projectId}/blob/{id}`). */
export async function fetchBlob(
  target: OrbitTarget,
  projectId: string,
  blobId: string,
): Promise<Buffer> {
  const creds = await getOrbitCreds(target);
  if (!creds) throw new OrbitClientError(412, `ORBIT ${target} credentials not configured`);
  const res = await orbitFetch(
    creds,
    `api/stream/${encodeURIComponent(projectId)}/blob/${encodeURIComponent(blobId)}`,
  );
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

const OBJECT_BATCH_CONCURRENCY = 8;

/**
 * Speckle ObjectLoader2 batch download adapter. ORBIT production exposes
 * per-object `/single` GETs; upstream Speckle v2 expects NDJSON from
 * `POST /api/v2/projects/{id}/object-stream/`.
 */
export async function fetchObjectBatch(
  target: OrbitTarget,
  projectId: string,
  objectIds: string[],
): Promise<string> {
  const unique = [...new Set(objectIds.filter(Boolean))];
  if (!unique.length) return '';

  const lines: string[] = new Array(unique.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= unique.length) return;
      const id = unique[idx]!;
      try {
        const json = await fetchObjectJson(target, projectId, id);
        lines[idx] = `${id}\t${json}`;
      } catch (err) {
        // A requested id may not be an object (e.g. a blob id that leaked in
        // from a version closure). Skip it instead of failing the whole batch.
        if (err instanceof OrbitClientError && err.status === 404) {
          lines[idx] = '';
          continue;
        }
        throw err;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(OBJECT_BATCH_CONCURRENCY, unique.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return `${lines.filter((l) => l).join('\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

const CREATE_PROJECT_MUTATION = `mutation CreateProject($name: String!, $description: String) {
  projectMutations {
    create(input: { name: $name, description: $description }) {
      id name description role visibility updatedAt
    }
  }
}`;

interface CreateProjectResult {
  projectMutations: { create: OrbitProjectSummary };
}

export async function createProject(
  target: OrbitTarget,
  name: string,
  description?: string,
): Promise<OrbitProjectSummary> {
  const creds = await getOrbitCreds(target);
  if (!creds) throw new OrbitClientError(412, `ORBIT ${target} credentials not configured`);
  const data = await gql<CreateProjectResult>(creds, CREATE_PROJECT_MUTATION, {
    name,
    description: description ?? null,
  });
  return data.projectMutations.create;
}

const CREATE_MODEL_MUTATION = `mutation CreateModel($input: CreateModelInput!) {
  modelMutations {
    create(input: $input) {
      id name displayName description previewUrl updatedAt
    }
  }
}`;

interface CreateModelResult {
  modelMutations: { create: OrbitModelSummary };
}

export async function createModel(
  target: OrbitTarget,
  projectId: string,
  name: string,
  description?: string,
): Promise<OrbitModelSummary> {
  const creds = await getOrbitCreds(target);
  if (!creds) throw new OrbitClientError(412, `ORBIT ${target} credentials not configured`);
  const data = await gql<CreateModelResult>(creds, CREATE_MODEL_MUTATION, {
    input: { projectId, name, description: description ?? null },
  });
  return data.modelMutations.create;
}

const DELETE_VERSIONS_MUTATION = `mutation DeleteVersions($input: DeleteVersionsInput!) {
  versionMutations {
    delete(input: $input)
  }
}`;

interface DeleteVersionsResult {
  versionMutations: { delete: boolean };
}

/** Permanently delete one or more model versions on ORBIT. */
export async function deleteModelVersions(
  target: OrbitTarget,
  projectId: string,
  versionIds: string[],
): Promise<boolean> {
  const ids = [...new Set(versionIds.map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) throw new OrbitClientError(400, 'versionIds is required');

  const creds = await getOrbitCreds(target);
  if (!creds) throw new OrbitClientError(412, `ORBIT ${target} credentials not configured`);

  const data = await gql<DeleteVersionsResult>(creds, DELETE_VERSIONS_MUTATION, {
    input: { projectId, versionIds: ids },
  });
  return data.versionMutations.delete;
}

/** Version ids with createdAt strictly before `before`, keeping at least one version on the model. */
export function selectVersionIdsDeletableBefore(
  items: OrbitVersionSummary[],
  before: Date,
): string[] {
  if (items.length <= 1) return [];
  const cutoff = before.getTime();
  const deletable = items.filter((v) => {
    const t = Date.parse(v.createdAt);
    return Number.isFinite(t) && t < cutoff;
  });
  if (!deletable.length) return [];
  const ids = deletable.map((v) => v.id);
  if (ids.length >= items.length) {
    return ids.filter((id) => id !== items[0]!.id);
  }
  return ids;
}

async function listAllModelVersions(
  target: OrbitTarget,
  projectId: string,
  modelId: string,
): Promise<OrbitVersionSummary[]> {
  const all: OrbitVersionSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await listModelVersions(target, projectId, modelId, { limit: 100, cursor });
    all.push(...res.items);
    if (!res.cursor || all.length >= res.totalCount) break;
    cursor = res.cursor;
  }
  return all;
}

export async function purgeModelVersionsBefore(
  target: OrbitTarget,
  projectId: string,
  modelId: string,
  before: Date,
  dryRun: boolean,
): Promise<{ versionIds: string[]; deleted: number }> {
  const items = await listAllModelVersions(target, projectId, modelId);
  const versionIds = selectVersionIdsDeletableBefore(items, before);
  if (!versionIds.length || dryRun) {
    return { versionIds, deleted: 0 };
  }
  await deleteModelVersions(target, projectId, versionIds);
  return { versionIds, deleted: versionIds.length };
}

export interface PurgeModelsVersionsResult {
  dryRun: boolean;
  before: string;
  modelsScanned: number;
  modelsWithDeletions: number;
  versionCount: number;
  deletedCount: number;
  failures: Array<{ modelId: string; error: string }>;
}

/** Delete Orbit versions older than `before` across many models (one project). */
export async function purgeModelsVersionsBefore(
  target: OrbitTarget,
  projectId: string,
  modelIds: string[],
  before: Date,
  dryRun: boolean,
): Promise<PurgeModelsVersionsResult> {
  const unique = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))];
  let versionCount = 0;
  let deletedCount = 0;
  let modelsWithDeletions = 0;
  const failures: Array<{ modelId: string; error: string }> = [];

  for (const modelId of unique) {
    try {
      const r = await purgeModelVersionsBefore(target, projectId, modelId, before, dryRun);
      if (r.versionIds.length) {
        modelsWithDeletions += 1;
        versionCount += r.versionIds.length;
        deletedCount += r.deleted;
      }
    } catch (err) {
      failures.push({
        modelId,
        error: err instanceof OrbitClientError ? err.message : (err as Error).message ?? 'purge failed',
      });
    }
  }

  return {
    dryRun,
    before: before.toISOString(),
    modelsScanned: unique.length,
    modelsWithDeletions,
    versionCount,
    deletedCount,
    failures,
  };
}
