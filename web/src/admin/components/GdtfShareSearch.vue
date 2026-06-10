<script setup lang="ts">
import { ref } from 'vue';
import { fixturesApi, type ApiError, type GdtfShareResult } from '../../shared/api';

const emit = defineEmits<{ imported: [id: string] }>();

const query = ref('');
const results = ref<GdtfShareResult[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const importing = ref<number | null>(null);

async function search(): Promise<void> {
  const q = query.value.trim();
  if (!q) return;
  loading.value = true;
  error.value = null;
  try {
    const res = await fixturesApi.searchGdtfShare(q);
    results.value = res.results;
  } catch (err) {
    const e = err as ApiError;
    error.value = e.message ?? 'search failed';
    results.value = [];
  } finally {
    loading.value = false;
  }
}

async function importOne(r: GdtfShareResult): Promise<void> {
  importing.value = r.rid;
  error.value = null;
  try {
    const res = await fixturesApi.importGdtfShare(r.rid, `${r.manufacturer} ${r.fixture}`);
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
    <div class="h-row">
      <input v-model="query" class="flex-1" placeholder="Search GDTF-Share…" @keyup.enter="search" />
      <button :disabled="loading" @click="search">{{ loading ? 'Searching…' : 'Search' }}</button>
    </div>
    <p class="muted small mt-sm">Requires GDTF-Share credentials in Settings.</p>
    <div v-if="error" class="error-box mt-sm">{{ error }}</div>
    <ul v-if="results.length" class="results mt">
      <li v-for="r in results" :key="r.rid">
        <span>{{ r.manufacturer }} — {{ r.fixture }}</span>
        <button :disabled="importing === r.rid" @click="importOne(r)">
          {{ importing === r.rid ? 'Importing…' : 'Import' }}
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.results { list-style: none; padding: 0; margin: 0; }
.results li {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 0; border-bottom: 1px solid var(--border, #333);
}
</style>
