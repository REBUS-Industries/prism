<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { modelsApi, type ApiError } from '../../shared/api';
import Icon from '../../shared/Icon.vue';
import { MODEL_CATEGORY_OPTIONS } from '../utils/modelCategories';

const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const error = ref<string | null>(null);
const name = ref('');
const category = ref('');
const tags = ref('');
const selectedFile = ref<File | null>(null);

const ACCEPT = '.glb,.gltf,.fbx,.obj,.3ds,.dae,.stl,.ply,.usdz,.zip';

function onFileChosen(ev: Event): void {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  selectedFile.value = file;
  error.value = null;
  if (!name.value) name.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
}

async function runImport(): Promise<void> {
  if (!selectedFile.value) return;
  importing.value = true;
  error.value = null;
  try {
    const res = await modelsApi.import(selectedFile.value, {
      name: name.value || undefined,
      category: category.value || undefined,
      tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
    });
    void router.push({ name: 'model-editor', params: { id: res.model.id } });
  } catch (err) {
    error.value = (err as ApiError).message ?? 'import failed';
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div class="h-row">
    <RouterLink :to="{ name: 'models' }" class="muted back-link"><Icon name="arrow_back" :size="14" /> Model library</RouterLink>
    <h1 class="flex-1">Import model</h1>
  </div>

  <section class="card mt">
    <h2>Upload a 3D mesh</h2>
    <p class="muted small">Accepts glTF/GLB, FBX, OBJ, 3DS, DAE, STL, PLY, or a .zip containing a single mesh. Non-GLB meshes are converted to GLB on import.</p>

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
  </section>

  <div v-if="error" class="error-box mt">{{ error }}</div>
</template>
