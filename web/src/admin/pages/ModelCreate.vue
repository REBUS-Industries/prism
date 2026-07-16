<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  meshyApi,
  modelsApi,
  type ApiError,
  type MeshyTask,
  type ModelCategoryOption,
  type ModelImportStatus,
} from '../../shared/api';
import Icon from '../../shared/Icon.vue';
import { loadModelCategories } from '../utils/modelCategories';
import {
  DEFAULT_MODEL_SOURCE_UNITS,
  MODEL_LENGTH_UNITS,
  type ModelLengthUnit,
} from '../utils/modelUnits';

type CreateMode = 'text' | 'image';
type Phase =
  | 'idle'
  | 'submitting'
  | 'polling'
  | 'preview_ready'
  | 'refining'
  | 'ready'
  | 'transferring'
  | 'failed';

const router = useRouter();
const mode = ref<CreateMode>('text');
const configured = ref<boolean | null>(null);
const phase = ref<Phase>('idle');
const error = ref<string | null>(null);
const progressLabel = ref<string | null>(null);
const progressPct = ref(0);

const prompt = ref('');
const enablePbr = ref(true);
const autoRefine = ref(true);

const imageFile = ref<File | null>(null);
const imagePreviewUrl = ref<string | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);

const taskId = ref<string | null>(null);
const previewTaskId = ref<string | null>(null);
const task = ref<MeshyTask | null>(null);

const name = ref('');
const category = ref('');
const tags = ref('meshy');
const sourceUnits = ref<ModelLengthUnit>(DEFAULT_MODEL_SOURCE_UNITS);
const categoryOptions = ref<ModelCategoryOption[]>([]);

let pollTimer: ReturnType<typeof setInterval> | null = null;

const canGenerate = computed(() => {
  if (configured.value === false) return false;
  if (phase.value === 'submitting' || phase.value === 'polling' || phase.value === 'refining' || phase.value === 'transferring') {
    return false;
  }
  if (mode.value === 'text') return prompt.value.trim().length > 0;
  return !!imageFile.value;
});

const glbUrl = computed(() => task.value?.model_urls?.glb ?? null);
const thumbUrl = computed(() => task.value?.thumbnail_url ?? null);
const canTransfer = computed(() => phase.value === 'ready' && !!glbUrl.value);

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function resetResult(): void {
  stopPolling();
  taskId.value = null;
  previewTaskId.value = null;
  task.value = null;
  progressPct.value = 0;
  progressLabel.value = null;
  if (phase.value !== 'transferring') phase.value = 'idle';
}

function onModeChange(next: CreateMode): void {
  if (mode.value === next) return;
  mode.value = next;
  error.value = null;
  resetResult();
  phase.value = 'idle';
}

function applyImage(file: File): void {
  if (imagePreviewUrl.value) URL.revokeObjectURL(imagePreviewUrl.value);
  imageFile.value = file;
  imagePreviewUrl.value = URL.createObjectURL(file);
  error.value = null;
  if (!name.value) {
    name.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  }
}

function onImageChosen(ev: Event): void {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (file) applyImage(file);
}

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
}

async function pollTask(
  kind: 'text' | 'image',
  id: string,
  onDone: (t: MeshyTask) => Promise<void> | void,
): Promise<void> {
  stopPolling();
  phase.value = kind === 'text' && previewTaskId.value && id !== previewTaskId.value
    ? 'refining'
    : 'polling';

  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const t = kind === 'text'
          ? await meshyApi.getTextTo3d(id)
          : await meshyApi.getImageTo3d(id);
        task.value = t;
        progressPct.value = typeof t.progress === 'number' ? t.progress : progressPct.value;
        progressLabel.value = t.status === 'PENDING'
          ? 'Queued at Meshy…'
          : t.status === 'IN_PROGRESS'
            ? `Generating… ${progressPct.value}%`
            : t.status;

        if (t.status === 'SUCCEEDED') {
          stopPolling();
          await onDone(t);
          resolve();
          return;
        }
        if (t.status === 'FAILED' || t.status === 'CANCELED') {
          stopPolling();
          phase.value = 'failed';
          error.value = t.task_error?.message || `Meshy task ${t.status.toLowerCase()}`;
          reject(new Error(error.value));
        }
      } catch (err) {
        stopPolling();
        phase.value = 'failed';
        error.value = (err as ApiError).message ?? 'Failed to poll Meshy task';
        reject(err);
      }
    };

    void tick();
    pollTimer = setInterval(() => { void tick(); }, 4000);
  });
}

