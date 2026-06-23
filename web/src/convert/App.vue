<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { convertApi, fixturesApi, jobsApi, type ApiError, type JobSummary, type LayerNode, type MvrImportResult } from '../shared/api';
import OrbitPicker from '../shared/OrbitPicker.vue';
import MvrFixtureMapModal from '../shared/MvrFixtureMapModal.vue';
import ThemeToggle from '../shared/ThemeToggle.vue';
import Icon from '../shared/Icon.vue';
import LayerPicker from './LayerPicker.vue';

const file = ref<File | null>(null);
const isMvrFile = computed(() => file.value?.name.toLowerCase().endsWith('.mvr') ?? false);
const projectId = ref('');
const modelId = ref('');
const modelName = ref('');
const orbitTarget = ref<'prod' | 'dev'>('prod');
const swapYZ = ref(false);
const quality = ref<'sensible' | 'extreme'>('sensible');
const selectLayers = ref(false);

/** Keep in sync with server `conversion/uploadLimits.ts`. */
const maxUploadBytes = 2 * 1024 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

const submitting = ref(false);
const uploadProgress = ref(0);
const error = ref<string | null>(null);
const jobId = ref<string | null>(null);
const job = ref<JobSummary | null>(null);
const layers = ref<LayerNode[] | null>(null);
const submittingLayers = ref(false);

const mvrModalOpen = ref(false);
const mvrResult = ref<MvrImportResult | null>(null);
const mvrSuccess = ref<string | null>(null);

let pollTimer: ReturnType<typeof setInterval> | null = null;
let sseSource: EventSource | null = null;

function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  file.value = input.files?.[0] ?? null;
  mvrSuccess.value = null;
}

const canSubmit = computed(() => {
  if (!file.value || submitting.value) return false;
  if (isMvrFile.value) return true;
  return !!projectId.value && !!modelId.value;
});

async function submitMvr(): Promise<void> {
  if (!file.value) return;
  error.value = null;
  submitting.value = true;
  try {
    mvrResult.value = await fixturesApi.importMvr(file.value);
    mvrModalOpen.value = true;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'MVR import failed';
  } finally {
    submitting.value = false;
  }
}

async function submit() {
  if (!file.value) return;
  if (isMvrFile.value) {
    await submitMvr();
    return;
  }
  error.value = null;
  submitting.value = true;
  uploadProgress.value = 0;
  try {
    const res = await convertApi.submit(file.value, {
      projectId: projectId.value.trim(),
      modelId: modelId.value.trim(),
      modelName: modelName.value.trim() || undefined,
      orbitTarget: orbitTarget.value,
      swapYZ: swapYZ.value,
      quality: quality.value,
      selectLayers: selectLayers.value,
    }, (p) => { uploadProgress.value = p; });
    jobId.value = res.jobId;
    job.value = null;
    layers.value = null;
    startTracking(res.jobId);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'submission failed';
  } finally {
    submitting.value = false;
    uploadProgress.value = 0;
  }
}

function startTracking(id: string) {
  // Try SSE first; fall back to polling if it errors.
  try {
    sseSource = new EventSource(`/api/jobs/${id}/stream`, { withCredentials: true });
    sseSource.addEventListener('state', (e) => applyPatch(JSON.parse((e as MessageEvent).data)));
    sseSource.addEventListener('update', (e) => applyPatch(JSON.parse((e as MessageEvent).data)));
    sseSource.addEventListener('error', () => {
      sseSource?.close(); sseSource = null;
      startPolling(id);
    });
  } catch {
    startPolling(id);
  }
}

function applyPatch(patch: Record<string, unknown>) {
  if (!job.value && patch['id']) {
    void jobsApi.get(String(patch['id'])).then((j) => {
      job.value = j;
      maybeFetchLayers(j);
    });
    return;
  }
  if (!job.value) return;
  job.value = { ...job.value, ...(patch as Partial<JobSummary>) };
  // The SSE `layers` patch on transition to awaiting_selection includes the
  // tree inline so we don't need a follow-up GET.
  if (patch['layers'] && Array.isArray(patch['layers'])) {
    layers.value = patch['layers'] as LayerNode[];
  }
  maybeFetchLayers(job.value);
  if (job.value.status === 'complete' || job.value.status === 'failed') {
    stopTracking();
  }
}

