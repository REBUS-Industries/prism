/**
 * Persistent local index for external material providers — faster search without
 * live API round-trips (especially Fab + FlareSolverr).
 *
 * Index files live under `${DATA_DIR}/external-materials-index/`:
 *   manifest.json — version, updatedAt, per-provider counts
 *   {provider}.json — array of ExternalMaterialIndexEntry
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetch } from 'undici';
import { getSetting, setSetting } from '../db/settings.js';
import { fabBrowseAllFreeMaterials } from '../fab/client.js';
import {
  fabProviderUrl,
  type FabAssetSummary,
} from '../fab/normalize.js';
import { loadTextureCatalog as loadPolyHavenCatalog } from './polyhaven.js';
import {
  pickAmbientCgThumbnail,
  type AmbientCgAsset,
  type AmbientCgSearchResponse,
} from './ambientcg.js';
import { scoreQueryMatch } from './unifiedSearch.js';
import type {
  ExternalMaterialSource,
  ExternalMaterialSummary,
  ExternalSearchPage,
} from './types.js';
import { EXTERNAL_MATERIAL_SOURCES } from './types.js';

const INDEX_VERSION = 1;
const INDEX_MAX_AGE_MS = Number(process.env.EXTERNAL_MATERIALS_INDEX_MAX_AGE_MS ?? 7 * 24 * 60 * 60 * 1000);
const FAB_INDEX_PAGE_DELAY_MS = Number(process.env.FAB_INDEX_PAGE_DELAY_MS ?? 600);
const AMBIENTCG_INDEX_PAGE_SIZE = 100;
const AMBIENTCG_API_BASE = process.env.AMBIENTCG_API_BASE ?? 'https://ambientcg.com/api/v3';
const AMBIENTCG_USER_AGENT = process.env.AMBIENTCG_USER_AGENT
  ?? 'PRISM/0.3.0 (REBUS Industries; materials-import; contact: dom@rebus.industries)';

const KEY_INDEX_USE = 'external_materials_index_use';
const KEY_INDEX_PROVIDERS = 'external_materials_index_providers';

function dataDir(): string {
  return process.env.PRISM_DATA_DIR ?? process.env.DATA_DIR ?? '/data/prism';
}

function indexRoot(): string {
  return resolve(dataDir(), 'external-materials-index');
}

function manifestPath(): string {
  return resolve(indexRoot(), 'manifest.json');
}

function providerIndexPath(source: ExternalMaterialSource): string {
  return resolve(indexRoot(), `${source}.json`);
}

export interface ExternalMaterialIndexEntry {
  source: ExternalMaterialSource;
  sourceId: string;
  title: string;
  tags: string[];
  categories?: string[];
  thumbnailUrl: string | null;
  previewUrl: string | null;
  category: string | null;
  providerUrl: string | null;
  metadata?: Record<string, unknown>;
}

export interface ExternalMaterialIndexManifest {
  version: number;
  updatedAt: string;
  counts: Partial<Record<ExternalMaterialSource, number>>;
}

export type ReindexStatus = 'idle' | 'running' | 'complete' | 'error';

export interface ReindexProgress {
  provider: ExternalMaterialSource;
  fetched: number;
  total?: number;
}

export interface ExternalMaterialIndexPublic {
  updatedAt: string | null;
  version: number;
  status: ReindexStatus;
  counts: Partial<Record<ExternalMaterialSource, number>>;
  indexProviders: Record<ExternalMaterialSource, boolean>;
  useIndex: boolean;
  error: string | null;
  progress: ReindexProgress | null;
  stale: boolean;
}

export interface ReindexOptions {
  providers?: Partial<Record<ExternalMaterialSource, boolean>>;
}

interface ReindexJobState {
  status: ReindexStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  progress: ReindexProgress | null;
  activeProviders: ExternalMaterialSource[];
}

let memoryManifest: ExternalMaterialIndexManifest | null = null;
const memoryEntries = new Map<ExternalMaterialSource, ExternalMaterialIndexEntry[]>();

let reindexJob: ReindexJobState = {
  status: 'idle',
  startedAt: null,
  completedAt: null,
  error: null,
  progress: null,
  activeProviders: [],
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultIndexProviders(): Record<ExternalMaterialSource, boolean> {
  return { fab: true, polyhaven: true, ambientcg: true };
}

export async function parseIndexProvidersSetting(): Promise<Record<ExternalMaterialSource, boolean>> {
  const raw = (await getSetting(KEY_INDEX_PROVIDERS))?.trim();
  if (!raw) return defaultIndexProviders();
  try {
    const parsed = JSON.parse(raw) as Partial<Record<ExternalMaterialSource, boolean>>;
    return {
      fab: parsed.fab !== false,
      polyhaven: parsed.polyhaven !== false,
      ambientcg: parsed.ambientcg !== false,
    };
  } catch {
    return defaultIndexProviders();
  }
}

export async function parseIndexUseSetting(): Promise<boolean> {
  if (process.env.EXTERNAL_MATERIALS_INDEX_USE === 'false') return false;
  if (process.env.EXTERNAL_MATERIALS_INDEX_USE === '0') return false;
  const raw = await getSetting(KEY_INDEX_USE);
  if (raw === '0') return false;
  if (raw === '1') return true;
  return true;
}

export async function setIndexUseSetting(use: boolean): Promise<void> {
  await setSetting(KEY_INDEX_USE, use ? '1' : '0');
}

export async function setIndexProvidersSetting(
  providers: Partial<Record<ExternalMaterialSource, boolean>>,
): Promise<void> {
  const current = await parseIndexProvidersSetting();
  const merged = { ...current, ...providers };
  await setSetting(KEY_INDEX_PROVIDERS, JSON.stringify(merged));
}

function isManifestStale(manifest: ExternalMaterialIndexManifest): boolean {
  const age = Date.now() - Date.parse(manifest.updatedAt);
  return !Number.isFinite(age) || age > INDEX_MAX_AGE_MS;
}

async function readManifestFromDisk(): Promise<ExternalMaterialIndexManifest | null> {
  const path = manifestPath();
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as ExternalMaterialIndexManifest;
    if (!parsed?.updatedAt || typeof parsed.version !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function loadProviderEntries(source: ExternalMaterialSource): Promise<ExternalMaterialIndexEntry[]> {
  const cached = memoryEntries.get(source);
  if (cached) return cached;

  const path = providerIndexPath(source);
  if (!existsSync(path)) return [];

  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as ExternalMaterialIndexEntry[];
    const entries = Array.isArray(parsed) ? parsed : [];
    memoryEntries.set(source, entries);
    return entries;
  } catch {
    return [];
  }
}

export async function getIndexManifest(): Promise<ExternalMaterialIndexManifest | null> {
  if (memoryManifest) return memoryManifest;
  memoryManifest = await readManifestFromDisk();
  return memoryManifest;
}

export function clearIndexMemoryCacheForTests(): void {
  memoryManifest = null;
  memoryEntries.clear();
  reindexJob = {
    status: 'idle',
    startedAt: null,
    completedAt: null,
    error: null,
    progress: null,
    activeProviders: [],
  };
}

export function getReindexJobState(): ReindexJobState {
  return reindexJob;
}

export async function loadExternalMaterialIndexPublic(): Promise<ExternalMaterialIndexPublic> {
  const [manifest, indexProviders, useIndex] = await Promise.all([
    getIndexManifest(),
    parseIndexProvidersSetting(),
    parseIndexUseSetting(),
  ]);

  return {
    updatedAt: manifest?.updatedAt ?? null,
    version: manifest?.version ?? 0,
    status: reindexJob.status,
    counts: manifest?.counts ?? {},
    indexProviders,
    useIndex,
    error: reindexJob.error,
    progress: reindexJob.progress,
    stale: manifest ? isManifestStale(manifest) : true,
  };
}

async function writeProviderIndex(
  source: ExternalMaterialSource,
  entries: ExternalMaterialIndexEntry[],
): Promise<void> {
  await mkdir(indexRoot(), { recursive: true });
  const target = providerIndexPath(source);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(entries), 'utf8');
  await rename(tmp, target);
  memoryEntries.set(source, entries);
}

async function writeManifest(manifest: ExternalMaterialIndexManifest): Promise<void> {
  await mkdir(indexRoot(), { recursive: true });
  const path = manifestPath();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest), 'utf8');
  await rename(tmp, path);
  memoryManifest = manifest;
  await setSetting('external_materials_index_updated_at', manifest.updatedAt);
  await setSetting('external_materials_index_version', String(manifest.version));
}

function fabSummaryToIndexEntry(item: FabAssetSummary): ExternalMaterialIndexEntry {
  return {
    source: 'fab',
    sourceId: item.id,
    title: item.title,
    tags: item.tags,
    thumbnailUrl: item.thumbnailUrl,
    previewUrl: item.previewUrl ?? item.thumbnailUrl,
    category: item.category,
    providerUrl: fabProviderUrl(item.id),
    metadata: {
      seller: item.seller,
      isFree: item.isFree,
      listingType: item.listingType,
    },
  };
}

function polyAssetToIndexEntry(
  id: string,
  asset: { name?: string; tags?: string[]; categories?: string[]; thumbnail_url?: string; download_count?: number },
): ExternalMaterialIndexEntry {
  const title = asset.name?.trim() || id;
  return {
    source: 'polyhaven',
    sourceId: id,
    title,
    tags: asset.tags ?? [],
    categories: asset.categories ?? [],
    thumbnailUrl: asset.thumbnail_url ?? null,
    previewUrl: asset.thumbnail_url ?? null,
    category: asset.categories?.[0] ?? null,
    providerUrl: `https://polyhaven.com/a/${encodeURIComponent(id)}`,
    metadata: { downloadCount: asset.download_count ?? 0 },
  };
}

function ambientAssetToIndexEntry(asset: AmbientCgAsset): ExternalMaterialIndexEntry {
  const title = asset.title?.trim() || asset.id;
  const thumbnailUrl = pickAmbientCgThumbnail(asset.thumbnails);
  return {
    source: 'ambientcg',
    sourceId: asset.id,
    title,
    tags: asset.tags ?? [],
    thumbnailUrl,
    previewUrl: thumbnailUrl,
    category: asset.tags?.[0] ?? null,
    providerUrl: `https://ambientcg.com/view?id=${encodeURIComponent(asset.id)}`,
    metadata: { downloadCount: asset.downloadStatistics?.total ?? 0 },
  };
}

async function buildFabIndex(onProgress: (n: number) => void): Promise<ExternalMaterialIndexEntry[]> {
  const summaries = await fabBrowseAllFreeMaterials({
    onProgress,
    pageDelayMs: FAB_INDEX_PAGE_DELAY_MS,
  });
  return summaries.map(fabSummaryToIndexEntry);
}

async function buildPolyHavenIndex(onProgress: (n: number) => void): Promise<ExternalMaterialIndexEntry[]> {
  const catalog = await loadPolyHavenCatalog();
  const entries: ExternalMaterialIndexEntry[] = [];
  for (const [id, asset] of Object.entries(catalog)) {
    if (asset.type !== 1) continue;
    entries.push(polyAssetToIndexEntry(id, asset));
  }
  onProgress(entries.length);
  return entries;
}

async function ambientCgFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${AMBIENTCG_API_BASE}${path}`, {
    headers: { 'User-Agent': AMBIENTCG_USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ambientCG API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function buildAmbientCgIndex(onProgress: (n: number) => void): Promise<ExternalMaterialIndexEntry[]> {
  const entries: ExternalMaterialIndexEntry[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const qs = new URLSearchParams({
      type: 'material',
      sort: 'popular',
      limit: String(AMBIENTCG_INDEX_PAGE_SIZE),
      offset: String(offset),
      include: 'title,tags,thumbnails,downloadStatistics',
    });
    const res = await ambientCgFetch<AmbientCgSearchResponse>(`/assets?${qs}`);
    total = res.totalResults ?? 0;
    for (const asset of res.assets ?? []) {
      entries.push(ambientAssetToIndexEntry(asset));
    }
    onProgress(entries.length);
    offset += res.assets?.length ?? 0;
    if (!res.assets?.length) break;
    await sleep(200);
  }

  return entries;
}

const INDEX_BUILDERS: Record<
  ExternalMaterialSource,
  (onProgress: (n: number) => void) => Promise<ExternalMaterialIndexEntry[]>
> = {
  fab: buildFabIndex,
  polyhaven: buildPolyHavenIndex,
  ambientcg: buildAmbientCgIndex,
};

export async function runExternalMaterialReindex(options: ReindexOptions = {}): Promise<void> {
  const providerFlags = { ...(await parseIndexProvidersSetting()), ...options.providers };
  const providers = EXTERNAL_MATERIAL_SOURCES.filter((p) => providerFlags[p]);

  reindexJob = {
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    progress: providers[0] ? { provider: providers[0], fetched: 0 } : null,
    activeProviders: providers,
  };

  const counts: Partial<Record<ExternalMaterialSource, number>> = {};

  try {
    for (const provider of providers) {
      reindexJob.progress = { provider, fetched: 0 };
      const entries = await INDEX_BUILDERS[provider]((fetched) => {
        reindexJob.progress = { provider, fetched };
      });
      await writeProviderIndex(provider, entries);
      counts[provider] = entries.length;
    }

    const manifest: ExternalMaterialIndexManifest = {
      version: INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      counts,
    };
    await writeManifest(manifest);

    reindexJob.status = 'complete';
    reindexJob.completedAt = manifest.updatedAt;
    reindexJob.progress = null;
  } catch (err) {
    reindexJob.status = 'error';
    reindexJob.error = err instanceof Error ? err.message : String(err);
    reindexJob.completedAt = new Date().toISOString();
    reindexJob.progress = null;
    throw err;
  }
}

export function startExternalMaterialReindex(options: ReindexOptions = {}): boolean {
  if (reindexJob.status === 'running') return false;
  void runExternalMaterialReindex(options).catch(() => { /* state updated in runner */ });
  return true;
}

