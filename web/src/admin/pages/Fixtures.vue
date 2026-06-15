<script setup lang="ts">

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { RouterLink, useRouter } from 'vue-router';

import FixtureLibraryDetail from '../components/FixtureLibraryDetail.vue';
import FixtureDownloadModal from '../components/FixtureDownloadModal.vue';
import Icon from '../../shared/Icon.vue';
import { fixtureCategoryFromTags, tagsWithFixtureCategory } from '../utils/fixtureTypes';
import { useFixtureTypesStore } from '../stores/fixtureTypes';
import type { GdtfModelQuality } from '../utils/fixtureModelQuality';

import {

  fixturesApi,

  type ApiError,

  type FixtureListItem,

  type GdtfShareCatalogEntry,

  type GdtfShareManufacturer,

} from '../../shared/api';



const router = useRouter();
const fixtureTypesStore = useFixtureTypesStore();

const PAGE = 500;

type DownloadFilter = 'all' | 'downloaded' | 'missing';
type MetadataFilter = 'all' | 'fix' | 'control' | 'anchor' | 'manufacturer' | 'authors';

const fixtures = ref<FixtureListItem[]>([]);

const shareManufacturers = ref<GdtfShareManufacturer[]>([]);

const shareEntries = ref<GdtfShareCatalogEntry[]>([]);

/** Catalog rows fetched for library fixtures absent from the current share page. */
const supplementalEntries = ref<GdtfShareCatalogEntry[]>([]);

const shareTotal = ref(0);



const loading = ref(false);

const error = ref<string | null>(null);

const search = ref('');

const selectedManufacturer = ref('__all__');

const selectedShareUuid = ref<string | null>(null);

const selectedShareRid = ref<number | null>(null);

const downloadFilter = ref<DownloadFilter>('all');
const metadataFilter = ref<MetadataFilter>('all');



const importing = ref(false);
const showDownloadModal = ref(false);
const pendingFixtureType = ref('Spot');

const showCreate = ref(false);

const newName = ref('');

const creating = ref(false);

const fileInput = ref<HTMLInputElement | null>(null);

const checkingUpdates = ref(false);



let searchTimer: ReturnType<typeof setTimeout> | null = null;
let shareLoadGeneration = 0;



function entrySearchHaystack(entry: GdtfShareCatalogEntry): string {
  const modeNames = entry.modes?.map((m) => m.name).join(' ') ?? '';
  return `${entry.fixture} ${entry.manufacturer} ${entry.creator ?? ''} ${entry.uploader ?? ''} ${modeNames}`.toLowerCase();
}

function catalogQueryParams(): { q?: string; manufacturer?: string; limit: number } {
  const q = search.value.trim();
  const manufacturer = selectedManufacturer.value === '__all__' ? undefined : selectedManufacturer.value;
  return { q: q || undefined, manufacturer, limit: 120 };
}

const localByShareUuid = computed(() => {
  const map = new Map<string, FixtureListItem>();
  for (const f of fixtures.value) {
    if (f.gdtfShareUuid) map.set(f.gdtfShareUuid, f);
  }
  return map;
});

/** True when a catalog entry has a matching row in the local fixture library. */
function isLibraryDownload(entry: GdtfShareCatalogEntry): boolean {
  return !!matchLocal(entry);
}

function matchLocal(entry: GdtfShareCatalogEntry): FixtureListItem | undefined {
  const byUuid = localByShareUuid.value.get(entry.uuid);
  if (byUuid) return byUuid;

  const mfg = entry.manufacturer.toLowerCase();
  const fix = entry.fixture.toLowerCase();
  return fixtures.value.find((f) => {
    const fm = f.manufacturer.toLowerCase();
    const fn = f.fixtureName.toLowerCase();
    return fm === mfg && (fn === fix || f.name.toLowerCase().includes(fix));
  });
}

const catalogEntries = computed(() => {
  const seen = new Set<string>();
  const merged: GdtfShareCatalogEntry[] = [];
  for (const entry of [...shareEntries.value, ...supplementalEntries.value]) {
    if (seen.has(entry.uuid)) continue;
    seen.add(entry.uuid);
    merged.push(entry);
  }
  return merged;
});



