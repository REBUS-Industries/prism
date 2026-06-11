/**
 * Merge search results from multiple external material providers.
 */
import type {
  ExternalMaterialProvider,
  ExternalMaterialSource,
  ExternalMaterialSummary,
  UnifiedCursorMap,
  UnifiedSearchParams,
  UnifiedSearchResult,
} from './types.js';
import { encodeUnifiedCursor } from './types.js';

export function scoreQueryMatch(
  q: string,
  fields: { title: string; tags?: string[]; categories?: string[] },
): number {
  const query = q.trim().toLowerCase();
  if (!query) return 0;
  const title = fields.title.toLowerCase();
  let score = 0;
  if (title === query) score += 100;
  else if (title.includes(query)) score += 60;
  else if (query.split(/\s+/).every((word) => title.includes(word))) score += 40;

  for (const tag of fields.tags ?? []) {
    const t = tag.toLowerCase();
    if (t === query) score += 30;
    else if (t.includes(query)) score += 15;
  }
  for (const cat of fields.categories ?? []) {
    const c = cat.toLowerCase();
    if (c.includes(query)) score += 10;
  }
  return score;
}

function providerErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function unifiedSearch(
  providers: ExternalMaterialProvider[],
  params: UnifiedSearchParams,
): Promise<UnifiedSearchResult> {
  const active = providers.filter((p) => p.enabled && params.sources.includes(p.id));
  const perProviderCursors: UnifiedCursorMap = params.cursor ?? {};

  const settled = await Promise.allSettled(
    active.map(async (provider) => {
      const page = await provider.search({
        q: params.q,
        cursor: perProviderCursors[provider.id] ?? null,
        limit: params.limit,
      });
      return { provider, page };
    }),
  );

  const pages: Array<{ provider: ExternalMaterialProvider; page: Awaited<ReturnType<ExternalMaterialProvider['search']>> }> = [];
  const providerErrors: Partial<Record<ExternalMaterialSource, string>> = {};

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    const provider = active[i]!;
    if (result.status === 'fulfilled') {
      pages.push(result.value);
    } else {
      providerErrors[provider.id] = providerErrorMessage(result.reason);
    }
  }

  const merged = pages
    .flatMap(({ page }) => page.items)
    .sort((a, b) => b.relevanceScore - a.relevanceScore || a.title.localeCompare(b.title))
    .slice(0, params.limit);

  const nextCursors: UnifiedCursorMap = { ...perProviderCursors };
  for (const { provider, page } of pages) {
    if (page.nextCursor) nextCursors[provider.id] = page.nextCursor;
    else delete nextCursors[provider.id];
  }

  const nextCursor = encodeUnifiedCursor(nextCursors);
  const hasMore = pages.some(({ page }) => page.nextCursor != null);

  return {
    items: merged,
    limit: params.limit,
    cursor: params.cursor ? encodeUnifiedCursor(params.cursor) : null,
    nextCursor: hasMore ? nextCursor : null,
    sources: active.map((p) => p.id),
    providerErrors: Object.keys(providerErrors).length ? providerErrors : undefined,
  };
}

export function interleaveBySource(
  items: ExternalMaterialSummary[],
  limit: number,
): ExternalMaterialSummary[] {
  const buckets = new Map<string, ExternalMaterialSummary[]>();
  for (const item of items) {
    const list = buckets.get(item.source) ?? [];
    list.push(item);
    buckets.set(item.source, list);
  }
  const keys = [...buckets.keys()];
  const out: ExternalMaterialSummary[] = [];
  let round = 0;
  while (out.length < limit) {
    let added = false;
    for (const key of keys) {
      const bucket = buckets.get(key)!;
      if (round < bucket.length && out.length < limit) {
        out.push(bucket[round]!);
        added = true;
      }
    }
    if (!added) break;
    round++;
  }
  return out;
}
