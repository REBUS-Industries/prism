/**
 * Fab marketplace HTTP client â€” public search/detail + Epic-authenticated download.
 */
import {
  FabOAuthError,
  fabAuthConfigured,
  fabAuthorizedFetch,
  fabBrowseFetch,
  fabFlareSolverrConfigured,
  fabHttpProxyConfigured,
  fabPublicFetch,
  ensureFabCloudflareAccess,
  ensureFabCsrf,
} from './auth.js';
import { FAB_DOWNLOADABLE_FORMATS, isFreeSingleMaterialListing, isFreeSingleMaterialSummary } from './filter.js';
import {
  normalizeListingDetail,
  normalizeSearchListing,
  type FabAssetDetail,
  type FabAssetSummary,
  type FabSearchPage,
} from './normalize.js';
import type {
  FabBrowseDownloadEntry,
  FabBrowseDownloadInfo,
  FabListingDetail,
  FabListingFormat,
  FabSearchResponse,
} from './types.js';

const FAB_BASE = 'https://www.fab.com';

const CF_MARKERS = [
  'cloudflare',
  'cf-ray',
  'just a moment',
  'attention required',
  'enable javascript and cookies',
];

/** Exported for unit tests. */
export function isFabCloudflareResponse(body: string, status: number): boolean {
  if (status !== 403 && status !== 503) return false;
  const lower = body.toLowerCase();
  return CF_MARKERS.some((m) => lower.includes(m));
}

export class FabApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'FabApiError';
  }
}

export function isFabImportConfigured(): boolean {
  return fabAuthConfigured();
}

/** Exported for unit tests. */
export function fabCloudflareBlockedMessage(): string {
  const solverHint = fabFlareSolverrConfigured()
    ? ' FlareSolverr is configured â€” check it is reachable from the server and uses the same egress as Fab HTTP requests.'
    : ' Configure FlareSolverr (Admin â†’ Settings â†’ External materials) or an HTTP proxy on the same egress.';
  if (fabAuthConfigured()) {
    if (fabHttpProxyConfigured()) {
      return `Fab is blocked by Cloudflare from this server even with Epic bearer token and HTTP proxy configured. Check proxy reachability or try a residential egress proxy (Admin â†’ Settings â†’ External materials).${solverHint}`;
    }
    return `Fab is blocked by Cloudflare from this server. Epic bearer token is configured but does not bypass Cloudflare â€” set an HTTP proxy or FlareSolverr under Admin â†’ Settings â†’ External materials (or FAB_HTTP_PROXY / FAB_FLARESOLVERR_URL).${solverHint}`;
  }
  if (fabHttpProxyConfigured()) {
    return `Fab is blocked by Cloudflare from this server even with HTTP proxy configured. Check proxy reachability or try a residential egress proxy (Admin â†’ Settings â†’ External materials).${solverHint}`;
  }
  return `Fab is blocked by Cloudflare from this server. Set an HTTP proxy or FlareSolverr under Admin â†’ Settings â†’ External materials (or FAB_HTTP_PROXY / FAB_FLARESOLVERR_URL). An Epic refresh token enables import but does not bypass Cloudflare for search.${solverHint}`;
}

async function fabBrowseRequest(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fabBrowseFetch(url, init);
  } catch (err) {
    if (err instanceof FabOAuthError) {
      throw new FabApiError(err.message, 401, 'fab_oauth_failed');
    }
    throw err;
  }
}

async function fabJson<T>(res: Response, retryOnCf = true): Promise<T> {
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    if (isFabCloudflareResponse(body, res.status)) {
      if (retryOnCf && fabFlareSolverrConfigured()) {
        await ensureFabCloudflareAccess(true);
        throw new FabApiError('Cloudflare challenge â€” retrying', res.status, 'fab_cloudflare_retry');
      }
      throw new FabApiError(
        fabCloudflareBlockedMessage(),
        res.status,
        'fab_cloudflare_blocked',
      );
    }
    throw new FabApiError(`Fab API ${res.status}: ${body.slice(0, 300)}`, res.status);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    if (isFabCloudflareResponse(body, res.status)) {
      if (retryOnCf && fabFlareSolverrConfigured()) {
        await ensureFabCloudflareAccess(true);
        throw new FabApiError('Cloudflare challenge â€” retrying', res.status, 'fab_cloudflare_retry');
      }
      throw new FabApiError(
        fabCloudflareBlockedMessage(),
        res.status,
        'fab_cloudflare_blocked',
      );
    }
    throw new FabApiError(`Fab API returned invalid JSON (${res.status})`, res.status);
  }
}

