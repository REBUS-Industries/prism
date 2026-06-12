/**
 * Unit coverage for Fab search/detail response normalization.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isFreeSingleMaterialListing,
} from '../src/fab/filter.js';
import {
  normalizeListingDetail,
  normalizeSearchListing,
  normalizeSearchPage,
} from '../src/fab/normalize.js';
import type { FabListingDetail, FabSearchResponse } from '../src/fab/types.js';

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'fab-search-brick.json'), 'utf8'),
) as FabSearchResponse;

const CONCRETE_FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'fab-search-concrete.json'), 'utf8'),
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
  it('treats Megascans zero-price listings as free', () => {
    const listing = CONCRETE_FIXTURE.results[1]!;
    const out = normalizeSearchListing(listing);
    expect(out.isFree).toBe(true);
    expect(out.price).toBe(0);
    expect(out.formats).toEqual(expect.arrayContaining(['texture-set']));
  });
});

describe('normalizeSearchPage', () => {
  it('wraps results with cursor metadata', () => {
    const page = normalizeSearchPage(FIXTURE, 2, null);
    expect(page.items).toHaveLength(2);
    expect(page.limit).toBe(2);
    expect(page.nextCursor).toBe('bz0y');
  });

  it('applies optional listing filter', () => {
    const mixed = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'fab-search-mixed.json'), 'utf8'),
    ) as FabSearchResponse;
    const page = normalizeSearchPage(mixed, 10, null, isFreeSingleMaterialListing);
    expect(page.items.map((i) => i.id)).toEqual(['free-single-001', 'free-single-004']);
  });

  it('returns Megascans concrete from real-shaped search fixture', () => {
    const page = normalizeSearchPage(CONCRETE_FIXTURE, 10, null, isFreeSingleMaterialListing);
    expect(page.items.map((i) => i.title)).toEqual(['Smooth Concrete', 'Rough Concrete']);
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
