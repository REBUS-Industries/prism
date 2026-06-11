/**
 * Normalize Fab API responses into stable PRISM-facing DTOs.
 */
import type {
  FabListingDetail,
  FabSearchListing,
  FabSearchResponse,
  FabThumbnail,
} from './types.js';

export interface FabAssetSummary {
  id: string;
  title: string;
  listingType: string | null;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  tags: string[];
  category: string | null;
  seller: string | null;
  isFree: boolean;
  price: number | null;
  formats: string[];
}

export interface FabAssetDetail extends FabAssetSummary {
  description: string | null;
  publishedAt: string | null;
  ratingAverage: number | null;
  ratingCount: number | null;
}

export interface FabSearchPage {
  items: FabAssetSummary[];
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
}

function pickThumbnailUrl(thumbnails: FabThumbnail[] | undefined): { thumb: string | null; preview: string | null } {
  if (!thumbnails?.length) return { thumb: null, preview: null };
  const t = thumbnails[0]!;
  const images = t.images ?? [];
  const sorted = [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  const preview = sorted[0]?.url ?? t.mediaUrl ?? null;
  const thumb = images.find((i) => (i.width ?? 0) >= 320 && (i.width ?? 0) <= 640)?.url
    ?? images.find((i) => (i.width ?? 0) >= 160)?.url
    ?? preview;
  return { thumb, preview };
}

function normalizeTags(tags: FabSearchListing['tags']): string[] {
  if (!tags?.length) return [];
  return tags.map((t) => t.name ?? t.slug ?? '').filter(Boolean);
}

function normalizeFormats(listing: FabSearchListing): string[] {
  return (listing.assetFormats ?? [])
    .map((f) => f.assetFormatType?.code)
    .filter((c): c is string => !!c);
}

export function normalizeSearchListing(listing: FabSearchListing): FabAssetSummary {
  const { thumb, preview } = pickThumbnailUrl(listing.thumbnails);
  return {
    id: listing.uid,
    title: listing.title?.trim() || 'Untitled',
    listingType: listing.listingType ?? null,
    thumbnailUrl: thumb,
    previewUrl: preview ?? thumb,
    tags: normalizeTags(listing.tags),
    category: listing.category?.name ?? listing.category?.path ?? null,
    seller: listing.user?.sellerName ?? null,
    isFree: listing.isFree === true,
    price: typeof listing.startingPrice?.price === 'number' ? listing.startingPrice.price : null,
    formats: normalizeFormats(listing),
  };
}

export function normalizeListingDetail(detail: FabListingDetail): FabAssetDetail {
  const base = normalizeSearchListing(detail);
  const ratings = detail.ratings as { averageRating?: number; total?: number } | undefined;
  return {
    ...base,
    description: detail.description?.trim() || null,
    publishedAt: detail.publishedAt ?? null,
    ratingAverage: typeof ratings?.averageRating === 'number' ? ratings.averageRating : null,
    ratingCount: typeof ratings?.total === 'number' ? ratings.total : detail.reviewCount ?? null,
  };
}

export function normalizeSearchPage(
  raw: FabSearchResponse,
  limit: number,
  cursor: string | null,
): FabSearchPage {
  return {
    items: (raw.results ?? []).map(normalizeSearchListing),
    limit,
    cursor,
    nextCursor: raw.cursors?.next ?? null,
  };
}
