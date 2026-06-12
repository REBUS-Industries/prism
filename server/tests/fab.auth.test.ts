/**
 * Fab OAuth browse fetch — no silent fallback when token is configured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearFabCookieJarForTests,
  FabOAuthError,
  fabBrowseAuthPath,
  fabBrowseFetch,
  ensureFabCsrf,
  setFabRefreshTokenForTests,
} from '../src/fab/auth.js';

const undiciFetch = vi.fn();

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => undiciFetch(...args),
  Agent: vi.fn(),
  ProxyAgent: vi.fn(),
}));

describe('fabBrowseFetch', () => {
  beforeEach(() => {
    undiciFetch.mockReset();
    clearFabCookieJarForTests();
    setFabRefreshTokenForTests(null);
    delete process.env.FAB_EPIC_REFRESH_TOKEN;
  });

  afterEach(() => {
    setFabRefreshTokenForTests(null);
  });

  it('reports public auth path when no token configured', () => {
    expect(fabBrowseAuthPath()).toBe('public');
  });

  it('reports bearer auth path when refresh token is set', () => {
    setFabRefreshTokenForTests('test-refresh-token-value');
    expect(fabBrowseAuthPath()).toBe('bearer');
  });

  it('surfaces OAuth errors instead of falling back to public fetch', async () => {
    setFabRefreshTokenForTests('bad-refresh-token');
    undiciFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'Refresh token expired' }),
      headers: new Headers(),
    });

    await expect(fabBrowseFetch('https://www.fab.com/i/listings/search?q=brick')).rejects.toBeInstanceOf(
      FabOAuthError,
    );
    expect(undiciFetch).toHaveBeenCalledTimes(1);
  });

  it('primes CSRF with bearer when token is configured', async () => {
    setFabRefreshTokenForTests('test-refresh-token-value');
    undiciFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'access-abc', expires_in: 3600 }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': 'fab_csrftoken=csrf123; Path=/' }),
      });

    await ensureFabCsrf();
    expect(undiciFetch).toHaveBeenCalledTimes(2);
    const csrfInit = undiciFetch.mock.calls[1]![1] as { headers?: Headers };
    expect((csrfInit.headers as Headers).get('Authorization')).toBe('bearer access-abc');
  });

  it('uses public fetch when no token is configured', async () => {
    undiciFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
    });

    await fabBrowseFetch('https://www.fab.com/i/csrf');
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    const init = undiciFetch.mock.calls[0]![1] as { headers?: Headers };
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBeNull();
  });
});
