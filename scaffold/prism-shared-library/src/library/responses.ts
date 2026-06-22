import type {
  FixtureDefinition,
  FixtureOrbitRef,
  FixtureTypeDetail,
  FixtureTypeSummary,
  FixtureVersionSummary,
} from '../contracts/fixtures.js';
import type {
  ModelDefinition,
  ModelOrbitRef,
  ModelTypeDetail,
  ModelTypeSummary,
  ModelVersionSummary,
} from '../contracts/models.js';

const DEFAULT_ORBIT_SERVER_URLS: Record<'prod' | 'dev', string> = {
  prod: 'https://orbit.rebus.industries',
  dev: 'https://orbit-dev.rebus.industries',
};

export function fixturePreviewGlbUrl(fixtureId: string): string {
  return `/api/fixtures/${fixtureId}/preview.glb`;
}

export function fixtureMediaUrl(fixtureId: string, mediaId: string): string {
  return `/api/fixtures/${fixtureId}/media/${mediaId}`;
}

export function modelPreviewGlbUrl(modelId: string): string {
  return `/api/models/${modelId}/preview.glb`;
}

export function modelMediaUrl(modelId: string, mediaId: string): string {
  return `/api/models/${modelId}/media/${mediaId}`;
}

export function orbitServerBaseUrl(
  settings: Record<string, string> | undefined,
  target: 'prod' | 'dev',
): string {
  const key = target === 'dev' ? 'orbit_dev_server_url' : 'orbit_server_url';
  const configured = settings?.[key]?.trim();
  return (configured || DEFAULT_ORBIT_SERVER_URLS[target]).replace(/\/+$/, '');
}

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

export function readModelOrbitRef(
  definition?: ModelDefinition | Record<string, unknown> | null,
): ModelOrbitRef | null {
  const meta = (definition as ModelDefinition | undefined)?.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const raw = (meta as Record<string, unknown>).orbit;
  if (!raw || typeof raw !== 'object') return null;
  const bag = raw as Record<string, unknown>;
  const projectId = typeof bag.projectId === 'string' ? bag.projectId.trim() : '';
  const modelId = typeof bag.modelId === 'string' ? bag.modelId.trim() : '';
  if (!projectId || !modelId) return null;
  return {
    target: bag.target === 'dev' ? 'dev' : 'prod',
    projectId,
    modelId,
    versionId: typeof bag.versionId === 'string' && bag.versionId.trim() ? bag.versionId.trim() : undefined,
    resultUrl: typeof bag.resultUrl === 'string' && bag.resultUrl.trim() ? bag.resultUrl.trim() : undefined,
  };
}

export function buildOrbitModelViewerUrl(
  serverUrl: string,
  ref: Pick<ModelOrbitRef, 'projectId' | 'modelId' | 'versionId' | 'resultUrl'>,
): string {
  if (ref.resultUrl) return ref.resultUrl;
  const base = serverUrl.replace(/\/+$/, '');
  const modelPath = ref.versionId ? `${ref.modelId}@${ref.versionId}` : ref.modelId;
  return `${base}/projects/${ref.projectId}/models/${modelPath}`;
}

export function resolveFixtureOrbitUrl(
  definition: FixtureDefinition | Record<string, unknown> | null | undefined,
  settings?: Record<string, string>,
): string | null {
  const ref = readFixtureOrbitRef(definition);
  if (!ref) return null;
  if (ref.orbitUrl) return ref.orbitUrl;
  const serverUrl = orbitServerBaseUrl(settings, ref.target);
  return buildOrbitModelViewerUrl(serverUrl, ref);
}

export function resolveModelOrbitUrl(
  definition: ModelDefinition | Record<string, unknown> | null | undefined,
  settings?: Record<string, string>,
): string | null {
  const ref = readModelOrbitRef(definition);
  if (!ref) return null;
  const serverUrl = orbitServerBaseUrl(settings, ref.target);
  return buildOrbitModelViewerUrl(serverUrl, ref);
}

export function resolveFixturePreviewUrl(
  fixtureId: string,
  opts: {
    hasPreview: boolean;
    previewModelId?: string | null;
    version?: { previewModelId: string | null; isActive: boolean } | null;
  },
): string | null {
  const version = opts.version;
  if (version?.previewModelId) {
    return fixtureMediaUrl(fixtureId, version.previewModelId);
  }
  if (version?.isActive && opts.hasPreview) {
    return fixturePreviewGlbUrl(fixtureId);
  }
  if (!version) {
    if (opts.hasPreview) return fixturePreviewGlbUrl(fixtureId);
    if (opts.previewModelId) return fixtureMediaUrl(fixtureId, opts.previewModelId);
  }
  return null;
}

