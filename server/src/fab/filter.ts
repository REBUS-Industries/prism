/**
 * Fab search filters — free, individually downloadable materials only.
 *
 * API params (`is_free`, `listing_types=material`, `formats=texture-set`) reduce
 * noise but Fab still returns paid listings and UE material packs, so we post-filter
 * on normalized listing fields.
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

function isPaidListing(listing: FabSearchListing): boolean {
  if (listing.isFree !== true) return true;
  const price = listing.startingPrice?.price;
  return typeof price === 'number' && price > 0;
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
  if (!item.isFree) return false;
  if (item.price != null && item.price > 0) return false;
  if (isPackListingType(item.listingType)) return false;
  if (item.listingType && item.listingType !== 'material' && item.listingType !== 'surface') {
    return false;
  }
  return hasDownloadableFormat(item.formats);
}
