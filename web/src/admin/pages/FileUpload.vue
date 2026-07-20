<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { filesApi, type ApiError, type FileLibraryStatus } from '../../shared/api';
import Icon from '../../shared/Icon.vue';

const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const dragOver = ref(false);
const error = ref<string | null>(null);
const progress = ref<string | null>(null);
const selectedFile = ref<File | null>(null);
const tags = ref('');
const projectId = ref('');
const status = ref<FileLibraryStatus | null>(null);
const DEFAULT_ACCEPT = '.3dm,.vwx,.dwg,.rvt,.skp,.fbx,.obj,.zip,.3ds,.dae';

async function loadStatus(): Promise<void> {
  try {
    status.value = await filesApi.status();
  } catch {
    status.value = null;
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
  uploading.value = true;
  error.value = null;
  progress.value = 'Uploading…';
  try {
    const res = await filesApi.upload(selectedFile.value, {
      name: selectedFile.value.name,
      tags: tags.value.trim() || undefined,
      projectId: projectId.value.trim() || undefined,
      sourceApp: 'admin',
    });
    progress.value = `Stored as version ${res.version.versionNumber}`;
    void router.push({ name: 'file-detail', params: { id: res.document.id } });
  } catch (err) {
    error.value = (err as ApiError).message ?? 'upload failed';
  } finally {
    uploading.value = false;
    progress.value = null;
  }
}

onMounted(() => void loadStatus());
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
        Connectors should use the same <code>POST /api/files</code> endpoint.
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
        <span class="field-label">Tags <span class="optional">(optional)</span></span>
        <input v-model="tags" placeholder="e.g. auditorium, schematic" />
      </label>
      <label class="field">
        <span class="field-label">Project id <span class="optional">(optional)</span></span>
        <input v-model="projectId" placeholder="Orbit project id" />
      </label>
    </div>

    <div v-if="error" class="error-box mt">{{ error }}</div>
    <p v-if="progress" class="muted small mt">{{ progress }}</p>

    <div class="actions mt">
      <button class="primary" :disabled="!selectedFile || uploading" @click="runUpload">
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
.field-label { font-size: 12px; opacity: 0.75; }
.optional { opacity: 0.6; }
.actions { display: flex; justify-content: flex-end; }
@media (max-width: 640px) {
  .form-grid { grid-template-columns: 1fr; }
}
</style>
