<script setup lang="ts">
import { ref } from 'vue';
import type { FixtureBeam } from '../../shared/api';
import { fixturesApi, type ApiError } from '../../shared/api';

const props = defineProps<{ fixtureId: string; beams: FixtureBeam[] }>();
const emit = defineEmits<{ uploaded: [] }>();

const beamId = ref(props.beams[0]?.beamId ?? '');
const uploading = ref(false);
const error = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

async function onFile(ev: Event): Promise<void> {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file || !beamId.value) return;
  uploading.value = true;
  error.value = null;
  try {
    await fixturesApi.uploadIes(props.fixtureId, beamId.value, file);
    emit('uploaded');
  } catch (err) {
    error.value = (err as ApiError).message ?? 'upload failed';
  } finally {
    uploading.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}
</script>

<template>
  <div class="ies-uploader">
    <label class="muted small">Beam</label>
    <select v-model="beamId">
      <option v-for="b in beams" :key="b.beamId" :value="b.beamId">{{ b.beamId }}</option>
    </select>
    <button :disabled="uploading || !beamId" @click="fileInput?.click()">
      {{ uploading ? 'Uploading…' : 'Attach .ies' }}
    </button>
    <input ref="fileInput" type="file" accept=".ies,text/plain" style="display:none" @change="onFile" />
    <div v-if="error" class="error-box mt-sm">{{ error }}</div>
  </div>
</template>

<style scoped>
.ies-uploader { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
select { min-width: 120px; }
</style>
