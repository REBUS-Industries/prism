/**
 * Orbit -> Prism model-library reconciliation.
 *
 * The Orbit connector publishes models straight into the Model Library Orbit
 * project (the same project Prism imports push to). Those connector models have
 * no `model_types` row, so they never appear in the Prism library. This module
 * lists every model in the configured Orbit project and ensures each one is
 * mirrored by a library row linked via `definition.metadata.orbit`, so the two
 * stay 1:1.
 *
 * Linked rows render in the web admin through the embedded Orbit viewer (which
 * reads `definition.metadata.orbit`), so a local GLB is not required for preview.
 */
import type { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  listModels,
  type OrbitModelSummary,
  type OrbitTarget,
} from '@rebus-industries/prism-shared/orbit';
import { db, eq, isNull, and } from '../db/client.js';
import { modelTypes, modelMedia } from '../db/schema.js';
import { emptyModelDefinition, type ModelDefinition, type ModelOrbitRef } from '../contracts/models.js';
import { getModelLibraryOrbitConfig, getOrbitSyncConfig } from './orbitConfig.js';
import { readStoredOrbitModelId } from './registerFromConvertJob.js';
import { modelDir } from './modelStorage.js';
import {
  extensionForContentType,
  fetchOrbitPreviewImage,
  readThumbnailMeta,
  type ModelThumbnailMeta,
  type OrbitPreviewImage,
} from './orbitPreview.js';

/** Marks a library row as having been created by Orbit reconciliation. */
export const ORBIT_CONNECTOR_SOURCE = 'orbit-connector';

const ORBIT_LIST_PAGE_SIZE = 200;
/** Hard ceiling on pagination loops to guard against a misbehaving cursor. */
const ORBIT_LIST_MAX_PAGES = 1000;

/** Minimal projection of a library row needed to plan a sync (testable shape). */
export interface ExistingModelRow {
  id: string;
  name: string;
  deletedAt: Date | null;
  definition: ModelDefinition | null;
}

/** Actions a sync run should take to reconcile Orbit -> library. */
export interface OrbitSyncPlan {
  /** Orbit models with no matching row — create a new library row. */
  create: OrbitModelSummary[];
  /** Existing rows (matched by name) to attach the Orbit ref to. */
  link: Array<{ rowId: string; orbit: OrbitModelSummary }>;
  /** Orbit models already linked to a row — nothing to do. */
  skip: OrbitModelSummary[];
  /** Row ids to soft-delete (only when prune is enabled). */
  prune: string[];
}

export interface SyncSummary {
  /** False when Orbit config is missing or a run is already in flight. */
  ran: boolean;
  busy?: boolean;
  total: number;
  created: number;
  linked: number;
  skipped: number;
  pruned: number;
  /** Orbit preview PNGs newly cached or refreshed this run. */
  thumbnails: number;
  projectId?: string;
  target?: OrbitTarget;
  error?: string;
}

/** Human-facing name for a synced model (Speckle display name, then branch name). */
export function orbitModelDisplayName(item: OrbitModelSummary): string {
  const name = (item.displayName ?? item.name ?? '').trim();
  return (name || 'Untitled model').slice(0, 256);
}

/** Build the library definition for a freshly-synced connector model. */
export function buildSyncedDefinition(
  target: OrbitTarget,
  projectId: string,
  item: OrbitModelSummary,
): ModelDefinition {
  const orbit: ModelOrbitRef = { target, projectId, modelId: item.id };
  const metadata: Record<string, unknown> = {
    orbit,
    importSource: ORBIT_CONNECTOR_SOURCE,
  };
  if (item.previewUrl) metadata.orbitPreviewUrl = item.previewUrl;
  return { ...emptyModelDefinition(), metadata };
}

/**
 * Decide create/link/skip/prune actions for a set of Orbit models against the
 * current library rows. Pure (no IO) so it can be unit-tested in isolation.
 */
