/**
 * Fab OAuth browse fetch — no silent fallback when token is configured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearFabCookieJarForTests,
  FabOAuthError,
  fabBrowseAuthPath,
  fabBrowseFetch,
  fabFlareSolverrConfigured,
  ensureFabCloudflareAccess,
  ensureFabCsrf,
  setFabFlareSolverrUrlForTests,
  setFabRefreshTokenForTests,
} from '../src/fab/auth.js';

const undiciFetch = vi.fn();
const flareSolverrSessionCreate = vi.fn();
const flareSolverrSessionFetch = vi.fn();

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => undiciFetch(...args),
  Agent: vi.fn(),
  ProxyAgent: vi.fn(),
}));

vi.mock('../src/fab/flaresolverr.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fab/flaresolverr.js')>();
  return {
    ...actual,
    flareSolverrSessionCreate: (...args: unknown[]) => flareSolverrSessionCreate(...args),
    flareSolverrSessionFetch: (...args: unknown[]) => flareSolverrSessionFetch(...args),
  };
});

describe('fabBrowseFetch', () => {
  beforeEach(() => {
    undiciFetch.mockReset();
    flareSolverrSessionCreate.mockReset();
    flareSolverrSessionFetch.mockReset();
    clearFabCookieJarForTests();
    setFabRefreshTokenForTests(null);
    setFabFlareSolverrUrlForTests(null);
    delete process.env.FAB_EPIC_REFRESH_TOKEN;
    delete process.env.FAB_FLARESOLVERR_URL;
    flareSolverrSessionCreate.mockResolvedValue('session-abc');
  });

  afterEach(() => {
    setFabRefreshTokenForTests(null);
    setFabFlareSolverrUrlForTests(null);
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
    expect((csrfInit.headers as Headers).get('Authorization')).toBe('Bearer access-abc');
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

  it('reports FlareSolverr configured when URL is set', () => {
    setFabFlareSolverrUrlForTests('http://127.0.0.1:8191/v1');
    expect(fabFlareSolverrConfigured()).toBe(true);
  });

  it('calls FlareSolverr session before CSRF when solver URL is configured', async () => {
    setFabFlareSolverrUrlForTests('http://127.0.0.1:8191/v1');
    flareSolverrSessionFetch
      .mockResolvedValueOnce({
        cookies: [{ name: 'cf_clearance', value: 'solver-tok', domain: '.fab.com' }],
        status: 200,
        response: '',
      })
      .mockResolvedValueOnce({
        cookies: [{ name: 'fab_csrftoken', value: 'csrf123', domain: '.fab.com' }],
        status: 200,
        response: '',
      });

    await ensureFabCsrf();
    expect(flareSolverrSessionCreate).toHaveBeenCalledTimes(1);
    expect(flareSolverrSessionFetch).toHaveBeenCalledTimes(2);
    expect(flareSolverrSessionFetch.mock.calls[0]![1]).toBe('https://www.fab.com/');
    expect(flareSolverrSessionFetch.mock.calls[1]![1]).toBe('https://www.fab.com/i/csrf');
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it('ensureFabCloudflareAccess skips repeat solve within TTL', async () => {
    setFabFlareSolverrUrlForTests('http://127.0.0.1:8191/v1');
    flareSolverrSessionFetch.mockResolvedValueOnce({
      cookies: [{ name: 'cf_clearance', value: 'solver-tok' }],
      status: 200,
      response: '',
    });

    await ensureFabCloudflareAccess();
    await ensureFabCloudflareAccess();
    expect(flareSolverrSessionCreate).toHaveBeenCalledTimes(1);
    expect(flareSolverrSessionFetch).toHaveBeenCalledTimes(1);
  });

  it('ensureFabCsrf skips repeat CSRF fetch within TTL', async () => {
    undiciFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'set-cookie': 'fab_csrftoken=csrf123; Path=/' }),
    });

    await ensureFabCsrf();
    await ensureFabCsrf();
    expect(undiciFetch).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent ensureFabCsrf calls', async () => {
    undiciFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'set-cookie': 'fab_csrftoken=csrf123; Path=/' }),
    }));

    await Promise.all([ensureFabCsrf(), ensureFabCsrf(), ensureFabCsrf()]);
    expect(undiciFetch).toHaveBeenCalledTimes(1);
  });

  it('wraps fetch failed from Fab CSRF as marketplace unreachable', async () => {
    undiciFetch.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    }));

    await expect(ensureFabCsrf()).rejects.toMatchObject({
      message: expect.stringContaining('Fab marketplace unreachable'),
    });
  });

  it('wraps bare fetch failed from Fab CSRF', async () => {
    undiciFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(ensureFabCsrf()).rejects.toMatchObject({
      message: expect.stringContaining('Fab marketplace'),
    });
  });
});