const filteredEntries = computed(() => {

  const q = search.value.trim().toLowerCase();

  return catalogEntries.value.filter((entry) => {

    if (selectedManufacturer.value !== '__all__' && entry.manufacturer !== selectedManufacturer.value) {
      return false;
    }

    const local = matchLocal(entry);
    const downloaded = !!local;

    if (downloadFilter.value === 'downloaded' && !downloaded) return false;

    if (downloadFilter.value === 'missing' && downloaded) return false;

    if (metadataFilter.value === 'fix' && local && local.hasPreview) return false;
    if (metadataFilter.value === 'fix' && !local) return false;

    if (metadataFilter.value === 'control' && !(entry.modes?.length)) return false;

    if (metadataFilter.value === 'anchor' && local && !local.hasPreview) return false;

    if (metadataFilter.value === 'authors' && !entry.creator && !entry.uploader) return false;

    if (!q) return true;

    const hay = entrySearchHaystack(entry);

    return q.split(/\s+/).every((term) => hay.includes(term));

  });

});



const displayManufacturers = computed((): GdtfShareManufacturer[] => {

  const q = search.value.trim();

  if (!q && downloadFilter.value === 'all' && metadataFilter.value === 'all') {

    return shareManufacturers.value;

  }

  const counts = new Map<string, number>();

  for (const entry of filteredEntries.value) {

    const m = entry.manufacturer || 'Unknown';

    counts.set(m, (counts.get(m) ?? 0) + 1);

  }

  return [...counts.entries()]

    .map(([name, count]) => ({ name, count }))

    .sort((a, b) => a.name.localeCompare(b.name));

});



const filteredAllCount = computed(() => {

  return filteredEntries.value.length;

});



const groupedEntries = computed(() => {

  const groups = new Map<string, GdtfShareCatalogEntry[]>();

  for (const entry of filteredEntries.value) {

    const m = entry.manufacturer || 'Unknown';

    if (!groups.has(m)) groups.set(m, []);

    groups.get(m)!.push(entry);

  }

  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

});



const fixturesWith3d = computed(() =>

  filteredEntries.value.filter((e) => matchLocal(e)?.hasPreview).length,

);



const selectedShare = computed(() =>

  catalogEntries.value.find((e) => e.uuid === selectedShareUuid.value) ?? null,

);



const selectedLocal = computed(() => {

  if (!selectedShare.value) return null;

  return matchLocal(selectedShare.value) ?? null;

});



const listCountLabel = computed(() =>
  `${filteredEntries.value.length} / ${shareTotal.value} Fixtures`,
);

const fixturesWithMetadata = computed(() =>
  filteredEntries.value.filter((e) => matchLocal(e)?.hasPreview).length,
);

function entryFixtureCategory(entry: GdtfShareCatalogEntry): string {
  const local = matchLocal(entry);
  if (!local) return 'Unassigned';
  return fixtureCategoryFromTags(local.tags, fixtureTypesStore.assignableLabels);
}

interface EntryRowMetrics {
  downloaded: boolean;
  dmxCount: number;
  d3Badge: string | null;
  wheelsBadge: string | null;
}

function entryRowMetrics(entry: GdtfShareCatalogEntry): EntryRowMetrics {
  const local = matchLocal(entry);
  const downloaded = isLibraryDownload(entry);
  const dmxCount = entry.modes?.length ?? 0;
  let d3Badge: string | null = null;
  let wheelsBadge: string | null = null;
  if (downloaded) {
    d3Badge = local?.hasPreview ? '✓' : '?';
    wheelsBadge = '?';
  }
  return { downloaded, dmxCount, d3Badge, wheelsBadge };
}



function upsertLocalFixture(item: FixtureListItem): void {
  const idx = fixtures.value.findIndex((f) => f.id === item.id);
  if (idx >= 0) {
    fixtures.value[idx] = { ...fixtures.value[idx], ...item };
  } else {
    fixtures.value = [item, ...fixtures.value];
  }
}

async function loadLocal(): Promise<void> {

  try {

    const res = await fixturesApi.list({ limit: PAGE });

    fixtures.value = res.fixtures;
    void syncDownloadedCatalogEntries();

  } catch {

    /* supplementary */

  }

}

async function syncDownloadedCatalogEntries(): Promise<void> {
  if (downloadFilter.value !== 'downloaded') {
    supplementalEntries.value = [];
    return;
  }

  const inCatalog = new Set(shareEntries.value.map((e) => e.uuid));
  const missingUuids = fixtures.value
    .filter((f) => f.gdtfShareUuid && !inCatalog.has(f.gdtfShareUuid))
    .map((f) => f.gdtfShareUuid!);

  if (!missingUuids.length) {
    supplementalEntries.value = [];
    return;
  }

  const fetched = await Promise.all(
    missingUuids.map((uuid) =>
      fixturesApi.versionsGdtfShare(uuid)
        .then((res) => res.entry)
        .catch(() => null),
    ),
  );
  supplementalEntries.value = fetched.filter((e): e is GdtfShareCatalogEntry => e != null);
}



