/**
 * Fab HTTP client — Cloudflare block detection.
 */
import { describe, expect, it } from 'vitest';
import { FabApiError, isFabCloudflareResponse } from '../src/fab/client.js';

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

describe('FabApiError', () => {
  it('carries fab_cloudflare_blocked code', () => {
    const err = new FabApiError('blocked', 403, 'fab_cloudflare_blocked');
    expect(err.code).toBe('fab_cloudflare_blocked');
    expect(err.status).toBe(403);
  });
});
