/** Raw Fab marketplace API shapes (camelCase as returned by fab.com). */

export interface FabSearchCursors {
  next?: string | null;
  previous?: string | null;
}

export interface FabTag {
  name?: string;
  slug?: string;
  uid?: string;
}

export interface FabThumbnailImage {
  url?: string;
  width?: number;
  height?: number;
}

export interface FabThumbnail {
  uid?: string;
  mediaUrl?: string;
  type?: string;
  images?: FabThumbnailImage[];
}

export interface FabListingCategory {
  uid?: string;
  name?: string;
  path?: string;
  slug?: string;
}

export interface FabUser {
  uid?: string;
  sellerName?: string;
  sellerId?: string;
}

export interface FabAssetFormatType {
  code?: string;
  name?: string;
  icon?: string;
  groupName?: string;
}

export interface FabAssetFormatSummary {
  assetFormatType?: FabAssetFormatType;
  fileSizesRange?: { lower?: number; upper?: number };
}

export interface FabSearchListing {
  uid: string;
  title?: string;
  listingType?: string;
  isFree?: boolean;
  isDiscounted?: boolean;
  publishedAt?: string;
  tags?: FabTag[];
  thumbnails?: FabThumbnail[];
  category?: FabListingCategory;
  user?: FabUser;
  ratings?: { averageRating?: number; total?: number };
  startingPrice?: { price?: number; offerId?: string };
  assetFormats?: FabAssetFormatSummary[];
}

export interface FabSearchResponse {
  results: FabSearchListing[];
  count?: number;
  cursors?: FabSearchCursors;
}

export interface FabListingDetail extends FabSearchListing {
  description?: string;
  reviewCount?: number;
  createdAt?: string;
}

export interface FabListingFile {
  uid?: string;
  name?: string;
  fileSize?: number;
}

export interface FabListingFormat {
  assetFormatType?: FabAssetFormatType;
  files?: FabListingFile[];
}

export interface FabDistributionPoint {
  manifestUrl: string;
  signatureExpiration: string;
}

export interface FabDownloadInfo {
  artifactId?: string;
  assetFormat?: string;
  buildVersion?: string;
  distributionPointBaseUrls?: string[];
  distributionPoints?: FabDistributionPoint[];
  manifestHash?: string;
  type?: string;
}

/** Signed direct download URL from Fab browse API (`/i/listings/.../download-info`). */
export interface FabBrowseDownloadEntry {
  assetFormat?: string;
  downloadUrl: string;
  expires?: string;
  type?: string;
}

export interface FabBrowseDownloadInfo {
  downloadInfo?: FabBrowseDownloadEntry[];
}
