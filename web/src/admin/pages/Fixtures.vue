<script setup lang="ts">

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { RouterLink, useRouter } from 'vue-router';

import FixtureLibraryDetail from '../components/FixtureLibraryDetail.vue';

import {

  fixturesApi,

  type ApiError,

  type FixtureListItem,

  type GdtfShareCatalogEntry,

  type GdtfShareManufacturer,

} from '../../shared/api';



const router = useRouter();

const PAGE = 80;

type FilterChip = 'all' | 'downloaded' | 'missing' | '3d';



const fixtures = ref<FixtureListItem[]>([]);

const shareManufacturers = ref<GdtfShareManufacturer[]>([]);

const shareEntries = ref<GdtfShareCatalogEntry[]>([]);

const shareTotal = ref(0);



const loading = ref(false);

const error = ref<string | null>(null);

const search = ref('');

const selectedManufacturer = ref('__all__');

const selectedShareUuid = ref<string | null>(null);

const selectedShareRid = ref<number | null>(null);

const activeFilter = ref<FilterChip>('all');



const importing = ref(false);

const showCreate = ref(false);

const newName = ref('');

const creating = ref(false);

const fileInput = ref<HTMLInputElement | null>(null);



let searchTimer: ReturnType<typeof setTimeout> | null = null;



function matchLocal(entry: GdtfShareCatalogEntry): FixtureListItem | undefined {

  const mfg = entry.manufacturer.toLowerCase();

  const fix = entry.fixture.toLowerCase();

  return fixtures.value.find((f) => {

    const fm = f.manufacturer.toLowerCase();

    const fn = f.fixtureName.toLowerCase();

    return fm === mfg && (fn === fix || f.name.toLowerCase().includes(fix));

  });

}



const filteredEntries = computed(() => {

  const q = search.value.trim().toLowerCase();

  return shareEntries.value.filter((entry) => {

    const local = matchLocal(entry);

    if (activeFilter.value === 'downloaded' && !local) return false;

    if (activeFilter.value === 'missing' && local) return false;

    if (activeFilter.value === '3d' && !local?.hasPreview) return false;

    if (!q) return true;

    const hay = `${entry.fixture} ${entry.manufacturer} ${entry.creator ?? ''}`.toLowerCase();

    return q.split(/\s+/).every((term) => hay.includes(term));

  });

});



