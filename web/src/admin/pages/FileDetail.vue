<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  filesApi,
  type ApiError,
  type FileDocumentDetail,
} from '../../shared/api';
import Icon from '../../shared/Icon.vue';

const props = defineProps<{ id: string }>();
const router = useRouter();

const document = ref<FileDocumentDetail | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

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
    second: '2-digit',
  });
}

async function reload(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await filesApi.get(props.id);
    document.value = res.document;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load file';
    document.value = null;
  } finally {
    loading.value = false;
  }
}

async function deleteVersion(versionId: string): Promise<void> {
  if (!confirm('Delete this version? Files will be moved to the project archive folder on the fileserver.')) return;
  busy.value = true;
  error.value = null;
  try {
    await filesApi.removeVersion(props.id, versionId);
    await reload();
    if (!document.value) {
      void router.push({ name: 'files' });
    }
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to delete version';
  } finally {
    busy.value = false;
  }
}

async function deleteDocument(): Promise<void> {
  if (!confirm('Delete this document and all versions? Files will be moved to the project archive folder on the fileserver.')) return;
  busy.value = true;
  error.value = null;
  try {
    await filesApi.remove(props.id);
    void router.push({ name: 'files' });
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to delete document';
  } finally {
    busy.value = false;
  }
}

const versions = computed(() => document.value?.versions ?? []);

onMounted(() => void reload());
watch(() => props.id, () => void reload());
</script>

<template>
  <div class="h-row">
    <RouterLink :to="{ name: 'files' }" class="muted back-link">
      <Icon name="arrow_back" :size="14" /> File library
    </RouterLink>
    <h1 class="flex-1" :title="document?.name">{{ document?.name ?? 'File' }}</h1>
    <a
      v-if="document"
      class="btn-link"
      :href="filesApi.downloadUrl(document.id)"
      target="_blank"
      rel="noopener"
    >
      <Icon name="download" :size="16" />Download latest
    </a>
    <button class="danger" :disabled="busy || !document" @click="deleteDocument">
      <Icon name="delete" :size="16" />Delete document
    </button>
  </div>

  <div v-if="error" class="error-box mt">{{ error }}</div>
  <p v-if="loading" class="muted mt">Loading…</p>

  <section v-if="document" class="card mt">
    <div class="meta-grid">
      <div><span class="label">Extension</span><span>{{ document.extension }}</span></div>
      <div><span class="label">Versions</span><span>{{ document.versionCount }}</span></div>
      <div><span class="label">Updated</span><span>{{ formatWhen(document.updatedAt) }}</span></div>
      <div v-if="document.projectId"><span class="label">Project</span><span>{{ document.projectId }}</span></div>
      <div v-if="document.tags?.length"><span class="label">Tags</span><span>{{ document.tags.join(', ') }}</span></div>
    </div>
  </section>

  <section v-if="document" class="card mt">
    <h2 class="section-title">Version history</h2>
    <p class="muted small">Every upload with this filename is kept. Newest first.</p>
    <div class="table-wrap mt">
      <table class="file-table">
        <thead>
          <tr>
            <th>Version</th>
            <th>Uploaded by</th>
            <th>Date / time</th>
            <th>Size</th>
            <th>Source</th>
            <th>Notes</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="v in versions" :key="v.id">
            <td><span class="pill">v{{ v.versionNumber }}</span></td>
            <td>{{ v.uploadedBy }}</td>
            <td :title="v.createdAt">{{ formatWhen(v.createdAt) }}</td>
            <td>{{ formatBytes(v.sizeBytes) }}</td>
            <td class="muted">{{ v.sourceApp || v.source }}</td>
            <td class="notes-cell" :title="v.notes || undefined">{{ v.notes || '—' }}</td>
            <td class="actions">
              <a class="btn-link" :href="v.downloadUrl" target="_blank" rel="noopener">
                <Icon name="download" :size="14" />Download
              </a>
              <button class="btn-link danger-text" :disabled="busy" @click="deleteVersion(v.id)">
                <Icon name="delete" :size="14" />Delete
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.back-link { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; margin-right: 8px; }
.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px 20px;
}
.meta-grid .label {
  display: block;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.6;
  margin-bottom: 2px;
}
.section-title { margin: 0 0 4px; font-size: 16px; }
.table-wrap { overflow-x: auto; }
.file-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.file-table th, .file-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--color-border, #2a2a32); }
.file-table th { font-weight: 600; white-space: nowrap; }
.pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-3, #24242c);
  font-size: 12px;
}
.actions { display: flex; gap: 8px; justify-content: flex-end; white-space: nowrap; }
.notes-cell {
  max-width: 280px;
  white-space: pre-wrap;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  color: var(--color-text-muted, #9a9aa3);
}
.danger-text { color: var(--color-danger, #e35d6a); }
</style>
