<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import GdtfShareSearch from '../components/GdtfShareSearch.vue';
import { fixturesApi, type ApiError } from '../../shared/api';

const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const error = ref<string | null>(null);
const name = ref('');

async function onFile(ev: Event): Promise<void> {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  importing.value = true;
  error.value = null;
  try {
    const res = await fixturesApi.importGdtf(file, name.value || undefined);
    void router.push({ name: 'fixture-editor', params: { id: res.fixture.id } });
  } catch (err) {
    error.value = (err as ApiError).message ?? 'import failed';
  } finally {
    importing.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}

function onImported(id: string): void {
  void router.push({ name: 'fixture-editor', params: { id } });
}
</script>

<template>
  <div class="h-row">
    <RouterLink :to="{ name: 'fixtures' }" class="muted">← Library</RouterLink>
    <h1 class="flex-1">Import GDTF</h1>
  </div>

  <section class="card mt">
    <h2>Upload .gdtf file</h2>
    <label class="muted small">Optional display name</label>
    <input v-model="name" placeholder="Override name" />
    <button class="mt-sm" :disabled="importing" @click="fileInput?.click()">
      {{ importing ? 'Importing…' : 'Choose .gdtf file' }}
    </button>
    <input ref="fileInput" type="file" accept=".gdtf" style="display:none" @change="onFile" />
  </section>

  <section class="card mt">
    <h2>GDTF-Share quick search</h2>
    <p class="muted small">For the full manufacturer browser and version picker, open <RouterLink :to="{ name: 'fixtures' }">Fixture library</RouterLink> and switch to the GDTF-Share catalog tab.</p>
    <GdtfShareSearch @imported="onImported" />
  </section>

  <div v-if="error" class="error-box mt">{{ error }}</div>
</template>
