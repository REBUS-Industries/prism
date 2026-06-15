<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { modelsApi, type ApiError, type ModelImportStatus } from '../../shared/api';
import Icon from '../../shared/Icon.vue';
import { MODEL_CATEGORY_OPTIONS } from '../utils/modelCategories';
import {
  DEFAULT_MODEL_SOURCE_UNITS,
  MODEL_LENGTH_UNITS,
  type ModelLengthUnit,
} from '../utils/modelUnits';

const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const error = ref<string | null>(null);
const progress = ref<string | null>(null);
const name = ref('');
const category = ref('');
const tags = ref('');
const sourceUnits = ref<ModelLengthUnit>(DEFAULT_MODEL_SOURCE_UNITS);
const selectedFile = ref<File | null>(null);

/** Match /convert/ supported formats (Rhino + assimp pre-convert). */
const ACCEPT = '.3dm,.dwg,.dxf,.fbx,.obj,.stl,.ply,.3mf,.skp,.dae,.gltf,.glb,.blend,.x,.usdz,.step,.stp,.iges,.igs,.zip';

let pollTimer: ReturnType<typeof setInterval> | null = null;

function onFileChosen(ev: Event): void {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  selectedFile.value = file;
  error.value = null;
  progress.value = null;
  if (!name.value) name.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
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
            ? 'Converting via PRISM pipeline and uploading to Orbit…'
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

onUnmounted(stopPolling);
</script>

<template>
  <div class="h-row">
    <RouterLink :to="{ name: 'models' }" class="muted back-link"><Icon name="arrow_back" :size="14" /> Model library</RouterLink>
    <h1 class="flex-1">Import model</h1>
  </div>

  <section class="card mt">
    <h2>Upload a 3D mesh</h2>
    <p class="muted small">
      Uses the same PRISM convert pipeline as
      <a href="/convert/" target="_blank" rel="noopener">/convert/</a>.
      Converted assets are stored in the Orbit Model Library project; a GLB preview is cached locally after conversion completes.
    </p>

    <label class="muted small">Display name</label>
    <input v-model="name" placeholder="Model name" />

    <label class="muted small mt-sm">Category (optional)</label>
    <select v-model="category">
      <option
        v-for="opt in MODEL_CATEGORY_OPTIONS"
        :key="opt.value || '__none__'"
        :value="opt.value"
      >
        {{ opt.label }}
      </option>
    </select>

    <label class="muted small mt-sm">Tags (comma-separated)</label>
    <input v-model="tags" placeholder="e.g. rigging, stage" />

    <label class="muted small mt-sm">Mesh units</label>
    <select v-model="sourceUnits">
      <option v-for="u in MODEL_LENGTH_UNITS" :key="u" :value="u">{{ u }}</option>
    </select>
    <p class="muted small unit-hint">Coordinate units of the mesh file. Used to scale the preview to real-world metres.</p>

    <div class="mt-sm">
      <button :disabled="importing" @click="fileInput?.click()">
        <Icon name="upload_file" :size="16" />Choose file
      </button>
      <input ref="fileInput" type="file" :accept="ACCEPT" style="display:none" @change="onFileChosen" />
    </div>
    <p v-if="selectedFile" class="muted small mt-sm">{{ selectedFile.name }}</p>

    <button
      v-if="selectedFile"
      class="primary mt-sm"
      :disabled="importing"
      @click="runImport"
    >
      <Icon name="download" :size="16" />{{ importing ? 'Importing…' : 'Import' }}
    </button>

    <p v-if="progress" class="muted small mt-sm progress-hint">{{ progress }}</p>
  </section>

  <div v-if="error" class="error-box mt">{{ error }}</div>
</template>

<style scoped>
.unit-hint { margin: 4px 0 0; max-width: 480px; line-height: 1.45; }
.progress-hint { margin-top: 8px; font-style: italic; }
</style>
