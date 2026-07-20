/**
 * Orbit Model Library project configuration.
 *
 * Imported meshes are converted via the PRISM /convert/ pipeline and stored
 * in the configured Orbit project (Model Library Project).
 */
import { db as prismSharedDb, settings as prismSettings, eq } from '@rebus-industries/prism-shared/db';

export type OrbitTarget = 'prod' | 'dev';

export interface ModelLibraryOrbitConfig {
  target: OrbitTarget;
  projectId: string;
}

/** When true, fall back to the legacy assimp-only import (local GLB, no Orbit). */
export function isLegacyAssimpImportEnabled(): boolean {
  return process.env.MODEL_IMPORT_LEGACY_ASSIMP === '1'
    || process.env.MODEL_IMPORT_LEGACY_ASSIMP === 'true';
}

/** Background reconciliation (Orbit project -> Prism model library) settings. */
export interface OrbitSyncConfig {
  /** Poll interval in ms; `0` disables the background poller. */
  intervalMs: number;
  /**
   * When true, soft-delete library rows linked to an Orbit model in the Model
   * Library project once that Orbit model disappears — i.e. enforce a strict
   * 1:1 mirror (connector syncs and Prism/Meshy imports). Off by default
   * (additive); the admin “Sync from Orbit” button passes `?prune=1`.
   */
  prune: boolean;
}

const DEFAULT_ORBIT_SYNC_INTERVAL_MS = 300_000;

function parseBoolFlag(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Resolve Orbit sync poller settings from the environment. */
export function getOrbitSyncConfig(): OrbitSyncConfig {
  const raw = process.env.ORBIT_SYNC_INTERVAL_MS?.trim();
  let intervalMs = DEFAULT_ORBIT_SYNC_INTERVAL_MS;
  if (raw != null && raw !== '') {
    const parsed = Number(raw);
    intervalMs = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_ORBIT_SYNC_INTERVAL_MS;
  }
  return { intervalMs, prune: parseBoolFlag(process.env.ORBIT_SYNC_PRUNE) };
}

/**
 * Shared `prism` settings key holding the Orbit Model Library project id.
 * Set from the Prism admin UI; takes precedence over the env var.
 */
export const ORBIT_MODEL_LIBRARY_PROJECT_ID_SETTING = 'orbit_model_library_project_id';

/**
 * Read a value from the shared `prism` settings table. Resilient: returns
 * undefined when the row is missing or the lookup fails, so env fallbacks apply
 * and a transient settings read never breaks an import.
 */
async function readSharedSetting(key: string): Promise<string | undefined> {
  try {
    const rows = await prismSharedDb
      .select({ value: prismSettings.value })
      .from(prismSettings)
      .where(eq(prismSettings.key, key))
      .limit(1);
    const value = rows[0]?.value?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Orbit Model Library project id. The shared settings value
 * (`orbit_model_library_project_id`, configured in the Prism admin UI) takes
 * precedence over the `ORBIT_MODEL_LIBRARY_PROJECT_ID` env var.
 */
export async function getModelLibraryProjectId(): Promise<string | null> {
  const fromDb = await readSharedSetting(ORBIT_MODEL_LIBRARY_PROJECT_ID_SETTING);
  if (fromDb) return fromDb;
  const fromEnv = process.env.ORBIT_MODEL_LIBRARY_PROJECT_ID?.trim();
  return fromEnv || null;
}

/**
 * Resolve the Orbit project used for model-library imports + sync.
 * Returns null when neither the shared setting nor the env var is set —
 * callers should surface a clear configuration error.
 */
export async function getModelLibraryOrbitConfig(): Promise<ModelLibraryOrbitConfig | null> {
  const projectId = await getModelLibraryProjectId();
  if (!projectId) return null;
  const rawTarget = (process.env.ORBIT_MODEL_LIBRARY_TARGET ?? 'prod').trim().toLowerCase();
  const target: OrbitTarget = rawTarget === 'dev' ? 'dev' : 'prod';
  return { target, projectId };
}

/** Base URL for prism-server API calls (convert + job outputs). */
export function prismServerUrl(): string {
  const raw = process.env.PRISM_SERVER_URL?.trim()
    || process.env.PUBLIC_BASE_URL?.trim()
    || 'http://prism-server:8765';
  return raw.replace(/\/+$/, '');
}

/** Optional service API key for server-to-server job output downloads (webhook path). */
export function prismServiceApiKey(): string | undefined {
  const key = process.env.PRISM_SERVICE_API_KEY?.trim();
  return key || undefined;
}

/**
 * Shared upload dir for convert job outputs (same volume as prism-server UPLOAD_DIR).
 * When mounted, the webhook can read GLB bytes without an HTTP round-trip.
 */
export function convertUploadDir(): string {
  return process.env.CONVERT_UPLOAD_DIR?.trim() || '/var/lib/prism/uploads';
}

/** Public callback URL for convert job completion webhooks. */
export function modelImportWebhookUrl(): string {
  const base = process.env.PUBLIC_BASE_URL?.trim() || 'http://localhost:8765';
  return `${base.replace(/\/+$/, '')}/api/model-import/webhook`;
}