async function startGenerate(): Promise<void> {
  if (!canGenerate.value) return;
  error.value = null;
  resetResult();
  phase.value = 'submitting';
  progressLabel.value = 'Submitting to Meshy…';

  try {
    if (mode.value === 'text') {
      if (!name.value.trim()) {
        name.value = prompt.value.trim().slice(0, 80);
      }
      const created = await meshyApi.createTextTo3d({
        mode: 'preview',
        prompt: prompt.value.trim(),
        should_remesh: true,
      });
      taskId.value = created.result;
      previewTaskId.value = created.result;
      await pollTask('text', created.result, async (t) => {
        if (autoRefine.value) {
          progressLabel.value = 'Preview ready — starting refine (texture)…';
          phase.value = 'refining';
          const refine = await meshyApi.createTextTo3d({
            mode: 'refine',
            preview_task_id: t.id,
            enable_pbr: enablePbr.value,
          });
          taskId.value = refine.result;
          await pollTask('text', refine.result, () => {
            phase.value = 'ready';
            progressLabel.value = 'Textured model ready';
            progressPct.value = 100;
          });
        } else {
          phase.value = 'preview_ready';
          progressLabel.value = 'Preview mesh ready — refine to add textures, or transfer as-is';
          progressPct.value = 100;
        }
      });
    } else {
      if (!imageFile.value) return;
      const dataUri = await fileToDataUri(imageFile.value);
      const created = await meshyApi.createImageTo3d({
        image_url: dataUri,
        should_texture: true,
        enable_pbr: enablePbr.value,
      });
      taskId.value = created.result;
      await pollTask('image', created.result, () => {
        phase.value = 'ready';
        progressLabel.value = 'Model ready';
        progressPct.value = 100;
      });
    }
  } catch (err) {
    phase.value = 'failed';
    error.value = (err as ApiError).message ?? 'Meshy generation failed';
  }
}

async function startRefine(): Promise<void> {
  if (!previewTaskId.value) return;
  error.value = null;
  phase.value = 'refining';
  progressLabel.value = 'Starting refine (texture)…';
  try {
    const refine = await meshyApi.createTextTo3d({
      mode: 'refine',
      preview_task_id: previewTaskId.value,
      enable_pbr: enablePbr.value,
    });
    taskId.value = refine.result;
    await pollTask('text', refine.result, () => {
      phase.value = 'ready';
      progressLabel.value = 'Textured model ready';
      progressPct.value = 100;
    });
  } catch (err) {
    phase.value = 'failed';
    error.value = (err as ApiError).message ?? 'Refine failed';
  }
}

async function pollImport(modelId: string): Promise<void> {
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
          progressLabel.value = status === 'converting'
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

/** glTF binary magic (`glTF`) — reject HTML/error bodies saved as .glb. */
async function assertGlbBlob(blob: Blob): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const magic = String.fromCharCode(head[0]!, head[1]!, head[2]!, head[3]!);
  if (magic !== 'glTF') {
    throw new Error(
      `Meshy download was not a GLB (got magic "${magic || '????'}", ${blob.size} bytes). `
      + 'The signed URL may have expired — regenerate, then transfer again.',
    );
  }
  if (blob.size < 64) {
    throw new Error(`Meshy GLB download is too small (${blob.size} bytes)`);
  }
  return blob;
}

async function transferToLibrary(): Promise<void> {
  if (!glbUrl.value) return;
  phase.value = 'transferring';
  error.value = null;
  progressLabel.value = 'Downloading GLB from Meshy…';
  try {
    const blob = await assertGlbBlob(await meshyApi.download(glbUrl.value));
    const fileName = `${(name.value || 'meshy-model').replace(/[^\w.-]+/g, '_').slice(0, 80)}.glb`;
    const file = new File([blob], fileName, { type: 'model/gltf-binary' });
    progressLabel.value = 'Uploading to Model Library convert pipeline…';
    const res = await modelsApi.import(file, {
      name: name.value.trim() || undefined,
      category: category.value || undefined,
      tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      sourceUnits: sourceUnits.value,
    });
    if (res.importStatus === 'converting' || res.jobId) {
      progressLabel.value = 'Converting via PRISM pipeline (assimp → Rhino → Orbit)…';
      await pollImport(res.model.id);
    }
    void router.push({ name: 'model-editor', params: { id: res.model.id } });
  } catch (err) {
    phase.value = 'ready';
    error.value = (err as ApiError).message ?? (err instanceof Error ? err.message : 'Transfer to library failed');
    progressLabel.value = null;
  } finally {
    stopPolling();
  }
}

