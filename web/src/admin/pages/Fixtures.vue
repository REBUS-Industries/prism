<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  fixturesApi,
  type ApiError,
  type FixtureListItem,
  type GdtfShareCatalogEntry,
  type GdtfShareManufacturer,
  type GdtfShareRevision,
} from '../../shared/api';

const router = useRouter();
const PAGE = 80;

type Source = 'library' | 'share';

const source = ref<Source>('library');
const fixtures = ref<FixtureListItem[]>([]);
const shareManufacturers = ref<GdtfShareManufacturer[]>([]);
const shareEntries = ref<GdtfShareCatalogEntry[]>([]);
const shareTotal = ref(0);

const loading = ref(false);
const error = ref<string | null>(null);
const nextCursor = ref<string | null>(null);
const search = ref('');
const selectedManufacturer = ref('__all__');
const selectedLocalId = ref<string | null>(null);
const selectedShareUuid = ref<string | null>(null);
const selectedShareRid = ref<number | null>(null);

const importing = ref(false);
const showCreate = ref(false);
const newName = ref('');
const creating = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

let searchTimer: ReturnType<typeof setTimeout> | null = null;

const localManufacturers = computed(() => {
  const counts = new Map<string, number>();
  for (const f of fixtures.value) {
    const m = f.manufacturer || 'Unknown';
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

const activeManufacturers = computed(() =>
  source.value === 'library' ? localManufacturers.value : shareManufacturers.value,
);

const filteredLocal = computed(() => {
  const mfg = selectedManufacturer.value;
  const q = search.value.trim().toLowerCase();
  return fixtures.value.filter((f) => {
    if (mfg !== '__all__' && f.manufacturer !== mfg) return false;
    if (!q) return true;
    const hay = `${f.name} ${f.manufacturer} ${f.fixtureName} ${f.tags.join(' ')}`.toLowerCase();
    return q.split(/\s+/).every((term) => hay.includes(term));
  });
});

const selectedLocal = computed(() =>
  filteredLocal.value.find((f) => f.id === selectedLocalId.value) ?? null,
);

const selectedShare = computed(() =>
  shareEntries.value.find((e) => e.uuid === selectedShareUuid.value) ?? null,
);

const selectedShareVersion = computed<GdtfShareRevision | null>(() => {
  if (!selectedShare.value) return null;
  if (selectedShareRid.value != null) {
    return selectedShare.value.versions.find((v) => v.rid === selectedShareRid.value) ?? null;
  }
  return selectedShare.value.versions[0] ?? null;
});

const listCountLabel = computed(() => {
  if (source.value === 'library') {
    return `${filteredLocal.value.length} / ${fixtures.value.length} fixtures`;
  }
  return `${shareEntries.value.length} / ${shareTotal.value} fixtures`;
});

async function loadLocal(reset = true): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await fixturesApi.list({
      q: search.value || undefined,
      limit: PAGE,
      cursor: reset ? undefined : nextCursor.value,
    });
    fixtures.value = reset ? res.fixtures : [...fixtures.value, ...res.fixtures];
    nextCursor.value = res.nextCursor;
    if (!selectedLocalId.value && fixtures.value[0]) {
      selectedLocalId.value = fixtures.value[0].id;
    }
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load fixtures';
  } finally {
    loading.value = false;
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
    if (!selectedShareUuid.value && res.entries[0]) {
      selectShareEntry(res.entries[0]);
    }
  } catch (err) {
    const e = err as ApiError;
    error.value = e.message ?? 'failed to load GDTF-Share catalog';
    shareEntries.value = [];
  } finally {
    loading.value = false;
  }
}

function reload(): void {
  if (source.value === 'library') void loadLocal(true);
  else void loadShare();
}

function onSearchInput(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(reload, 350);
}

function selectManufacturer(name: string): void {
  selectedManufacturer.value = name;
  reload();
}

function selectLocal(f: FixtureListItem): void {
  selectedLocalId.value = f.id;
}

function selectShareEntry(entry: GdtfShareCatalogEntry): void {
  selectedShareUuid.value = entry.uuid;
  selectedShareRid.value = entry.versions[0]?.rid ?? null;
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
    if (selectedLocalId.value === f.id) {
      selectedLocalId.value = filteredLocal.value[0]?.id ?? null;
    }
  } catch (err) {
    error.value = (err as ApiError).message ?? 'delete failed';
  }
}

async function importShareSelected(): Promise<void> {
  const ver = selectedShareVersion.value;
  const entry = selectedShare.value;
  if (!ver || !entry) return;
  importing.value = true;
  error.value = null;
  try {
    const res = await fixturesApi.importGdtfShare(ver.rid, `${entry.manufacturer} ${entry.fixture}`);
    source.value = 'library';
    await loadLocal(true);
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
    openEditor(res.fixture.id);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'import failed';
  } finally {
    importing.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}

function formatVersionLabel(v: GdtfShareRevision): string {
  const parts = [v.revision, v.version ? `GDTF ${v.version}` : null, v.creator ? `by ${v.creator}` : null]
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : `Revision ${v.rid}`;
}

function formatDate(ts?: string): string {
  if (!ts) return '—';
  const n = parseInt(ts, 10);
  if (!n) return ts;
  return new Date(n * 1000).toLocaleDateString();
}

watch(source, () => {
  selectedManufacturer.value = '__all__';
  reload();
});

onMounted(() => void loadLocal(true));
onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });
</script>

