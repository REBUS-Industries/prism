/**
 * Admin-configurable external material provider settings (Fab, Poly Haven, ambientCG).
 *
 * Stored in the `settings` table; Fab token/proxy override env when set in DB.
 * Applied to fab/auth + provider registry on bootstrap and before external-materials
 * API handlers so the materials microservice picks up changes without restart.
 */
import { getSetting, setSetting } from '../db/settings.js';
import { applyFabRuntimeConfig } from '../fab/auth.js';
import { applyProviderEnabledFromSettings } from '../external-materials/registry.js';

const KEY_FAB_TOKEN = 'fab_epic_refresh_token';
const KEY_FAB_PROXY = 'fab_http_proxy';
const KEY_FAB_FLARESOLVERR = 'fab_flaresolverr_url';
const KEY_FAB_ENABLED = 'fab_enabled';
const KEY_POLYHAVEN_ENABLED = 'external_polyhaven_enabled';
const KEY_AMBIENTCG_ENABLED = 'external_ambientcg_enabled';

export interface ExternalMaterialsSettingsPublic {
  fab: {
    enabled: boolean;
    httpProxy: string;
    flareSolverrUrl: string;
    tokenConfigured: boolean;
    tokenPreview: string | null;
    tokenSource: 'db' | 'env' | 'none';
  };
  polyhaven: { enabled: boolean };
  ambientcg: { enabled: boolean };
}

export interface ExternalMaterialsSettingsPatch {
  fab?: {
    enabled?: boolean;
    epicRefreshToken?: string;
    httpProxy?: string;
    flareSolverrUrl?: string;
  };
  polyhaven?: { enabled?: boolean };
  ambientcg?: { enabled?: boolean };
}

function envTruthy(name: string, defaultTrue = true): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultTrue;
  return raw !== 'false' && raw !== '0';
}

function parseBoolSetting(dbVal: string | undefined, envName: string, defaultTrue = true): boolean {
  if (dbVal === '1') return true;
  if (dbVal === '0') return false;
  return envTruthy(envName, defaultTrue);
}

function tokenPreview(token: string): string {
  if (!token) return '';
  if (token.length <= 6) return '••••••';
  return token.slice(0, 3) + '••••' + token.slice(-2);
}

async function resolveFabRefreshToken(): Promise<{ token: string | null; source: 'db' | 'env' | 'none' }> {
  const dbToken = (await getSetting(KEY_FAB_TOKEN))?.trim();
  if (dbToken) return { token: dbToken, source: 'db' };
  const envToken = process.env.FAB_EPIC_REFRESH_TOKEN?.trim();
  if (envToken) return { token: envToken, source: 'env' };
  return { token: null, source: 'none' };
}

async function resolveFabHttpProxy(): Promise<string | null> {
  const dbProxy = (await getSetting(KEY_FAB_PROXY))?.trim();
  if (dbProxy !== undefined && dbProxy !== '') return dbProxy;
  const envProxy = process.env.FAB_HTTP_PROXY?.trim();
  return envProxy || null;
}

async function resolveFabFlareSolverrUrl(): Promise<string | null> {
  const dbUrl = (await getSetting(KEY_FAB_FLARESOLVERR))?.trim();
  if (dbUrl !== undefined && dbUrl !== '') return dbUrl;
  const envUrl = process.env.FAB_FLARESOLVERR_URL?.trim();
  return envUrl || null;
}

export async function loadExternalMaterialsSettingsPublic(): Promise<ExternalMaterialsSettingsPublic> {
  const [fabEnabledRaw, polyEnabledRaw, ambientEnabledRaw, fabProxy, fabFlareSolverr] = await Promise.all([
    getSetting(KEY_FAB_ENABLED),
    getSetting(KEY_POLYHAVEN_ENABLED),
    getSetting(KEY_AMBIENTCG_ENABLED),
    resolveFabHttpProxy(),
    resolveFabFlareSolverrUrl(),
  ]);
  const { token, source } = await resolveFabRefreshToken();

  return {
    fab: {
      enabled: parseBoolSetting(fabEnabledRaw, 'FAB_ENABLED'),
      httpProxy: fabProxy ?? '',
      flareSolverrUrl: fabFlareSolverr ?? '',
      tokenConfigured: !!token,
      tokenPreview: token ? tokenPreview(token) : null,
      tokenSource: source,
    },
    polyhaven: {
      enabled: parseBoolSetting(polyEnabledRaw, 'POLYHAVEN_ENABLED'),
    },
    ambientcg: {
      enabled: parseBoolSetting(ambientEnabledRaw, 'AMBIENTCG_ENABLED'),
    },
  };
}

export async function patchExternalMaterialsSettings(
  patch: ExternalMaterialsSettingsPatch,
): Promise<ExternalMaterialsSettingsPublic> {
  if (patch.fab?.enabled !== undefined) {
    await setSetting(KEY_FAB_ENABLED, patch.fab.enabled ? '1' : '0');
  }
  if (patch.fab?.httpProxy !== undefined) {
    await setSetting(KEY_FAB_PROXY, patch.fab.httpProxy.trim());
  }
  if (patch.fab?.flareSolverrUrl !== undefined) {
    await setSetting(KEY_FAB_FLARESOLVERR, patch.fab.flareSolverrUrl.trim());
  }
  if (patch.fab?.epicRefreshToken !== undefined) {
    await setSetting(KEY_FAB_TOKEN, patch.fab.epicRefreshToken.trim());
  }
  if (patch.polyhaven?.enabled !== undefined) {
    await setSetting(KEY_POLYHAVEN_ENABLED, patch.polyhaven.enabled ? '1' : '0');
  }
  if (patch.ambientcg?.enabled !== undefined) {
    await setSetting(KEY_AMBIENTCG_ENABLED, patch.ambientcg.enabled ? '1' : '0');
  }

  await applyExternalMaterialsSettings();
  return loadExternalMaterialsSettingsPublic();
}

export async function applyExternalMaterialsSettings(): Promise<void> {
  const settings = await loadExternalMaterialsSettingsPublic();
  const { token } = await resolveFabRefreshToken();
  const proxy = await resolveFabHttpProxy();
  const flareSolverrUrl = await resolveFabFlareSolverrUrl();

  applyFabRuntimeConfig({ refreshToken: token, httpProxy: proxy, flareSolverrUrl });
  applyProviderEnabledFromSettings({
    fab: settings.fab.enabled,
    polyhaven: settings.polyhaven.enabled,
    ambientcg: settings.ambientcg.enabled,
  });
}
