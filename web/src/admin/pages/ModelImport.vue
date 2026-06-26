<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { modelsApi, type ApiError, type ModelImportStatus, type ModelCategoryOption } from '../../shared/api';
import Icon from '../../shared/Icon.vue';
import { loadModelCategories } from '../utils/modelCategories';
import {
  DEFAULT_MODEL_SOURCE_UNITS,
  MODEL_LENGTH_UNITS,
  type ModelLengthUnit,
} from '../utils/modelUnits';

const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const dragOver = ref(false);
const error = ref<string | null>(null);
const progress = ref<string | null>(null);
const name = ref('');
const category = ref('');
const tags = ref('');
const sourceUnits = ref<ModelLengthUnit>(DEFAULT_MODEL_SOURCE_UNITS);
const selectedFile = ref<File | null>(null);
const categoryOptions = ref<ModelCategoryOption[]>([]);

/** Match /convert/ supported formats (Rhino + assimp pre-convert). */
const ACCEPT = '.3dm,.dwg,.dxf,.fbx,.obj,.stl,.ply,.3mf,.skp,.dae,.gltf,.glb,.blend,.x,.usdz,.step,.stp,.iges,.igs,.zip';
const ACCEPT_LABEL = '3DM, DWG, DXF, FBX, OBJ, STL, PLY, 3MF, SKP, DAE, GLTF, GLB, BLEND, X, USDZ, STEP, IGES, ZIP';

let pollTimer: ReturnType<typeof setInterval> | null = null;

function applyChosenFile(file: File): void {
  selectedFile.value = file;
  error.value = null;
  progress.value = null;
  if (!name.value) name.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
}

function onFileChosen(ev: Event): void {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  applyChosenFile(file);
}

function onDragOver(ev: DragEvent): void {
  ev.preventDefault();
  if (!importing.value) dragOver.value = true;
}

function onDragLeave(): void {
  dragOver.value = false;
}