const FAB_SEARCH_MAX_PAGES = 3;
const FAB_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedFabSearch {
  expiresAt: number;
  page: FabSearchPage;
}

const fabSearchCache = new Map<string, CachedFabSearch>();

/** Exported for unit tests. */
export function fabSearchCacheKey(q: string, limit: number, cursor: string | null): string {
  return `${q.trim().toLowerCase()}|${cursor ?? ''}|${limit}`;
}

export function clearFabSearchCacheForTests(): void {
  fabSearchCache.clear();
}

function getCachedFabSearch(key: string): FabSearchPage | null {
  const entry = fabSearchCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    fabSearchCache.delete(key);
    return null;
  }
  return entry.page;
}

function setCachedFabSearch(key: string, page: FabSearchPage): void {
  fabSearchCache.set(key, {
    expiresAt: Date.now() + FAB_SEARCH_CACHE_TTL_MS,
    page,
  });
}

function fabSearchParams(q: string, pageSize: number, cursor: string | null): URLSearchParams {
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  params.set('listing_types', 'material');
  params.set('is_free', '1');
  params.set('count', String(Math.min(Math.max(pageSize, 1), 48)));
  params.set('sort_by', 'relevance');
  if (cursor) params.set('cursor', cursor);
  return params;
}

async function fabSearchRawPage(
  q: string,
  pageSize: number,
  cursor: string | null,
): Promise<FabSearchResponse> {
  const url = `${FAB_BASE}/i/listings/search?${fabSearchParams(q, pageSize, cursor).toString()}`;
  let res = await fabBrowseRequest(url);
  try {
    return await fabJson<FabSearchResponse>(res);
  } catch (err) {
    if (err instanceof FabApiError && err.code === 'fab_cloudflare_retry') {
      res = await fabBrowseRequest(url);
      return fabJson<FabSearchResponse>(res, false);
    }
    throw err;
  }
}

export async function fabSearch(
  q: string,
  limit: number,
  cursor: string | null,
): Promise<FabSearchPage> {
  const target = Math.min(Math.max(limit, 1), 48);
  const cacheKey = fabSearchCacheKey(q, target, cursor);
  const cached = getCachedFabSearch(cacheKey);
  if (cached) return cached;

  await ensureFabCsrf();
  const pageSize = target;

  const items: FabSearchPage['items'] = [];
  let requestCursor = cursor;
  let nextCursor: string | null = null;
  let pagesFetched = 0;

  while (items.length < target && pagesFetched < FAB_SEARCH_MAX_PAGES) {
    const raw = await fabSearchRawPage(q, pageSize, requestCursor);
    pagesFetched += 1;

    for (const listing of raw.results ?? []) {
      if (!isFreeSingleMaterialListing(listing)) continue;
      items.push(normalizeSearchListing(listing));
      if (items.length >= target) break;
    }

    nextCursor = raw.cursors?.next ?? null;
    if (!nextCursor) break;
    requestCursor = nextCursor;
  }

  const page: FabSearchPage = {
    items: items.slice(0, target),
    limit: target,
    cursor,
    nextCursor: items.length >= target ? nextCursor : null,
  };
  setCachedFabSearch(cacheKey, page);
  return page;
}

const FAB_INDEX_PAGE_DELAY_MS = Number(process.env.FAB_INDEX_PAGE_DELAY_MS ?? 600);

