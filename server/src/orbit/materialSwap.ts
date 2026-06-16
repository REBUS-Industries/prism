/**
 * Orchestrate swapping an ORBIT mesh material with a PRISM library material.
 */
import { readFile } from 'node:fs/promises';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { textures } from '../db/schema.js';
import type { Principal } from '../auth/principal.js';
import { loadMaterialDetail } from '../materials/loadDetail.js';
import type { OrbitTarget } from './client.js';
import { OrbitClientError, resolveModelVersion } from './client.js';
import {
  downloadObjectGraph,
  findMeshInGraph,
  rehashGraphAfterMutation,
} from './graphWalker.js';
import {
  buildOrbitRenderMaterial,
  SLOT_TO_ORBIT,
  type OrbitTextureRefs,
} from './prismToRenderMaterial.js';
import {
  createVersion,
  resolveOrbitCredsForRequest,
  uploadObjects,
  uploadTextureBytes,
} from './upload.js';

export interface MaterialSwapInput {
  projectId: string;
  modelId: string;
  versionId?: string;
  prismMaterialId: string;
  objectId?: string;
  applicationId?: string;
  orbitTarget?: OrbitTarget;
  message?: string;
}

export interface MaterialSwapResult {
  target: OrbitTarget;
  projectId: string;
  modelId: string;
  previousVersionId: string;
  newVersionId: string;
  newRootObjectId: string;
  meshObjectId: string;
  meshObjectIdAfter: string;
  prismMaterialId: string;
  prismMaterialName: string;
  uploadedObjectCount: number;
  uploadedBlobCount: number;
  idRemap: Record<string, string>;
}

export interface MaterialSwapBatchAssignment {
  prismMaterialId: string;
  objectId?: string;
  applicationId?: string;
}

export interface MaterialSwapBatchInput {
  projectId: string;
  modelId: string;
  versionId?: string;
  orbitTarget?: OrbitTarget;
  message?: string;
  assignments: MaterialSwapBatchAssignment[];
}

export interface MaterialSwapBatchResult {
  target: OrbitTarget;
  projectId: string;
  modelId: string;
  previousVersionId: string;
  newVersionId: string;
  newRootObjectId: string;
  appliedCount: number;
  uploadedObjectCount: number;
  uploadedBlobCount: number;
  idRemap: Record<string, string>;
}

export async function swapOrbitMaterialsBatch(
  principal: Principal | undefined,
  input: MaterialSwapBatchInput,
): Promise<MaterialSwapBatchResult> {
  if (!input.assignments.length) {
    throw new OrbitClientError(400, 'assignments must not be empty');
  }

  for (const [i, a] of input.assignments.entries()) {
    if (!a.objectId && !a.applicationId) {
      throw new OrbitClientError(400, `assignments[${i}]: objectId or applicationId is required`);
    }
  }

  const target = input.orbitTarget ?? 'prod';
  const creds = await resolveOrbitCredsForRequest(target, principal);

  const version = await resolveModelVersion(
    target,
    input.projectId,
    input.modelId,
    input.versionId,
  );

  const originalIds = new Set<string>();
  const objects = await downloadObjectGraph(creds, input.projectId, version.rootObjectId);
  for (const id of objects.keys()) originalIds.add(id);

  const materialCache = new Map<string, NonNullable<Awaited<ReturnType<typeof loadMaterialDetail>>>>();
  const blobCache = new Map<string, OrbitTextureRefs>();
  let totalBlobCount = 0;
  let appliedCount = 0;

  for (const assignment of input.assignments) {
    const material = await loadCachedMaterial(assignment.prismMaterialId, materialCache);
    if (!material) {
      throw new OrbitClientError(404, `PRISM material ${assignment.prismMaterialId} not found`);
    }

    let blobRefs = blobCache.get(assignment.prismMaterialId);
    if (!blobRefs) {
      blobRefs = await uploadPrismMaterialTextures(creds, input.projectId, material);
      blobCache.set(assignment.prismMaterialId, blobRefs);
      totalBlobCount += Object.keys(blobRefs).length;
    }

    const { mesh } = findMeshInGraph(objects, {
      objectId: assignment.objectId,
      applicationId: assignment.applicationId,
    });

    mesh.renderMaterial = buildOrbitRenderMaterial(material, blobRefs);
    appliedCount += 1;
  }

  const { rootObjectId, toUpload, idMap } = rehashGraphAfterMutation(objects, originalIds);

  await uploadObjects(creds, input.projectId, toUpload);

  const closureSize = Object.keys(
    (objects.get(rootObjectId)?.__closure ?? {}) as Record<string, unknown>,
  ).length;

  const newVersion = await createVersion(creds, {
    projectId: input.projectId,
    modelId: input.modelId,
    objectId: rootObjectId,
    message: input.message ?? `PRISM material sync (${appliedCount} mesh${appliedCount === 1 ? '' : 'es'})`,
    sourceApplication: 'PRISM',
    totalChildrenCount: closureSize,
  });

  return {
    target,
    projectId: input.projectId,
    modelId: input.modelId,
    previousVersionId: version.versionId,
    newVersionId: newVersion.id,
    newRootObjectId: rootObjectId,
    appliedCount,
    uploadedObjectCount: toUpload.length,
    uploadedBlobCount: totalBlobCount,
    idRemap: Object.fromEntries(idMap),
  };
}

