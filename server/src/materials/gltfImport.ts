/**
 * Packaged glTF / GLB material import — parse material texture references from
 * a ZIP archive and map them onto PRISM PBR slots.
 *
 * Pure helpers (no DB / Fastify) shared by `/api/materials/import` and unit
 * tests. Megascans-style filename heuristics live in `slots.ts`; this module
 * handles archives that ship a `.gltf` + sidecar assets or a single `.glb`.
 */
import type { MaterialParametersPatch } from './parameters.js';
import { ALLOWED_SLOTS, imageContentType, type MaterialSlot } from './slots.js';

export interface ZipFileEntry {
  entryName: string;
  isDirectory: boolean;
  getData(): Buffer;
}

export interface GltfResolvedTexture {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface GltfImportResult {
  /** One texture per slot; metallic + roughness may reference the same bytes. */
  slots: Partial<Record<MaterialSlot, GltfResolvedTexture>>;
  parameters: MaterialParametersPatch;
  /** glTF material name, when present. */
  materialName?: string;
  /** ZIP entry basenames that were not assigned to a slot. */
  skipped: string[];
}

interface GltfRoot {
  buffers?: Array<{ uri?: string; byteLength?: number }>;
  bufferViews?: Array<{ buffer?: number; byteOffset?: number; byteLength?: number }>;
  images?: Array<{ uri?: string; bufferView?: number; mimeType?: string; name?: string }>;
  textures?: Array<{ source?: number; name?: string }>;
  materials?: GltfMaterial[];
}

interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    metallicFactor?: number;
    roughnessFactor?: number;
    baseColorTexture?: { index: number };
    metallicRoughnessTexture?: { index: number };
  };
  normalTexture?: { index: number; scale?: number };
  occlusionTexture?: { index: number; strength?: number };
  emissiveTexture?: { index: number };
  emissiveFactor?: number[];
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  doubleSided?: boolean;
}

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;

function normalizeZipPath(entryName: string): string {
  return entryName.replace(/\\/g, '/').replace(/^\.\//, '');
}

function zipDirname(entryPath: string): string {
  const norm = normalizeZipPath(entryPath);
  const slash = norm.lastIndexOf('/');
  return slash === -1 ? '' : norm.slice(0, slash);
}

function zipBaseName(entryPath: string): string {
  const norm = normalizeZipPath(entryPath);
  const slash = norm.lastIndexOf('/');
  return slash === -1 ? norm : norm.slice(slash + 1);
}

function resolveZipPath(baseDir: string, uri: string): string {
  const decoded = decodeURIComponent(uri.split('?')[0] ?? uri);
  if (/^(https?:|data:)/i.test(decoded)) return decoded;
  const parts = [...(baseDir ? baseDir.split('/') : []), ...decoded.split('/')];
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

function buildPathMap(entries: ZipFileEntry[]): Map<string, Buffer> {
  const map = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    map.set(normalizeZipPath(entry.entryName), entry.getData());
  }
  return map;
}

function lookupPath(pathMap: Map<string, Buffer>, path: string): Buffer | undefined {
  const norm = normalizeZipPath(path);
  const direct = pathMap.get(norm);
  if (direct) return direct;
  const lower = norm.toLowerCase();
  for (const [key, value] of pathMap) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function parseGlb(buffer: Buffer): { json: GltfRoot; binChunk: Buffer | null } {
  if (buffer.length < 12) throw new Error('truncated glb');
  const magic = buffer.readUInt32LE(0);
  if (magic !== GLB_MAGIC) throw new Error('invalid glb magic');
  const length = buffer.readUInt32LE(8);
  if (length > buffer.length) throw new Error('glb length exceeds buffer');

  let offset = 12;
  let json: GltfRoot | null = null;
  let binChunk: Buffer | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    offset += 8;
    const chunkData = buffer.subarray(offset, offset + chunkLength);
    offset += chunkLength;

    if (chunkType === GLB_JSON_CHUNK) {
      const text = chunkData.toString('utf8').replace(/\0+$/, '').trimEnd();
      json = JSON.parse(text) as GltfRoot;
    } else if (chunkType === GLB_BIN_CHUNK) {
      binChunk = Buffer.from(chunkData);
    }
  }

  if (!json) throw new Error('glb missing json chunk');
  return { json, binChunk };
}

function findGltfRootPath(paths: string[]): string | null {
  const gltf = paths.filter((p) => /\.gltf$/i.test(p));
  const glb = paths.filter((p) => /\.glb$/i.test(p));
  const candidates = [...gltf, ...glb];
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const depth = a.split('/').length - b.split('/').length;
    const depthB = b.split('/').length - b.split('/').length;
    if (depth !== depthB) return depth - depthB;
    return a.localeCompare(b);
  });
  return candidates[0] ?? null;
}

