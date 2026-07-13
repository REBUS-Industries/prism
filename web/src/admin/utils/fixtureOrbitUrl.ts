import type { FixtureDefinition, FixtureListItem, FixtureOrbitRef } from '../../shared/api';
import { fixtureHasCustomMeshes } from './fixtureCustomMesh';
import { fixtureHasIesProfiles } from './fixtureIes';

const DEFAULT_ORBIT_SERVER_URLS = {
  prod: 'https://orbit.rebus.industries',
  dev: 'https://orbit-dev.rebus.industries',
} as const;

/** Default Orbit Fixtures project when publish ref omits projectId. */
const DEFAULT_FIXTURES_PROJECT_ID = '0f2893eb28';

function orbitRefBag(
  definition?: FixtureDefinition | Record<string, unknown> | null,
): Record<string, unknown> | null {
  const meta = (definition as FixtureDefinition | undefined)?.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const raw = (meta as Record<string, unknown>).orbitFixtureRef;
  if (!raw || typeof raw !== 'object') return null;
  return raw as Record<string, unknown>;
}

/** Match FixtureEditor: published when metadata carries a model id. */
export function hasOrbitFixtureRef(
  definition?: FixtureDefinition | Record<string, unknown> | null,
): boolean {
  const bag = orbitRefBag(definition);
  if (!bag) return false;
  const modelId = typeof bag.modelId === 'string' ? bag.modelId.trim() : '';
  return !!modelId;
}

export function readFixtureOrbitRef(
  definition?: FixtureDefinition | Record<string, unknown> | null,
): FixtureOrbitRef | null {
  const bag = orbitRefBag(definition);
  if (!bag) return null;
  const modelId = typeof bag.modelId === 'string' ? bag.modelId.trim() : '';
  if (!modelId) return null;
  const projectId = typeof bag.projectId === 'string' && bag.projectId.trim()
    ? bag.projectId.trim()
    : DEFAULT_FIXTURES_PROJECT_ID;
  return {
    target: bag.target === 'dev' ? 'dev' : 'prod',
    projectId,
    modelId,
    versionId: typeof bag.versionId === 'string' ? bag.versionId : '',
    objectId: typeof bag.objectId === 'string' ? bag.objectId : '',
    publishedAt: typeof bag.publishedAt === 'string' ? bag.publishedAt : '',
    orbitUrl: typeof bag.orbitUrl === 'string' && bag.orbitUrl.trim() ? bag.orbitUrl.trim() : undefined,
  };
}

export function resolveFixtureOrbitUrl(
  item: Pick<FixtureListItem, 'orbitUrl'> & { definition?: FixtureDefinition | null },
): string | null {
  if (item.orbitUrl) return item.orbitUrl;
  const ref = readFixtureOrbitRef(item.definition);
  if (!ref) return null;
  if (ref.orbitUrl) return ref.orbitUrl;
  const base = DEFAULT_ORBIT_SERVER_URLS[ref.target];
  return `${base}/projects/${ref.projectId}/models/${ref.modelId}`;
}

/**
 * Parse `/projects/{projectId}/models/{modelId}` from an Orbit viewer URL.
 * Used when list rows expose `orbitUrl` but omit `definition.metadata.orbitFixtureRef`.
 */
export function parseOrbitModelUrl(url: string | null | undefined): Pick<
  FixtureOrbitRef,
  'target' | 'projectId' | 'modelId'
> | null {
  if (!url?.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    const match = parsed.pathname.match(/\/projects\/([^/]+)\/models\/([^/]+)/i);
    if (!match?.[1] || !match[2]) return null;
    const host = parsed.hostname.toLowerCase();
    const target: FixtureOrbitRef['target'] =
      host.includes('orbit-dev') || host.startsWith('dev.') ? 'dev' : 'prod';
    return {
      target,
      projectId: decodeURIComponent(match[1]),
      modelId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve Orbit project/model ids from definition metadata, falling back to `orbitUrl`.
 * List endpoints often set `orbitUrl` without embedding the full definition.
 */
export function resolveFixtureOrbitRef(
  item: Pick<FixtureListItem, 'orbitUrl'> & { definition?: FixtureDefinition | null },
): FixtureOrbitRef | null {
  const fromDef = readFixtureOrbitRef(item.definition);
  if (fromDef) return fromDef;
  const fromUrl = parseOrbitModelUrl(item.orbitUrl ?? resolveFixtureOrbitUrl(item));
  if (!fromUrl) return null;
  return {
    ...fromUrl,
    versionId: '',
    objectId: '',
    publishedAt: '',
    orbitUrl: item.orbitUrl ?? undefined,
  };
}

export function fixtureHasOrbitPublish(
  item: Pick<FixtureListItem, 'orbitUrl'> & { definition?: FixtureDefinition | null },
): boolean {
  if (item.orbitUrl) return true;
  return hasOrbitFixtureRef(item.definition);
}

export function enrichFixtureListItem<T extends FixtureListItem & { definition?: FixtureDefinition | null }>(
  item: T,
): T {
  const orbitUrl = resolveFixtureOrbitUrl(item);
  const hasCustomMeshes = item.hasCustomMeshes
    ?? (item.definition ? fixtureHasCustomMeshes(item.definition) : undefined);
  const hasIesProfiles = item.hasIesProfiles
    ?? (item.definition ? fixtureHasIesProfiles(item.definition) : undefined);
  let out: T = item;
  if (orbitUrl && !item.orbitUrl) out = { ...out, orbitUrl };
  if (hasCustomMeshes !== undefined && item.hasCustomMeshes !== hasCustomMeshes) {
    out = { ...out, hasCustomMeshes };
  }
  if (hasIesProfiles !== undefined && item.hasIesProfiles !== hasIesProfiles) {
    out = { ...out, hasIesProfiles };
  }
  return out;
}

const ORBIT_DETAIL_BATCH = 12;

/** List rows omit definition/orbitUrl — fetch detail for accurate on-Orbit counts. */
export async function enrichFixturesOrbitFromDetails(
  items: FixtureListItem[],
  fetchDetail: (id: string) => Promise<FixtureListItem & { definition?: FixtureDefinition | null }>,
  onUpdate: (item: FixtureListItem & { definition?: FixtureDefinition | null }) => void,
): Promise<void> {
  const missing = items.filter((f) => !fixtureHasOrbitPublish(f));
  if (!missing.length) return;

  for (let i = 0; i < missing.length; i += ORBIT_DETAIL_BATCH) {
    const chunk = missing.slice(i, i + ORBIT_DETAIL_BATCH);
    await Promise.all(chunk.map(async (f) => {
      try {
        const detail = await fetchDetail(f.id);
        onUpdate(enrichFixtureListItem({ ...f, ...detail, definition: detail.definition }));
      } catch {
        /* non-fatal — leave row unchanged */
      }
    }));
  }
}