async function loadShare(): Promise<void> {

  const generation = ++shareLoadGeneration;

  loading.value = true;

  error.value = null;

  try {

    const query = catalogQueryParams();

    const res = await fixturesApi.catalogGdtfShare(query);

    if (generation !== shareLoadGeneration) return;

    shareManufacturers.value = res.manufacturers;

    shareEntries.value = res.entries;

    shareTotal.value = res.total;

    if (

      !query.q

      && selectedManufacturer.value !== '__all__'

      && !res.manufacturers.some((m) => m.name === selectedManufacturer.value)

    ) {

      selectedManufacturer.value = res.manufacturers[0]?.name ?? '__all__';

      return loadShare();

    }

    if (!selectedShareUuid.value && res.entries[0]) {

      selectShareEntry(res.entries[0]);

    } else if (selectedShareUuid.value && !res.entries.some((e) => e.uuid === selectedShareUuid.value)) {

      selectedShareUuid.value = res.entries[0]?.uuid ?? null;

      selectedShareRid.value = res.entries[0]?.versions[0]?.rid ?? null;

    }

  } catch (err) {

    const e = err as ApiError;

    error.value = e.message ?? 'failed to load GDTF-Share catalog';

    shareEntries.value = [];

  } finally {

    if (generation === shareLoadGeneration) loading.value = false;

  }

}



async function reloadAll(): Promise<void> {

  await Promise.all([loadLocal(), loadShare()]);

}



async function bulkCheckUpdates(): Promise<void> {

  const ids = fixtures.value.filter((f) => f.gdtfShareUuid).map((f) => f.id);

  if (!ids.length) return;

  checkingUpdates.value = true;

  try {

    const res = await fixturesApi.bulkCheckUpdates(ids);

    fixtures.value = fixtures.value.map((f) => ({

      ...f,

      updateAvailable: f.gdtfShareUuid ? (res.updates[f.id] ?? false) : f.updateAvailable,

    }));

  } finally {

    checkingUpdates.value = false;

  }

}



function onFixtureRefreshed(item: FixtureListItem): void {

  const idx = fixtures.value.findIndex((f) => f.id === item.id);

  if (idx >= 0) fixtures.value[idx] = { ...fixtures.value[idx], ...item };

}



function onSearchInput(): void {

  if (searchTimer) clearTimeout(searchTimer);

  searchTimer = setTimeout(() => void loadShare(), 350);

}



function selectManufacturer(name: string): void {

  selectedManufacturer.value = name;

  void loadShare();

}



function selectShareEntry(entry: GdtfShareCatalogEntry): void {

  selectedShareUuid.value = entry.uuid;

  selectedShareRid.value = entry.versions[0]?.rid ?? null;

}



function setDownloadFilter(chip: DownloadFilter): void {
  downloadFilter.value = chip;
  void syncDownloadedCatalogEntries().then(() => ensureVisibleManufacturer());
}

function setMetadataFilter(chip: MetadataFilter): void {
  metadataFilter.value = chip;
  ensureVisibleManufacturer();
}



function ensureVisibleManufacturer(): void {

  if (selectedManufacturer.value === '__all__') return;

  const visible = displayManufacturers.value.some((m) => m.name === selectedManufacturer.value);

  if (!visible) {

    selectedManufacturer.value = displayManufacturers.value[0]?.name ?? '__all__';

    void loadShare();

  }

}



function resetFilters(): void {
  search.value = '';
  selectedManufacturer.value = '__all__';
  downloadFilter.value = 'all';
  metadataFilter.value = 'all';
  void loadShare();
}



function openEditor(id: string): void {

  void router.push({ name: 'fixture-editor', params: { id } });

}



async function createBlank(): Promise<void> {

  const name = newName.value.trim();

  if (!name) return;

  creating.value = true;

  try {

    const created = await fixturesApi.create({ name });

    showCreate.value = false;

    newName.value = '';

    openEditor(created.fixture.id);

  } catch (err) {

    error.value = (err as ApiError).message ?? 'create failed';

  } finally {

    creating.value = false;

  }

}



async function removeFixture(f: FixtureListItem): Promise<void> {

  if (!confirm(`Delete fixture "${f.name}"?`)) return;

  try {

    await fixturesApi.remove(f.id);

    fixtures.value = fixtures.value.filter((x) => x.id !== f.id);

  } catch (err) {

    error.value = (err as ApiError).message ?? 'delete failed';

  }

}



