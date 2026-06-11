/**
 * External materials admin settings — token override + provider toggles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyFabRuntimeConfig,
  fabAuthConfigured,
  setFabRefreshTokenForTests,
} from '../src/fab/auth.js';

const getSetting = vi.fn<(key: string) => Promise<string | undefined>>();
const setSetting = vi.fn<(key: string, value: string) => Promise<void>>();

vi.mock('../src/db/settings.js', () => ({
  getSetting: (key: string) => getSetting(key),
  setSetting: (key: string, value: string) => setSetting(key, value),
}));

describe('external materials settings', () => {
  beforeEach(() => {
    getSetting.mockReset();
    setSetting.mockReset();
    setFabRefreshTokenForTests(null);
    delete process.env.FAB_EPIC_REFRESH_TOKEN;
    delete process.env.FAB_HTTP_PROXY;
    delete process.env.FAB_ENABLED;
    delete process.env.POLYHAVEN_ENABLED;
    delete process.env.AMBIENTCG_ENABLED;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers DB token over env when applying runtime config', async () => {
    vi.stubEnv('FAB_EPIC_REFRESH_TOKEN', 'env-token-abcdefghij');
    getSetting.mockImplementation(async (key) => {
      if (key === 'fab_epic_refresh_token') return 'db-token-xyz123456789';
      return undefined;
    });

    const { applyExternalMaterialsSettings } = await import('../src/settings/externalMaterials.js');
    await applyExternalMaterialsSettings();

    expect(fabAuthConfigured()).toBe(true);
    applyFabRuntimeConfig({ refreshToken: 'db-token-xyz123456789', httpProxy: null });
    expect(fabAuthConfigured()).toBe(true);
  });

  it('masks token in public settings response', async () => {
    getSetting.mockImplementation(async (key) => {
      if (key === 'fab_epic_refresh_token') return 'secretRefreshTokenValue';
      return undefined;
    });

    const { loadExternalMaterialsSettingsPublic } = await import('../src/settings/externalMaterials.js');
    const settings = await loadExternalMaterialsSettingsPublic();

    expect(settings.fab.tokenConfigured).toBe(true);
    expect(settings.fab.tokenPreview).toBe('sec••••ue');
    expect(settings.fab.tokenSource).toBe('db');
    expect(JSON.stringify(settings)).not.toContain('secretRefreshTokenValue');
  });

  it('patch stores provider toggles and clears token override with empty string', async () => {
    const { patchExternalMaterialsSettings } = await import('../src/settings/externalMaterials.js');

    await patchExternalMaterialsSettings({
      fab: { enabled: false, epicRefreshToken: '', httpProxy: 'http://proxy.local:8080' },
      polyhaven: { enabled: false },
      ambientcg: { enabled: true },
    });

    expect(setSetting).toHaveBeenCalledWith('fab_enabled', '0');
    expect(setSetting).toHaveBeenCalledWith('fab_epic_refresh_token', '');
    expect(setSetting).toHaveBeenCalledWith('fab_http_proxy', 'http://proxy.local:8080');
    expect(setSetting).toHaveBeenCalledWith('external_polyhaven_enabled', '0');
    expect(setSetting).toHaveBeenCalledWith('external_ambientcg_enabled', '1');
  });

  it('falls back to env enabled flags when DB unset', async () => {
    vi.stubEnv('FAB_ENABLED', 'false');
    vi.stubEnv('POLYHAVEN_ENABLED', 'true');
    vi.stubEnv('AMBIENTCG_ENABLED', 'false');

    const { loadExternalMaterialsSettingsPublic } = await import('../src/settings/externalMaterials.js');
    const settings = await loadExternalMaterialsSettingsPublic();

    expect(settings.fab.enabled).toBe(false);
    expect(settings.polyhaven.enabled).toBe(true);
    expect(settings.ambientcg.enabled).toBe(false);
  });
});
