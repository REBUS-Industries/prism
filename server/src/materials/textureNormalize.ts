/**
 * Convert texture bodies into formats the admin UI can preview.
 *
 * Browsers and three.js TextureLoader support JPEG/PNG/WebP/GIF/BMP only.
 * Megascans/Fab zips ship TIFF (and sometimes TGA) channels — we normalise
 * those to PNG at ingest so node-graph thumbnails and the live PBR viewer work.
 */
import sharp from 'sharp';
import { imageContentType } from './slots.js';

/** MIME types the web preview stack can decode without conversion. */
export const WEB_NATIVE_TEXTURE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
]);

export interface NormalizedTextureBody {
  data: Buffer;
  /** Stored filename (extension reflects the on-disk body). */
  storageFilename: string;
  contentType: string;
  /** True when the body was transcoded for web preview. */
  converted: boolean;
}

/** True when the upload should be transcoded before persisting. */
export function textureNeedsWebNormalize(contentType: string, filename: string): boolean {
  if (WEB_NATIVE_TEXTURE_TYPES.has(contentType)) return false;
  const fromName = imageContentType(filename);
  if (fromName && WEB_NATIVE_TEXTURE_TYPES.has(fromName)) return false;
  // TIFF/TGA/EXR/HDR and unknown image/* — attempt conversion.
  return contentType.startsWith('image/')
    || fromName != null
    || /\.(tiff?|tga|exr|hdr)$/i.test(filename);
}

function pngStorageFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/i, '') || 'texture';
  return `${base}.png`;
}

/**
 * Transcode non-web texture formats to PNG. Pass-through when already web-native.
 * Throws when sharp cannot decode the body.
 */
export async function normalizeTextureBody(
  data: Buffer,
  filename: string,
  contentType: string,
): Promise<NormalizedTextureBody> {
  if (!textureNeedsWebNormalize(contentType, filename)) {
    return { data, storageFilename: filename, contentType, converted: false };
  }

  const png = await sharp(data, { failOn: 'none' })
    .png({ compressionLevel: 6 })
    .toBuffer();

  return {
    data: png,
    storageFilename: pngStorageFilename(filename),
    contentType: 'image/png',
    converted: true,
  };
}