function requestImport(): void {
  if (!selectedShare.value || selectedLocal.value) return;
  showDownloadModal.value = true;
}

async function confirmDownload(fixtureType: string, modelQuality: GdtfModelQuality): Promise<void> {
  const entry = selectedShare.value;
  if (!entry) return;
  const rid = selectedShareRid.value ?? entry.versions[0]?.rid;
  if (rid == null) return;

  importing.value = true;
  error.value = null;
  pendingFixtureType.value = fixtureType;
  try {
    const res = await fixturesApi.importGdtfShare(
      rid,
      `${entry.manufacturer} ${entry.fixture}`,
      modelQuality,
    );
    const tagged = await fixturesApi.update(res.fixture.id, {
      tags: tagsWithFixtureCategory(res.fixture.tags, fixtureType, fixtureTypesStore.assignableLabels),
    });
    upsertLocalFixture(tagged.fixture);
    selectShareEntry(entry);
    await syncDownloadedCatalogEntries();
    showDownloadModal.value = false;
    openEditor(res.fixture.id);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'import failed';
  } finally {
    importing.value = false;
  }
}

async function importShareSelected(): Promise<void> {
  if (selectedLocal.value) return;
  requestImport();
}



async function importShareEntry(entry: GdtfShareCatalogEntry): Promise<void> {
  selectShareEntry(entry);
  if (matchLocal(entry)) return;
  requestImport();
}



async function onFile(ev: Event): Promise<void> {

  const file = (ev.target as HTMLInputElement).files?.[0];

  if (!file) return;

  importing.value = true;

  error.value = null;

  try {

    const res = await fixturesApi.importGdtf(file);

    await loadLocal();

    openEditor(res.fixture.id);

  } catch (err) {

    error.value = (err as ApiError).message ?? 'import failed';

  } finally {

    importing.value = false;

    if (fileInput.value) fileInput.value.value = '';

  }

}



function formatVersionSub(entry: GdtfShareCatalogEntry): string {
  const v = entry.versions[0];
  const rev = v?.revision ? `v${v.revision}` : 'v?';
  return `by Manuf: ${entry.manufacturer} - ${rev}`;
}



watch(downloadFilter, () => { void syncDownloadedCatalogEntries(); });

watch(
  () => fixtures.value.map((f) => `${f.id}:${f.gdtfShareUuid ?? ''}`).join(','),
  () => { void syncDownloadedCatalogEntries(); },
);

onMounted(() => {
  void fixtureTypesStore.ensureLoaded();
  void reloadAll();
});

onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });

</script>



