/**
 * External materials persistent index — build, search, settings hooks.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPolyHavenProvider } from '../src/external-materials/polyhaven.js';
import { createFabProvider } from '../src/external-materials/fab.js';
import { unifiedSearch } from '../src/external-materials/unifiedSearch.js';

const getSetting = vi.fn<(key: string) => Promise<string | undefined>>();
const setSetting = vi.fn<(key: string, value: string) => Promise<void>>();

vi.mock('../src/db/settings.js', () => ({
  getSetting: (key: string) => getSetting(key),
  setSetting: (key: string, value: string) => setSetting(key, value),
}));

describe('external materials index cache', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'prism-ext-index-'));
    process.env.PRISM_DATA_DIR = dataDir;
    getSetting.mockReset();
    setSetting.mockReset();
    getSetting.mockResolvedValue(undefined);

    const mod = await import('../src/external-materials/indexCache.js');
    mod.clearIndexMemoryCacheForTests();
  });

  afterEach(async () => {
    delete process.env.PRISM_DATA_DIR;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('searches indexed entries locally with text match', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const indexRoot = join(dataDir, 'external-materials-index');
    await mkdir(indexRoot, { recursive: true });
    await writeFile(join(indexRoot, 'manifest.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      counts: { polyhaven: 2 },
    }));
    await writeFile(join(indexRoot, 'polyhaven.json'), JSON.stringify([
      {
        source: 'polyhaven',
        sourceId: 'concrete_a',
        title: 'Concrete Floor',
        tags: ['concrete'],
        thumbnailUrl: null,
        previewUrl: null,
        category: null,
        providerUrl: 'https://polyhaven.com/a/concrete_a',
        metadata: { downloadCount: 100 },
      },
      {
        source: 'polyhaven',
        sourceId: 'brick_b',
        title: 'Red Brick',
        tags: ['brick'],
        thumbnailUrl: null,
        previewUrl: null,
        category: null,
        providerUrl: 'https://polyhaven.com/a/brick_b',
        metadata: { downloadCount: 50 },
      },
    ]));

    getSetting.mockImplementation(async (key) => {
      if (key === 'external_materials_index_use') return '1';
      return undefined;
    });

    const { searchExternalMaterialIndex, clearIndexMemoryCacheForTests } = await import('../src/external-materials/indexCache.js');
    clearIndexMemoryCacheForTests();

    const page = await searchExternalMaterialIndex('polyhaven', { q: 'concrete', cursor: null, limit: 10 });
    expect(page?.items).toHaveLength(1);
    expect(page?.items[0]?.sourceId).toBe('concrete_a');
    expect(page?.items[0]?.relevanceScore).toBeGreaterThan(0);
  });

  it('falls back to live provider search when index is disabled', async () => {
    getSetting.mockImplementation(async (key) => {
      if (key === 'external_materials_index_use') return '0';
      return undefined;
    });

    const poly = createPolyHavenProvider({
      fetchCatalog: async () => ({
        live_only: { name: 'Live Texture', type: 1, tags: ['live'], download_count: 1 },
      }),
      fetchFiles: async () => ({}),
      fetchBuffer: async () => Buffer.from('x'),
    });

    let liveSearchCalls = 0;
    const fab = createFabProvider({
      search: async () => {
        liveSearchCalls += 1;
        return { items: [], limit: 5, cursor: null, nextCursor: null };
      },
      getListing: async () => null,
      download: async () => ({ buffer: Buffer.from(''), filename: 'x.zip', name: 'x' }),
    });

    const result = await unifiedSearch([fab, poly], {
      q: 'live',
      sources: ['fab', 'polyhaven'],
      cursor: null,
      limit: 5,
    });

    expect(liveSearchCalls).toBe(1);
    expect(result.items.some((i) => i.sourceId === 'live_only')).toBe(true);
  });

  it('reports reindex already running via startExternalMaterialReindex guard', async () => {
    const mod = await import('../src/external-materials/indexCache.js');
    mod.getReindexJobState().status = 'running';

    expect(mod.startExternalMaterialReindex()).toBe(false);
    mod.clearIndexMemoryCacheForTests();
  });
});