/** Paginate all free material listings for persistent local index build. */
export async function fabBrowseAllFreeMaterials(options?: {
  onProgress?: (count: number) => void;
  pageDelayMs?: number;
  maxPages?: number;
}): Promise<FabAssetSummary[]> {
  await ensureFabCsrf();
  const items: FabAssetSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  const maxPages = options?.maxPages ?? 500;
  const delayMs = options?.pageDelayMs ?? FAB_INDEX_PAGE_DELAY_MS;

  while (pages < maxPages) {
    const raw = await fabSearchRawPage('', 48, cursor);
    pages += 1;

    for (const listing of raw.results ?? []) {
      if (!isFreeSingleMaterialListing(listing)) continue;
      const summary = normalizeSearchListing(listing);
      if (seen.has(summary.id)) continue;
      seen.add(summary.id);
      items.push(summary);
    }

    options?.onProgress?.(items.length);
    cursor = raw.cursors?.next ?? null;
    if (!cursor) break;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return items;
}

export async function fabGetListing(uid: string): Promise<FabAssetDetail | null> {
  await ensureFabCsrf();
  const res = await fabBrowseRequest(`${FAB_BASE}/i/listings/${encodeURIComponent(uid)}`);
  if (res.status === 404) return null;
  const raw = await fabJson<FabListingDetail>(res);
  return normalizeListingDetail(raw);
}

const FAB_RESOLUTION_ORDER = ['1k', '2k', '4k', '8k', '16k'] as const;

export function parseFabZipResolution(filename: string): string | null {
  const match = filename.match(/_(\d+k)\.zip$/i);
  return match ? match[1]!.toLowerCase() : null;
}

export function listFabDownloadResolutions(formats: FabListingFormat[]): string[] {
  const resolutions = new Set<string>();
  for (const format of formats) {
    for (const file of format.files ?? []) {
      const name = file.name ?? '';
      const res = parseFabZipResolution(name);
      if (res) resolutions.add(res);
    }
  }
  return [...resolutions].sort(
    (a, b) => FAB_RESOLUTION_ORDER.indexOf(a as typeof FAB_RESOLUTION_ORDER[number])
      - FAB_RESOLUTION_ORDER.indexOf(b as typeof FAB_RESOLUTION_ORDER[number]),
  );
}

export function defaultFabResolution(resolutions: string[]): string | null {
  if (!resolutions.length) return null;
  const preferred = ['4k', '2k', '8k', '1k'];
  for (const res of preferred) {
    if (resolutions.includes(res)) return res;
  }
  return resolutions[0] ?? null;
}

export async function fabListingFormats(listingId: string): Promise<FabListingFormat[]> {
  await ensureFabCsrf();
  const res = await fabAuthorizedFetch(`${FAB_BASE}/i/listings/${encodeURIComponent(listingId)}/asset-formats`);
  const raw = await fabJson<{ formats?: FabListingFormat[] } | FabListingFormat[]>(res);
  return Array.isArray(raw) ? raw : raw.formats ?? [];
}

/** Exported for unit tests. */
export function parseFabBrowseDownloadInfo(raw: unknown): FabBrowseDownloadEntry {
  if (!raw || typeof raw !== 'object') {
    throw new FabApiError('Fab download-info returned invalid response', 502, 'invalid_download_info');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.detail === 'string' && obj.detail.trim()) {
    throw new FabApiError(`Fab download-info rejected: ${obj.detail}`, 502, 'fab_download_info_failed');
  }
  const entry = (raw as FabBrowseDownloadInfo).downloadInfo?.find((item) => item.downloadUrl?.trim());
  if (!entry?.downloadUrl) {
    throw new FabApiError('Fab download URL unavailable', 502, 'no_download_url');
  }
  return entry;
}

async function fabBrowseFileDownloadInfo(
  listingId: string,
  formatId: string,
  fileId: string,
): Promise<FabBrowseDownloadEntry> {
  const url = `${FAB_BASE}/i/listings/${encodeURIComponent(listingId)}/asset-formats/${encodeURIComponent(formatId)}/files/${encodeURIComponent(fileId)}/download-info`;
  const res = await fabAuthorizedFetch(url);
  return parseFabBrowseDownloadInfo(await fabJson<unknown>(res));
}

async function fabDownloadSignedZip(downloadUrl: string): Promise<Buffer> {
  const res = await fabPublicFetch(downloadUrl);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new FabApiError(`Fab asset download failed (${res.status}): ${body.slice(0, 200)}`, res.status);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function fabAddToLibrary(listingId: string): Promise<void> {
  await ensureFabCsrf();
  const res = await fabAuthorizedFetch(`${FAB_BASE}/i/listings/${encodeURIComponent(listingId)}/add-to-library`, {
    method: 'POST',
  });
  if (res.status === 204 || res.ok) return;
  if (res.status === 409) return; // already in library
  const body = await res.text().catch(() => '');
  throw new FabApiError(`Fab add-to-library ${res.status}: ${body.slice(0, 200)}`, res.status);
}

export function pickDownloadTarget(
  formats: FabListingFormat[],
  resolution?: string | null,
): { formatId: string; fileId: string; filename: string; fileSize: number | null } {
  const preferred = formats.find((f) =>
    FAB_DOWNLOADABLE_FORMATS.has(f.assetFormatType?.code ?? ''),
  ) ?? formats.find((f) =>
    (f.files ?? []).some((file) => file.name?.toLowerCase().endsWith('.zip')),
  ) ?? formats[0];

  if (!preferred?.files?.length) {
    throw new FabApiError('No downloadable Fab format on listing', 404, 'no_format');
  }

  const formatId = preferred.assetFormatType?.code ?? 'texture-set';
  const zipFiles = preferred.files.filter((f) => f.name?.toLowerCase().endsWith('.zip'));
  const files = zipFiles.length ? zipFiles : preferred.files;

  const requested = resolution?.trim().toLowerCase();
  if (requested) {
    const match = files.find((f) => parseFabZipResolution(f.name ?? '') === requested);
    if (match) {
      return {
        formatId,
        fileId: match.uid ?? match.name ?? '0',
        filename: match.name?.endsWith('.zip') ? match.name : `${formatId}.zip`,
        fileSize: typeof match.fileSize === 'number' ? match.fileSize : null,
      };
    }
  }

  const ranked = [...files].sort((a, b) => {
    const ra = parseFabZipResolution(a.name ?? '');
    const rb = parseFabZipResolution(b.name ?? '');
    const ia = ra ? FAB_RESOLUTION_ORDER.indexOf(ra as typeof FAB_RESOLUTION_ORDER[number]) : -1;
    const ib = rb ? FAB_RESOLUTION_ORDER.indexOf(rb as typeof FAB_RESOLUTION_ORDER[number]) : -1;
    return ib - ia;
  });
  const file = ranked[0] ?? files[0]!;
  const fileId = file.uid ?? file.name ?? '0';
  const filename = file.name?.endsWith('.zip') ? file.name : `${formatId}.zip`;
  return {
    formatId,
    fileId,
    filename,
    fileSize: typeof file.fileSize === 'number' ? file.fileSize : null,
  };
}

export async function fabDownloadMaterialZip(
  listingId: string,
  options?: { resolution?: string },
): Promise<{ buffer: Buffer; filename: string; name: string }> {
  if (!fabAuthConfigured()) {
    throw new Error('Fab import requires FAB_EPIC_REFRESH_TOKEN on the server');
  }

  const detail = await fabGetListing(listingId);
  if (!detail) throw new FabApiError('Fab listing not found', 404);
  if (!isFreeSingleMaterialSummary(detail)) {
    throw new FabApiError(
      'Fab listing is not a free single downloadable material',
      403,
      'fab_listing_not_importable',
    );
  }

  await fabAddToLibrary(listingId).catch(() => { /* may already own */ });

  const formats = await fabListingFormats(listingId);
  const { formatId, fileId, filename } = pickDownloadTarget(formats, options?.resolution);
  const downloadInfo = await fabBrowseFileDownloadInfo(listingId, formatId, fileId);
  const buffer = await fabDownloadSignedZip(downloadInfo.downloadUrl);

  return {
    buffer,
    filename,
    name: detail.title,
  };
}

/** @deprecated use fabDownloadMaterialZip */
export const fabDownloadAssetPackage = fabDownloadMaterialZip;

export { fabAuthConfigured };