export function planOrbitSync(
  orbitItems: OrbitModelSummary[],
  existingRows: ExistingModelRow[],
  projectId: string,
  opts: { prune?: boolean } = {},
): OrbitSyncPlan {
  // Rows already carrying an Orbit ref for this project (deleted included, so we
  // never resurrect a row the user intentionally removed).
  const byOrbitId = new Map<string, ExistingModelRow>();
  // Non-deleted rows with no Orbit ref, keyed by lowercased name for linking.
  const linkableByName = new Map<string, ExistingModelRow>();

  for (const row of existingRows) {
    const orbitId = readStoredOrbitModelId(row.definition, projectId);
    if (orbitId) {
      if (!byOrbitId.has(orbitId)) byOrbitId.set(orbitId, row);
      continue;
    }
    if (row.deletedAt) continue;
    const key = row.name.trim().toLowerCase();
    if (key && !linkableByName.has(key)) linkableByName.set(key, row);
  }

  const plan: OrbitSyncPlan = { create: [], link: [], skip: [], prune: [] };
  const usedRowIds = new Set<string>();

  for (const item of orbitItems) {
    if (byOrbitId.has(item.id)) {
      plan.skip.push(item);
      continue;
    }

    let linked: ExistingModelRow | undefined;
    for (const candidate of [item.displayName, item.name]) {
      if (!candidate) continue;
      const row = linkableByName.get(candidate.trim().toLowerCase());
      if (row && !usedRowIds.has(row.id)) {
        linked = row;
        break;
      }
    }

    if (linked) {
      plan.link.push({ rowId: linked.id, orbit: item });
      usedRowIds.add(linked.id);
      continue;
    }

    plan.create.push(item);
  }

  if (opts.prune) {
    // Soft-delete any non-deleted library row whose Orbit modelId for this
    // project is gone — connector mirrors *and* Prism/Meshy imports that were
    // published into the Model Library project. Rows with no Orbit ref are
    // never pruned (blank drafts, local-only legacy imports).
    const orbitIds = new Set(orbitItems.map((i) => i.id));
    for (const row of existingRows) {
      if (row.deletedAt) continue;
      const orbitId = readStoredOrbitModelId(row.definition, projectId);
      if (orbitId && !orbitIds.has(orbitId)) plan.prune.push(row.id);
    }
  }

  return plan;
}

/** Pull every model in an Orbit project, following the cursor and de-duping by id. */
export async function listAllOrbitModels(
  target: OrbitTarget,
  projectId: string,
): Promise<OrbitModelSummary[]> {
  const items: OrbitModelSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;

  do {
    const page = await listModels(target, projectId, {
      limit: ORBIT_LIST_PAGE_SIZE,
      cursor: cursor ?? undefined,
    });
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    cursor = page.cursor;
    pages += 1;
    if (page.items.length === 0) break;
  } while (cursor && pages < ORBIT_LIST_MAX_PAGES);

  return items;
}

async function loadExistingRows(): Promise<ExistingModelRow[]> {
  const rows = await db
    .select({
      id: modelTypes.id,
      name: modelTypes.name,
      deletedAt: modelTypes.deletedAt,
      definition: modelTypes.definition,
    })
    .from(modelTypes);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    deletedAt: r.deletedAt,
    definition: (r.definition ?? null) as ModelDefinition | null,
  }));
}

async function createRowFromOrbit(
  target: OrbitTarget,
  projectId: string,
  item: OrbitModelSummary,
): Promise<void> {
  await db.insert(modelTypes).values({
    name: orbitModelDisplayName(item),
    category: null,
    tags: [],
    status: 'draft',
    origin: 'import',
    description: item.description ?? null,
    definition: buildSyncedDefinition(target, projectId, item),
    createdByAdminId: null,
    createdByApiKeyId: null,
  });
}

async function linkRowToOrbit(
  rowId: string,
  target: OrbitTarget,
  projectId: string,
  item: OrbitModelSummary,
): Promise<void> {
  const rows = await db.select().from(modelTypes).where(eq(modelTypes.id, rowId)).limit(1);
  const row = rows[0];
  if (!row) return;
  const def = (row.definition ?? emptyModelDefinition()) as ModelDefinition;
  const orbit: ModelOrbitRef = { target, projectId, modelId: item.id };
  const metadata: Record<string, unknown> = { ...(def.metadata ?? {}), orbit };
  if (item.previewUrl) metadata.orbitPreviewUrl = item.previewUrl;
  await db
    .update(modelTypes)
    .set({ definition: { ...def, metadata }, updatedAt: new Date() })
    .where(eq(modelTypes.id, rowId));
}

async function cacheThumbnailForRow(
  rowId: string,
  def: ModelDefinition,
  sourceUrl: string,
  image: OrbitPreviewImage,
): Promise<void> {
  const mediaId = randomUUID();
  const ext = extensionForContentType(image.contentType);
  const dir = modelDir(rowId);
  await mkdir(dir, { recursive: true });
  const storagePath = join(dir, `thumbnail-${mediaId}.${ext}`);
  await writeFile(storagePath, image.bytes);

  const thumbnail: ModelThumbnailMeta = {
    mediaId,
    sourceUrl,
    contentType: image.contentType,
    fetchedAt: new Date().toISOString(),
  };

  await db.insert(modelMedia).values({
    id: mediaId,
    mediaType: 'THUMBNAIL',
    contentHash: image.contentHash,
    originalFilename: `thumbnail.${ext}`.slice(0, 256),
    contentType: image.contentType,
    sizeBytes: image.bytes.length,
    storagePath,
    modelTypeId: rowId,
    metadata: { sourceUrl },
  });

  const metadata: Record<string, unknown> = {
    ...(def.metadata ?? {}),
    thumbnail,
  };
  if (metadata.orbitPreviewUrl == null) metadata.orbitPreviewUrl = sourceUrl;

  await db.update(modelTypes).set({
    definition: { ...def, metadata },
    updatedAt: new Date(),
  }).where(eq(modelTypes.id, rowId));
}

