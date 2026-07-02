import type { FixtureDefinition, FixtureListItem, FixtureOrbitRef } from '../../shared/api';

const DEFAULT_ORBIT_SERVER_URLS = {
  prod: 'https://orbit.rebus.industries',
  dev: 'https://orbit-dev.rebus.industries',
} as const;

export function readFixtureOrbitRef(
  definition?: FixtureDefinition | Record<string, unknown> | null,
): FixtureOrbitRef | null {
  const meta = (definition as FixtureDefinition | undefined)?.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const raw = (meta as Record<string, unknown>).orbitFixtureRef;
  if (!raw || typeof raw !== 'object') return null;
  const bag = raw as Record<string, unknown>;
  const projectId = typeof bag.projectId === 'string' ? bag.projectId.trim() : '';
  const modelId = typeof bag.modelId === 'string' ? bag.modelId.trim() : '';
  const versionId = typeof bag.versionId === 'string' ? bag.versionId.trim() : '';
  const objectId = typeof bag.objectId === 'string' ? bag.objectId.trim() : '';
  if (!projectId || !modelId || !versionId || !objectId) return null;
  return {
    target: bag.target === 'dev' ? 'dev' : 'prod',
    projectId,
    modelId,
    versionId,
    objectId,
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

export function fixtureHasOrbitPublish(
  item: Pick<FixtureListItem, 'orbitUrl'> & { definition?: FixtureDefinition | null },
): boolean {
  return resolveFixtureOrbitUrl(item) != null;
}

export function enrichFixtureListItem<T extends FixtureListItem & { definition?: FixtureDefinition | null }>(
  item: T,
): T {
  const orbitUrl = resolveFixtureOrbitUrl(item);
  return orbitUrl && !item.orbitUrl ? { ...item, orbitUrl } : item;
}
