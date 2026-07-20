<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  filesApi,
  orbitApi,
  type ApiError,
  type FileLibraryProjectFolder,
  type FileLibraryStatus,
  type OrbitProject,
} from '../../shared/api';
import Icon from '../../shared/Icon.vue';

const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const dragOver = ref(false);
const error = ref<string | null>(null);
const progress = ref<string | null>(null);
const selectedFile = ref<File | null>(null);
const tags = ref('');
const notes = ref('');
const projectId = ref('');
const status = ref<FileLibraryStatus | null>(null);
const projects = ref<OrbitProject[]>([]);
const folders = ref<FileLibraryProjectFolder[]>([]);
const loadingMeta = ref(true);
const DEFAULT_ACCEPT = '.3dm,.vwx,.dwg,.rvt,.skp,.fbx,.obj,.zip,.3ds,.dae';

const folderByProject = computed(() => {
  const m = new Map<string, FileLibraryProjectFolder>();
  for (const f of folders.value) m.set(f.projectId, f);
  return m;
});

const selectedFolder = computed(() =>
  projectId.value ? folderByProject.value.get(projectId.value) ?? null : null,
);

const canUpload = computed(() =>
  !!selectedFile.value && !!projectId.value && !!selectedFolder.value && !uploading.value,
);

async function loadMeta(): Promise<void> {
  loadingMeta.value = true;
  try {
    const [st, folderRes, projRes] = await Promise.all([
      filesApi.status().catch(() => null),
      filesApi.listProjectFolders(),
      orbitApi.projects('prod', 500),
    ]);
    status.value = st;
    folders.value = folderRes.folders;
    projects.value = [...projRes.items].sort((a, b) =>
      (a.name || a.id).localeCompare(b.name || b.id, undefined, { sensitivity: 'base' }),
    );
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load projects';
  } finally {
    loadingMeta.value = false;
  }
}

function applyChosenFile(file: File): void {
  selectedFile.value = file;
  error.value = null;
  progress.value = null;
}

function onFileChosen(ev: Event): void {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  applyChosenFile(file);
}

function onDragOver(ev: DragEvent): void {
  ev.preventDefault();
  if (!uploading.value) dragOver.value = true;
}

function onDragLeave(): void {
  dragOver.value = false;
}

function onDrop(ev: DragEvent): void {
  ev.preventDefault();
  dragOver.value = false;
  if (uploading.value) return;
  const file = ev.dataTransfer?.files?.[0];
  if (file) applyChosenFile(file);
}

async function runUpload(): Promise<void> {
  if (!selectedFile.value) return;
  if (!projectId.value.trim()) {
    error.value = 'Select an Orbit project';
    return;
  }
  if (!selectedFolder.value) {
    error.value = 'No File Library folder configured for this project — set one in Settings → File Library';
    return;
  }
  uploading.value = true;
  error.value = null;
  progress.value = 'Uploading…';
  try {
    const res = await filesApi.upload(selectedFile.value, {
      name: selectedFile.value.name,
      tags: tags.value.trim() || undefined,
      notes: notes.value.trim() || undefined,
      projectId: projectId.value.trim(),
      sourceApp: 'admin',
    });
    progress.value = `Stored as version ${res.version.versionNumber}`;
    void router.push({ name: 'file-detail', params: { id: res.document.id } });
  } catch (err) {
    const apiErr = err as ApiError;
    const code = (apiErr.body as { code?: string } | undefined)?.code;
    if (code === 'project_folder_required') {
      error.value = 'No File Library folder configured for this project — set one in Settings → File Library';
    } else {
      error.value = apiErr.message ?? 'upload failed';
    }
  } finally {
    uploading.value = false;
    progress.value = null;
  }
}

onMounted(() => void loadMeta());
</script>

<template>
  <div class="h-row">
    <RouterLink :to="{ name: 'files' }" class="muted back-link">
      <Icon name="arrow_back" :size="14" /> File library
    </RouterLink>
    <h1 class="flex-1">Upload file</h1>
  </div>

  <section class="card mt import-card">
    <header class="import-intro">
      <h2>Send a native CAD / DCC file</h2>
      <p class="muted small">
        Same filename as an existing document creates a <strong>new version</strong> (nothing is overwritten).
        Files are stored under the project folder configured in Settings → File Library.
      </p>
      <p v-if="status" class="muted small">
        Allowed: {{ status.allowedExts.join(', ') }}
      </p>
    </header>

    <div
      class="dropzone"
      :class="{ over: dragOver, disabled: uploading }"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @click="fileInput?.click()"
    >
      <Icon name="upload_file" :size="28" />
      <p v-if="selectedFile">{{ selectedFile.name }} ({{ Math.round(selectedFile.size / 1024) }} KB)</p>
      <p v-else class="muted">Drop a file here or click to browse</p>
      <input
        ref="fileInput"
        type="file"
        class="hidden"
        :accept="status?.allowedExts?.join(',') || DEFAULT_ACCEPT"
        @change="onFileChosen"
      />
    </div>

    <div class="form-grid mt">
      <label class="field">
        <span class="field-label">Orbit project</span>
        <select v-model="projectId" :disabled="loadingMeta || uploading">
          <option value="" disabled>{{ loadingMeta ? 'Loading…' : 'Select a project…' }}</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">
            {{ p.name || p.id }}{{ folderByProject.has(p.id) ? '' : ' (no folder)' }}
          </option>
        </select>
        <span v-if="projectId && selectedFolder" class="muted small path-hint">
          Folder: <code>{{ selectedFolder.relativePath }}</code>
        </span>
        <span v-else-if="projectId && !selectedFolder" class="warn small">
          No folder configured —
          <RouterLink :to="{ name: 'settings', query: { open: 'file-library' } }">open File Library settings</RouterLink>
        </span>
      </label>
      <label class="field">
        <span class="field-label">Tags <span class="optional">(optional)</span></span>
        <input v-model="tags" placeholder="e.g. auditorium, schematic" />
      </label>
      <label class="field field-span">
        <span class="field-label">Version notes <span class="optional">(optional)</span></span>
        <textarea v-model="notes" rows="3" placeholder="What changed in this version?" />
      </label>
    </div>

    <div v-if="error" class="error-box mt">{{ error }}</div>
    <p v-if="progress" class="muted small mt">{{ progress }}</p>

    <div class="actions mt">
      <button class="primary" :disabled="!canUpload" @click="runUpload">
        <Icon name="cloud_upload" :size="16" />{{ uploading ? 'Uploading…' : 'Upload' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.back-link { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; margin-right: 8px; }
.import-intro h2 { margin: 0 0 6px; font-size: 18px; }
.dropzone {
  margin-top: 16px;
  border: 1px dashed var(--color-border-strong, #3a3a44);
  border-radius: 10px;
  padding: 36px 20px;
  text-align: center;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  transition: border-color 0.15s, background 0.15s;
}
.dropzone.over { border-color: var(--color-accent, #5b8def); background: rgba(91, 141, 239, 0.06); }
.dropzone.disabled { opacity: 0.6; pointer-events: none; }
.hidden { display: none; }
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.field { display: flex; flex-direction: column; gap: 4px; }
.field-span { grid-column: 1 / -1; }
.field textarea { resize: vertical; min-height: 72px; }
.field-label { font-size: 12px; opacity: 0.75; }
.optional { opacity: 0.6; }
.path-hint code { font-size: 11px; word-break: break-all; }
.warn { color: var(--color-warning, #c9a227); }
.actions { display: flex; justify-content: flex-end; }
@media (max-width: 640px) {
  .form-grid { grid-template-columns: 1fr; }
}
</style>