function mimeToExtension(mimeType: string | undefined): string {
  switch ((mimeType ?? '').toLowerCase()) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    default: return 'png';
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}

function textureImageIndex(root: GltfRoot, textureIndex: number): number | null {
  const source = root.textures?.[textureIndex]?.source;
  return source == null ? null : source;
}

function resolveImage(
  imageIndex: number,
  root: GltfRoot,
  baseDir: string,
  pathMap: Map<string, Buffer>,
  binBuffer: Buffer | null,
): GltfResolvedTexture | null {
  const image = root.images?.[imageIndex];
  if (!image) return null;

  let data: Buffer | undefined;
  let filename: string;
  let contentType: string;

  if (image.uri) {
    if (image.uri.startsWith('data:')) {
      const match = image.uri.match(/^data:([^;]+);base64,(.+)$/);
      if (!match?.[2]) return null;
      contentType = match[1] ?? 'image/png';
      data = Buffer.from(match[2], 'base64');
      filename = image.name ?? `embedded_${imageIndex}.${mimeToExtension(contentType)}`;
    } else {
      const resolved = resolveZipPath(baseDir, image.uri);
      data = lookupPath(pathMap, resolved);
      filename = zipBaseName(resolved);
      contentType = image.mimeType ?? imageContentType(filename) ?? 'application/octet-stream';
    }
  } else if (image.bufferView != null && binBuffer) {
    const view = root.bufferViews?.[image.bufferView];
    if (!view) return null;
    const start = view.byteOffset ?? 0;
    const length = view.byteLength ?? 0;
    data = binBuffer.subarray(start, start + length);
    contentType = image.mimeType ?? 'image/png';
    filename = image.name ?? `bufferView_${image.bufferView}.${mimeToExtension(contentType)}`;
  } else {
    return null;
  }

  if (!data?.length) return null;
  return { filename, contentType, data: Buffer.from(data) };
}

function loadExternalBin(root: GltfRoot, baseDir: string, pathMap: Map<string, Buffer>): Buffer | null {
  const uri = root.buffers?.[0]?.uri;
  if (!uri || uri.startsWith('data:')) return null;
  const resolved = resolveZipPath(baseDir, uri);
  return lookupPath(pathMap, resolved) ?? null;
}

function extractParameters(material: GltfMaterial): MaterialParametersPatch {
  const patch: MaterialParametersPatch = {};
  const pbr = material.pbrMetallicRoughness ?? {};

  if (pbr.baseColorFactor && pbr.baseColorFactor.length >= 3) {
    patch.baseColor = rgbToHex(pbr.baseColorFactor[0]!, pbr.baseColorFactor[1]!, pbr.baseColorFactor[2]!);
    const alpha = pbr.baseColorFactor[3];
    if (alpha != null && alpha < 1) patch.opacity = alpha;
  }
  if (pbr.roughnessFactor != null) patch.roughness = pbr.roughnessFactor;
  if (pbr.metallicFactor != null) patch.metallic = pbr.metallicFactor;
  if (material.emissiveFactor && material.emissiveFactor.length >= 3) {
    patch.emissiveColor = rgbToHex(
      material.emissiveFactor[0]!,
      material.emissiveFactor[1]!,
      material.emissiveFactor[2]!,
    );
  }
  if (material.normalTexture?.scale != null) patch.normalScale = material.normalTexture.scale;
  if (material.occlusionTexture?.strength != null) patch.aoIntensity = material.occlusionTexture.strength;
  if (material.doubleSided) patch.doubleSided = true;

  if (material.alphaMode === 'BLEND') patch.alphaMode = 'blend';
  else if (material.alphaMode === 'MASK') {
    patch.alphaMode = 'mask';
    if (material.alphaCutoff != null) patch.alphaCutoff = material.alphaCutoff;
  }

  return patch;
}