async function maybeFetchLayers(j: JobSummary) {
  // If we transitioned into awaiting_selection but the SSE patch didn't
  // carry the tree (eg. on first connect after a refresh), pull it now.
  if (j.status === 'awaiting_selection' && !layers.value) {
    try {
      const res = await jobsApi.getLayers(j.id);
      layers.value = res.layers;
    } catch {
      /* try again on the next tick — the agent might not have replied yet */
    }
  }
}

function startPolling(id: string) {
  const tick = async () => {
    try {
      const j = await jobsApi.get(id);
      job.value = j;
      maybeFetchLayers(j);
      if (j.status === 'complete' || j.status === 'failed') {
        stopTracking();
      }
    } catch { /* keep trying */ }
  };
  void tick();
  pollTimer = setInterval(tick, 2_000);
}

function stopTracking() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (sseSource) { sseSource.close(); sseSource = null; }
}

async function onLayerContinue(value: { includedLayers: string[]; includeLayerDescendants: boolean }) {
  if (!jobId.value) return;
  submittingLayers.value = true;
  error.value = null;
  try {
    await jobsApi.submitLayers(jobId.value, value);
    // The job transitions back to `queued`; the SSE stream is already
    // attached and will deliver status updates as the dispatcher picks
    // it up for the convert phase.
  } catch (err) {
    error.value = (err as ApiError).message ?? 'layer selection failed';
  } finally {
    submittingLayers.value = false;
  }
}

function reset() {
  stopTracking();
  file.value = null;
  jobId.value = null;
  job.value = null;
  layers.value = null;
  error.value = null;
  uploadProgress.value = 0;
  mvrModalOpen.value = false;
  mvrResult.value = null;
  mvrSuccess.value = null;
}

function onMvrUploaded(payload: { versionId: string; objectCount: number }): void {
  mvrSuccess.value = `Uploaded ${payload.objectCount} fixture(s) to ORBIT (version ${payload.versionId})`;
  file.value = null;
  mvrResult.value = null;
}

onUnmounted(stopTracking);

function fmtBytes(b: number): string {
  if (!b) return '0 B';
  const u = ['B','KB','MB','GB']; let v = b, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}