onMounted(async () => {
  void loadModelCategories().then((opts) => { categoryOptions.value = opts; });
  try {
    const s = await meshyApi.status();
    configured.value = s.configured;
  } catch {
    configured.value = false;
  }
});

onUnmounted(() => {
  stopPolling();
  if (imagePreviewUrl.value) URL.revokeObjectURL(imagePreviewUrl.value);
});
</script>

<template>
  <div class="h-row">
    <RouterLink :to="{ name: 'models' }" class="muted back-link">
      <Icon name="arrow_back" :size="14" /> Model library
    </RouterLink>
    <h1 class="flex-1">Create model</h1>
  </div>

  <div v-if="configured === false" class="error-box mt">
    Meshy API key is not configured.
    <RouterLink :to="{ name: 'settings' }">Open Settings → Meshy</RouterLink>
    to add your key, then return here.
  </div>

  <section class="card mt create-card">
    <header class="create-intro">
      <h2>Generate with Meshy</h2>
      <p class="muted small">
        Create a mesh via
        <a href="https://docs.meshy.ai/en/api/quick-start" target="_blank" rel="noopener">Meshy API</a>,
        then transfer it into the Model Library (PRISM convert pipeline → Orbit).
      </p>
    </header>

    <div class="mode-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        :class="{ active: mode === 'text' }"
        :disabled="phase === 'submitting' || phase === 'polling' || phase === 'refining' || phase === 'transferring'"
        @click="onModeChange('text')"
      >
        <Icon name="edit_note" :size="16" /> Text to 3D
      </button>
      <button
        type="button"
        role="tab"
        :class="{ active: mode === 'image' }"
        :disabled="phase === 'submitting' || phase === 'polling' || phase === 'refining' || phase === 'transferring'"
        @click="onModeChange('image')"
      >
        <Icon name="image" :size="16" /> Image to 3D
      </button>
    </div>

    <div class="create-section">
      <h3 class="section-label">Library metadata</h3>
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
        <label class="field">
          <span class="field-label">Tags</span>
          <input v-model="tags" placeholder="meshy, prop" />
        </label>
        <label class="field">
          <span class="field-label">Mesh units</span>
          <select v-model="sourceUnits">
            <option v-for="u in MODEL_LENGTH_UNITS" :key="u" :value="u">{{ u }}</option>
          </select>
        </label>
      </div>
    </div>

    <div v-if="mode === 'text'" class="create-section">
      <h3 class="section-label">Prompt</h3>
      <label class="field field--wide">
        <span class="field-label">Describe the model</span>
        <textarea
          v-model="prompt"
          rows="4"
          maxlength="600"
          placeholder="e.g. a stage clamp for a lighting pipe, dark steel, industrial"
        />
      </label>
      <div class="options-row">
        <label class="check">
          <input v-model="autoRefine" type="checkbox" />
          Auto-refine (add textures after preview)
        </label>
        <label class="check">
          <input v-model="enablePbr" type="checkbox" :disabled="!autoRefine && phase !== 'preview_ready'" />
          Enable PBR maps on refine
        </label>
      </div>
    </div>

    <div v-else class="create-section">
      <h3 class="section-label">Source image</h3>
      <div
        class="dropzone"
        :class="{ 'has-file': imageFile }"
        @click="imageInput?.click()"
      >
        <input
          ref="imageInput"
          type="file"
          accept=".jpg,.jpeg,.png,image/jpeg,image/png"
          style="display: none"
          @change="onImageChosen"
        />
        <img v-if="imagePreviewUrl" :src="imagePreviewUrl" alt="Source" class="image-preview" />
        <template v-else>
          <Icon name="add_photo_alternate" :size="28" class="dropzone-icon" />
          <strong>Choose a JPG or PNG</strong>
          <p class="muted small">Sent to Meshy as a data URI (not stored in PRISM).</p>
        </template>
      </div>
      <label class="check mt-sm">
        <input v-model="enablePbr" type="checkbox" />
        Enable PBR maps
      </label>
    </div>

    <div class="create-actions">
      <button
        class="primary"
        :disabled="!canGenerate"
        @click="startGenerate"
      >
        <Icon name="auto_awesome" :size="16" />
        {{ phase === 'submitting' || phase === 'polling' || phase === 'refining' ? 'Generating…' : 'Generate with Meshy' }}
      </button>
      <button
        v-if="phase === 'preview_ready'"
        @click="startRefine"
      >
        <Icon name="brush" :size="16" /> Refine (texture)
      </button>
    </div>

    <div v-if="progressLabel" class="info-box progress-box">
      <Icon name="hourglass_empty" :size="16" />
      <span>{{ progressLabel }}</span>
      <span v-if="progressPct > 0 && phase !== 'ready'" class="pct">{{ progressPct }}%</span>
    </div>
  </section>

  <section v-if="task && (phase === 'preview_ready' || phase === 'ready' || phase === 'transferring')" class="card mt result-card">
    <header class="result-head">
      <h2>Result</h2>
      <span class="pill" :class="phase === 'ready' || phase === 'transferring' ? 'online' : ''">{{ task.status }}</span>
    </header>
    <div class="result-body">
      <div class="thumb-wrap">
        <img v-if="thumbUrl" :src="thumbUrl" alt="Meshy thumbnail" />
        <div v-else class="thumb-empty muted">No thumbnail</div>
      </div>
      <div class="result-meta">
        <p class="muted small">Task <code>{{ task.id }}</code></p>
        <p v-if="glbUrl" class="muted small">GLB ready for library transfer</p>
        <button
          class="primary"
          :disabled="!canTransfer || phase === 'transferring'"
          @click="transferToLibrary"
        >
          <Icon name="download" :size="16" />
          {{ phase === 'transferring' ? 'Transferring…' : 'Transfer to Model Library' }}
        </button>
        <p class="muted small transfer-hint">
          Downloads the GLB, runs the PRISM convert pipeline, and publishes into the Orbit Model Library project.
        </p>
      </div>
    </div>
  </section>

  <div v-if="error" class="error-box mt">{{ error }}</div>
