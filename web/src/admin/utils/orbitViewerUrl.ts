import type { ModelDefinition, ModelOrbitRef } from '../../shared/api';

// ORBIT dev/staging was retired — there is a single production server.
const DEFAULT_ORBIT_SERVER_URL = 'https://orbit.rebus.industries';

/** Parse `definition.metadata.orbit` written by prism-models-service on import. */
export function readModelOrbitRef(definition?: ModelDefinition | null): ModelOrbitRef | null {
  const raw = definition?.metadata?.orbit;
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

/** Resolve the Orbit server base URL from admin settings (non-secret key).
 *  `target` is retained for call-site compatibility but ORBIT dev was retired,
 *  so every target resolves to the single production server. */
export function orbitServerBaseUrl(
  settings: Record<string, string>,
  _target: 'prod' | 'dev' = 'prod',
): string {
  const configured = settings['orbit_server_url']?.trim();
  return (configured || DEFAULT_ORBIT_SERVER_URL).replace(/\/+$/, '');
}

/**
 * Build the Orbit web viewer URL for a model version.
 * Matches convert/agent conventions: `/projects/{id}/models/{modelId}` with optional `@{versionId}`.
 */
export function buildOrbitModelViewerUrl(
  serverUrl: string,
  ref: Pick<ModelOrbitRef, 'projectId' | 'modelId' | 'versionId' | 'resultUrl'>,
): string {
  if (ref.resultUrl) return ref.resultUrl;
  const base = serverUrl.replace(/\/+$/, '');
  const modelPath = ref.versionId ? `${ref.modelId}@${ref.versionId}` : ref.modelId;
  return `${base}/projects/${ref.projectId}/models/${modelPath}`;
}
