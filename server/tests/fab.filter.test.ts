/**
 * Fab search filters — free single downloadable materials only.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isFreeSingleMaterialListing,
  isFreeSingleMaterialSummary,
  isPaidListing,
} from '../src/fab/filter.js';
import { normalizeSearchListing } from '../src/fab/normalize.js';
import type { FabSearchListing, FabSearchResponse } from '../src/fab/types.js';

const BRICK_FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'fab-search-brick.json'), 'utf8'),
) as FabSearchResponse;

const CONCRETE_FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'fab-search-concrete.json'), 'utf8'),
) as FabSearchResponse;

function listing(overrides: Partial<FabSearchListing> & { uid: string }): FabSearchListing {
  return {
    title: 'Test Material',
    listingType: 'material',
    isFree: true,
    tags: [],
    assetFormats: [{ assetFormatType: { code: 'texture-set', name: 'Texture Set' } }],
    ...overrides,
  };
}

describe('isFreeSingleMaterialListing', () => {
  it('accepts free material with texture-set format', () => {
    expect(isFreeSingleMaterialListing(listing({ uid: 'a' }))).toBe(true);
  });

  it('accepts free material with megascans format', () => {
    expect(isFreeSingleMaterialListing(listing({
      uid: 'b',
      assetFormats: [{ assetFormatType: { code: 'megascans' } }],
    }))).toBe(true);
  });

  it('rejects paid listings (isFree false)', () => {
    const paid = BRICK_FIXTURE.results[0]!;
    expect(isFreeSingleMaterialListing(paid)).toBe(false);
  });

  it('accepts Megascans free concrete (isFree false, price 0)', () => {
    const megascans = CONCRETE_FIXTURE.results[1]!;
    expect(isPaidListing(megascans)).toBe(false);
    expect(isFreeSingleMaterialListing(megascans)).toBe(true);
  });

  it('filters concrete search fixture to importable materials only', () => {
    const importable = CONCRETE_FIXTURE.results.filter(isFreeSingleMaterialListing);
    expect(importable.map((r) => r.uid)).toEqual([
      '68db59f6-f151-473b-aa47-48e64f47d8c3',
      'rough-concrete-003',
    ]);
  });

  it('rejects UE material packs even when price is zero', () => {
    const pack = CONCRETE_FIXTURE.results[0]!;
    expect(isFreeSingleMaterialListing(pack)).toBe(false);
  });

  it('rejects free listings with non-zero startingPrice', () => {
    expect(isFreeSingleMaterialListing(listing({
      uid: 'c',
      isFree: true,
      startingPrice: { price: 9.99 },
    }))).toBe(false);
  });

  it('rejects UE-only material packs (no texture-set/megascans)', () => {
    expect(isFreeSingleMaterialListing(listing({
      uid: 'd',
      title: 'Glass Material Pack',
      assetFormats: [{ assetFormatType: { code: 'unreal-engine', name: 'Unreal Engine' } }],
    }))).toBe(false);
  });

  it('rejects pack listing types', () => {
    expect(isFreeSingleMaterialListing(listing({
      uid: 'e',
      listingType: 'material-pack',
    }))).toBe(false);
  });

  it('rejects non-material product types', () => {
    expect(isFreeSingleMaterialListing(listing({
      uid: 'f',
      listingType: 'environment',
      assetFormats: [{ assetFormatType: { code: 'unreal-engine' } }],
    }))).toBe(false);
  });
});

describe('isFreeSingleMaterialSummary', () => {
  it('matches normalized free texture-set listing', () => {
    const summary = normalizeSearchListing(listing({ uid: 'g', title: 'Red Brick' }));
    expect(isFreeSingleMaterialSummary(summary)).toBe(true);
  });

  it('rejects normalized paid listing', () => {
    const summary = normalizeSearchListing(BRICK_FIXTURE.results[0]!);
    expect(isFreeSingleMaterialSummary(summary)).toBe(false);
  });

  it('accepts normalized Megascans concrete with price 0', () => {
    const summary = normalizeSearchListing(CONCRETE_FIXTURE.results[1]!);
    expect(summary.isFree).toBe(true);
    expect(isFreeSingleMaterialSummary(summary)).toBe(true);
  });
});