/** Pull Orbit preview PNGs for linked models when the source URL changed. */
async function syncOrbitThumbnails(
  target: OrbitTarget,
  projectId: string,
  orbitItems: OrbitModelSummary[],
  log?: FastifyBaseLogger,
): Promise<number> {
  const rows = await db.select().from(modelTypes).where(isNull(modelTypes.deletedAt));
  const byOrbitId = new Map<string, typeof modelTypes.$inferSelect>();
  for (const row of rows) {
    const orbitId = readStoredOrbitModelId(row.definition as ModelDefinition | null, projectId);
    if (orbitId) byOrbitId.set(orbitId, row);
  }

  let refreshed = 0;
  for (const item of orbitItems) {
    if (!item.previewUrl?.trim()) continue;
    const row = byOrbitId.get(item.id);
    if (!row) continue;

    const def = (row.definition ?? emptyModelDefinition()) as ModelDefinition;
    const existing = readThumbnailMeta(def);
    if (existing?.sourceUrl === item.previewUrl) continue;

    const image = await fetchOrbitPreviewImage(target, item.previewUrl);
    if (!image) {
      log?.warn({ modelId: row.id, orbitModelId: item.id }, 'orbit thumbnail fetch failed');
      continue;
    }

    try {
      await cacheThumbnailForRow(row.id, def, item.previewUrl, image);
      refreshed += 1;
    } catch (err) {
      log?.warn({ err, modelId: row.id, orbitModelId: item.id }, 'orbit thumbnail cache failed');
    }
  }
  return refreshed;
}

let syncing = false;

/**
 * Reconcile the configured Orbit Model Library project into the Prism library.
 * Serialised via a module-level lock so the poller and manual endpoint never
 * run concurrently. Never throws — failures are returned on the summary.
 */
export async function syncModelsFromOrbit(
  opts: { prune?: boolean; log?: FastifyBaseLogger } = {},
): Promise<SyncSummary> {
  const log = opts.log;
  const cfg = await getModelLibraryOrbitConfig();
  if (!cfg) {
    log?.warn('orbit sync skipped: Orbit Model Library project is not configured (orbit_model_library_project_id setting or ORBIT_MODEL_LIBRARY_PROJECT_ID env var)');
    return { ran: false, total: 0, created: 0, linked: 0, skipped: 0, pruned: 0, thumbnails: 0 };
  }

  if (syncing) {
    log?.info('orbit sync skipped: a run is already in progress');
    return {
      ran: false,
      busy: true,
      total: 0,
      created: 0,
      linked: 0,
      skipped: 0,
      pruned: 0,
      thumbnails: 0,
      projectId: cfg.projectId,
      target: cfg.target,
    };
  }

  const prune = opts.prune ?? getOrbitSyncConfig().prune;
  syncing = true;
  try {
    const orbitItems = await listAllOrbitModels(cfg.target, cfg.projectId);
    const existing = await loadExistingRows();
    const plan = planOrbitSync(orbitItems, existing, cfg.projectId, { prune });

    for (const item of plan.create) {
      await createRowFromOrbit(cfg.target, cfg.projectId, item);
    }
    for (const { rowId, orbit } of plan.link) {
      await linkRowToOrbit(rowId, cfg.target, cfg.projectId, orbit);
    }
    for (const rowId of plan.prune) {
      await db
        .update(modelTypes)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(modelTypes.id, rowId));
    }

    const thumbnails = await syncOrbitThumbnails(cfg.target, cfg.projectId, orbitItems, log);

    const summary: SyncSummary = {
      ran: true,
      total: orbitItems.length,
      created: plan.create.length,
      linked: plan.link.length,
      skipped: plan.skip.length,
      pruned: plan.prune.length,
      thumbnails,
      projectId: cfg.projectId,
      target: cfg.target,
    };
    log?.info(
      {
        projectId: summary.projectId,
        target: summary.target,
        total: summary.total,
        created: summary.created,
        linked: summary.linked,
        skipped: summary.skipped,
        pruned: summary.pruned,
        thumbnails: summary.thumbnails,
        prune,
      },
      'orbit sync complete',
    );
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'orbit sync failed';
    log?.error({ err, projectId: cfg.projectId, target: cfg.target }, 'orbit sync failed');
    return {
      ran: false,
      total: 0,
      created: 0,
      linked: 0,
      skipped: 0,
      pruned: 0,
      thumbnails: 0,
      projectId: cfg.projectId,
      target: cfg.target,
      error: message,
    };
  } finally {
    syncing = false;
  }
}
