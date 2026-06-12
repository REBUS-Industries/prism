/**
 * Normalize Fab API responses into stable PRISM-facing DTOs.
 */
import { isPaidListing } from './filter.js';
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
    isFree: !isPaidListing(listing),
    price: typeof listing.startingPrice?.price === 'number' ? listing.startingPrice.price : null,
    formats: normalizeFormats(listing),
  };
}

const FAB_MAP_LABELS = [
  'albedo',
  'base color',
  'basecolor',
  'diffuse',
  'normal',
  'roughness',
  'displacement',
  'height',
  'ao',
  'ambient occlusion',
  'cavity',
  'bump',
  'specular',
  'gloss',
  'opacity',
  'emissive',
  'metalness',
  'metallic',
] as const;

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** Strip Fab listing HTML to readable plain text (preserves line breaks). */
export function stripFabDescriptionHtml(html: string): string {
  let text = html.trim();
  if (!text) return '';

  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '• ');
  text = text.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function titleCaseMapLabel(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower === 'ao' || lower === 'basecolor' || lower === 'base color') {
    return lower === 'ao' ? 'AO' : 'Albedo';
  }
  return raw.trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Extract PBR map names mentioned in Fab HTML descriptions. */
export function extractFabMapsFromDescription(html: string): string[] {
  const found = new Set<string>();
  const lower = html.toLowerCase();

  for (const label of FAB_MAP_LABELS) {
    if (lower.includes(label)) {
      found.add(titleCaseMapLabel(label === 'base color' || label === 'basecolor' || label === 'diffuse'
        ? 'Albedo'
        : label));
    }
  }

  const listMatch = html.match(/maps?\s*:?\s*<\/strong>\s*([^<]+)/i)
    ?? html.match(/maps?\s*:?\s*([^<\n]+)/i);
  if (listMatch?.[1]) {
    for (const part of listMatch[1].split(/[,;•]/)) {
      const cleaned = part.replace(/<[^>]+>/g, '').trim();
      if (cleaned.length >= 2 && cleaned.length <= 32) {
        found.add(titleCaseMapLabel(cleaned));
      }
    }
  }

  return [...found];
}

export function parseFabDescription(html: string | null | undefined): {
  text: string | null;
  maps: string[];
} {
  if (!html?.trim()) return { text: null, maps: [] };
  return {
    text: stripFabDescriptionHtml(html) || null,
    maps: extractFabMapsFromDescription(html),
  };
}

export function fabProviderUrl(listingId: string): string {
  return `https://www.fab.com/listings/${encodeURIComponent(listingId)}`;
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
  filter?: (listing: FabSearchListing) => boolean,
): FabSearchPage {
  const results = filter
    ? (raw.results ?? []).filter(filter)
    : (raw.results ?? []);
  return {
    items: results.map(normalizeSearchListing),
    limit,
    cursor,
    nextCursor: raw.cursors?.next ?? null,
  };
}
