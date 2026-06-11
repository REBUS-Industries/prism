/**
 * Fab marketplace HTTP client — public search/detail + Epic-authenticated download.
 */
import {
  fabAuthConfigured,
  fabAuthorizedFetch,
  fabPublicFetch,
  ensureFabCsrf,
} from './auth.js';
import { assembleFileFromManifest, fetchManifestBytes } from './downloadManifest.js';
import {
  normalizeListingDetail,
  normalizeSearchPage,
  type FabAssetDetail,
  type FabSearchPage,
} from './normalize.js';
import type {
  FabDownloadInfo,
  FabListingDetail,
  FabListingFormat,
  FabSearchResponse,
} from './types.js';

const FAB_BASE = 'https://www.fab.com';

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

async function fabJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new FabApiError(`Fab API ${res.status}: ${body.slice(0, 300)}`, res.status);
  }
  return res.json() as Promise<T>;
}

export async function fabSearch(
  q: string,
  limit: number,
  cursor: string | null,
): Promise<FabSearchPage> {
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  params.set('listing_types', 'material');
  params.set('count', String(Math.min(Math.max(limit, 1), 48)));
  params.set('sort_by', 'relevance');
  if (cursor) params.set('cursor', cursor);

  const res = await fabPublicFetch(`${FAB_BASE}/i/listings/search?${params.toString()}`);
  const raw = await fabJson<FabSearchResponse>(res);
  return normalizeSearchPage(raw, limit, cursor);
}

export async function fabGetListing(uid: string): Promise<FabAssetDetail | null> {
  const res = await fabPublicFetch(`${FAB_BASE}/i/listings/${encodeURIComponent(uid)}`);
  if (res.status === 404) return null;
  const raw = await fabJson<FabListingDetail>(res);
  return normalizeListingDetail(raw);
}

async function fabListingFormats(listingId: string): Promise<FabListingFormat[]> {
  await ensureFabCsrf();
  const res = await fabAuthorizedFetch(`${FAB_BASE}/i/listings/${encodeURIComponent(listingId)}/asset-formats`);
  const raw = await fabJson<{ formats?: FabListingFormat[] } | FabListingFormat[]>(res);
  return Array.isArray(raw) ? raw : raw.formats ?? [];
}

async function fabFileDownloadInfo(
  listingId: string,
  formatId: string,
  fileId: string,
): Promise<FabDownloadInfo> {
  const url = `${FAB_BASE}/p/egl/listings/${encodeURIComponent(listingId)}/asset-formats/${encodeURIComponent(formatId)}/files/${encodeURIComponent(fileId)}/download-info`;
  const res = await fabAuthorizedFetch(url);
  return fabJson<FabDownloadInfo>(res);
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

function pickDownloadTarget(formats: FabListingFormat[]): { formatId: string; fileId: string; filename: string } {
  const preferred = formats.find((f) =>
    f.assetFormatType?.code === 'texture-set' || f.assetFormatType?.code === 'megascans',
  ) ?? formats.find((f) =>
    (f.files ?? []).some((file) => file.name?.toLowerCase().endsWith('.zip')),
  ) ?? formats[0];

  if (!preferred?.files?.length) {
    throw new FabApiError('No downloadable Fab format on listing', 404, 'no_format');
  }

  const file = preferred.files.find((f) => f.name?.toLowerCase().endsWith('.zip')) ?? preferred.files[0]!;
  const formatId = preferred.assetFormatType?.code ?? 'texture-set';
  const fileId = file.uid ?? file.name ?? '0';
  const filename = file.name?.endsWith('.zip') ? file.name : `${formatId}.zip`;
  return { formatId, fileId, filename };
}

export async function fabDownloadMaterialZip(
  listingId: string,
): Promise<{ buffer: Buffer; filename: string; name: string }> {
  if (!fabAuthConfigured()) {
    throw new Error('Fab import requires FAB_EPIC_REFRESH_TOKEN on the server');
  }

  const detail = await fabGetListing(listingId);
  if (!detail) throw new FabApiError('Fab listing not found', 404);

  await fabAddToLibrary(listingId).catch(() => { /* may already own */ });

  const formats = await fabListingFormats(listingId);
  const { formatId, fileId, filename } = pickDownloadTarget(formats);
  const info = await fabFileDownloadInfo(listingId, formatId, fileId);
  const point = info.distributionPoints?.[0];
  if (!point?.manifestUrl) {
    throw new FabApiError('Fab download manifest unavailable', 502, 'no_manifest');
  }

  const baseUrl = info.distributionPointBaseUrls?.[0] ?? point.manifestUrl.replace(/\/[^/]+$/, '');
  const manifestBytes = await fetchManifestBytes(point.manifestUrl);
  const assembled = await assembleFileFromManifest(manifestBytes, baseUrl);

  return {
    buffer: assembled.data,
    filename: assembled.filename || filename,
    name: detail.title,
  };
}

/** @deprecated use fabDownloadMaterialZip */
export const fabDownloadAssetPackage = fabDownloadMaterialZip;

export { fabAuthConfigured };