<template>

  <div class="fixture-library page-fill">

    <header class="lib-header">

      <div class="header-brand">

        <span class="brand-icon" aria-hidden="true">G</span>

        <div>

          <h1>GDTF Fixture Library</h1>

          <p class="header-sub">Browse the GDTF Share catalog, then download 3D geometry per fixture to populate full DMX, wheels and meshes.</p>

        </div>

      </div>

      <div class="lib-actions">

        <button class="btn-outline" :disabled="loading" @click="reloadAll">

          <Icon name="refresh" :size="16" /> Refresh

        </button>

        <button class="btn-outline" disabled title="Coming soon">

          <Icon name="add_photo_alternate" :size="16" /> Enrich missing photos

        </button>

        <button class="btn-primary" :disabled="loading" @click="loadShare">

          <Icon name="cloud_download" :size="16" /> Import share catalog

        </button>

        <button class="btn-danger" @click="resetFilters">

          <Icon name="close" :size="16" /> Clear

        </button>

        <input ref="fileInput" type="file" accept=".gdtf" hidden @change="onFile" />

      </div>

    </header>



    <div class="filter-toolbar">

      <div class="search-wrap">

        <Icon name="search" :size="16" class="search-icon" />

        <input

          v-model="search"

          class="search-input"

          type="search"

          placeholder="Search manufacturer, fixture, mode…"

          @input="onSearchInput"

        />

      </div>



      <div class="filter-pills">

        <div class="chip-row">

          <span class="chip-label">3D</span>

          <button type="button" class="chip" :class="{ active: downloadFilter === 'all' }" @click="setDownloadFilter('all')">All</button>

          <button type="button" class="chip" :class="{ active: downloadFilter === 'downloaded' }" @click="setDownloadFilter('downloaded')">Downloaded</button>

          <button type="button" class="chip" :class="{ active: downloadFilter === 'missing' }" @click="setDownloadFilter('missing')">Missing</button>

        </div>

        <div class="chip-row">

          <span class="chip-label">Metadata</span>

          <button type="button" class="chip" :class="{ active: metadataFilter === 'all' }" @click="setMetadataFilter('all')">All</button>

          <button type="button" class="chip" :class="{ active: metadataFilter === 'fix' }" @click="setMetadataFilter('fix')">Fix</button>

          <button type="button" class="chip" :class="{ active: metadataFilter === 'control' }" @click="setMetadataFilter('control')">Control only</button>

          <button type="button" class="chip" :class="{ active: metadataFilter === 'anchor' }" @click="setMetadataFilter('anchor')">Anchor</button>

          <button type="button" class="chip" :class="{ active: metadataFilter === 'manufacturer' }" @click="setMetadataFilter('manufacturer')">Manufacturer</button>

          <button type="button" class="chip" :class="{ active: metadataFilter === 'authors' }" @click="setMetadataFilter('authors')">All authors</button>

        </div>

      </div>



      <div class="toolbar-right">

        <select

          class="mfg-dropdown"

          :value="selectedManufacturer"

          @change="selectManufacturer(($event.target as HTMLSelectElement).value)"

        >

          <option value="__all__">All manufacturers</option>

          <option v-for="m in displayManufacturers" :key="m.name" :value="m.name">{{ m.name }} ({{ m.count }})</option>

        </select>

        <button type="button" class="btn-reset" @click="resetFilters">Reset</button>

        <span class="count-label">{{ listCountLabel }}</span>

      </div>

    </div>



    <div v-if="error" class="error-box">{{ error }}</div>



    <div class="lib-body">

      <aside class="mfg-sidebar">

        <h2>Manufacturers</h2>

        <button

          type="button"

          class="mfg-item"

          :class="{ active: selectedManufacturer === '__all__' }"

          @click="selectManufacturer('__all__')"

        >

          <span>All manufacturers</span>

          <span class="mfg-count">{{ filteredAllCount }}</span>

        </button>

        <button

          v-for="m in displayManufacturers"

          :key="m.name"

          type="button"

          class="mfg-item"

          :class="{ active: selectedManufacturer === m.name }"

          @click="selectManufacturer(m.name)"

        >

          <span>{{ m.name }}</span>

          <span class="mfg-count">{{ m.count }}</span>

        </button>

      </aside>



      <section class="fixture-list">

        <div class="list-header">

          <h2>Fixtures <span class="list-count">{{ filteredEntries.length }}</span></h2>

          <span class="list-sub muted">{{ fixturesWithMetadata }} with 3D / metadata</span>

        </div>



        <div v-if="loading && !shareEntries.length" class="muted pad">Loading…</div>

        <div v-else-if="!groupedEntries.length" class="muted pad">

          No catalog results. Check GDTF-Share credentials in Settings or adjust filters.

        </div>



        <template v-for="[mfg, entries] in groupedEntries" :key="mfg">

          <div class="mfg-group-header">

            <span class="mfg-logo">{{ mfg.charAt(0) }}</span>

            <div class="mfg-group-info">

              <span class="mfg-group-name">{{ mfg }}</span>

              <span class="mfg-group-web muted">www.{{ mfg.toLowerCase().replace(/\s+/g, '') }}.com</span>

            </div>

          </div>



          <button

            v-for="entry in entries"

            :key="entry.uuid"

            type="button"

            class="fixture-row"

            :class="{ active: selectedShareUuid === entry.uuid }"

            @click="selectShareEntry(entry)"

          >
            <span
              v-if="entryFixtureCategory(entry) !== 'Unassigned'"
              class="type-bar"
              :style="{ background: fixtureTypesStore.colorFor(entryFixtureCategory(entry)) }"
              :title="entryFixtureCategory(entry)"
              aria-hidden="true"
            />

            <span
              class="dl-status"
              :class="entryRowMetrics(entry).downloaded ? 'downloaded' : 'missing'"
              :title="entryRowMetrics(entry).downloaded ? 'Downloaded to library' : 'Not downloaded'"
            >
              <Icon v-if="entryRowMetrics(entry).downloaded" name="check" :size="14" />
              <Icon v-else name="close" :size="14" />
            </span>

            <div class="row-main">

              <span class="row-title">
                {{ entry.fixture }}
                <span
                  v-if="matchLocal(entry)?.updateAvailable"
                  class="update-badge"
                  title="Newer GDTF revision available"
                ><Icon name="arrow_upward" :size="11" /></span>
              </span>

              <span class="row-sub muted">{{ formatVersionSub(entry) }}</span>

            </div>

            <div class="data-icons" :class="{ active: entryRowMetrics(entry).downloaded }">
              <span class="data-icon dmx" title="DMX modes">
                <Icon name="equalizer" :size="18" />
                <span
                  v-if="entryRowMetrics(entry).downloaded && entryRowMetrics(entry).dmxCount > 0"
                  class="data-badge"
                >{{ entryRowMetrics(entry).dmxCount }}</span>
              </span>
              <span class="data-icon d3" title="3D preview">
                <Icon name="view_in_ar" :size="18" />
                <span v-if="entryRowMetrics(entry).d3Badge" class="data-badge">{{ entryRowMetrics(entry).d3Badge }}</span>
              </span>
              <span class="data-icon wheels" title="Wheels">
                <Icon name="album" :size="18" />
                <span v-if="entryRowMetrics(entry).wheelsBadge" class="data-badge">{{ entryRowMetrics(entry).wheelsBadge }}</span>
              </span>
            </div>

          </button>

        </template>

      </section>



      <aside class="detail-panel">

        <FixtureLibraryDetail

          :entry="selectedShare"

          :local-fixture="selectedLocal"

          :selected-rid="selectedShareRid"

          :importing="importing"

          @import="requestImport"

          @edit="openEditor"

          @delete="removeFixture"

          @update:selected-rid="selectedShareRid = $event"

          @refreshed="onFixtureRefreshed"

        />

      </aside>

    </div>



    <div class="lib-footer">

      <button class="btn-outline small" :disabled="importing" @click="fileInput?.click()"><Icon name="upload_file" :size="14" /> Upload .gdtf</button>

      <button class="btn-outline small" @click="showCreate = true"><Icon name="add" :size="14" /> Blank fixture</button>

      <a href="/convert/" class="btn-outline small link-btn"><Icon name="input" :size="14" /> MVR import</a>

    </div>



    <FixtureDownloadModal
      v-if="showDownloadModal && selectedShare && (selectedShareRid ?? selectedShare.versions[0]?.rid)"
      :fixture-name="selectedShare.fixture"
      :manufacturer="selectedShare.manufacturer"
      :rid="selectedShareRid ?? selectedShare.versions[0]!.rid"
      :saving="importing"
      @cancel="showDownloadModal = false"
      @confirm="confirmDownload"
    />

    <div v-if="showCreate" class="modal-backdrop" @click.self="showCreate = false">

      <div class="card modal">

        <h2>New fixture type</h2>

        <input v-model="newName" placeholder="Display name" @keyup.enter="createBlank" />

        <div class="h-row" style="justify-content: flex-end;">

          <button @click="showCreate = false">Cancel</button>

          <button class="primary" :disabled="creating" @click="createBlank"><Icon name="add" :size="16" /> Create</button>

        </div>

      </div>

    </div>

  </div>