function indexEntryToSummary(entry: ExternalMaterialIndexEntry, q: string): ExternalMaterialSummary {
  const popularity = typeof entry.metadata?.downloadCount === 'number'
    ? entry.metadata.downloadCount as number
    : 0;
  const isFree = entry.metadata?.isFree === true;
  return {
    source: entry.source,
    sourceId: entry.sourceId,
    title: entry.title,
    thumbnailUrl: entry.thumbnailUrl,
    previewUrl: entry.previewUrl ?? entry.thumbnailUrl,
    tags: entry.tags,
    category: entry.category,
    downloadSize: null,
    relevanceScore: scoreQueryMatch(q, {
      title: entry.title,
      tags: entry.tags,
      categories: entry.categories,
    }) + Math.min(popularity / 1000, 20) + (isFree ? 5 : 0),
    providerUrl: entry.providerUrl,
  };
}

function filterIndexEntries(
  entries: ExternalMaterialIndexEntry[],
  q: string,
): ExternalMaterialIndexEntry[] {
  const query = q.trim().toLowerCase();
  if (!query) {
    return [...entries].sort((a, b) => {
      const pa = typeof a.metadata?.downloadCount === 'number' ? a.metadata.downloadCount as number : 0;
      const pb = typeof b.metadata?.downloadCount === 'number' ? b.metadata.downloadCount as number : 0;
      return pb - pa || a.title.localeCompare(b.title);
    });
  }

  return entries
    .map((entry) => ({
      entry,
      score: scoreQueryMatch(q, {
        title: entry.title,
        tags: entry.tags,
        categories: entry.categories,
      }),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
    .map((row) => row.entry);
}

/** Search a provider's on-disk index. Returns null when index should not be used. */
export async function searchExternalMaterialIndex(
  source: ExternalMaterialSource,
  params: { q: string; cursor: string | null; limit: number },
  opts?: { force?: boolean },
): Promise<ExternalSearchPage | null> {
  if (!opts?.force) {
    const [useIndex, manifest] = await Promise.all([parseIndexUseSetting(), getIndexManifest()]);
    if (!useIndex || !manifest || isManifestStale(manifest)) return null;
    if (!manifest.counts[source]) return null;
  }

  const entries = await loadProviderEntries(source);
  if (!entries.length) return null;

  const filtered = filterIndexEntries(entries, params.q);
  const offset = Math.max(Number(params.cursor ?? 0), 0);
  const slice = filtered.slice(offset, offset + params.limit).map((e) => indexEntryToSummary(e, params.q));
  const nextOffset = offset + slice.length;

  return {
    items: slice,
    limit: params.limit,
    cursor: params.cursor,
    nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
  };
}
