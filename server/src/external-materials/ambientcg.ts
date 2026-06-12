/**
 * ambientCG public API provider — CC0 PBR materials (no auth).
 * https://docs.ambientcg.com/api/v3/assets
 */
import { fetch } from 'undici';
import type {
  ExternalImportOptions,
  ExternalImportPayload,
  ExternalMaterialDetail,
  ExternalMaterialProvider,
  ExternalSearchPage,
} from './types.js';
import { scoreQueryMatch } from './unifiedSearch.js';

const API_BASE = process.env.AMBIENTCG_API_BASE ?? 'https://ambientcg.com/api/v3';
const USER_AGENT = process.env.AMBIENTCG_USER_AGENT
  ?? 'PRISM/0.3.0 (REBUS Industries; materials-import; contact: dom@rebus.industries)';
const DOWNLOAD_ATTRIBUTES = process.env.AMBIENTCG_DOWNLOAD_ATTRIBUTES ?? '2K-JPG';
const THUMBNAIL_KEY = process.env.AMBIENTCG_THUMBNAIL_KEY ?? '256-PNG';
const SEARCH_INCLUDE = 'title,tags,shortDescription,downloads,thumbnails,previews';
const DETAIL_INCLUDE = 'title,tags,shortDescription,longDescription,downloads,thumbnails,previews,downloadStatistics';

const RESOLUTION_ORDER = ['1K', '2K', '4K', '8K', '12K', '16K'] as const;
const FORMAT_PREF = ['JPG', 'PNG'] as const;

export interface AmbientCgDownload {
  attributes: string;
  extension: string;
  url: string;
  size: number;
}

export interface AmbientCgAsset {
  id: string;
  title?: string;
  tags?: string[];
  shortDescription?: string;
  longDescription?: string;
  downloads?: AmbientCgDownload[];
  thumbnails?: Record<string, string>;
  previews?: Array<{ type: string; url: string }>;
  downloadStatistics?: { total?: number };
}

interface AmbientCgSearchResponse {
  totalResults: number;
  assets: AmbientCgAsset[];
}

function parseAttributes(raw: string): { resolution: string; format: string } | null {
  const dash = raw.indexOf('-');
  if (dash <= 0) return null;
  return { resolution: raw.slice(0, dash), format: raw.slice(dash + 1) };
}

/** Pick a ZIP download at or below the configured resolution, preferring JPG. */
export function selectAmbientCgDownload(
  downloads: AmbientCgDownload[],
  preferredAttributes: string,
): AmbientCgDownload | null {
  if (!downloads.length) return null;

  const exact = downloads.find((d) => d.attributes === preferredAttributes);
  if (exact) return exact;

  const pref = parseAttributes(preferredAttributes);
  if (!pref) return downloads[0] ?? null;

  const prefIdx = RESOLUTION_ORDER.indexOf(pref.resolution as typeof RESOLUTION_ORDER[number]);
  const ranked = downloads
    .map((d) => {
      const parsed = parseAttributes(d.attributes);
      if (!parsed) return null;
      const resIdx = RESOLUTION_ORDER.indexOf(parsed.resolution as typeof RESOLUTION_ORDER[number]);
      const fmtIdx = FORMAT_PREF.indexOf(parsed.format as typeof FORMAT_PREF[number]);
      return { d, resIdx, fmtIdx: fmtIdx >= 0 ? fmtIdx : FORMAT_PREF.length };
    })
    .filter((row): row is NonNullable<typeof row> => row != null && row.resIdx >= 0)
    .filter((row) => prefIdx < 0 || row.resIdx <= prefIdx)
    .sort((a, b) => b.resIdx - a.resIdx || a.fmtIdx - b.fmtIdx);

  return ranked[0]?.d ?? downloads[0] ?? null;
}

/** Standard PBR maps bundled in ambientCG material ZIPs. */
export const AMBIENTCG_STANDARD_MAPS = [
  'Albedo',
  'Normal',
  'Roughness',
  'Displacement',
  'AO',
  'Metallic',
] as const;

export function listAmbientCgDownloadOptions(downloads: AmbientCgDownload[]): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const download of downloads) {
    if (!seen.has(download.attributes)) {
      seen.add(download.attributes);
      options.push(download.attributes);
    }
  }
  return options.sort((a, b) => {
    const pa = parseAttributes(a);
    const pb = parseAttributes(b);
    const ra = pa ? RESOLUTION_ORDER.indexOf(pa.resolution as typeof RESOLUTION_ORDER[number]) : -1;
    const rb = pb ? RESOLUTION_ORDER.indexOf(pb.resolution as typeof RESOLUTION_ORDER[number]) : -1;
    if (ra !== rb) return ra - rb;
    const fa = pa ? FORMAT_PREF.indexOf(pa.format as typeof FORMAT_PREF[number]) : FORMAT_PREF.length;
    const fb = pb ? FORMAT_PREF.indexOf(pb.format as typeof FORMAT_PREF[number]) : FORMAT_PREF.length;
    return fa - fb;
  });
}

