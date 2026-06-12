/**
 * Fab provider for unified external-materials search/import.
 */
import type {
  ExternalDetailOptions,
  ExternalImportOptions,
  ExternalImportPayload,
  ExternalMaterialDetail,
  ExternalMaterialProvider,
  ExternalSearchPage,
} from './types.js';
import { scoreQueryMatch } from './unifiedSearch.js';
import {
  defaultFabResolution,
  fabDownloadMaterialZip,
  fabGetListing,
  fabListingFormats,
  fabSearch,
  isFabImportConfigured,
  listFabDownloadResolutions,
  pickDownloadTarget,
} from '../fab/client.js';
import {
  fabProviderUrl,
  parseFabDescription,
  type FabAssetDetail,
  type FabAssetSummary,
} from '../fab/normalize.js';

function toExternalSummary(item: FabAssetSummary, q: string): ExternalMaterialDetail {
  return {
    source: 'fab',
    sourceId: item.id,
    title: item.title,
    thumbnailUrl: item.thumbnailUrl,
    previewUrl: item.previewUrl ?? item.thumbnailUrl,
    tags: item.tags,
    category: item.category,
    downloadSize: null,
    relevanceScore: scoreQueryMatch(q, { title: item.title, tags: item.tags }) + (item.isFree ? 5 : 0),
    description: null,
    formats: item.formats,
    providerUrl: fabProviderUrl(item.id),
    metadata: {
      seller: item.seller,
      isFree: item.isFree,
      price: item.price,
      listingType: item.listingType,
      importConfigured: isFabImportConfigured(),
    },
  };
}

function toExternalDetail(
  detail: FabAssetDetail,
  q: string,
  extras?: {
    resolutions?: string[];
    defaultResolution?: string | null;
    downloadSize?: number | null;
    maps?: string[];
  },
): ExternalMaterialDetail {
  const parsed = parseFabDescription(detail.description);
  const maps = extras?.maps?.length ? extras.maps : parsed.maps;
  const base = toExternalSummary(detail, q);
  return {
    ...base,
    description: parsed.text,
    maps: maps.length ? maps : undefined,
    resolutions: extras?.resolutions?.length ? extras.resolutions : undefined,
    defaultResolution: extras?.defaultResolution ?? null,
    downloadSize: extras?.downloadSize ?? null,
    metadata: {
      ...base.metadata,
      publishedAt: detail.publishedAt,
      ratingAverage: detail.ratingAverage,
      ratingCount: detail.ratingCount,
    },
  };
}

async function fabDetailExtras(
  sourceId: string,
  options: ExternalDetailOptions | undefined,
  getFormatsFn: typeof fabListingFormats,
  allowFormatsWithoutAuth = false,
): Promise<{
  resolutions: string[];
  defaultResolution: string | null;
  downloadSize: number | null;
}> {
  const empty = {
    resolutions: [] as string[],
    defaultResolution: null as string | null,
    downloadSize: null as number | null,
  };
  if (!isFabImportConfigured() && !allowFormatsWithoutAuth) return empty;

  try {
    const formats = await getFormatsFn(sourceId);
    const resolutions = listFabDownloadResolutions(formats);
    if (!resolutions.length) return empty;

    const defaultResolution = defaultFabResolution(resolutions);
    const requested = options?.resolution?.trim().toLowerCase();
    const selected = (requested && resolutions.includes(requested))
      ? requested
      : defaultResolution;
    const target = pickDownloadTarget(formats, selected);

    return {
      resolutions,
      defaultResolution,
      downloadSize: target.fileSize,
    };
  } catch {
    return empty;
  }
}

export function createFabProvider(deps?: {
  search?: typeof fabSearch;
  getListing?: typeof fabGetListing;
  getFormats?: typeof fabListingFormats;
  download?: typeof fabDownloadMaterialZip;
}): ExternalMaterialProvider {
  const searchFn = deps?.search ?? fabSearch;
  const getListingFn = deps?.getListing ?? fabGetListing;
  const getFormatsFn = deps?.getFormats ?? fabListingFormats;
  const downloadFn = deps?.download ?? fabDownloadMaterialZip;

  return {
    id: 'fab',
    label: 'Fab',
    enabled: process.env.FAB_ENABLED !== 'false',

    async search({ q, cursor, limit }): Promise<ExternalSearchPage> {
      const page = await searchFn(q, limit, cursor);
      return {
        items: page.items.map((item) => toExternalSummary(item, q)),
        limit: page.limit,
        cursor: page.cursor,
        nextCursor: page.nextCursor,
      };
    },

    async getDetail(sourceId: string, options?: ExternalDetailOptions): Promise<ExternalMaterialDetail | null> {
      const detail = await getListingFn(sourceId);
      if (!detail) return null;

      const extras = await fabDetailExtras(sourceId, options, getFormatsFn, !!deps?.getFormats);
      return toExternalDetail(detail, '', extras);
    },

    async downloadForImport(sourceId: string, options?: ExternalImportOptions): Promise<ExternalImportPayload> {
      const payload = await downloadFn(sourceId, { resolution: options?.resolution });
      return {
        buffer: payload.buffer,
        filename: payload.filename,
        name: payload.name,
      };
    },
  };
}

export const fabProvider = createFabProvider();
