/**
 * Unit tests for external material providers + unified search (mocked API).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  createAmbientCgProvider,
  listAmbientCgDownloadOptions,
  selectAmbientCgDownload,
} from '../src/external-materials/ambientcg.js';
import { createPolyHavenProvider, resetPolyHavenCatalogCache } from '../src/external-materials/polyhaven.js';
import {
  buildPolyHavenPreviewUrlByResolution,
  estimatePolyHavenDownloadSize,
  listPolyHavenMapLabels,
  listPolyHavenResolutions,
  polyHavenPreviewUrl,
  selectPolyHavenMaps,
} from '../src/external-materials/polyhavenMaps.js';
import { FabApiError } from '../src/fab/client.js';
import { scoreQueryMatch, unifiedSearch } from '../src/external-materials/unifiedSearch.js';
import { createFabProvider } from '../src/external-materials/fab.js';
import {
  defaultFabResolution,
  listFabDownloadResolutions,
  parseFabZipResolution,
  pickDownloadTarget,
} from '../src/fab/client.js';
import type { FabListingFormat } from '../src/fab/types.js';
import { encodeUnifiedCursor } from '../src/external-materials/types.js';
import { externalImportResolutionTag } from '../src/api/externalMaterials.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');
const catalog = JSON.parse(readFileSync(resolve(fixturesDir, 'polyhaven-catalog.json'), 'utf8'));
const files = JSON.parse(readFileSync(resolve(fixturesDir, 'polyhaven-files-concrete.json'), 'utf8'));
const fabSearch = JSON.parse(readFileSync(resolve(fixturesDir, 'fab-search.json'), 'utf8'));
const fabFormats = JSON.parse(readFileSync(resolve(fixturesDir, 'fab-formats-concrete.json'), 'utf8')) as FabListingFormat[];
const ambientSearch = JSON.parse(readFileSync(resolve(fixturesDir, 'ambientcg-search-concrete.json'), 'utf8'));
const ambientDetail = JSON.parse(readFileSync(resolve(fixturesDir, 'ambientcg-detail-concrete048.json'), 'utf8'));

describe('scoreQueryMatch', () => {
  it('ranks exact title matches highest', () => {
    expect(scoreQueryMatch('concrete', { title: 'Concrete Floor', tags: [] })).toBeGreaterThan(
      scoreQueryMatch('concrete', { title: 'Brick Wall', tags: ['concrete'] }),
    );
  });
});

describe('polyhavenMaps', () => {
  it('selects PBR maps at configured resolution', () => {
    const maps = selectPolyHavenMaps(files, 'concrete_floor_worn_001', '2k');
    expect(maps.map((m) => m.slot)).toEqual(['albedo', 'normal', 'roughness']);
    expect(maps[0]?.filename).toContain('_diff_2k.jpg');
  });

  it('estimates total download size', () => {
    expect(estimatePolyHavenDownloadSize(files, '2k')).toBe(482906 + 512000 + 256000);
  });

  it('lists resolutions and human-readable map labels', () => {
    expect(listPolyHavenResolutions(files)).toEqual(['2k']);
    expect(listPolyHavenMapLabels(files, '2k')).toEqual(['Albedo', 'Normal', 'Roughness']);
  });

  it('builds preview URLs from diffuse maps', () => {
    expect(polyHavenPreviewUrl(files, '2k')).toBe('https://dl.example.com/concrete_floor_worn_001_diff_2k.jpg');
    expect(buildPolyHavenPreviewUrlByResolution(files, ['2k'])).toEqual({
      '2k': 'https://dl.example.com/concrete_floor_worn_001_diff_2k.jpg',
    });
  });
});

describe('polyhaven provider (mocked)', () => {
  it('filters catalog by query and paginates', async () => {
    resetPolyHavenCatalogCache();
    const narrowCatalog = {
      concrete_floor_worn_001: catalog.concrete_floor_worn_001,
    };
    const provider = createPolyHavenProvider({
      fetchCatalog: async () => narrowCatalog,
      fetchFiles: async () => files,
      fetchBuffer: async () => Buffer.from('fake-image'),
    });

    const page1 = await provider.search({ q: 'concrete', cursor: null, limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]?.sourceId).toBe('concrete_floor_worn_001');
    expect(page1.nextCursor).toBeNull();
  });

  it('exposes maps and resolutions on detail', async () => {
    resetPolyHavenCatalogCache();
    const provider = createPolyHavenProvider({
      fetchCatalog: async () => catalog,
      fetchFiles: async () => files,
      fetchBuffer: async () => Buffer.from('jpeg-bytes'),
    });
    const detail = await provider.getDetail('concrete_floor_worn_001');
    expect(detail?.maps).toEqual(['Albedo', 'Normal', 'Roughness']);
    expect(detail?.resolutions).toEqual(['2k']);
    expect(detail?.defaultResolution).toBe('2k');
    expect(detail?.previewUrl).toBe('https://dl.example.com/concrete_floor_worn_001_diff_2k.jpg');
    expect(detail?.previewUrlByResolution).toEqual({
      '2k': 'https://dl.example.com/concrete_floor_worn_001_diff_2k.jpg',
    });
    expect(detail?.providerUrl).toBe('https://polyhaven.com/a/concrete_floor_worn_001');
  });

  it('updates preview URL when resolution is requested on detail', async () => {
    resetPolyHavenCatalogCache();
    const multiResFiles = {
      ...files,
      Diffuse: {
        '1k': { jpg: { url: 'https://dl.example.com/concrete_floor_worn_001_diff_1k.jpg', size: 120000 } },
        '2k': files.Diffuse['2k'],
      },
    };
    const provider = createPolyHavenProvider({
      fetchCatalog: async () => catalog,
      fetchFiles: async () => multiResFiles,
      fetchBuffer: async () => Buffer.from('jpeg-bytes'),
    });
    const detail = await provider.getDetail('concrete_floor_worn_001', { resolution: '1k' });
    expect(detail?.previewUrl).toBe('https://dl.example.com/concrete_floor_worn_001_diff_1k.jpg');
    expect(detail?.downloadSize).toBeGreaterThan(0);
  });

  it('builds a virtual zip on download', async () => {
    resetPolyHavenCatalogCache();
    const provider = createPolyHavenProvider({
      fetchCatalog: async () => catalog,
      fetchFiles: async () => files,
      fetchBuffer: async () => Buffer.from('jpeg-bytes'),
    });
    const payload = await provider.downloadForImport('concrete_floor_worn_001');
    expect(payload.filename).toContain('.zip');
    expect(payload.buffer.length).toBeGreaterThan(0);
  });

  it('honours requested resolution on download', async () => {
    resetPolyHavenCatalogCache();
    const provider = createPolyHavenProvider({
      fetchCatalog: async () => catalog,
      fetchFiles: async () => files,
      fetchBuffer: async () => Buffer.from('jpeg-bytes'),
    });
    const payload = await provider.downloadForImport('concrete_floor_worn_001', { resolution: '2k' });
    expect(payload.filename).toBe('concrete_floor_worn_001_2k.zip');
  });
});

describe('external import resolution tag', () => {
  it('normalizes resolution into a material tag', () => {
    expect(externalImportResolutionTag('2K-JPG')).toBe('resolution:2k-jpg');
    expect(externalImportResolutionTag('  4k  ')).toBe('resolution:4k');
    expect(externalImportResolutionTag(undefined)).toBeNull();
  });
});

describe('ambientcg downloads', () => {
  it('prefers exact attribute match', () => {
    const downloads = ambientDetail.assets[0].downloads;
    const picked = selectAmbientCgDownload(downloads, '2K-JPG');
    expect(picked?.attributes).toBe('2K-JPG');
  });

  it('lists download attribute options', () => {
    const downloads = ambientDetail.assets[0].downloads;
    expect(listAmbientCgDownloadOptions(downloads)).toEqual(['1K-JPG', '2K-JPG', '2K-PNG', '4K-JPG']);
  });

  it('falls back to lower resolution when preferred is unavailable', () => {
    const downloads = ambientDetail.assets[0].downloads;
    const picked = selectAmbientCgDownload(downloads, '8K-JPG');
    expect(picked?.attributes).toBe('4K-JPG');
  });
});

describe('ambientcg provider (mocked)', () => {
  it('normalizes search results with thumbnails', async () => {
    const provider = createAmbientCgProvider({
      searchAssets: async () => ambientSearch,
      fetchAsset: async (id) => ambientDetail.assets.find((a: { id: string }) => a.id === id) ?? null,
      fetchBuffer: async () => Buffer.from('PK'),
    });

    const page = await provider.search({ q: 'concrete', cursor: null, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.source).toBe('ambientcg');
    expect(page.items[0]?.sourceId).toBe('Concrete048');
    expect(page.items[0]?.thumbnailUrl).toContain('Concrete048');
    expect(page.nextCursor).toBeNull();
  });

  it('exposes maps and resolutions on detail', async () => {
    const provider = createAmbientCgProvider({
      searchAssets: async () => ambientSearch,
      fetchAsset: async () => ambientDetail.assets[0],
      fetchBuffer: async () => Buffer.from('zip-bytes'),
    });
    const detail = await provider.getDetail('Concrete048');
    expect(detail?.maps).toContain('Albedo');
    expect(detail?.resolutions).toContain('2K-JPG');
    expect(detail?.defaultResolution).toBe('2K-JPG');
    expect(detail?.providerUrl).toBe('https://ambientcg.com/view?id=Concrete048');
  });

  it('downloads the configured ZIP package', async () => {
    const provider = createAmbientCgProvider({
      searchAssets: async () => ambientSearch,
      fetchAsset: async () => ambientDetail.assets[0],
      fetchBuffer: async () => Buffer.from('zip-bytes'),
    });
    const payload = await provider.downloadForImport('Concrete048');
    expect(payload.filename).toBe('Concrete048_2K-JPG.zip');
    expect(payload.name).toBe('Concrete 048');
    expect(payload.buffer.length).toBeGreaterThan(0);
  });

  it('honours requested resolution on download', async () => {
    const provider = createAmbientCgProvider({
      searchAssets: async () => ambientSearch,
      fetchAsset: async () => ambientDetail.assets[0],
      fetchBuffer: async () => Buffer.from('zip-bytes'),
    });
    const payload = await provider.downloadForImport('Concrete048', { resolution: '4K-JPG' });
    expect(payload.filename).toBe('Concrete048_4K-JPG.zip');
  });
});

describe('fab download resolutions', () => {
  it('parses resolution suffixes from Fab ZIP filenames', () => {
    expect(parseFabZipResolution('concrete_floor_worn_001_8k.zip')).toBe('8k');
    expect(parseFabZipResolution('concrete_floor_worn_001_4k.zip')).toBe('4k');
    expect(parseFabZipResolution('material.zip')).toBeNull();
  });

  it('lists and defaults Fab resolutions', () => {
    expect(listFabDownloadResolutions(fabFormats)).toEqual(['1k', '2k', '4k', '8k']);
    expect(defaultFabResolution(['1k', '2k', '4k', '8k'])).toBe('4k');
  });

  it('picks the requested resolution file', () => {
    const target = pickDownloadTarget(fabFormats, '2k');
    expect(target.filename).toBe('concrete_floor_worn_001_2k.zip');
    expect(target.fileSize).toBe(32768000);
  });
});

describe('fab provider (mocked)', () => {
  it('normalizes search results', async () => {
    const provider = createFabProvider({
      search: async () => ({
        items: fabSearch.results.map((r: { uid: string; title?: string; tags?: { name?: string }[] }) => ({
          id: r.uid,
          title: r.title ?? 'Untitled',
          listingType: 'surface',
          thumbnailUrl: 'https://cdn.example.com/t.jpg',
          previewUrl: 'https://cdn.example.com/p.jpg',
          tags: (r.tags ?? []).map((t) => t.name ?? '').filter(Boolean),
          category: 'Surfaces',
          seller: 'Quixel',
          isFree: true,
          price: null,
          formats: ['zip'],
        })),
        limit: 2,
        cursor: null,
        nextCursor: 'cursor-page-2',
      }),
      getListing: async () => null,
      download: async () => ({ buffer: Buffer.from('PK'), filename: 'mat.zip', name: 'Test' }),
    });

    const page = await provider.search({ q: 'concrete', cursor: null, limit: 2 });
    expect(page.items[0]?.source).toBe('fab');
    expect(page.items[0]?.title).toBe('Concrete Wall Surface');
    expect(page.items[0]?.providerUrl).toContain('fab.com/listings/');
  });

  it('exposes resolutions, sanitized description, and provider URL on detail', async () => {
    const provider = createFabProvider({
      search: async () => ({ items: [], limit: 0, cursor: null, nextCursor: null }),
      getListing: async () => ({
        id: 'fab-concrete-001',
        title: 'Concrete Floor',
        listingType: 'material',
        thumbnailUrl: 'https://cdn.example.com/t.jpg',
        previewUrl: 'https://cdn.example.com/p.jpg',
        tags: ['concrete'],
        category: 'Surfaces',
        seller: 'Quixel',
        isFree: true,
        price: null,
        formats: ['texture-set'],
        description: '<p><strong>Texel density</strong>: 2048 px/m</p><p>Maps: Albedo, Normal</p>',
        publishedAt: null,
        ratingAverage: null,
        ratingCount: null,
      }),
      getFormats: async () => fabFormats,
      download: async (_id, opts) => ({
        buffer: Buffer.from('PK'),
        filename: `concrete_floor_worn_001_${opts?.resolution ?? '4k'}.zip`,
        name: 'Concrete Floor',
      }),
    });

    const detail = await provider.getDetail('fab-concrete-001');
    expect(detail?.providerUrl).toBe('https://www.fab.com/listings/fab-concrete-001');
    expect(detail?.description).toBe('Texel density: 2048 px/m\nMaps: Albedo, Normal');
    expect(detail?.resolutions).toEqual(['1k', '2k', '4k', '8k']);
    expect(detail?.defaultResolution).toBe('4k');
    expect(detail?.downloadSize).toBe(131072000);

    const detail2k = await provider.getDetail('fab-concrete-001', { resolution: '2k' });
    expect(detail2k?.downloadSize).toBe(32768000);
  });

  it('honours requested resolution on download', async () => {
    const provider = createFabProvider({
      search: async () => ({ items: [], limit: 0, cursor: null, nextCursor: null }),
      getListing: async () => null,
      getFormats: async () => fabFormats,
      download: async (_id, opts) => ({
        buffer: Buffer.from('PK'),
        filename: `concrete_floor_worn_001_${opts?.resolution ?? '4k'}.zip`,
        name: 'Concrete Floor',
      }),
    });

    const payload = await provider.downloadForImport('fab-concrete-001', { resolution: '1k' });
    expect(payload.filename).toBe('concrete_floor_worn_001_1k.zip');
  });
});

describe('unifiedSearch', () => {
  beforeEach(async () => {
    process.env.EXTERNAL_MATERIALS_INDEX_USE = 'false';
    const { clearIndexMemoryCacheForTests } = await import('../src/external-materials/indexCache.js');
    clearIndexMemoryCacheForTests();
  });

  afterEach(() => {
    delete process.env.EXTERNAL_MATERIALS_INDEX_USE;
  });

  it('merges providers and encodes multi-source cursors', async () => {
    resetPolyHavenCatalogCache();
    const poly = createPolyHavenProvider({ fetchCatalog: async () => catalog, fetchFiles: async () => files });
    const fab = createFabProvider({
      search: async () => ({
        items: [{
          id: 'fab-1',
          title: 'Fab Concrete',
          listingType: 'material',
          thumbnailUrl: null,
          previewUrl: null,
          tags: ['concrete'],
          category: null,
          seller: null,
          isFree: true,
          price: null,
          formats: ['texture-set'],
        }],
        limit: 5,
        cursor: null,
        nextCursor: 'fab-next',
      }),
      getListing: async () => null,
      download: async () => ({ buffer: Buffer.from(''), filename: 'x.zip', name: 'x' }),
    });

    const result = await unifiedSearch([fab, poly], {
      q: 'concrete',
      sources: ['fab', 'polyhaven', 'ambientcg'],
      cursor: null,
      limit: 5,
    });

    expect(result.items.some((i) => i.source === 'fab')).toBe(true);
    expect(result.items.some((i) => i.source === 'polyhaven')).toBe(true);
    expect(result.nextCursor).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(result.nextCursor!, 'base64url').toString('utf8'));
    expect(decoded.fab).toBe('fab-next');
  });

  it('round-trips unified cursor encoding', () => {
    const encoded = encodeUnifiedCursor({ fab: 'abc', polyhaven: '10' });
    expect(encoded).toBeTruthy();
  });

  it('returns partial results when one provider fails', async () => {
    resetPolyHavenCatalogCache();
    const poly = createPolyHavenProvider({ fetchCatalog: async () => catalog, fetchFiles: async () => files });
    const fab = createFabProvider({
      search: async () => {
        throw new FabApiError(
          'Fab is blocked by Cloudflare from this server.',
          403,
          'fab_cloudflare_blocked',
        );
      },
      getListing: async () => null,
      download: async () => ({ buffer: Buffer.from(''), filename: 'x.zip', name: 'x' }),
    });

    const result = await unifiedSearch([fab, poly], {
      q: 'concrete',
      sources: ['fab', 'polyhaven'],
      cursor: null,
      limit: 5,
    });

    expect(result.items.some((i) => i.source === 'polyhaven')).toBe(true);
    expect(result.items.some((i) => i.source === 'fab')).toBe(false);
    expect(result.providerErrors?.fab).toContain('Cloudflare');
  });

  it('wraps bare fetch failed into actionable provider error', async () => {
    const fab = createFabProvider({
      search: async () => {
        throw new TypeError('fetch failed');
      },
      getListing: async () => null,
      download: async () => ({ buffer: Buffer.from(''), filename: 'x.zip', name: 'x' }),
    });

    const result = await unifiedSearch([fab], {
      q: 'brick',
      sources: ['fab'],
      cursor: null,
      limit: 5,
    });

    expect(result.providerErrors?.fab).toContain('FlareSolverr URL');
  });
});