export function defaultAmbientCgDownloadAttributes(
  downloads: AmbientCgDownload[],
  preferred = DOWNLOAD_ATTRIBUTES,
): string | null {
  return selectAmbientCgDownload(downloads, preferred)?.attributes ?? downloads[0]?.attributes ?? null;
}

export function pickAmbientCgThumbnail(thumbnails: Record<string, string> | undefined): string | null {
  if (!thumbnails) return null;
  return thumbnails[THUMBNAIL_KEY]
    ?? thumbnails['512-PNG']
    ?? thumbnails['256-PNG']
    ?? Object.values(thumbnails)[0]
    ?? null;
}

async function acgFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ambientCG API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function normalizeAsset(asset: AmbientCgAsset, q: string): ExternalMaterialDetail {
  const title = asset.title?.trim() || asset.id;
  const tags = asset.tags ?? [];
  const thumbnailUrl = pickAmbientCgThumbnail(asset.thumbnails);
  const downloads = asset.downloads ?? [];
  const resolutions = listAmbientCgDownloadOptions(downloads);
  const defaultResolution = defaultAmbientCgDownloadAttributes(downloads, DOWNLOAD_ATTRIBUTES);
  const download = defaultResolution
    ? downloads.find((d) => d.attributes === defaultResolution) ?? selectAmbientCgDownload(downloads, DOWNLOAD_ATTRIBUTES)
    : selectAmbientCgDownload(downloads, DOWNLOAD_ATTRIBUTES);
  const popularity = asset.downloadStatistics?.total ?? 0;
  const relevanceScore = scoreQueryMatch(q, { title, tags })
    + Math.min(popularity / 1000, 20);

  return {
    source: 'ambientcg',
    sourceId: asset.id,
    title,
    thumbnailUrl,
    previewUrl: thumbnailUrl,
    tags,
    category: tags[0] ?? null,
    downloadSize: download?.size ?? null,
    relevanceScore,
    description: asset.longDescription?.trim() || asset.shortDescription?.trim() || null,
    formats: [...new Set(downloads.map((d) => d.extension))],
    maps: [...AMBIENTCG_STANDARD_MAPS],
    resolutions,
    defaultResolution,
    metadata: {
      downloadAttributes: DOWNLOAD_ATTRIBUTES,
      selectedDownload: download?.attributes ?? null,
      downloadCount: popularity,
    },
  };
}

export function createAmbientCgProvider(deps?: {
  searchAssets?: (params: { q: string; limit: number; offset: number }) => Promise<AmbientCgSearchResponse>;
  fetchAsset?: (id: string) => Promise<AmbientCgAsset | null>;
  fetchBuffer?: (url: string) => Promise<Buffer>;
}): ExternalMaterialProvider {
  const searchAssets = deps?.searchAssets ?? (async ({ q, limit, offset }) => {
    const qs = new URLSearchParams({
      type: 'material',
      sort: 'popular',
      limit: String(limit),
      offset: String(offset),
      include: SEARCH_INCLUDE,
    });
    if (q.trim()) qs.set('q', q.trim());
    return acgFetch<AmbientCgSearchResponse>(`/assets?${qs}`);
  });

  const fetchAsset = deps?.fetchAsset ?? (async (id: string) => {
    const qs = new URLSearchParams({ id, include: DETAIL_INCLUDE });
    const res = await acgFetch<AmbientCgSearchResponse>(`/assets?${qs}`);
    return res.assets[0] ?? null;
  });

  const fetchBuffer = deps?.fetchBuffer ?? (async (url: string) => {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`ambientCG download ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  });

  const enabled = process.env.AMBIENTCG_ENABLED !== 'false';

  return {
    id: 'ambientcg',
    label: 'ambientCG',
    enabled,

    async search({ q, cursor, limit }): Promise<ExternalSearchPage> {
      const offset = Math.max(Number(cursor ?? 0), 0);
      const res = await searchAssets({ q, limit, offset });
      const items = res.assets.map((asset) => normalizeAsset(asset, q));
      const nextOffset = offset + items.length;
      return {
        items,
        limit,
        cursor,
        nextCursor: nextOffset < res.totalResults ? String(nextOffset) : null,
      };
    },

    async getDetail(sourceId: string): Promise<ExternalMaterialDetail | null> {
      const asset = await fetchAsset(sourceId);
      if (!asset) return null;
      return normalizeAsset(asset, '');
    },

    async downloadForImport(sourceId: string, options?: ExternalImportOptions): Promise<ExternalImportPayload> {
      const asset = await fetchAsset(sourceId);
      if (!asset) throw new Error('ambientCG material not found');

      const downloads = asset.downloads ?? [];
      const preferred = options?.resolution?.trim() || DOWNLOAD_ATTRIBUTES;
      const download = downloads.find((d) => d.attributes === preferred)
        ?? selectAmbientCgDownload(downloads, preferred);
      if (!download) throw new Error(`No downloadable ZIP for ${preferred}`);

      const buffer = await fetchBuffer(download.url);
      const title = asset.title?.trim() || asset.id;
      return {
        buffer,
        filename: `${asset.id}_${download.attributes}.zip`,
        name: title,
      };
    },
  };
}

export const ambientcgProvider = createAmbientCgProvider();
