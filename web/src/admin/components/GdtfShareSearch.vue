<script setup lang="ts">
import { ref } from 'vue';
import { fixturesApi, type ApiError, type GdtfShareCatalogEntry, type GdtfShareRevision } from '../../shared/api';
import { defaultModelQualityForAvailable } from '../utils/fixtureModelQuality';

const emit = defineEmits<{ imported: [id: string] }>();

const query = ref('');
const entries = ref<GdtfShareCatalogEntry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const importing = ref<number | null>(null);
const selectedRid = ref<Record<string, number>>({});

async function search(): Promise<void> {
  const q = query.value.trim();
  if (!q) return;
  loading.value = true;
  error.value = null;
  try {
    const res = await fixturesApi.catalogGdtfShare({ q, limit: 40 });
    entries.value = res.entries;
    for (const e of res.entries) {
      if (!selectedRid.value[e.uuid] && e.versions[0]) {
        selectedRid.value[e.uuid] = e.versions[0].rid;
      }
    }
  } catch (err) {
    const e = err as ApiError;
    error.value = e.message ?? 'search failed';
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

function versionLabel(v: GdtfShareRevision): string {
  return [v.revision, v.version ? `GDTF ${v.version}` : null, v.creator ? `by ${v.creator}` : null]
    .filter(Boolean)
    .join(' · ') || `Revision ${v.rid}`;
}

async function importOne(entry: GdtfShareCatalogEntry): Promise<void> {
  const rid = selectedRid.value[entry.uuid] ?? entry.versions[0]?.rid;
  if (!rid) return;
  importing.value = rid;
  error.value = null;
  try {
    const qualities = await fixturesApi.gdtfShareModelQualities(rid);
    const modelQuality = defaultModelQualityForAvailable(qualities.availableModelQualities);
    const res = await fixturesApi.importGdtfShare(
      rid,
      `${entry.manufacturer} ${entry.fixture}`,
      modelQuality,
    );
    emit('imported', res.fixture.id);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'import failed';
  } finally {
    importing.value = null;
  }
}
</script>

<template>
  <div class="gdtf-search">
    <p class="muted small">Tip: use the <strong>GDTF-Share catalog</strong> tab on the Fixture library page for the full browse experience and mesh quality picker.</p>
    <div class="h-row">
      <input v-model="query" class="flex-1" placeholder="Search GDTF-Share…" @keyup.enter="search" />
      <button :disabled="loading" @click="search">{{ loading ? 'Searching…' : 'Search' }}</button>
    </div>
    <p class="muted small mt-sm">Requires GDTF-Share credentials in Settings.</p>
    <div v-if="error" class="error-box mt-sm">{{ error }}</div>
    <ul v-if="entries.length" class="results mt">
      <li v-for="entry in entries" :key="entry.uuid">
        <div class="result-main">
          <strong>{{ entry.manufacturer }} — {{ entry.fixture }}</strong>
          <select v-if="entry.versions.length > 1" v-model.number="selectedRid[entry.uuid]" class="version-select">
            <option v-for="v in entry.versions" :key="v.rid" :value="v.rid">{{ versionLabel(v) }}</option>
          </select>
          <span v-else-if="entry.versions[0]" class="muted small">{{ versionLabel(entry.versions[0]) }}</span>
        </div>
        <button :disabled="importing === (selectedRid[entry.uuid] ?? entry.versions[0]?.rid)" @click="importOne(entry)">
          {{ importing ? 'Importing…' : 'Import' }}
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.results { list-style: none; padding: 0; margin: 0; }
.results li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--color-border);
}
.result-main { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.version-select {
  max-width: 320px;
  padding: 6px 8px;
  font-size: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-input);
}
</style>
