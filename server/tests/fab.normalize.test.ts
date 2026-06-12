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
  fabProviderUrl,
  normalizeListingDetail,
  normalizeSearchListing,
  normalizeSearchPage,
  parseFabDescription,
  stripFabDescriptionHtml,
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

describe('stripFabDescriptionHtml', () => {
  it('removes HTML tags and preserves readable structure', () => {
    const html = '<p><strong>Texel density</strong>: 2048 px/m</p><p>Maps: Albedo, Normal, Roughness</p>';
    expect(stripFabDescriptionHtml(html)).toBe(
      'Texel density: 2048 px/m\nMaps: Albedo, Normal, Roughness',
    );
  });

  it('strips anchor tags but keeps link text', () => {
    const html = '<p>See <a href="https://quixel.com/megascans">Megascans</a> for details.</p>';
    expect(stripFabDescriptionHtml(html)).toBe('See Megascans for details.');
  });
});

describe('parseFabDescription', () => {
  it('extracts map names from HTML descriptions', () => {
    const html = '<p><strong>Maps</strong></p><ul><li>Albedo</li><li>Normal</li><li>Roughness</li></ul>';
    const parsed = parseFabDescription(html);
    expect(parsed.text).toContain('Albedo');
    expect(parsed.maps).toEqual(expect.arrayContaining(['Albedo', 'Normal', 'Roughness']));
  });
});

describe('fabProviderUrl', () => {
  it('builds Fab listing URLs from listing uid', () => {
    expect(fabProviderUrl('abc-123')).toBe('https://www.fab.com/listings/abc-123');
  });
});