function mapMaterialSlots(
  root: GltfRoot,
  material: GltfMaterial,
): Partial<Record<MaterialSlot, number>> {
  const slots: Partial<Record<MaterialSlot, number>> = {};
  const pbr = material.pbrMetallicRoughness;

  const assign = (slot: MaterialSlot, textureIndex: number | undefined) => {
    if (textureIndex == null) return;
    const imageIndex = textureImageIndex(root, textureIndex);
    if (imageIndex != null) slots[slot] = imageIndex;
  };

  assign('albedo', pbr?.baseColorTexture?.index);
  if (pbr?.metallicRoughnessTexture != null) {
    const imageIndex = textureImageIndex(root, pbr.metallicRoughnessTexture.index);
    if (imageIndex != null) {
      // glTF ORM packs roughness (G) and metallic (B) in one texture.
      slots.roughness = imageIndex;
      slots.metallic = imageIndex;
    }
  }
  assign('normal', material.normalTexture?.index);
  assign('ao', material.occlusionTexture?.index);
  assign('emissive', material.emissiveTexture?.index);

  return slots;
}

/** True when the archive contains at least one `.gltf` or `.glb` entry. */
export function isGltfPackage(entries: ZipFileEntry[]): boolean {
  return entries.some((e) => !e.isDirectory && /\.(gltf|glb)$/i.test(normalizeZipPath(e.entryName)));
}

/**
 * Parse the first material from a glTF / GLB package inside a ZIP.
 * Returns `null` when no `.gltf` / `.glb` is present.
 */
export function parseGltfMaterialZip(entries: ZipFileEntry[]): GltfImportResult | null {
  const fileEntries = entries.filter((e) => !e.isDirectory);
  const pathMap = buildPathMap(fileEntries);
  const paths = [...pathMap.keys()];
  const rootPath = findGltfRootPath(paths);
  if (!rootPath) return null;

  const rootBytes = lookupPath(pathMap, rootPath);
  if (!rootBytes) return null;

  let root: GltfRoot;
  let baseDir = zipDirname(rootPath);
  let binBuffer: Buffer | null = null;

  try {
    if (/\.glb$/i.test(rootPath)) {
      const parsed = parseGlb(rootBytes);
      root = parsed.json;
      binBuffer = parsed.binChunk;
    } else {
      root = JSON.parse(rootBytes.toString('utf8')) as GltfRoot;
      binBuffer = loadExternalBin(root, baseDir, pathMap);
    }
  } catch {
    return {
      slots: {},
      parameters: {},
      skipped: paths.map(zipBaseName),
    };
  }

  const material = root.materials?.[0];
  if (!material) {
    return {
      slots: {},
      parameters: {},
      skipped: paths.map(zipBaseName).filter((b) => !/\.(gltf|glb|bin)$/i.test(b)),
    };
  }

  const slotImageIndices = mapMaterialSlots(root, material);
  const slots: Partial<Record<MaterialSlot, GltfResolvedTexture>> = {};
  const usedBasenames = new Set<string>([zipBaseName(rootPath)]);

  if (binBuffer) usedBasenames.add(zipBaseName(root.buffers?.[0]?.uri ?? ''));
  for (const uri of root.buffers?.map((b) => b.uri).filter(Boolean) ?? []) {
    usedBasenames.add(zipBaseName(resolveZipPath(baseDir, uri!)));
  }

  for (const slot of ALLOWED_SLOTS) {
    const imageIndex = slotImageIndices[slot];
    if (imageIndex == null) continue;
    const resolved = resolveImage(imageIndex, root, baseDir, pathMap, binBuffer);
    if (!resolved) continue;
    slots[slot] = resolved;
    usedBasenames.add(resolved.filename);
  }

  const skipped = fileEntries
    .map((e) => zipBaseName(e.entryName))
    .filter((base) => {
      if (!base) return false;
      if (usedBasenames.has(base)) return false;
      if (/\.(gltf|glb|bin)$/i.test(base)) return false;
      // Skip non-glTF JSON manifests (Megascans metadata, etc.).
      if (/\.json$/i.test(base) && !/\.gltf\.json$/i.test(base)) return true;
      return true;
    });

  const result: GltfImportResult = {
    slots,
    parameters: extractParameters(material),
    skipped,
  };
  if (material.name?.trim()) result.materialName = material.name.trim().slice(0, 256);
  return result;
}