const displayManufacturers = computed((): GdtfShareManufacturer[] => {

  if (activeFilter.value === 'all') {

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

  if (activeFilter.value === 'all') {

    return selectedManufacturer.value === '__all__' ? shareTotal.value : filteredEntries.value.length;

  }

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

  shareEntries.value.find((e) => e.uuid === selectedShareUuid.value) ?? null,

);



const selectedLocal = computed(() => {

  if (!selectedShare.value) return null;

  return matchLocal(selectedShare.value) ?? null;

});



const listCountLabel = computed(() =>

  `${filteredEntries.value.length} / ${shareTotal.value} fixtures`,

);



async function loadLocal(): Promise<void> {

  try {

    const res = await fixturesApi.list({ limit: PAGE });

    fixtures.value = res.fixtures;

  } catch {

    /* supplementary */

  }

}



async function loadShare(): Promise<void> {

  loading.value = true;

  error.value = null;

  try {

    const res = await fixturesApi.catalogGdtfShare({

      q: search.value || undefined,

      manufacturer: selectedManufacturer.value === '__all__' ? undefined : selectedManufacturer.value,

      limit: 120,

    });

    shareManufacturers.value = res.manufacturers;

    shareEntries.value = res.entries;

    shareTotal.value = res.total;

    if (

      selectedManufacturer.value !== '__all__'

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

    loading.value = false;

  }

}



async function reloadAll(): Promise<void> {

  await Promise.all([loadLocal(), loadShare()]);

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



function setFilter(chip: FilterChip): void {

  activeFilter.value = chip;

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



function clearFilters(): void {

  search.value = '';

  selectedManufacturer.value = '__all__';

  activeFilter.value = 'all';

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



async function importShareSelected(): Promise<void> {

  const entry = selectedShare.value;

  if (!entry) return;

  const rid = selectedShareRid.value ?? entry.versions[0]?.rid;

  if (rid == null) return;

  importing.value = true;

  error.value = null;

  try {

    const res = await fixturesApi.importGdtfShare(rid, `${entry.manufacturer} ${entry.fixture}`);

    await loadLocal();

    openEditor(res.fixture.id);

  } catch (err) {

    error.value = (err as ApiError).message ?? 'import failed';

  } finally {

    importing.value = false;

  }

}



async function importShareEntry(entry: GdtfShareCatalogEntry): Promise<void> {

  selectShareEntry(entry);

  const rid = entry.versions[0]?.rid;

  if (rid == null) return;

  importing.value = true;

  error.value = null;

  try {

    const res = await fixturesApi.importGdtfShare(rid, `${entry.manufacturer} ${entry.fixture}`);

    await loadLocal();

    openEditor(res.fixture.id);

  } catch (err) {

    error.value = (err as ApiError).message ?? 'import failed';

  } finally {

    importing.value = false;

  }

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

  const parts = [

    entry.manufacturer,

    v?.revision ? `v${v.revision}` : null,

    entry.creator ? `by ${entry.creator}` : null,

  ].filter(Boolean);

  return parts.join(' · ');

}



onMounted(() => void reloadAll());

onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });

</script>



<template>

  <div class="fixture-library">

    <header class="lib-header">

      <div class="header-brand">

        <span class="brand-icon" aria-hidden="true">G</span>

        <div>

          <h1>GDTF Fixture Library</h1>

          <p class="header-sub">Browse and download GDTF-Share catalog entries. Downloaded fixtures appear in your local library.</p>

        </div>

      </div>

      <div class="lib-actions">

        <button class="btn-outline" :disabled="loading" @click="reloadAll">

          <span class="btn-icon">↻</span> Refresh

        </button>

        <button class="btn-outline" disabled title="Coming soon">

          <span class="btn-icon">🖼</span> Enrich missing photos

        </button>

        <button class="btn-primary" :disabled="loading" @click="loadShare">

          <span class="btn-icon">☁</span> Import share catalog

        </button>

        <button class="btn-danger" @click="clearFilters">

          <span class="btn-icon">✕</span> Clear

        </button>

        <input ref="fileInput" type="file" accept=".gdtf" hidden @change="onFile" />

      </div>

    </header>



    <div class="filter-toolbar">

      <div class="search-wrap">

        <span class="search-icon" aria-hidden="true">🔍</span>

        <input

          v-model="search"

          class="search-input"

          type="search"

          placeholder="Search manufacturer, fixture, mode…"

          @input="onSearchInput"

        />

      </div>



      <div class="chip-row">

        <span class="chip-label">Filters</span>

        <button type="button" class="chip" :class="{ active: activeFilter === 'all' }" @click="setFilter('all')">All</button>

        <button type="button" class="chip" :class="{ active: activeFilter === 'downloaded' }" @click="setFilter('downloaded')">Downloaded</button>

        <button type="button" class="chip" :class="{ active: activeFilter === 'missing' }" @click="setFilter('missing')">Missing</button>

        <button type="button" class="chip" :class="{ active: activeFilter === '3d' }" @click="setFilter('3d')">3D</button>

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

          <h2>Fixtures</h2>

          <span class="list-sub muted">{{ fixturesWith3d }} with 3D / materials</span>

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

            <span class="fixture-icon" aria-hidden="true">💡</span>

            <div class="row-main">

              <span class="row-title">{{ entry.fixture }}</span>

              <span class="row-sub muted">{{ formatVersionSub(entry) }}</span>

            </div>

            <div class="row-actions" @click.stop>

              <button type="button" class="row-action" title="View" @click="selectShareEntry(entry)">👁</button>

              <button

                v-if="!matchLocal(entry)"

                type="button"

                class="row-action"

                title="Download"

                :disabled="importing"

                @click="importShareEntry(entry)"

              >⬇</button>

              <button

                v-if="matchLocal(entry)"

                type="button"

                class="row-action"

                title="Edit"

                @click="openEditor(matchLocal(entry)!.id)"

              >✎</button>

              <button

                v-if="matchLocal(entry)"

                type="button"

                class="row-action danger"

                title="Delete"

                @click="removeFixture(matchLocal(entry)!)"

              >🗑</button>

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

          @import="importShareSelected"

          @edit="openEditor"

          @delete="removeFixture"

          @update:selected-rid="selectedShareRid = $event"

        />

      </aside>

    </div>



    <div class="lib-footer">

      <button class="btn-outline small" :disabled="importing" @click="fileInput?.click()">Upload .gdtf</button>

      <button class="btn-outline small" @click="showCreate = true">+ Blank fixture</button>

      <RouterLink :to="{ name: 'mvr-import' }" class="btn-outline small link-btn">MVR import</RouterLink>

    </div>



    <div v-if="showCreate" class="modal-backdrop" @click.self="showCreate = false">

      <div class="card modal">

        <h2>New fixture type</h2>

        <input v-model="newName" placeholder="Display name" @keyup.enter="createBlank" />

        <div class="h-row" style="justify-content: flex-end;">

          <button @click="showCreate = false">Cancel</button>

          <button class="primary" :disabled="creating" @click="createBlank">Create</button>

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

  height: calc(100vh - 32px);

  min-height: 520px;

}

.lib-header {

  display: flex;

  justify-content: space-between;

  align-items: flex-start;

  gap: 16px;

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

.fixture-list { overflow-y: auto; border-right: 1px solid var(--color-border); }

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

.mfg-group-name {

  font-size: 13px;

  font-weight: 700;

  text-transform: uppercase;

  letter-spacing: 0.03em;

}

.fixture-row {

  display: flex;

  align-items: center;

  gap: 10px;

  width: 100%;

  padding: 10px 16px;

  border: none;

  border-bottom: 1px solid var(--color-border);

  background: transparent;

  text-align: left;

  cursor: pointer;

}

.fixture-row:hover { background: var(--color-bg-hover); }

.fixture-row.active { background: var(--orbit-primary-fade); box-shadow: inset 3px 0 0 var(--orbit-primary); }

.fixture-icon {

  flex-shrink: 0;

  width: 32px;

  height: 32px;

  display: flex;

  align-items: center;

  justify-content: center;

  border-radius: 50%;

  background: var(--orbit-primary-fade);

  font-size: 14px;

}

.row-main { min-width: 0; flex: 1; }

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

.detail-panel { overflow-y: auto; padding: 16px; }

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