export function resolveModelPreviewUrl(
  modelId: string,
  opts: {
    hasPreview: boolean;
    previewModelId?: string | null;
    version?: { previewModelId: string | null; isActive: boolean } | null;
  },
): string | null {
  const version = opts.version;
  if (version?.previewModelId) {
    return modelMediaUrl(modelId, version.previewModelId);
  }
  if (version?.isActive && opts.hasPreview) {
    return modelPreviewGlbUrl(modelId);
  }
  if (!version) {
    if (opts.hasPreview) return modelPreviewGlbUrl(modelId);
    if (opts.previewModelId) return modelMediaUrl(modelId, opts.previewModelId);
  }
  return null;
}

type FixtureVersionRow = Omit<FixtureVersionSummary, 'previewUrl'> & {
  previewModelId: string | null;
};

type ModelVersionRow = {
  id: string;
  sourceHash: string | null;
  createdAt: string;
  isActive: boolean;
  previewModelId?: string | null;
  definition?: ModelDefinition | Record<string, unknown> | null;
};

export function toFixtureVersionSummary(
  fixtureId: string,
  row: FixtureVersionRow,
  hasPreview: boolean,
): FixtureVersionSummary {
  return {
    ...row,
    previewUrl: resolveFixturePreviewUrl(fixtureId, {
      hasPreview,
      version: row,
    }),
  };
}

export function toModelVersionSummary(
  modelId: string,
  row: ModelVersionRow,
  hasPreview: boolean,
  settings?: Record<string, string>,
): ModelVersionSummary {
  const orbitUrl = resolveModelOrbitUrl(row.definition ?? null, settings);
  return {
    id: row.id,
    sourceHash: row.sourceHash,
    createdAt: row.createdAt,
    isActive: row.isActive,
    previewUrl: resolveModelPreviewUrl(modelId, {
      hasPreview,
      previewModelId: row.previewModelId ?? null,
      version: {
        previewModelId: row.previewModelId ?? null,
        isActive: row.isActive,
      },
    }),
    orbitUrl,
  };
}

export function toFixtureTypeSummary(
  row: FixtureTypeSummary & {
    previewModelId?: string | null;
    definition?: FixtureDefinition | Record<string, unknown> | null;
  },
  versions: FixtureVersionRow[] = [],
  settings?: Record<string, string>,
): FixtureTypeSummary {
  const enrichedVersions = versions.map((v) => toFixtureVersionSummary(row.id, v, row.hasPreview));
  const activeVersion = enrichedVersions.find((v) => v.isActive) ?? null;
  return {
    ...row,
    previewUrl: resolveFixturePreviewUrl(row.id, {
      hasPreview: row.hasPreview,
      previewModelId: row.previewModelId ?? null,
      version: activeVersion,
    }),
    orbitUrl: resolveFixtureOrbitUrl(row.definition ?? null, settings),
    versions: enrichedVersions,
  };
}

export function toFixtureTypeDetail(
  row: FixtureTypeDetail,
  versions: FixtureVersionRow[] = [],
  settings?: Record<string, string>,
): FixtureTypeDetail {
  const summary = toFixtureTypeSummary(row, versions, settings);
  const activeVersion = summary.versions.find((v) => v.isActive) ?? null;
  return {
    ...summary,
    definition: row.definition,
    previewModelId: row.previewModelId,
    sourceGdtfId: row.sourceGdtfId,
    activeVersion,
  };
}

export function toModelTypeSummary(
  row: ModelTypeSummary & {
    previewModelId?: string | null;
    definition?: ModelDefinition | Record<string, unknown> | null;
  },
  versions: ModelVersionRow[] = [],
  settings?: Record<string, string>,
): ModelTypeSummary {
  const enrichedVersions = versions.map((v) => toModelVersionSummary(row.id, v, row.hasPreview, settings));
  const activeVersion = enrichedVersions.find((v) => v.isActive) ?? null;
  return {
    ...row,
    previewUrl: activeVersion?.previewUrl
      ?? resolveModelPreviewUrl(row.id, {
        hasPreview: row.hasPreview,
        previewModelId: row.previewModelId ?? null,
      }),
    orbitUrl: resolveModelOrbitUrl(row.definition ?? null, settings),
    versions: enrichedVersions,
  };
}

export function toModelTypeDetail(
  row: ModelTypeDetail,
  versions: ModelVersionRow[] = [],
  settings?: Record<string, string>,
): ModelTypeDetail {
  const summary = toModelTypeSummary(row, versions, settings);
  return {
    ...summary,
    definition: row.definition,
    dimensions: row.dimensions,
    boundingBox: row.boundingBox,
  };
}
