<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink } from 'vue-router';
import { fixturesApi, type ApiError, type MvrImportResult } from '../../shared/api';

const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const uploading = ref(false);
const error = ref<string | null>(null);
const result = ref<MvrImportResult | null>(null);

const projectId = ref('');
const modelId = ref('');
const orbitTarget = ref<'prod' | 'dev'>('dev');
const selected = ref<Set<string>>(new Set());

async function onFile(ev: Event): Promise<void> {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  importing.value = true;
  error.value = null;
  result.value = null;
  try {
    const res = await fixturesApi.importMvr(file);
    result.value = res;
    selected.value = new Set(res.instances.map((i) => i.id));
  } catch (err) {
    error.value = (err as ApiError).message ?? 'import failed';
  } finally {
    importing.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}

function toggle(id: string): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

async function uploadToOrbit(): Promise<void> {
  if (!result.value || !projectId.value || !modelId.value) return;
  uploading.value = true;
  error.value = null;
  try {
    const res = await fixturesApi.uploadMvrToOrbit({
      runId: result.value.runId,
      projectId: projectId.value.trim(),
      modelId: modelId.value.trim(),
      orbitTarget: orbitTarget.value,
      instanceIds: [...selected.value],
    });
    alert(`Uploaded to ORBIT: version ${res.versionId} (${res.objectCount} objects)`);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'orbit upload failed';
  } finally {
    uploading.value = false;
  }
}
</script>

<template>
  <div class="h-row">
    <RouterLink :to="{ name: 'fixtures' }" class="muted">← Library</RouterLink>
    <h1 class="flex-1">MVR import</h1>
  </div>
  <p class="muted">Parse MVR fixtures, resolve GDTF types, then upload instances to ORBIT.</p>

  <button :disabled="importing" @click="fileInput?.click()">
    {{ importing ? 'Parsing…' : 'Upload .mvr' }}
  </button>
  <input ref="fileInput" type="file" accept=".mvr" style="display:none" @change="onFile" />

  <div v-if="result" class="card mt">
    <h2>Instances ({{ result.instances.length }})</h2>
    <div v-if="result.patchConflicts.length" class="error-box">
      Patch conflicts: {{ result.patchConflicts.join('; ') }}
    </div>
    <ul class="inst-list">
      <li v-for="inst in result.instances" :key="inst.id">
        <label>
          <input type="checkbox" :checked="selected.has(inst.id)" @change="toggle(inst.id)" />
          {{ inst.instanceName }}
          <span class="muted small">type {{ inst.fixtureTypeId ?? 'unresolved' }}</span>
        </label>
        <ul v-if="inst.warnings.length" class="warn">
          <li v-for="(w, i) in inst.warnings" :key="i">{{ w }}</li>
        </ul>
      </li>
    </ul>

    <h3 class="mt">Upload to ORBIT</h3>
    <label>Project ID <input v-model="projectId" /></label>
    <label>Model ID <input v-model="modelId" /></label>
    <label>Target
      <select v-model="orbitTarget">
        <option value="dev">dev</option>
        <option value="prod">prod</option>
      </select>
    </label>
    <button class="primary mt-sm" :disabled="uploading || !selected.size" @click="uploadToOrbit">
      {{ uploading ? 'Uploading…' : 'Upload selected to ORBIT' }}
    </button>
  </div>

  <div v-if="error" class="error-box mt">{{ error }}</div>
</template>

<style scoped>
.inst-list { list-style: none; padding: 0; }
.inst-list > li { padding: 8px 0; border-bottom: 1px solid var(--border, #333); }
.warn { color: #c90; font-size: 12px; margin: 4px 0 0 20px; }
label { display: block; margin-top: 8px; }
</style>
