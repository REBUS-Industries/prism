<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import GdtfShareSearch from '../components/GdtfShareSearch.vue';
import FixtureModelQualitySelect from '../components/FixtureModelQualitySelect.vue';
import { fixturesApi, type ApiError } from '../../shared/api';
import Icon from '../../shared/Icon.vue';
import {
  DEFAULT_GDTF_MODEL_QUALITY,
  coerceModelQuality,
  defaultModelQualityForAvailable,
  type GdtfModelQuality,
  type GdtfModelFormat,
} from '../utils/fixtureModelQuality';

const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const inspecting = ref(false);
const error = ref<string | null>(null);
const name = ref('');
const selectedFile = ref<File | null>(null);
const availableModelQualities = ref<GdtfModelQuality[] | null>(null);
const availableModelFormats = ref<GdtfModelFormat[] | null>(null);
const modelQuality = ref<GdtfModelQuality>(DEFAULT_GDTF_MODEL_QUALITY);

async function onFileChosen(ev: Event): Promise<void> {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  selectedFile.value = file;
  inspecting.value = true;
  error.value = null;
  availableModelQualities.value = null;
  availableModelFormats.value = null;
  try {
    const res = await fixturesApi.inspectGdtf(file);
    availableModelQualities.value = res.availableModelQualities;
    availableModelFormats.value = res.availableModelFormats ?? null;
    modelQuality.value = defaultModelQualityForAvailable(res.availableModelQualities);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to read GDTF mesh options';
    selectedFile.value = null;
  } finally {
    inspecting.value = false;
  }
}

async function runImport(): Promise<void> {
  if (!selectedFile.value) return;
  importing.value = true;
  error.value = null;
  try {
    const res = await fixturesApi.importGdtf(selectedFile.value, {
      name: name.value || undefined,
      modelQuality: coerceModelQuality(modelQuality.value, availableModelQualities.value),
    });
    void router.push({ name: 'fixture-editor', params: { id: res.fixture.id } });
  } catch (err) {
    error.value = (err as ApiError).message ?? 'import failed';
  } finally {
    importing.value = false;
  }
}

function onImported(id: string): void {
  void router.push({ name: 'fixture-editor', params: { id } });
}
</script>

<template>
  <div class="h-row">
    <RouterLink :to="{ name: 'fixtures' }" class="muted back-link"><Icon name="arrow_back" :size="14" /> Library</RouterLink>
    <h1 class="flex-1">Import GDTF</h1>
  </div>

  <section class="card mt">
    <h2>Upload .gdtf file</h2>
    <label class="muted small">Optional display name</label>
    <input v-model="name" placeholder="Override name" />
    <button class="mt-sm" :disabled="importing || inspecting" @click="fileInput?.click()">
      <Icon name="upload_file" :size="16" />{{ inspecting ? 'Reading GDTF…' : 'Choose .gdtf file' }}
    </button>
    <input ref="fileInput" type="file" accept=".gdtf" style="display:none" @change="onFileChosen" />
    <p v-if="selectedFile" class="muted small mt-sm">{{ selectedFile.name }}</p>
    <FixtureModelQualitySelect
      v-if="selectedFile"
      v-model="modelQuality"
      class="mt-sm"
      :available="availableModelQualities"
      :formats="availableModelFormats"
      :loading="inspecting"
      :disabled="importing"
    />
    <button
      v-if="selectedFile && availableModelQualities?.length"
      class="mt-sm"
      :disabled="importing || inspecting"
      @click="runImport"
    >
      <Icon name="download" :size="16" />{{ importing ? 'Importing…' : 'Import' }}
    </button>
  </section>

  <section class="card mt">
    <h2>GDTF-Share quick search</h2>
    <p class="muted small">For the full manufacturer browser and version picker, open <RouterLink :to="{ name: 'fixtures' }">Fixture library</RouterLink> and switch to the GDTF-Share catalog tab.</p>
    <GdtfShareSearch @imported="onImported" />
  </section>

  <div v-if="error" class="error-box mt">{{ error }}</div>
</template>
