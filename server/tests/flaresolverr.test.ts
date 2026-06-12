/**
 * FlareSolverr client — cookie injection and API parsing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FlareSolverrError,
  flareSolverrRequestGet,
  hasCloudflareClearance,
  injectFlareSolverrCookies,
} from '../src/fab/flaresolverr.js';

describe('flaresolverr', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes solver base URL and returns cookies', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        status: 'ok',
        message: 'Challenge solved',
        solution: {
          cookies: [
            { name: 'cf_clearance', value: 'abc123', domain: '.fab.com' },
            { name: '__cf_bm', value: 'bm456', domain: '.fab.com' },
          ],
          userAgent: 'Mozilla/5.0 test',
        },
      }),
    });

    const result = await flareSolverrRequestGet('http://127.0.0.1:8191', 'https://www.fab.com/');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8191/v1',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.cookies).toHaveLength(2);
    expect(result.userAgent).toBe('Mozilla/5.0 test');
  });

  it('forwards Fab HTTP proxy to FlareSolverr', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        status: 'ok',
        solution: { cookies: [] },
      }),
    });

    await flareSolverrRequestGet('http://localhost:8191/v1', 'https://www.fab.com/', {
      proxy: 'http://proxy.local:8080',
    });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.proxy).toEqual({ url: 'http://proxy.local:8080' });
  });

  it('throws FlareSolverrError on failure response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'error', message: 'timeout' }),
    });

    await expect(
      flareSolverrRequestGet('http://127.0.0.1:8191/v1', 'https://www.fab.com/'),
    ).rejects.toBeInstanceOf(FlareSolverrError);
  });

  it('throws FlareSolverrError for invalid solver URL', async () => {
    await expect(
      flareSolverrRequestGet(':::bad:::', 'https://www.fab.com/'),
    ).rejects.toMatchObject({ message: expect.stringContaining('FlareSolverr URL invalid') });
  });

  it('reports FlareSolverr unreachable on connection failure', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    }));

    await expect(
      flareSolverrRequestGet('http://127.0.0.1:8191/v1', 'https://www.fab.com/'),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/FlareSolverr unreachable at http:\/\/127\.0\.0\.1:8191\/v1/),
    });
  });

  it('hints docker networking when loopback FlareSolverr URL fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(
      flareSolverrRequestGet('http://127.0.0.1:8191/v1', 'https://www.fab.com/'),
    ).rejects.toMatchObject({
      message: expect.stringContaining('http://flaresolverr:8191/v1'),
    });
  });

  it('injects cookies into hostname jar', () => {
    const jar = new Map<string, Map<string, string>>();
    injectFlareSolverrCookies(
      [{ name: 'cf_clearance', value: 'tok', domain: '.fab.com' }],
      'www.fab.com',
      jar,
    );
    expect(hasCloudflareClearance(jar, 'www.fab.com')).toBe(true);
    expect(jar.get('www.fab.com')?.get('cf_clearance')).toBe('tok');
  });
});