</template>

<style scoped>
.create-card,
.result-card {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.create-intro h2,
.result-head h2 {
  margin: 0 0 6px;
}

.create-intro p {
  margin: 0;
  max-width: 640px;
}

.mode-tabs {
  display: flex;
  gap: 8px;
}

.mode-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.mode-tabs button.active {
  border-color: var(--color-accent, #6ea8fe);
  background: color-mix(in srgb, var(--color-accent, #6ea8fe) 12%, transparent);
}

.create-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-label {
  margin: 0;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.7;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field--wide {
  grid-column: 1 / -1;
}

.field-label {
  font-size: 12px;
  opacity: 0.8;
}

.optional {
  opacity: 0.55;
  font-weight: normal;
}

textarea {
  resize: vertical;
  min-height: 96px;
  font: inherit;
}

.options-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.dropzone {
  border: 1px dashed var(--color-border, #2a2a32);
  border-radius: 8px;
  padding: 28px 16px;
  text-align: center;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.dropzone.has-file {
  padding: 12px;
}

.dropzone-icon {
  opacity: 0.55;
}

.image-preview {
  max-height: 220px;
  max-width: 100%;
  object-fit: contain;
  border-radius: 6px;
}

.create-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.progress-box {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pct {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.result-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.result-body {
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: 16px;
  align-items: start;
}

.thumb-wrap {
  aspect-ratio: 1;
  border: 1px solid var(--color-border, #2a2a32);
  border-radius: 8px;
  overflow: hidden;
  background: color-mix(in srgb, var(--color-bg, #111) 80%, #222);
  display: flex;
  align-items: center;
  justify-content: center;
}

.thumb-wrap img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb-empty {
  font-size: 12px;
}

.result-meta {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}

.transfer-hint {
  max-width: 420px;
  margin: 0;
}

.back-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 12px;
}

.mt-sm {
  margin-top: 8px;
}

@media (max-width: 640px) {
  .result-body {
    grid-template-columns: 1fr;
  }
}
</style>