<template>
  <div class="fixture-library">
    <header class="lib-header">
      <div>
        <h1>Fixture library</h1>
        <p class="muted small">Lighting fixture types from GDTF. Instances are created via MVR import or connectors.</p>
      </div>
      <div class="lib-actions">
        <button :disabled="loading" @click="reload">{{ loading ? 'Refreshing…' : 'Refresh' }}</button>
        <button :disabled="importing" @click="fileInput?.click()">{{ importing ? 'Importing…' : 'Upload .gdtf' }}</button>
        <input ref="fileInput" type="file" accept=".gdtf" hidden @change="onFile" />
        <button class="primary" @click="showCreate = true">+ Blank fixture</button>
        <RouterLink :to="{ name: 'mvr-import' }"><button>MVR import</button></RouterLink>
      </div>
    </header>

    <div class="source-toggle">
      <button type="button" :class="{ active: source === 'library' }" @click="source = 'library'">Downloaded library</button>
      <button type="button" :class="{ active: source === 'share' }" @click="source = 'share'">GDTF-Share catalog</button>
    </div>

    <div class="lib-toolbar">
      <input
        v-model="search"
        class="search-input"
        type="search"
        placeholder="Search manufacturer, fixture, model…"
        @input="onSearchInput"
      />
      <span class="count-label muted">{{ listCountLabel }}</span>
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
          <span class="mfg-count">{{ source === 'library' ? fixtures.length : shareTotal }}</span>
        </button>
        <button
          v-for="m in activeManufacturers"
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
        <div v-if="loading && !(source === 'library' ? fixtures.length : shareEntries.length)" class="muted pad">
          Loading…
        </div>

        <template v-else-if="source === 'library'">
          <div v-if="!filteredLocal.length" class="muted pad">No fixtures yet. Import from GDTF-Share or upload a .gdtf file.</div>
          <button
            v-for="f in filteredLocal"
            :key="f.id"
            type="button"
            class="fixture-row"
            :class="{ active: selectedLocalId === f.id }"
            @click="selectLocal(f)"
          >
            <div class="row-main">
              <span class="row-title">{{ f.name }}</span>
              <span class="row-sub muted">{{ f.manufacturer }} · {{ f.fixtureName }}<span v-if="f.revision"> · v{{ f.revision }}</span></span>
            </div>
            <div class="row-actions" @click.stop>
              <button title="Open editor" @click="openEditor(f.id)">✎</button>
              <button class="danger" title="Delete" @click="removeFixture(f)">🗑</button>
            </div>
          </button>
          <div v-if="nextCursor" class="load-more">
            <button :disabled="loading" @click="loadLocal(false)">{{ loading ? 'Loading…' : 'Load more' }}</button>
          </div>
        </template>

        <template v-else>
          <div v-if="!shareEntries.length" class="muted pad">
            No catalog results. Check GDTF-Share credentials in Settings.
          </div>
          <button
            v-for="entry in shareEntries"
            :key="entry.uuid"
            type="button"
            class="fixture-row"
            :class="{ active: selectedShareUuid === entry.uuid }"
            @click="selectShareEntry(entry)"
          >
            <div class="row-main">
              <span class="row-title">{{ entry.fixture }}</span>
              <span class="row-sub muted">
                {{ entry.manufacturer }}
                <span v-if="entry.creator"> · by {{ entry.creator }}</span>
                <span v-if="entry.versions.length > 1"> · {{ entry.versions.length }} versions</span>
              </span>
            </div>
            <span class="pill">{{ entry.versions.length }} rev</span>
          </button>
        </template>
      </section>

      <aside class="detail-panel">
        <template v-if="source === 'library' && selectedLocal">
          <h2>Fixture information</h2>
          <p class="detail-title">{{ selectedLocal.name }}</p>
          <p class="muted small">{{ selectedLocal.manufacturer }} · {{ selectedLocal.fixtureName }}</p>
          <dl class="detail-grid">
            <dt>Revision</dt><dd>{{ selectedLocal.revision ?? '—' }}</dd>
            <dt>Status</dt><dd>{{ selectedLocal.status }}</dd>
            <dt>Preview</dt><dd>{{ selectedLocal.hasPreview ? 'GLB available' : 'None' }}</dd>
          </dl>
          <div v-if="selectedLocal.tags.length" class="tag-row">
            <span v-for="tag in selectedLocal.tags" :key="tag" class="pill">{{ tag }}</span>
          </div>
          <button class="primary mt" @click="openEditor(selectedLocal.id)">Open editor</button>
        </template>

        <template v-else-if="source === 'share' && selectedShare">
          <h2>Fixture information</h2>
          <p class="detail-title">{{ selectedShare.fixture }}</p>
          <p class="muted small mono">{{ selectedShare.uuid }}</p>

          <div class="version-block">
            <label class="version-label">GDTF version / revision</label>
            <select v-model.number="selectedShareRid" class="version-select">
              <option v-for="v in selectedShare.versions" :key="v.rid" :value="v.rid">
                {{ formatVersionLabel(v) }}
              </option>
            </select>
            <p v-if="selectedShareVersion" class="muted small version-meta">
              Modified {{ formatDate(selectedShareVersion.lastModified) }}
              <span v-if="selectedShareVersion.filesize"> · {{ (selectedShareVersion.filesize / 1024 / 1024).toFixed(1) }} MB</span>
              <span v-if="selectedShareVersion.rating"> · ★ {{ selectedShareVersion.rating }}</span>
            </p>
          </div>

          <div class="badge-row">
            <span class="pill ok">Share catalog</span>
            <span v-if="selectedShare.modes?.length" class="pill">{{ selectedShare.modes.length }} modes</span>
          </div>

          <dl class="detail-grid">
            <dt>Brand</dt><dd>{{ selectedShare.manufacturer }}</dd>
            <dt>Creator</dt><dd>{{ selectedShare.creator ?? '—' }}</dd>
            <dt>Uploader</dt><dd>{{ selectedShare.uploader ?? '—' }}</dd>
          </dl>

          <div v-if="selectedShare.modes?.length" class="modes-preview">
            <h3>DMX modes</h3>
            <ul>
              <li v-for="(m, i) in selectedShare.modes" :key="i">
                {{ m.name }} <span class="muted">({{ m.dmxfootprint }}CH)</span>
              </li>
            </ul>
          </div>

          <button class="primary mt download-btn" :disabled="importing || !selectedShareVersion" @click="importShareSelected">
            {{ importing ? 'Downloading…' : 'Download & import' }}
          </button>
        </template>

        <div v-else class="muted pad">Select a fixture to view details.</div>
      </aside>
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
  gap: 12px;
  height: calc(100vh - 32px);
  min-height: 520px;
}
.lib-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.lib-header h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.lib-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }

