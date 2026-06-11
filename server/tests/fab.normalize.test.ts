/**
 * Unit coverage for Fab search/detail response normalization.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeListingDetail,
  normalizeSearchListing,
  normalizeSearchPage,
} from '../src/fab/normalize.js';
import type { FabListingDetail, FabSearchResponse } from '../src/fab/types.js';

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'fab-search-brick.json'), 'utf8'),
) as FabSearchResponse;

describe('normalizeSearchListing', () => {
  it('maps Fab search listing to PRISM summary fields', () => {
    const listing = FIXTURE.results[0]!;
    const out = normalizeSearchListing(listing);
    expect(out.id).toBe('7d5b8684-bd22-44a6-892d-b2c2d872a248');
    expect(out.title).toBe('Red Brick Wall');
    expect(out.listingType).toBe('material');
    expect(out.seller).toBe('Quixel Megascans');
    expect(out.tags).toContain('Brick');
    expect(out.formats).toEqual(expect.arrayContaining(['texture-set', 'gltf']));
    expect(out.thumbnailUrl).toMatch(/^https:\/\/media\.fab\.com\//);
    expect(out.previewUrl).toMatch(/^https:\/\/media\.fab\.com\//);
  });

  it('handles missing optional fields', () => {
    const out = normalizeSearchListing({ uid: 'x', title: undefined, tags: [] });
    expect(out.title).toBe('Untitled');
    expect(out.tags).toEqual([]);
    expect(out.thumbnailUrl).toBeNull();
  });
});

describe('normalizeSearchPage', () => {
  it('wraps results with cursor metadata', () => {
    const page = normalizeSearchPage(FIXTURE, 2, null);
    expect(page.items).toHaveLength(2);
    expect(page.limit).toBe(2);
    expect(page.nextCursor).toBe('bz0y');
  });
});

describe('normalizeListingDetail', () => {
  it('extends summary with description and ratings', () => {
    const detail: FabListingDetail = {
      ...FIXTURE.results[0]!,
      description: 'Weathered red brick surface material.',
      reviewCount: 1,
      ratings: { averageRating: 5, total: 1 },
    };
    const out = normalizeListingDetail(detail);
    expect(out.description).toBe('Weathered red brick surface material.');
    expect(out.ratingAverage).toBe(5);
    expect(out.ratingCount).toBe(1);
  });
});