</template>



<style scoped>

.fixture-library {

  display: flex;

  flex-direction: column;

  gap: 0;

}

.lib-header {

  display: flex;

  justify-content: space-between;

  align-items: flex-start;

  gap: 16px;

  flex-shrink: 0;

  padding: 16px 20px;

  border-bottom: 1px solid var(--color-border);

  background: var(--color-bg);

}

.header-brand { display: flex; align-items: flex-start; gap: 14px; }

.brand-icon {

  flex-shrink: 0;

  width: 44px;

  height: 44px;

  display: flex;

  align-items: center;

  justify-content: center;

  border-radius: 50%;

  background: var(--orbit-primary);

  color: #fff;

  font-size: 20px;

  font-weight: 800;

}

.lib-header h1 {

  margin: 0;

  font-size: 20px;

  font-weight: 800;

  letter-spacing: 0.04em;

  text-transform: uppercase;

}

.header-sub {

  margin: 4px 0 0;

  font-size: 13px;

  color: var(--color-text-muted);

  max-width: 520px;

  line-height: 1.4;

}

.lib-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; }

.btn-outline, .btn-primary, .btn-danger {

  display: inline-flex;

  align-items: center;

  gap: 6px;

  padding: 8px 14px;

  border-radius: var(--radius);

  font-size: 11px;

  font-weight: 700;

  letter-spacing: 0.05em;

  text-transform: uppercase;

  cursor: pointer;

  white-space: nowrap;

}

