/**
 * Fab search filters — free, individually downloadable materials only.
 *
 * API params (`is_free`, `listing_types=material`) reduce noise but Fab still
 * returns paid listings and UE material packs, so we post-filter on price,
 * listingType, and texture-set/megascans formats.
 *
 * Megascans free materials often arrive with `isFree: false` and
 * `startingPrice.price: 0` — treat zero price as free, not the boolean flag.
 */
import type { FabAssetSummary } from './normalize.js';
import type { FabSearchListing } from './types.js';

/** Formats PRISM can download via fabDownloadMaterialZip (texture ZIP manifest). */
export const FAB_DOWNLOADABLE_FORMATS = new Set(['texture-set', 'megascans']);

const PACK_LISTING_TYPE_MARKERS = ['pack', 'collection', 'bundle', 'library'];

function listingFormats(listing: FabSearchListing): string[] {
  return (listing.assetFormats ?? [])
    .map((f) => f.assetFormatType?.code)
    .filter((c): c is string => !!c);
}

function hasDownloadableFormat(formats: string[]): boolean {
  return formats.some((f) => FAB_DOWNLOADABLE_FORMATS.has(f));
}

function isPackListingType(listingType: string | undefined | null): boolean {
  if (!listingType) return false;
  const lt = listingType.toLowerCase();
  if (lt !== 'material' && lt !== 'surface') {
    return PACK_LISTING_TYPE_MARKERS.some((m) => lt.includes(m));
  }
  return false;
}

/** Fab search rows use price, not isFree, for Megascans $0 materials. */
export function isPaidListing(listing: FabSearchListing): boolean {
  const price = listing.startingPrice?.price;
  if (typeof price === 'number') return price > 0;
  return listing.isFree !== true;
}

function isPaidSummary(item: FabAssetSummary): boolean {
  if (item.price != null) return item.price > 0;
  return !item.isFree;
}

/** Raw Fab search row — used before normalization. */
export function isFreeSingleMaterialListing(listing: FabSearchListing): boolean {
  if (isPaidListing(listing)) return false;
  if (isPackListingType(listing.listingType)) return false;
  if (listing.listingType && listing.listingType !== 'material' && listing.listingType !== 'surface') {
    return false;
  }
  return hasDownloadableFormat(listingFormats(listing));
}

/** Normalized summary — used after normalizeSearchListing. */
export function isFreeSingleMaterialSummary(item: FabAssetSummary): boolean {
  if (isPaidSummary(item)) return false;
  if (isPackListingType(item.listingType)) return false;
  if (item.listingType && item.listingType !== 'material' && item.listingType !== 'surface') {
    return false;
  }
  return hasDownloadableFormat(item.formats);
}