const showLayerPicker = computed(() =>
  job.value?.status === 'awaiting_selection' && layers.value !== null && layers.value.length > 0,
);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="brand">
        <img src="/prism-logo.png" alt="PRISM" class="brand-logo" />
        <span class="brand-mark">PR<span class="brand-accent">ISM</span></span> convert
      </div>
      <div class="spacer"></div>
      <ThemeToggle />
    </header>

    <div v-if="!jobId" class="card">
      <h2>{{ isMvrFile ? 'Import MVR fixtures' : 'Submit a conversion' }}</h2>
      <form @submit.prevent="submit" class="form">
        <label>File
          <input type="file" @change="onFile" accept=".3dm,.dwg,.dxf,.fbx,.obj,.stl,.ply,.3mf,.skp,.dae,.gltf,.glb,.blend,.x,.usdz,.step,.stp,.iges,.igs,.zip,.mvr" />
          <span v-if="file" class="muted" style="font-size: 11px;">{{ file.name }} — {{ fmtBytes(file.size) }}</span>
        </label>

        <p v-if="isMvrFile" class="muted mvr-hint">
          MVR files open a fixture-mapping step before upload to ORBIT. Pick project and model in the modal.
        </p>

        <template v-if="!isMvrFile">
        <div class="row">
          <label class="flex-1">ORBIT target
            <select v-model="orbitTarget">
              <option value="prod">Production</option>
              <option value="dev">Dev</option>
            </select>
          </label>
          <label class="flex-1">Quality
            <select v-model="quality">
              <option value="sensible">Sensible</option>
              <option value="extreme">Extreme</option>
            </select>
          </label>
        </div>

        <OrbitPicker
          :target="orbitTarget"
          v-model:projectId="projectId"
          v-model:modelId="modelId"
          v-model:modelName="modelName" />

        <label class="check"><input type="checkbox" v-model="swapYZ" /> Swap Y/Z axes</label>
        <label class="check">
          <input type="checkbox" v-model="selectLayers" />
          Choose layers to include before converting
        </label>
        </template>

        <div v-if="mvrSuccess" class="success-box">{{ mvrSuccess }}</div>
        <div v-if="error" class="error-box">{{ error }}</div>
        <p v-if="file && !isMvrFile" class="muted file-hint">
          {{ file.name }} · {{ formatBytes(file.size) }}
          <span v-if="file.size > maxUploadBytes"> — exceeds 2 GB limit</span>
        </p>
        <div v-if="submitting && !isMvrFile" class="upload-progress">
          <div class="upload-progress-labels">
            <span class="muted">{{ uploadProgress < 1 ? 'Uploading…' : 'Processing…' }}</span>
            <span class="muted">{{ Math.round(uploadProgress * 100) }}%</span>
          </div>
          <div class="progress mt-sm">
            <div class="fill" :style="{ width: `${Math.round(uploadProgress * 100)}%` }" />
          </div>
        </div>
        <button class="primary" type="submit" :disabled="!canSubmit">
          {{ submitting ? (isMvrFile ? 'Parsing MVR…' : (uploadProgress < 1 ? 'Uploading…' : 'Submitting…')) : (isMvrFile ? 'Import MVR' : 'Convert') }}
        </button>
      </form>
    </div>

    <div v-else class="card">
      <h2>Job {{ jobId?.slice(0, 8) }}…</h2>

      <div v-if="!job" class="muted">waiting for status…</div>
      <div v-else>
        <div class="h-row">
          <span class="pill" :class="job.status">{{ job.status }}</span>
          <div class="muted">{{ job.fileName }}</div>
          <div class="spacer"></div>
          <div v-if="job.nodeName" class="muted">on <strong>{{ job.nodeName }}</strong></div>
        </div>

        <div v-if="job.progressPercent != null" class="mt">
          <div class="progress"><div class="fill" :style="{ width: `${job.progressPercent}%` }"></div></div>
          <div class="muted mt-sm" style="font-size: 12px;">{{ job.currentStage }} — {{ job.lastMessage ?? '' }}</div>
        </div>

        <div v-if="showLayerPicker" class="mt-lg">
          <LayerPicker
            :layers="layers!"
            :busy="submittingLayers"
            @continue="onLayerContinue"
            @cancel="reset" />
        </div>
        <div v-else-if="job.status === 'awaiting_selection'" class="muted mt">
          fetching layer tree from agent…
        </div>

        <div v-if="job.status === 'complete'" class="success-box mt">
          Done — <a v-if="job.resultUrl" :href="job.resultUrl" target="_blank">open in ORBIT</a>
          <span v-if="job.outputs && Object.keys(job.outputs).length">
            · downloads:
            <a v-for="(url, fmt) in job.outputs" :key="fmt" :href="url" style="margin-right: 6px;">.{{ fmt }}</a>
          </span>
        </div>
        <div v-else-if="job.status === 'failed'" class="error-box mt">{{ job.error ?? 'failed' }}</div>
      </div>

      <button class="mt-lg" @click="reset">Submit another</button>
    </div>

    <footer class="page-footer muted">
      Powered by PRISM.
      <a href="/docs/" target="_blank" rel="noopener" class="ext-link">API reference<Icon name="open_in_new" :size="13" /></a>
    </footer>

    <MvrFixtureMapModal
      :open="mvrModalOpen"
      :result="mvrResult"
      :orbit-target="orbitTarget"
      @close="mvrModalOpen = false"
      @uploaded="onMvrUploaded"
    />
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  max-width: 640px;
  margin: 0 auto;
  padding: 24px;
  background: hsl(var(--muted) / 0.3);
}
.page-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 68px;
  margin-bottom: 8px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  font-size: 1.125rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.brand-logo { width: 32px; height: 32px; object-fit: contain; }
h2 { font-size: 1rem; font-weight: 600; margin: 0 0 16px; }
.form { display: flex; flex-direction: column; gap: 14px; }
.form label { display: flex; flex-direction: column; gap: 6px; }
.form label.check {
  flex-direction: row;
  gap: 8px;
  align-items: center;
  text-transform: none;
  font-weight: 400;
  font-size: 0.875rem;
  letter-spacing: normal;
}
.row { display: flex; gap: 12px; }
.page-footer {
  margin-top: 48px;
  padding-top: 16px;
  border-top: 1px solid hsl(var(--border));
  font-size: 0.75rem;
  text-align: center;
}
.page-footer a { margin-left: 8px; }
.ext-link { display: inline-flex; align-items: center; gap: 4px; }
.mvr-hint { font-size: 0.8125rem; margin: 0; }
.upload-progress-labels {
  display: flex;
  justify-content: space-between;
  font-size: 0.8125rem;
}
.mt-sm { margin-top: 6px; }
</style>
