/**
 * Poly Haven public API provider — textures only (CC0, no auth).
 * https://polyhaven.com/our-api
 */
import AdmZip from 'adm-zip';
import { fetch } from 'undici';
import type {
  ExternalImportPayload,
  ExternalMaterialDetail,
  ExternalMaterialProvider,
  ExternalSearchPage,
} from './types.js';
import { scoreQueryMatch } from './unifiedSearch.js';
import {
  estimatePolyHavenDownloadSize,
  selectPolyHavenMaps,
  type PolyHavenFilesTree,
} from './polyhavenMaps.js';

const API_BASE = process.env.POLYHAVEN_API_BASE ?? 'https://api.polyhaven.com';
const USER_AGENT = process.env.POLYHAVEN_USER_AGENT
  ?? 'PRISM/0.3.0 (REBUS Industries; materials-import; contact: dom@rebus.industries)';
const TEXTURE_RES = process.env.POLYHAVEN_TEXTURE_RESOLUTION ?? '2k';
const CACHE_TTL_MS = Number(process.env.POLYHAVEN_CACHE_TTL_MS ?? 3_600_000);

interface PolyAsset {
  name: string;
  type: number;
  tags?: string[];
  categories?: string[];
  download_count?: number;
  thumbnail_url?: string;
  max_resolution?: number[];
}

type AssetCatalog = Record<string, PolyAsset>;

let catalogCache: { fetchedAt: number; assets: AssetCatalog } | null = null;

export function resetPolyHavenCatalogCache(): void {
  catalogCache = null;
}

async function phFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Poly Haven API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function loadTextureCatalog(): Promise<AssetCatalog> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.fetchedAt < CACHE_TTL_MS) {
    return catalogCache.assets;
  }
  const assets = await phFetch<AssetCatalog>('/assets?t=textures');
  catalogCache = { fetchedAt: now, assets };
  return assets;
}

function normalizeAsset(id: string, asset: PolyAsset, q: string): ExternalMaterialDetail {
  const title = asset.name?.trim() || id;
  const relevanceScore = scoreQueryMatch(q, {
    title,
    tags: asset.tags,
    categories: asset.categories,
  }) + Math.min((asset.download_count ?? 0) / 1000, 20);

  return {
    source: 'polyhaven',
    sourceId: id,
    title,
    thumbnailUrl: asset.thumbnail_url ?? null,
    previewUrl: asset.thumbnail_url ?? null,
    tags: asset.tags ?? [],
    category: asset.categories?.[0] ?? null,
    downloadSize: null,
    relevanceScore,
    description: null,
    formats: ['jpg', 'png', 'exr'],
    metadata: {
      categories: asset.categories ?? [],
      downloadCount: asset.download_count ?? 0,
      maxResolution: asset.max_resolution ?? null,
      resolution: TEXTURE_RES,
    },
  };
}

function filterAndSortCatalog(
  catalog: AssetCatalog,
  q: string,
): Array<[string, PolyAsset]> {
  const query = q.trim().toLowerCase();
  const entries = Object.entries(catalog).filter(([, a]) => a.type === 1);
  if (!query) {
    return entries.sort((a, b) => (b[1].download_count ?? 0) - (a[1].download_count ?? 0));
  }
  return entries
    .map(([id, asset]) => {
      const title = asset.name?.trim() || id;
      const textScore = scoreQueryMatch(q, {
        title,
        tags: asset.tags,
        categories: asset.categories,
      });
      return { id, asset, textScore };
    })
    .filter((row) => row.textScore > 0)
    .sort((a, b) => b.textScore - a.textScore || (b.asset.download_count ?? 0) - (a.asset.download_count ?? 0))
    .map((row) => [row.id, row.asset] as [string, PolyAsset]);
}

export function createPolyHavenProvider(deps?: {
  fetchCatalog?: () => Promise<AssetCatalog>;
  fetchFiles?: (id: string) => Promise<PolyHavenFilesTree>;
  fetchBuffer?: (url: string) => Promise<Buffer>;
}): ExternalMaterialProvider {
  const fetchCatalog = deps?.fetchCatalog ?? loadTextureCatalog;
  const fetchFiles = deps?.fetchFiles ?? ((id: string) => phFetch<PolyHavenFilesTree>(`/files/${encodeURIComponent(id)}`));
  const fetchBuffer = deps?.fetchBuffer ?? (async (url: string) => {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`Poly Haven download ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  });

  const enabled = process.env.POLYHAVEN_ENABLED !== 'false';

  return {
    id: 'polyhaven',
    label: 'Poly Haven',
    enabled,

    async search({ q, cursor, limit }): Promise<ExternalSearchPage> {
      const catalog = await fetchCatalog();
      const filtered = filterAndSortCatalog(catalog, q);
      const offset = Math.max(Number(cursor ?? 0), 0);
      const slice = filtered.slice(offset, offset + limit);
      const items = slice.map(([id, asset]) => normalizeAsset(id, asset, q));
      const nextOffset = offset + slice.length;
      return {
        items,
        limit,
        cursor: cursor,
        nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
      };
    },

    async getDetail(sourceId: string): Promise<ExternalMaterialDetail | null> {
      const catalog = await fetchCatalog();
      const asset = catalog[sourceId];
      if (!asset || asset.type !== 1) return null;
      const detail = normalizeAsset(sourceId, asset, '');
      try {
        const files = await fetchFiles(sourceId);
        detail.downloadSize = estimatePolyHavenDownloadSize(files, TEXTURE_RES);
        detail.metadata = { ...detail.metadata, maps: selectPolyHavenMaps(files, sourceId, TEXTURE_RES).map((m) => m.map) };
      } catch {
        /* size estimate optional */
      }
      return detail;
    },

    async downloadForImport(sourceId: string): Promise<ExternalImportPayload> {
      const catalog = await fetchCatalog();
      const asset = catalog[sourceId];
      if (!asset) throw new Error('Poly Haven texture not found');

      const files = await fetchFiles(sourceId);
      const maps = selectPolyHavenMaps(files, sourceId, TEXTURE_RES);
      if (!maps.length) throw new Error('No downloadable PBR maps at configured resolution');

      const zip = new AdmZip();
      for (const map of maps) {
        const data = await fetchBuffer(map.url);
        zip.addFile(map.filename, data);
      }

      const title = asset.name?.trim() || sourceId;
      return {
        buffer: zip.toBuffer(),
        filename: `${sourceId}_${TEXTURE_RES}.zip`,
        name: title,
      };
    },
  };
}

export const polyhavenProvider = createPolyHavenProvider();