async function loadCachedMaterial(
  id: string,
  cache: Map<string, NonNullable<Awaited<ReturnType<typeof loadMaterialDetail>>>>,
): Promise<NonNullable<Awaited<ReturnType<typeof loadMaterialDetail>>> | null> {
  const cached = cache.get(id);
  if (cached) return cached;
  const material = await loadMaterialDetail(id);
  if (!material) return null;
  cache.set(id, material);
  return material;
}

export async function swapOrbitMaterial(
  principal: Principal | undefined,
  input: MaterialSwapInput,
): Promise<MaterialSwapResult> {
  if (!input.objectId && !input.applicationId) {
    throw new OrbitClientError(400, 'objectId or applicationId is required');
  }

  const target = input.orbitTarget ?? 'prod';
  const creds = await resolveOrbitCredsForRequest(target, principal);

  const material = await loadMaterialDetail(input.prismMaterialId);
  if (!material) throw new OrbitClientError(404, `PRISM material ${input.prismMaterialId} not found`);

  const version = await resolveModelVersion(
    target,
    input.projectId,
    input.modelId,
    input.versionId,
  );

  const originalIds = new Set<string>();
  const objects = await downloadObjectGraph(creds, input.projectId, version.rootObjectId);
  for (const id of objects.keys()) originalIds.add(id);

  const { objectId: meshIdBefore, mesh } = findMeshInGraph(objects, {
    objectId: input.objectId,
    applicationId: input.applicationId,
  });

  const blobRefs = await uploadPrismMaterialTextures(creds, input.projectId, material);
  const renderMaterial = buildOrbitRenderMaterial(material, blobRefs);

  mesh.renderMaterial = renderMaterial;

  const { rootObjectId, toUpload, idMap } = rehashGraphAfterMutation(objects, originalIds);

  await uploadObjects(creds, input.projectId, toUpload);

  const closureSize = Object.keys(
    (objects.get(rootObjectId)?.__closure ?? {}) as Record<string, unknown>,
  ).length;

  const newVersion = await createVersion(creds, {
    projectId: input.projectId,
    modelId: input.modelId,
    objectId: rootObjectId,
    message: input.message ?? `Material swap: ${material.name}`,
    sourceApplication: 'PRISM',
    totalChildrenCount: closureSize,
  });

  const meshIdAfter = idMap.get(meshIdBefore) ?? meshIdBefore;

  return {
    target,
    projectId: input.projectId,
    modelId: input.modelId,
    previousVersionId: version.versionId,
    newVersionId: newVersion.id,
    newRootObjectId: rootObjectId,
    meshObjectId: meshIdBefore,
    meshObjectIdAfter: meshIdAfter,
    prismMaterialId: material.id,
    prismMaterialName: material.name,
    uploadedObjectCount: toUpload.length,
    uploadedBlobCount: Object.keys(blobRefs).length,
    idRemap: Object.fromEntries(idMap),
  };
}

async function uploadPrismMaterialTextures(
  creds: import('./client.js').OrbitCreds,
  projectId: string,
  material: NonNullable<Awaited<ReturnType<typeof loadMaterialDetail>>>,
): Promise<OrbitTextureRefs> {
  const refs: OrbitTextureRefs = {};
  if (!material.slots.length) return refs;

  const textureIds = material.slots.map((s) => s.textureId);
  const rows = await db
    .select({
      id: textures.id,
      storagePath: textures.storagePath,
      originalFilename: textures.originalFilename,
      contentType: textures.contentType,
    })
    .from(textures)
    .where(inArray(textures.id, textureIds));

  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const slot of material.slots) {
    const orbitKey = SLOT_TO_ORBIT[slot.slot];
    if (!orbitKey) continue;
    const row = byId.get(slot.textureId);
    if (!row?.storagePath) continue;

    const bytes = await readFile(row.storagePath);
    const { blobId } = await uploadTextureBytes(
      creds,
      projectId,
      bytes,
      row.originalFilename,
      row.contentType || 'image/png',
    );
    refs[orbitKey] = blobId;
  }

  return refs;
}