function onDrop(ev: DragEvent): void {
  ev.preventDefault();
  dragOver.value = false;
  if (importing.value) return;
  const file = ev.dataTransfer?.files?.[0];
  if (file) applyChosenFile(file);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollUntilReady(modelId: string): Promise<void> {
  stopPolling();
  return new Promise((resolve, reject) => {
    pollTimer = setInterval(async () => {
      try {
        const { model } = await modelsApi.get(modelId);
        const status = model.importStatus as ModelImportStatus | null | undefined;
        if (status === 'failed') {
          stopPolling();
          reject(new Error('Conversion failed — check Pipeline jobs for details'));
          return;
        }
        if (model.hasPreview || status === 'complete') {
          stopPolling();
          resolve();
        } else {
          progress.value = status === 'converting'
            ? (progress.value?.startsWith('Adding new version')
              ? progress.value
              : 'Converting via PRISM pipeline and uploading to Orbit…')
            : 'Waiting for conversion…';
        }
      } catch (err) {
        stopPolling();
        reject(err);
      }
    }, 3000);
  });
}

async function runImport(): Promise<void> {
  if (!selectedFile.value) return;
  importing.value = true;
  error.value = null;
  progress.value = 'Uploading and submitting convert job…';
  try {
    const res = await modelsApi.import(selectedFile.value, {
      name: name.value || undefined,
      category: category.value || undefined,
      tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      sourceUnits: sourceUnits.value,
    });

    if (res.isNewVersion) {
      progress.value = `Adding new version to existing model ${res.model.name}…`;
    }

    if (res.importStatus === 'converting' || res.jobId) {
      await pollUntilReady(res.model.id);
    }

    void router.push({ name: 'model-editor', params: { id: res.model.id } });
  } catch (err) {
    error.value = (err as ApiError).message ?? 'import failed';
  } finally {
    importing.value = false;
    progress.value = null;
    stopPolling();
  }
}

onMounted(() => {
  void loadModelCategories().then((opts) => { categoryOptions.value = opts; });
});
onUnmounted(stopPolling);
</script>

<template>
  <div class="h-row">
    <RouterLink :to="{ name: 'models' }" class="muted back-link">
      <Icon name="arrow_back" :size="14" /> Model library
    </RouterLink>
    <h1 class="flex-1">Import model</h1>
  </div>

  <section class="card mt import-card">
    <header class="import-intro">
      <h2>Upload a 3D mesh</h2>
      <p class="muted small">
        Uses the same PRISM convert pipeline as
        <a href="/convert/" target="_blank" rel="noopener">/convert/</a>.
        Converted assets are stored in the Orbit Model Library project; a GLB preview is cached locally after conversion completes.
      </p>
    </header>

    <div class="import-section">
      <h3 class="section-label">Identity</h3>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">Display name</span>
          <input v-model="name" placeholder="Model name" />
        </label>
        <label class="field">
          <span class="field-label">Category <span class="optional">(optional)</span></span>
          <select v-model="category">
            <option
              v-for="opt in categoryOptions"
              :key="opt.value || '__none__'"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </select>
        </label>
        <label class="field field--wide">
          <span class="field-label">Tags <span class="optional">(comma-separated)</span></span>
          <input v-model="tags" placeholder="e.g. rigging, stage" />
        </label>
      </div>
    </div>

    <div class="import-section">
      <h3 class="section-label">Import settings</h3>
      <label class="field field--units">
        <span class="field-label">Mesh units</span>
        <select v-model="sourceUnits">
          <option v-for="u in MODEL_LENGTH_UNITS" :key="u" :value="u">{{ u }}</option>
        </select>
        <p class="muted small field-hint">
          Coordinate units of the mesh file. Used to scale the preview to real-world metres.
        </p>
      </label>
    </div>

    <div class="import-section">
      <h3 class="section-label">File</h3>
      <div
        :class="['dropzone', { active: dragOver, disabled: importing, 'has-file': selectedFile }]"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
        @click="!importing && fileInput?.click()"
      >
        <input
          ref="fileInput"
          type="file"
          :accept="ACCEPT"
          style="display: none"
          @change="onFileChosen"
        />
        <Icon name="upload_file" :size="28" class="dropzone-icon" />
        <strong v-if="selectedFile">{{ selectedFile.name }}</strong>
        <strong v-else>Drop a mesh file here, or click to choose</strong>
        <p class="muted small">
          Supported formats: {{ ACCEPT_LABEL }}.
        </p>
      </div>
    </div>

    <div v-if="selectedFile" class="import-actions">
      <button
        class="primary"
        :disabled="importing"
        @click="runImport"
      >
        <Icon name="download" :size="16" />{{ importing ? 'Importing…' : 'Import model' }}
      </button>
    </div>

    <div v-if="progress" class="info-box progress-box">
      <Icon name="hourglass_empty" :size="16" />
      <span>{{ progress }}</span>
    </div>
  </section>

  <div v-if="error" class="error-box mt">{{ error }}</div>
</template>

<style scoped>
.import-card {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.import-intro h2 {
  margin: 0 0 6px;
}

.import-intro p {
  margin: 0;
  max-width: 640px;
  line-height: 1.5;
}

.import-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-label {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: hsl(var(--muted-foreground));
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}

@media (min-width: 640px) {
  .form-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.field--wide {
  grid-column: 1 / -1;
}

.field--units {
  max-width: 320px;
}

.field-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: hsl(var(--muted-foreground));
}

.optional {
  font-weight: 500;
  text-transform: none;
  letter-spacing: normal;
}

.field input,
.field select {
  width: 100%;
}

.field-hint {
  margin: 2px 0 0;
  line-height: 1.45;
}

.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  border: 2px dashed hsl(var(--border));
  border-radius: var(--radius);
  padding: 36px 20px;
  text-align: center;
  cursor: pointer;
  transition: background 80ms, border-color 80ms;
}

.dropzone:hover:not(.disabled) {
  background: hsl(var(--accent) / 0.35);
}

.dropzone.active {
  border-color: hsl(var(--primary));
  background: var(--orbit-primary-fade);
}

.dropzone.disabled {
  opacity: 0.65;
  cursor: not-allowed;
  pointer-events: none;
}

.dropzone.has-file {
  border-style: solid;
  border-color: hsl(var(--primary) / 0.45);
  background: var(--orbit-primary-fade);
}

.dropzone-icon {
  color: hsl(var(--muted-foreground));
}

.dropzone.has-file .dropzone-icon {
  color: hsl(var(--primary));
}

.dropzone p {
  margin: 0;
  max-width: 520px;
}

.import-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 4px;
}

.progress-box {
  display: flex;
  align-items: center;
  gap: 8px;
  font-style: italic;
}
</style>
