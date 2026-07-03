import { describe, expect, it } from 'vitest';
import { materialPreviewEtag, materialPreviewUrl } from '../src/materials/previewUrl.js';

describe('materialPreviewUrl', () => {
  it('returns null when no thumbnail is set', () => {
    expect(materialPreviewUrl('abc', '2026-01-01T00:00:00.000Z', null)).toBeNull();
  });

  it('includes a cache-busting query from updatedAt', () => {
    const url = materialPreviewUrl(
      'abc',
      '2026-01-01T00:00:00.000Z',
      'thumb-id',
    );
    expect(url).toBe(`/api/materials/abc/preview?v=${Date.parse('2026-01-01T00:00:00.000Z')}`);
  });

  it('builds a stable etag from thumbnail id and updatedAt', () => {
    const etag = materialPreviewEtag('thumb-id', '2026-01-01T00:00:00.000Z');
    expect(etag).toBe(`"thumb-id-${Date.parse('2026-01-01T00:00:00.000Z')}"`);
  });
});
