/**
 * Download manifest parsing + chunk assembly for Fab asset packages.
 * Handles Epic's JSON download manifests (used by Fab web exports).
 */
import { inflateSync } from 'node:zlib';
import { fabPublicFetch } from './auth.js';

interface JsonChunkPart {
  Guid?: string;
  guid?: string;
  Offset?: number | string;
  offset?: number | string;
  Size?: number | string;
  size?: number | string;
}

interface JsonFileManifest {
  Filename?: string;
  filename?: string;
  FileChunkParts?: JsonChunkPart[];
  fileChunkParts?: JsonChunkPart[];
}

interface JsonDownloadManifest {
  ManifestFileVersion?: string | number;
  manifestFileVersion?: string | number;
  FileManifestList?: JsonFileManifest[];
  fileManifestList?: JsonFileManifest[];
  ChunkHashList?: Record<string, string | number>;
  chunkHashList?: Record<string, string | number>;
  CustomFields?: Record<string, string>;
  customFields?: Record<string, string>;
}

function chunkDir(version: number): string {
  if (version >= 15) return 'ChunksV4';
  if (version >= 6) return 'ChunksV3';
  if (version >= 3) return 'ChunksV2';
  return 'Chunks';
}

function parseManifestVersion(raw: JsonDownloadManifest): number {
  const v = raw.ManifestFileVersion ?? raw.manifestFileVersion ?? 0;
  if (typeof v === 'number') return v;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : 0;
}

function epicBlobToNumber(value: string | number): bigint {
  if (typeof value === 'number') return BigInt(value);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === 'number') return BigInt(parsed);
    if (typeof parsed === 'string') return BigInt(parsed);
  } catch { /* fall through */ }
  const n = Number.parseInt(String(value), 10);
  return BigInt(Number.isFinite(n) ? n : 0);
}

function hashHex(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}

function buildChunkUrls(baseUrl: string, dir: string, guid: string, hash: bigint): string[] {
  const base = baseUrl.replace(/\/+$/, '');
  const h = hashHex(hash);
  const g = guid.replace(/-/g, '').toLowerCase();
  return [
    `${base}/${dir}/${h}${g}.chunk`,
    `${base}/${dir}/${g}.chunk`,
    `${base}/${dir}/${h}_${g}.chunk`,
    `${base}/${dir}/${guid}.chunk`,
  ];
}

async function downloadBytes(url: string): Promise<Buffer> {
  const res = await fabPublicFetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadChunk(baseUrl: string, dir: string, guid: string, hash: bigint): Promise<Buffer> {
  const urls = buildChunkUrls(baseUrl, dir, guid, hash);
  let lastErr: Error | null = null;
  for (const url of urls) {
    try {
      const raw = await downloadBytes(url);
      try {
        return inflateSync(raw);
      } catch {
        return raw;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error(`chunk not found: ${guid}`);
}

function fileEntries(manifest: JsonDownloadManifest): JsonFileManifest[] {
  return manifest.FileManifestList ?? manifest.fileManifestList ?? [];
}

function chunkParts(file: JsonFileManifest): JsonChunkPart[] {
  return file.FileChunkParts ?? file.fileChunkParts ?? [];
}

function fileName(file: JsonFileManifest): string {
  return file.Filename ?? file.filename ?? '';
}

function pickArchiveFile(manifest: JsonDownloadManifest): JsonFileManifest | null {
  const files = fileEntries(manifest);
  const zip = files.find((f) => /\.zip$/i.test(fileName(f)));
  if (zip) return zip;
  return files[0] ?? null;
}

export async function assembleFileFromManifest(
  manifestBytes: Buffer,
  distributionBaseUrl: string,
): Promise<{ data: Buffer; filename: string }> {
  let manifest: JsonDownloadManifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as JsonDownloadManifest;
  } catch {
    throw new Error('unsupported download manifest format (expected JSON)');
  }

  const target = pickArchiveFile(manifest);
  if (!target) throw new Error('download manifest contains no files');

  const name = fileName(target) || 'package.zip';
  const parts = chunkParts(target);
  if (!parts.length) throw new Error('download manifest file has no chunks');

  const hashMap = manifest.ChunkHashList ?? manifest.chunkHashList ?? {};
  const version = parseManifestVersion(manifest);
  const dir = chunkDir(version);
  const custom = manifest.CustomFields ?? manifest.customFields ?? {};
  const baseUrl = custom.SourceURL ?? custom.BaseUrl?.split(',')[0]?.trim() ?? distributionBaseUrl;

  const totalSize = parts.reduce((sum, p) => {
    const size = Number(p.Size ?? p.size ?? 0);
    return sum + (Number.isFinite(size) ? size : 0);
  }, 0);
  const out = Buffer.alloc(Math.max(totalSize, 1));

  for (const part of parts) {
    const guid = String(part.Guid ?? part.guid ?? '');
    if (!guid) continue;
    const offset = Number(part.Offset ?? part.offset ?? 0);
    const size = Number(part.Size ?? part.size ?? 0);
    const hashRaw = hashMap[guid];
    if (hashRaw == null) throw new Error(`missing chunk hash for ${guid}`);
    const hash = epicBlobToNumber(hashRaw);
    const chunkData = await downloadChunk(baseUrl, dir, guid, hash);
    chunkData.copy(out, offset, 0, Math.min(size, chunkData.length));
  }

  return { data: out, filename: name };
}

export async function fetchManifestBytes(manifestUrl: string): Promise<Buffer> {
  return downloadBytes(manifestUrl);
}
