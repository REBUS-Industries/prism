/**
 * Fab provider for unified external-materials search/import.
 */
import type {
  ExternalImportPayload,
  ExternalMaterialDetail,
  ExternalMaterialProvider,
  ExternalSearchPage,
} from './types.js';
import { scoreQueryMatch } from './unifiedSearch.js';
import {
  fabDownloadMaterialZip,
  fabGetListing,
  fabSearch,
  isFabImportConfigured,
} from '../fab/client.js';
import type { FabAssetDetail, FabAssetSummary } from '../fab/normalize.js';

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
    metadata: {
      seller: item.seller,
      isFree: item.isFree,
      price: item.price,
      listingType: item.listingType,
      importConfigured: isFabImportConfigured(),
    },
  };
}

function toExternalDetail(detail: FabAssetDetail, q: string): ExternalMaterialDetail {
  const base = toExternalSummary(detail, q);
  return {
    ...base,
    description: detail.description,
    metadata: {
      ...base.metadata,
      publishedAt: detail.publishedAt,
      ratingAverage: detail.ratingAverage,
      ratingCount: detail.ratingCount,
    },
  };
}

export function createFabProvider(deps?: {
  search?: typeof fabSearch;
  getListing?: typeof fabGetListing;
  download?: typeof fabDownloadMaterialZip;
}): ExternalMaterialProvider {
  const searchFn = deps?.search ?? fabSearch;
  const getListingFn = deps?.getListing ?? fabGetListing;
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

    async getDetail(sourceId: string): Promise<ExternalMaterialDetail | null> {
      const detail = await getListingFn(sourceId);
      if (!detail) return null;
      return toExternalDetail(detail, '');
    },

    async downloadForImport(sourceId: string): Promise<ExternalImportPayload> {
      const payload = await downloadFn(sourceId);
      return {
        buffer: payload.buffer,
        filename: payload.filename,
        name: payload.name,
      };
    },
  };
}

export const fabProvider = createFabProvider();
