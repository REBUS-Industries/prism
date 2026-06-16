/**
 * ORBIT REST upload helpers — object batches and texture blobs.
 */
import type { OrbitCreds } from './client.js';
import { computeBlobContentHash } from './objectHash.js';
import type { OrbitObjectJson } from './graphWalker.js';

const CREATE_VERSION_MUTATION = `mutation CreateVersion($input: CreateVersionInput!) {
  versionMutations {
    create(input: $input) {
      id
      referencedObject
      createdAt
      message
    }
  }
}`;

export interface CreateVersionInput {
  projectId: string;
  modelId: string;
  objectId: string;
  message?: string;
  sourceApplication?: string;
  totalChildrenCount?: number;
}

export interface CreateVersionResult {
  id: string;
  referencedObject: string;
  createdAt: string;
  message?: string | null;
}

async function orbitFetch(creds: OrbitCreds, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${creds.url}/${path.replace(/^\/+/, '')}`, {
    ...init,
    headers: {
      authorization: `Bearer ${creds.token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ORBIT ${init?.method ?? 'GET'} ${path} returned ${res.status}: ${text}`);
  }
  return res;
}

async function gqlWithCreds<T>(creds: OrbitCreds, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${creds.url}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${creds.token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ORBIT GraphQL returned ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  if (!json.data) throw new Error('ORBIT GraphQL response missing data');
  return json.data;
}

/** Speckle/ORBIT object batch field name (`@speckle/objectsender` ServerTransport). */
const OBJECT_BATCH_FIELD = 'object-batch';

/** ORBIT hard limit per POST /objects/{projectId} request (Speckle REST API). */
const MAX_OBJECT_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Upload one or more serialised objects (`POST /objects/{projectId}`). */
export async function uploadObjects(
  creds: OrbitCreds,
  projectId: string,
  objects: OrbitObjectJson[],
): Promise<void> {
  if (!objects.length) return;

  const json = JSON.stringify(objects);
  if (json.length > MAX_OBJECT_UPLOAD_BYTES) {
    throw new Error(
      `ORBIT object batch exceeds ${MAX_OBJECT_UPLOAD_BYTES} bytes — split the upload`,
    );
  }

  const form = new FormData();
  form.append(
    OBJECT_BATCH_FIELD,
    new Blob([json], { type: 'application/json' }),
    'batch.json',
  );

  const path = `objects/${encodeURIComponent(projectId)}`;
  const res = await fetch(`${creds.url}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${creds.token}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ORBIT POST ${path} returned ${res.status}: ${text}`);
  }
}

/**
 * Upload a texture file to ORBIT blob storage. Returns the server-assigned
 * blob id (10-char string), not the content hash.
 */
export async function uploadBlob(
  creds: OrbitCreds,
  projectId: string,
  bytes: Buffer,
  filename: string,
  contentType: string,
): Promise<string> {
  const form = new FormData();
  const blob = new Blob([bytes], { type: contentType });
  form.append('files', blob, filename);

  const res = await fetch(`${creds.url}/api/stream/${encodeURIComponent(projectId)}/blob`, {
    method: 'POST',
    headers: { authorization: `Bearer ${creds.token}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ORBIT blob upload returned ${res.status}: ${text}`);
  }
  const json = (await res.json()) as {
    uploadResults?: Array<{ blobId?: string }>;
  };
  const blobId = json.uploadResults?.[0]?.blobId;
  if (!blobId) throw new Error('ORBIT blob upload response missing blobId');
  return blobId;
}

/** Upload PRISM texture bytes; returns ORBIT blob id. */
export async function uploadTextureBytes(
  creds: OrbitCreds,
  projectId: string,
  bytes: Buffer,
  filename: string,
  contentType: string,
): Promise<{ blobId: string; contentHash: string }> {
  const contentHash = computeBlobContentHash(bytes);
  const blobId = await uploadBlob(creds, projectId, bytes, filename, contentType);
  return { blobId, contentHash };
}

export async function createVersion(
  creds: OrbitCreds,
  input: CreateVersionInput,
): Promise<CreateVersionResult> {
  const data = await gqlWithCreds<{
    versionMutations: { create: CreateVersionResult };
  }>(creds, CREATE_VERSION_MUTATION, {
    input: {
      projectId: input.projectId,
      modelId: input.modelId,
      objectId: input.objectId,
      message: input.message ?? 'PRISM material swap',
      sourceApplication: input.sourceApplication ?? 'PRISM',
      totalChildrenCount: input.totalChildrenCount ?? 0,
    },
  });
  return data.versionMutations.create;
}

export async function resolveOrbitCredsForRequest(
  target: 'prod' | 'dev',
  principal?: import('../auth/principal.js').Principal,
): Promise<OrbitCreds> {
  if (principal?.kind === 'orbitUser') {
    return { url: principal.serverUrl, token: principal.orbitToken };
  }
  const { getOrbitCreds, OrbitClientError } = await import('./client.js');
  const creds = await getOrbitCreds(target);
  if (!creds) throw new OrbitClientError(412, `ORBIT ${target} credentials not configured`);
  return creds;
}
