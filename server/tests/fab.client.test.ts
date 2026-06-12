/**
 * Fab HTTP client — Cloudflare block detection.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FabApiError,
  fabCloudflareBlockedMessage,
  isFabCloudflareResponse,
  parseFabBrowseDownloadInfo,
} from '../src/fab/client.js';
import {
  applyFabRuntimeConfig,
  setFabRefreshTokenForTests,
} from '../src/fab/auth.js';

describe('isFabCloudflareResponse', () => {
  it('detects Cloudflare HTML on 403', () => {
    const body = '<!DOCTYPE html><html><title>Just a moment...</title><span id="cf-ray">abc</span></html>';
    expect(isFabCloudflareResponse(body, 403)).toBe(true);
  });

  it('ignores non-CF 403 bodies', () => {
    expect(isFabCloudflareResponse('{"error":"forbidden"}', 403)).toBe(false);
  });

  it('ignores Cloudflare markers on 200', () => {
    expect(isFabCloudflareResponse('cloudflare', 200)).toBe(false);
  });
});

describe('parseFabBrowseDownloadInfo', () => {
  it('rejects API error details with a clear message', () => {
    expect(() => parseFabBrowseDownloadInfo({ detail: 'listing not owned' }))
      .toThrowError(/download-info rejected/i);
  });

  it('extracts signed CDN download URLs', () => {
    const entry = parseFabBrowseDownloadInfo({
      downloadInfo: [{
        assetFormat: 'asset-format/texture-set',
        downloadUrl: 'https://cdn.example.com/material_2k.zip?f_token=abc',
        type: 'binary',
      }],
    });
    expect(entry.downloadUrl).toContain('material_2k.zip');
    expect(entry.type).toBe('binary');
  });
});

describe('FabApiError', () => {
  it('carries fab_cloudflare_blocked code', () => {
    const err = new FabApiError('blocked', 403, 'fab_cloudflare_blocked');
    expect(err.code).toBe('fab_cloudflare_blocked');
    expect(err.status).toBe(403);
  });
});

describe('fabCloudflareBlockedMessage', () => {
  beforeEach(() => {
    setFabRefreshTokenForTests(null);
    applyFabRuntimeConfig({ refreshToken: null, httpProxy: null });
    delete process.env.FAB_EPIC_REFRESH_TOKEN;
    delete process.env.FAB_HTTP_PROXY;
  });

  it('mentions proxy when bearer token is configured', () => {
    setFabRefreshTokenForTests('refresh-token');
    const msg = fabCloudflareBlockedMessage();
    expect(msg).toContain('HTTP proxy');
    expect(msg).toContain('does not bypass Cloudflare');
    expect(msg).not.toContain('FAB_EPIC_REFRESH_TOKEN');
  });

  it('mentions proxy for unauthenticated requests', () => {
    const msg = fabCloudflareBlockedMessage();
    expect(msg).toContain('HTTP proxy');
    expect(msg).toContain('does not bypass Cloudflare');
  });

  it('notes proxy already configured when bearer and proxy are set', () => {
    setFabRefreshTokenForTests('refresh-token');
    applyFabRuntimeConfig({ httpProxy: 'http://proxy.local:8080' });
    const msg = fabCloudflareBlockedMessage();
    expect(msg).toContain('HTTP proxy configured');
  });
});
