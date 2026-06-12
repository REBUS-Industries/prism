/**
 * Unified external PBR material providers (Fab, Poly Haven, …).
 */

export const EXTERNAL_MATERIAL_SOURCES = ['fab', 'polyhaven', 'ambientcg'] as const;
export type ExternalMaterialSource = typeof EXTERNAL_MATERIAL_SOURCES[number];

export function isExternalMaterialSource(value: string): value is ExternalMaterialSource {
  return (EXTERNAL_MATERIAL_SOURCES as readonly string[]).includes(value);
}

export interface ExternalMaterialSummary {
  source: ExternalMaterialSource;
  sourceId: string;
  title: string;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  tags: string[];
  category: string | null;
  /** Total download size in bytes when known. */
  downloadSize: number | null;
  /** Provider-local relevance score for unified merge sorting. */
  relevanceScore: number;
  /** Public page on the provider site (Fab listing, Poly Haven asset, ambientCG view). */
  providerUrl?: string | null;
}

export interface ExternalMaterialDetail extends ExternalMaterialSummary {
  description: string | null;
  formats: string[];
  /** Map/texture channels included in the download package (e.g. Albedo, Normal). */
  maps?: string[];
  /** Available download resolutions (provider-specific, e.g. 2k or 2K-JPG). */
  resolutions?: string[];
  /** Suggested default resolution for import. */
  defaultResolution?: string | null;
  /** Preview image URL keyed by resolution option (when provider exposes per-resolution previews). */
  previewUrlByResolution?: Record<string, string>;
  metadata: Record<string, unknown>;
}

export interface ExternalDetailOptions {
  resolution?: string;
}

export interface ExternalImportOptions {
  resolution?: string;
}

export interface ExternalSearchParams {
  q: string;
  cursor: string | null;
  limit: number;
}

export interface ExternalSearchPage {
  items: ExternalMaterialSummary[];
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
}

export interface ExternalImportPayload {
  buffer: Buffer;
  filename: string;
  name?: string;
}

export interface ExternalMaterialProvider {
  readonly id: ExternalMaterialSource;
  readonly label: string;
  enabled: boolean;
  search(params: ExternalSearchParams): Promise<ExternalSearchPage>;
  getDetail(sourceId: string, options?: ExternalDetailOptions): Promise<ExternalMaterialDetail | null>;
  downloadForImport(sourceId: string, options?: ExternalImportOptions): Promise<ExternalImportPayload>;
}

export interface UnifiedSearchParams {
  q: string;
  sources: ExternalMaterialSource[];
  cursor: UnifiedCursorMap | null;
  limit: number;
}

export interface UnifiedSearchResult {
  items: ExternalMaterialSummary[];
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  sources: ExternalMaterialSource[];
  /** Per-provider failures when Promise.allSettled catches an error (partial results still returned). */
  providerErrors?: Partial<Record<ExternalMaterialSource, string>>;
}

/** Per-provider cursors encoded as base64url JSON. */
export type UnifiedCursorMap = Partial<Record<ExternalMaterialSource, string>>;

export function encodeUnifiedCursor(cursors: UnifiedCursorMap): string | null {
  const filtered = Object.fromEntries(
    Object.entries(cursors).filter(([, v]) => v != null && v !== ''),
  ) as UnifiedCursorMap;
  if (!Object.keys(filtered).length) return null;
  return Buffer.from(JSON.stringify(filtered)).toString('base64url');
}

export function decodeUnifiedCursor(raw: string | null | undefined): UnifiedCursorMap {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as UnifiedCursorMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function parseSourcesParam(raw: string | undefined): ExternalMaterialSource[] {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (!trimmed || trimmed === 'all') return [...EXTERNAL_MATERIAL_SOURCES];
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(isExternalMaterialSource);
}
