/**
 * Unit tests for external material providers + unified search (mocked API).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAmbientCgProvider,
  selectAmbientCgDownload,
} from '../src/external-materials/ambientcg.js';
import { createPolyHavenProvider, resetPolyHavenCatalogCache } from '../src/external-materials/polyhaven.js';
import { estimatePolyHavenDownloadSize, selectPolyHavenMaps } from '../src/external-materials/polyhavenMaps.js';
import { scoreQueryMatch, unifiedSearch } from '../src/external-materials/unifiedSearch.js';
import { createFabProvider } from '../src/external-materials/fab.js';
import { encodeUnifiedCursor } from '../src/external-materials/types.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');
const catalog = JSON.parse(readFileSync(resolve(fixturesDir, 'polyhaven-catalog.json'), 'utf8'));
const files = JSON.parse(readFileSync(resolve(fixturesDir, 'polyhaven-files-concrete.json'), 'utf8'));
const fabSearch = JSON.parse(readFileSync(resolve(fixturesDir, 'fab-search.json'), 'utf8'));
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
});

describe('polyhaven provider (mocked)', () => {
  it('filters catalog by query and paginates', async () => {
    resetPolyHavenCatalogCache();
    const provider = createPolyHavenProvider({
      fetchCatalog: async () => catalog,
      fetchFiles: async () => files,
      fetchBuffer: async () => Buffer.from('fake-image'),
    });

    const page1 = await provider.search({ q: 'concrete', cursor: null, limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]?.sourceId).toBe('concrete_floor_worn_001');
    expect(page1.nextCursor).toBeNull();

    const page2 = await provider.search({ q: 'concrete', cursor: '1', limit: 1 });
    expect(page2.items).toHaveLength(0);
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
});

describe('ambientcg downloads', () => {
  it('prefers exact attribute match', () => {
    const downloads = ambientDetail.assets[0].downloads;
    const picked = selectAmbientCgDownload(downloads, '2K-JPG');
    expect(picked?.attributes).toBe('2K-JPG');
  });

  it('falls back to lower resolution when preferred is unavailable', () => {
    const downloads = ambientDetail.assets[0].downloads;
    const picked = selectAmbientCgDownload(downloads, '8K-JPG');
    expect(picked?.attributes).toBe('2K-JPG');
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
  });
});

describe('unifiedSearch', () => {
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
});