.btn-outline {

  border: 1px solid var(--color-border-strong);

  background: var(--color-bg);

  color: var(--color-text);

}

.btn-outline:hover:not(:disabled) { border-color: var(--orbit-primary); color: var(--orbit-primary); }

.btn-outline:disabled { opacity: 0.45; cursor: not-allowed; }

.btn-primary { border: 1px solid var(--orbit-primary); background: var(--orbit-primary); color: #fff; }

.btn-primary:hover:not(:disabled) { background: var(--orbit-primary-hover); border-color: var(--orbit-primary-hover); }

.btn-primary:disabled { opacity: 0.55; cursor: not-allowed; }

.btn-danger { border: 1px solid var(--color-error); background: var(--color-error); color: #fff; }

.btn-danger:hover { filter: brightness(1.08); }

.btn-icon { font-size: 13px; }

.filter-toolbar {

  display: flex;

  flex-wrap: wrap;

  align-items: center;

  gap: 10px 16px;

  padding: 10px 20px;

  border-bottom: 1px solid var(--color-border);

  background: var(--color-bg-elevated);

}

.search-wrap { position: relative; flex: 1; min-width: 200px; }

.search-icon {

  position: absolute;

  left: 12px;

  top: 50%;

  transform: translateY(-50%);

  font-size: 14px;

  opacity: 0.5;

  pointer-events: none;

}

.search-input {

  width: 100%;

  padding: 9px 14px 9px 36px;

  border: 1px solid var(--color-border);

  border-radius: var(--radius);

  background: var(--color-bg-input);

  color: var(--color-text);

  font-size: 13px;

}

.filter-pills { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 20px; }

.chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }

.chip-label {

  font-size: 11px;

  font-weight: 700;

  text-transform: uppercase;

  letter-spacing: 0.06em;

  color: var(--color-text-muted);

  margin-right: 2px;

}

.chip {

  padding: 5px 12px;

  border: 1px solid var(--color-border);

  border-radius: 999px;

  background: var(--color-bg);

  color: var(--color-text-muted);

  font-size: 12px;

  font-weight: 500;

  cursor: pointer;

}

.chip:hover { border-color: var(--orbit-primary); color: var(--orbit-primary); }

.chip.active { background: var(--orbit-primary); border-color: var(--orbit-primary); color: #fff; }

.toolbar-right { display: flex; align-items: center; gap: 12px; margin-left: auto; }

.mfg-dropdown {

  padding: 7px 10px;

  border: 1px solid var(--color-border);

  border-radius: var(--radius);

  background: var(--color-bg-input);

  color: var(--color-text);

  font-size: 12px;

  max-width: 200px;

}

.btn-reset {
  padding: 7px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.btn-reset:hover { border-color: var(--orbit-primary); color: var(--orbit-primary); }

.count-label { font-size: 12px; color: var(--color-text-muted); white-space: nowrap; }

.lib-body {

  flex: 1;

  min-height: 0;

  display: grid;

  grid-template-columns: 220px 1fr 340px;

  overflow: hidden;

  background: var(--color-bg);

}

.mfg-sidebar {

  border-right: 1px solid var(--color-border);

  background: var(--color-bg-elevated);

  min-height: 0;

  overflow-y: auto;

  padding: 12px 10px;

}

.mfg-sidebar h2 {

  margin: 0 0 8px;

  padding: 0 8px;

  font-size: 10px;

  font-weight: 700;

  letter-spacing: 0.1em;

  text-transform: uppercase;

  color: var(--color-text-muted);

}

.mfg-item {

  display: flex;

  justify-content: space-between;

  align-items: center;

  width: 100%;

  padding: 8px 12px;

  margin-bottom: 2px;

  border: none;

  border-radius: 999px;

  background: transparent;

  text-align: left;

  font-size: 13px;

  color: var(--color-text);

  cursor: pointer;

}

.mfg-item:hover { background: var(--color-bg-hover); }

.mfg-item.active { background: var(--orbit-primary); color: #fff; }

.mfg-count {

  font-size: 11px;

  font-weight: 600;

  min-width: 24px;

  height: 20px;

  padding: 0 6px;

  display: inline-flex;

  align-items: center;

  justify-content: center;

  border-radius: 999px;

  background: rgba(0, 0, 0, 0.1);

}

.mfg-item.active .mfg-count { background: rgba(255, 255, 255, 0.25); }

.fixture-list { min-height: 0; overflow-y: auto; border-right: 1px solid var(--color-border); }

.list-header {

  display: flex;

  align-items: baseline;

  gap: 10px;

  padding: 12px 16px 8px;

  position: sticky;

  top: 0;

  background: var(--color-bg);

  border-bottom: 1px solid var(--color-border);

  z-index: 1;

}

.list-header h2 {

  margin: 0;

  font-size: 10px;

  font-weight: 700;

  letter-spacing: 0.1em;

  text-transform: uppercase;

  color: var(--color-text-muted);

}

.list-count { color: var(--color-text); font-weight: 700; }

.list-sub { font-size: 12px; }

.mfg-group-header {

  display: flex;

  align-items: center;

  gap: 10px;

  padding: 14px 16px 6px;

  background: var(--color-bg-elevated);

  border-bottom: 1px solid var(--color-border);

}

.mfg-logo {

  width: 28px;

  height: 28px;

  display: flex;

  align-items: center;

  justify-content: center;

  border-radius: 50%;

  background: var(--orbit-primary-fade);

  color: var(--orbit-primary);

  font-size: 13px;

  font-weight: 700;

}

.mfg-group-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }

.mfg-group-name {

  font-size: 13px;

  font-weight: 700;

  text-transform: uppercase;

  letter-spacing: 0.03em;

}

.mfg-group-web { font-size: 10px; }

.fixture-row {

  position: relative;

  display: flex;

  align-items: center;

  gap: 10px;

  width: 100%;

  padding: 10px 16px 10px 12px;

  border: none;

  border-bottom: 1px solid var(--color-border);

  background: transparent;

  text-align: left;

  cursor: pointer;

}

.fixture-row:hover { background: var(--color-bg-hover); }

.fixture-row.active {
  background: rgba(255, 107, 0, 0.12);
  border-color: rgba(255, 107, 0, 0.35);
}

.type-bar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  border-radius: 0;
}

.dl-status {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: none;
}

.dl-status.downloaded {
  background: #22c55e;
  color: #fff;
}

.dl-status.missing {
  background: #ef4444;
  color: #fff;
}

.dl-icon {
  width: 12px;
  height: 12px;
}

.data-icons {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  opacity: 0.35;
}

.data-icons.active {
  opacity: 1;
}

.data-icon {
  position: relative;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
}

.data-icons.active .data-icon {
  color: var(--orbit-primary);
}

.data-icon svg {
  width: 18px;
  height: 18px;
}

.data-badge {
  position: absolute;
  right: -2px;
  bottom: -1px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 999px;
  background: var(--orbit-primary);
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
  text-align: center;
}

.row-main { min-width: 0; flex: 1; }

.update-badge {
  display: inline-flex;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--color-warn-bg);
  color: var(--color-warn);
  font-size: 10px;
  font-weight: 700;
  vertical-align: middle;
}

.row-title {

  display: block;

  font-size: 14px;

  font-weight: 600;

  white-space: nowrap;

  overflow: hidden;

  text-overflow: ellipsis;

}

.row-sub { font-size: 11px; }

.row-actions { display: flex; gap: 2px; flex-shrink: 0; }

.row-action {

  width: 28px;

  height: 28px;

  padding: 0;

  border: none;

  border-radius: var(--radius-sm);

  background: transparent;

  font-size: 13px;

  cursor: pointer;

  opacity: 0.65;

}

.row-action:hover:not(:disabled) { opacity: 1; background: var(--color-bg-hover); }

.row-action.danger:hover { color: var(--color-error); }

.row-action:disabled { opacity: 0.3; cursor: not-allowed; }

.detail-panel { min-height: 0; overflow-y: auto; padding: 16px; }

.lib-footer {

  display: flex;

  gap: 8px;

  padding: 8px 20px;

  border-top: 1px solid var(--color-border);

  background: var(--color-bg-elevated);

}

.lib-footer .small { font-size: 12px; padding: 6px 12px; text-transform: none; letter-spacing: 0; font-weight: 600; }

.link-btn { text-decoration: none; color: inherit; display: inline-flex; align-items: center; }

.pad { padding: 24px 16px; }

@media (max-width: 1100px) { .lib-body { grid-template-columns: 180px 1fr 300px; } }

@media (max-width: 900px) {

  .lib-body { grid-template-columns: 1fr; grid-template-rows: auto 1fr auto; }

  .mfg-sidebar, .fixture-list { border-right: none; border-bottom: 1px solid var(--color-border); }

  .mfg-sidebar { max-height: 160px; }

  .fixture-list { min-height: 240px; }

}

</style>