.source-toggle {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-bg-elevated);
  width: fit-content;
}
.source-toggle button {
  border: none;
  background: transparent;
  padding: 8px 14px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-muted);
  cursor: pointer;
}
.source-toggle button.active {
  background: var(--orbit-primary);
  color: #fff;
}

.lib-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
}
.search-input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-input);
  color: var(--color-text);
}
.count-label { font-size: 12px; white-space: nowrap; }

.lib-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 220px 1fr 300px;
  gap: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--color-bg);
}

.mfg-sidebar {
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  overflow-y: auto;
  padding: 12px 0;
}
.mfg-sidebar h2 {
  margin: 0 0 8px;
  padding: 0 14px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.mfg-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: transparent;
  text-align: left;
  font-size: 13px;
  color: var(--color-text);
  cursor: pointer;
}
.mfg-item:hover { background: var(--color-bg-hover); }
.mfg-item.active {
  background: var(--orbit-primary);
  color: #fff;
}
.mfg-count {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.85;
}

.fixture-list {
  overflow-y: auto;
  border-right: 1px solid var(--color-border);
}
.fixture-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 12px 16px;
  border: none;
  border-bottom: 1px solid var(--color-border);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.fixture-row:hover { background: var(--color-bg-hover); }
.fixture-row.active {
  background: var(--orbit-primary-fade);
  box-shadow: inset 3px 0 0 var(--orbit-primary);
}
.row-main { min-width: 0; }
.row-title {
  display: block;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-sub { font-size: 12px; }
.row-actions { display: flex; gap: 4px; }
.row-actions button {
  padding: 4px 8px;
  font-size: 12px;
}

.detail-panel {
  overflow-y: auto;
  padding: 16px;
}
.detail-panel h2 {
  margin: 0 0 12px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.detail-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}
.detail-grid {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 8px;
  margin: 14px 0;
  font-size: 13px;
}
.detail-grid dt { color: var(--color-text-muted); margin: 0; }
.detail-grid dd { margin: 0; }
.mono { font-family: var(--font-mono); font-size: 11px; word-break: break-all; }

.version-block { margin: 14px 0; }
.version-label {
  display: block;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  margin-bottom: 6px;
}
.version-select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-input);
  color: var(--color-text);
  font-size: 13px;
}
.version-meta { margin: 6px 0 0; }

.badge-row { display: flex; flex-wrap: wrap; gap: 6px; }
.pill.ok { background: var(--color-success-bg); color: var(--color-success); }

.modes-preview h3 {
  margin: 16px 0 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
}
.modes-preview ul {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
}
.modes-preview li { margin-bottom: 4px; }

.download-btn { width: 100%; }
.pad { padding: 24px 16px; }
.load-more { padding: 12px; text-align: center; }
.mt { margin-top: 12px; }

@media (max-width: 1100px) {
  .lib-body { grid-template-columns: 180px 1fr 260px; }
}
@media (max-width: 900px) {
  .lib-body {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr auto;
  }
  .mfg-sidebar, .fixture-list { border-right: none; border-bottom: 1px solid var(--color-border); }
  .mfg-sidebar { max-height: 160px; }
  .fixture-list { min-height: 240px; }
}
</style>
