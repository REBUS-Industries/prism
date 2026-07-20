<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { filesApi, type ApiError, type FileDocumentListItem, type FileLibraryStatus } from '../../shared/api';
import Icon from '../../shared/Icon.vue';

const documents = ref<FileDocumentListItem[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const search = ref('');
const extFilter = ref('');
const nextCursor = ref<string | null>(null);
const status = ref<FileLibraryStatus | null>(null);
const PAGE = 50;

let searchTimer: ReturnType<typeof setTimeout> | null = null;

function formatBytes(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatWhen(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function loadStatus(): Promise<void> {
  try {
    status.value = await filesApi.status();
  } catch {
    status.value = null;
  }
}

async function load(reset = true): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await filesApi.list({
      q: search.value.trim() || undefined,
      ext: extFilter.value || undefined,
      limit: PAGE,
      cursor: reset ? null : nextCursor.value,
    });
    documents.value = reset ? res.documents : [...documents.value, ...res.documents];
    nextCursor.value = res.nextCursor;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load files';
  } finally {
    loading.value = false;
  }
}

function onSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void load(true), 300);
}

function onExtFilter(): void {
  void load(true);
}

const isEmpty = computed(() => !loading.value && documents.value.length === 0);

onMounted(() => {
  void loadStatus();
  void load(true);
});
</script>

<template>
  <div class="h-row">
    <h1 class="flex-1">File Library</h1>
    <RouterLink :to="{ name: 'file-upload' }" class="primary">
      <Icon name="upload_file" :size="16" />Upload file
    </RouterLink>
  </div>

  <p class="muted small mt">
    Native CAD / DCC source archives (not Orbit geometry). Re-uploading the same filename stacks a new version.
  </p>

  <p v-if="status" class="muted small status-line" :class="{ warn: !status.writable }">
    Storage:
    <code>{{ status.root }}</code>
    · {{ status.writable ? 'writable' : 'not writable' }}
    · max {{ formatBytes(status.maxBytes) }}
  </p>

  <section class="card mt">
    <div class="toolbar">
      <div class="search-box">
        <Icon name="search" :size="16" class="search-icon" />
        <input v-model="search" placeholder="Search by filename…" @input="onSearch" />
      </div>
      <select v-model="extFilter" class="ext-filter" @change="onExtFilter">
        <option value="">All types</option>
        <option v-for="ext in (status?.allowedExts ?? [])" :key="ext" :value="ext">{{ ext }}</option>
      </select>
      <button :disabled="loading" @click="load(true)"><Icon name="refresh" :size="16" />Refresh</button>
    </div>
  </section>

  <div v-if="error" class="error-box mt">{{ error }}</div>
  <p v-if="isEmpty" class="muted mt">No files yet. Upload from the admin UI or a connector (Rhino / Vectorworks).</p>

  <div class="table-wrap mt" v-if="documents.length">
    <table class="file-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Versions</th>
          <th>Latest size</th>
          <th>Uploaded by</th>
          <th>Date / time</th>
          <th>Source</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="d in documents" :key="d.id">
          <td>
            <RouterLink :to="{ name: 'file-detail', params: { id: d.id } }" class="name-link">
              {{ d.name }}
            </RouterLink>
          </td>
          <td class="muted">{{ d.extension }}</td>
          <td><span class="pill">v{{ d.versionCount }}</span></td>
          <td>{{ formatBytes(d.latestVersion?.sizeBytes) }}</td>
          <td>{{ d.latestVersion?.uploadedBy ?? '—' }}</td>
          <td :title="d.latestVersion?.createdAt">{{ formatWhen(d.latestVersion?.createdAt) }}</td>
          <td class="muted">{{ d.latestVersion?.sourceApp || d.latestVersion?.source || '—' }}</td>
          <td class="notes-cell" :title="d.latestVersion?.notes || undefined">
            {{ d.latestVersion?.notes || '—' }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="nextCursor" class="center mt">
    <button :disabled="loading" @click="load(false)">{{ loading ? 'Loading…' : 'Load more' }}</button>
  </div>
</template>

<style scoped>
.toolbar { display: flex; gap: 12px; align-items: center; }
.search-box { position: relative; flex: 1; }
.search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); opacity: 0.5; }
.search-box input { width: 100%; padding-left: 32px; }
.ext-filter { min-width: 120px; }
.status-line { margin-top: 6px; }
.status-line.warn { color: var(--color-warning, #c9a227); }
.status-line code { font-size: 12px; }
.table-wrap { overflow-x: auto; border: 1px solid var(--color-border, #2a2a32); border-radius: 8px; }
.file-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.file-table th, .file-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--color-border, #2a2a32); }
.file-table th { font-weight: 600; background: var(--surface-2, #1a1a1f); white-space: nowrap; }
.file-table tbody tr:hover { background: var(--surface-hover, rgba(255,255,255,0.03)); }
.name-link { color: inherit; font-weight: 500; text-decoration: none; }
.name-link:hover { text-decoration: underline; }
.pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-3, #24242c);
  font-size: 12px;
}
.notes-cell {
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-text-muted, #9a9aa3);
}
.center { text-align: center; }
</style>
