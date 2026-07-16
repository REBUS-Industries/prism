<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
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
import ModelViewer from '../components/ModelViewer.vue';
import { loadModelCategories } from '../utils/modelCategories';
import {
  DEFAULT_MODEL_SOURCE_UNITS,
  MODEL_LENGTH_UNITS,
  type ModelLengthUnit,
} from '../utils/modelUnits';

type CreateMode = 'text' | 'image';
type TaskKind = 'text' | 'image' | 'retexture' | 'remesh';
type Phase =
  | 'idle'
  | 'submitting'
  | 'polling'
  | 'preview_ready'
  | 'refining'
  | 'editing'
  | 'ready'
  | 'transferring'
  | 'failed';

type ActivityTone = 'info' | 'progress' | 'success' | 'error';
interface ActivityItem {
  id: number;
  tone: ActivityTone;
  text: string;
  at: number;
}

const router = useRouter();
const mode = ref<CreateMode>('text');
const configured = ref<boolean | null>(null);
const phase = ref<Phase>('idle');
const error = ref<string | null>(null);
const progressLabel = ref<string | null>(null);
const progressPct = ref(0);

const prompt = ref('');
const enablePbr = ref(true);
/** Off by default so the preview mesh appears in the viewer before texturing. */
const autoRefine = ref(false);

const imageFile = ref<File | null>(null);
const imagePreviewUrl = ref<string | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);

const taskId = ref<string | null>(null);
const previewTaskId = ref<string | null>(null);
/** Latest succeeded Meshy task id (input for refine / retexture / remesh). */
const sourceTaskId = ref<string | null>(null);
const taskKind = ref<TaskKind>('text');
const task = ref<MeshyTask | null>(null);

const texturePrompt = ref('');
const remeshTopology = ref<'triangle' | 'quad'>('triangle');
const remeshPolycount = ref(30000);

const name = ref('');
const category = ref('');
const tags = ref('meshy');
const sourceUnits = ref<ModelLengthUnit>(DEFAULT_MODEL_SOURCE_UNITS);
const categoryOptions = ref<ModelCategoryOption[]>([]);

const viewerUrl = ref<string | null>(null);
const viewerLoading = ref(false);
const activity = ref<ActivityItem[]>([]);
const activityListEl = ref<HTMLElement | null>(null);
let activitySeq = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let viewerLoadToken = 0;

const busy = computed(() =>
  phase.value === 'submitting'
  || phase.value === 'polling'
  || phase.value === 'refining'
  || phase.value === 'editing'
  || phase.value === 'transferring',
);

const canGenerate = computed(() => {
  if (configured.value === false) return false;
  if (busy.value) return false;
  if (mode.value === 'text') return prompt.value.trim().length > 0;
  return !!imageFile.value;
});

const glbUrl = computed(() => task.value?.model_urls?.glb ?? null);
const canEdit = computed(() =>
  !!sourceTaskId.value
  && !!glbUrl.value
  && (phase.value === 'preview_ready' || phase.value === 'ready'),
);
const canTransfer = computed(() =>
  (phase.value === 'preview_ready' || phase.value === 'ready') && !!glbUrl.value,
);
const phaseLabel = computed(() => {
  switch (phase.value) {
    case 'idle': return 'Ready';
    case 'submitting': return 'Submitting';
    case 'polling': return 'Generating';
    case 'preview_ready': return 'Preview ready';
    case 'refining': return 'Texturing';
    case 'editing': return 'Updating mesh';
    case 'ready': return 'Ready';
    case 'transferring': return 'Importing';
    case 'failed': return 'Failed';
    default: return phase.value;
  }
});

function logActivity(text: string, tone: ActivityTone = 'info'): void {
  activity.value.push({ id: ++activitySeq, tone, text, at: Date.now() });
  void nextTick(() => {
    const el = activityListEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function revokeViewerUrl(): void {
  if (viewerUrl.value) {
    URL.revokeObjectURL(viewerUrl.value);
    viewerUrl.value = null;
  }
}

function resetResult(keepActivity = false): void {
  stopPolling();
  taskId.value = null;
  previewTaskId.value = null;
  sourceTaskId.value = null;
  task.value = null;
  progressPct.value = 0;
  progressLabel.value = null;
  revokeViewerUrl();
  viewerLoading.value = false;
  if (!keepActivity) activity.value = [];
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

async function fetchTask(kind: TaskKind, id: string): Promise<MeshyTask> {
  switch (kind) {
    case 'text': return meshyApi.getTextTo3d(id);
    case 'image': return meshyApi.getImageTo3d(id);
    case 'retexture': return meshyApi.getRetexture(id);
    case 'remesh': return meshyApi.getRemesh(id);
  }
}

function statusLabel(kind: TaskKind, status: string, pct: number): string {
  if (status === 'PENDING') {
    if (kind === 'retexture') return 'Retexture queued at Meshy…';
    if (kind === 'remesh') return 'Remesh queued at Meshy…';
    return 'Queued at Meshy…';
  }
  if (status === 'IN_PROGRESS') {
    if (kind === 'retexture') return `Retexturing… ${pct}%`;
    if (kind === 'remesh') return `Remeshing… ${pct}%`;
    if (phase.value === 'refining') return `Adding textures… ${pct}%`;
    return `Generating mesh… ${pct}%`;
  }
  return status;
}

async function pollTask(
  kind: TaskKind,
  id: string,
  onDone: (t: MeshyTask) => Promise<void> | void,
): Promise<void> {
  stopPolling();
  taskKind.value = kind;
  if (kind === 'retexture' || kind === 'remesh') phase.value = 'editing';
  else if (phase.value !== 'refining') phase.value = 'polling';

  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const t = await fetchTask(kind, id);
        task.value = t;
        progressPct.value = typeof t.progress === 'number' ? t.progress : progressPct.value;
        const label = statusLabel(kind, t.status, progressPct.value);
        progressLabel.value = label;

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
          logActivity(error.value, 'error');
          reject(new Error(error.value));
        }
      } catch (err) {
        stopPolling();
        phase.value = 'failed';
        error.value = (err as ApiError).message ?? 'Failed to poll Meshy task';
        logActivity(error.value, 'error');
        reject(err);
      }
    };

    void tick();
    pollTimer = setInterval(() => { void tick(); }, 3500);
  });
}

/** glTF binary magic (`glTF`) — reject HTML/error bodies saved as .glb. */
async function assertGlbBlob(blob: Blob): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const magic = String.fromCharCode(head[0]!, head[1]!, head[2]!, head[3]!);
  if (magic !== 'glTF') {
    throw new Error(
      `Meshy download was not a GLB (got magic "${magic || '????'}", ${blob.size} bytes). `
      + 'The signed URL may have expired — regenerate, then try again.',
    );
  }
  if (blob.size < 64) {
    throw new Error(`Meshy GLB download is too small (${blob.size} bytes)`);
  }
  return blob;
}

async function loadViewerFromGlb(url: string): Promise<void> {
  const token = ++viewerLoadToken;
  viewerLoading.value = true;
  logActivity('Loading GLB into viewer…', 'progress');
  try {
    const blob = await assertGlbBlob(await meshyApi.download(url));
    if (token !== viewerLoadToken) return;
    revokeViewerUrl();
    viewerUrl.value = URL.createObjectURL(blob);
    logActivity('3D preview updated', 'success');
  } catch (err) {
    if (token !== viewerLoadToken) return;
    const msg = (err as ApiError).message ?? (err instanceof Error ? err.message : 'Failed to load GLB');
    logActivity(msg, 'error');
  } finally {
    if (token === viewerLoadToken) viewerLoading.value = false;
  }
}

watch(glbUrl, (url) => {
  if (url) void loadViewerFromGlb(url);
});

async function markMeshReady(t: MeshyTask, asPreview: boolean): Promise<void> {
  sourceTaskId.value = t.id;
  taskId.value = t.id;
  phase.value = asPreview ? 'preview_ready' : 'ready';
  progressPct.value = 100;
  progressLabel.value = asPreview
    ? 'Preview mesh ready — refine, retexture, remesh, or transfer'
    : 'Model ready — edit further or transfer to the library';
  logActivity(progressLabel.value, 'success');
}

async function startGenerate(): Promise<void> {
  if (!canGenerate.value) return;
  error.value = null;
  resetResult();
  phase.value = 'submitting';
  progressLabel.value = 'Submitting to Meshy…';
  logActivity(
    mode.value === 'text'
      ? `Text to 3D: “${prompt.value.trim().slice(0, 120)}${prompt.value.trim().length > 120 ? '…' : ''}”`
      : `Image to 3D: ${imageFile.value?.name ?? 'image'}`,
    'info',
  );
  logActivity('Submitting task to Meshy…', 'progress');

  try {
    if (mode.value === 'text') {
      if (!name.value.trim()) name.value = prompt.value.trim().slice(0, 80);
      const created = await meshyApi.createTextTo3d({
        mode: 'preview',
        prompt: prompt.value.trim(),
        should_remesh: true,
      });
      taskId.value = created.result;
      previewTaskId.value = created.result;
      logActivity(`Preview task ${created.result.slice(0, 8)}… started`, 'info');
      await pollTask('text', created.result, async (t) => {
        if (autoRefine.value) {
          logActivity('Preview complete — starting refine (textures)…', 'progress');
          phase.value = 'refining';
          progressLabel.value = 'Preview ready — starting refine…';
          // Show untextured mesh while refine runs.
          sourceTaskId.value = t.id;
          const refine = await meshyApi.createTextTo3d({
            mode: 'refine',
            preview_task_id: t.id,
            enable_pbr: enablePbr.value,
            ...(texturePrompt.value.trim()
              ? { texture_prompt: texturePrompt.value.trim() }
              : {}),
          });
          taskId.value = refine.result;
          logActivity(`Refine task ${refine.result.slice(0, 8)}… started`, 'info');
          await pollTask('text', refine.result, async (rt) => {
            await markMeshReady(rt, false);
          });
        } else {
          await markMeshReady(t, true);
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
      logActivity(`Image task ${created.result.slice(0, 8)}… started`, 'info');
      await pollTask('image', created.result, async (t) => {
        await markMeshReady(t, false);
      });
    }
  } catch (err) {
    phase.value = 'failed';
    error.value = (err as ApiError).message ?? 'Meshy generation failed';
    logActivity(error.value, 'error');
  }
}

async function startRefine(): Promise<void> {
  const previewId = previewTaskId.value || sourceTaskId.value;
  if (!previewId) return;
  error.value = null;
  phase.value = 'refining';
  progressLabel.value = 'Starting refine (texture)…';
  logActivity(
    texturePrompt.value.trim()
      ? `Refine with texture prompt: “${texturePrompt.value.trim().slice(0, 80)}”`
      : 'Refine — adding textures to preview mesh…',
    'progress',
  );
  try {
    const refine = await meshyApi.createTextTo3d({
      mode: 'refine',
      preview_task_id: previewId,
      enable_pbr: enablePbr.value,
      ...(texturePrompt.value.trim()
        ? { texture_prompt: texturePrompt.value.trim() }
        : {}),
    });
    taskId.value = refine.result;
    logActivity(`Refine task ${refine.result.slice(0, 8)}… started`, 'info');
    await pollTask('text', refine.result, async (t) => {
      await markMeshReady(t, false);
    });
  } catch (err) {
    phase.value = sourceTaskId.value ? 'preview_ready' : 'failed';
    error.value = (err as ApiError).message ?? 'Refine failed';
    logActivity(error.value, 'error');
  }
}

async function startRetexture(): Promise<void> {
  if (!sourceTaskId.value || !texturePrompt.value.trim()) return;
  error.value = null;
  phase.value = 'editing';
  progressLabel.value = 'Starting retexture…';
  logActivity(`Retexture: “${texturePrompt.value.trim().slice(0, 100)}”`, 'progress');
  try {
    const created = await meshyApi.createRetexture({
      input_task_id: sourceTaskId.value,
      text_style_prompt: texturePrompt.value.trim(),
      enable_pbr: enablePbr.value,
      enable_original_uv: true,
      target_formats: ['glb'],
    });
    taskId.value = created.result;
    logActivity(`Retexture task ${created.result.slice(0, 8)}… started`, 'info');
    await pollTask('retexture', created.result, async (t) => {
      await markMeshReady(t, false);
    });
  } catch (err) {
    phase.value = 'ready';
    error.value = (err as ApiError).message ?? 'Retexture failed';
    logActivity(error.value, 'error');
  }
}

async function startRemesh(): Promise<void> {
  if (!sourceTaskId.value) return;
  error.value = null;
  phase.value = 'editing';
  progressLabel.value = 'Starting remesh…';
  logActivity(
    `Remesh (${remeshTopology.value}, ~${remeshPolycount.value.toLocaleString()} polys)…`,
    'progress',
  );
  try {
    const created = await meshyApi.createRemesh({
      input_task_id: sourceTaskId.value,
      topology: remeshTopology.value,
      target_polycount: remeshPolycount.value,
      target_formats: ['glb'],
    });
    taskId.value = created.result;
    logActivity(`Remesh task ${created.result.slice(0, 8)}… started`, 'info');
    await pollTask('remesh', created.result, async (t) => {
      // Remesh may clear preview lineage for refine; keep previewTaskId if set.
      await markMeshReady(t, false);
    });
  } catch (err) {
    phase.value = previewTaskId.value && !task.value?.model_urls?.glb ? 'preview_ready' : 'ready';
    error.value = (err as ApiError).message ?? 'Remesh failed';
    logActivity(error.value, 'error');
  }
}

async function pollImport(modelId: string): Promise<void> {
  stopPolling();
  let lastImportLabel = '';
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
          const label = status === 'converting'
            ? 'Converting via PRISM pipeline and uploading to Orbit…'
            : 'Waiting for conversion…';
          progressLabel.value = label;
          if (label !== lastImportLabel) {
            lastImportLabel = label;
            logActivity(label, 'progress');
          }
        }
      } catch (err) {
        stopPolling();
        reject(err);
      }
    }, 3000);
  });
}

async function transferToLibrary(): Promise<void> {
  if (!glbUrl.value) return;
  phase.value = 'transferring';
  error.value = null;
  progressLabel.value = 'Downloading GLB from Meshy…';
  logActivity('Transfer: downloading GLB from Meshy…', 'progress');
  try {
    const blob = await assertGlbBlob(await meshyApi.download(glbUrl.value));
    const fileName = `${(name.value || 'meshy-model').replace(/[^\w.-]+/g, '_').slice(0, 80)}.glb`;
    const file = new File([blob], fileName, { type: 'model/gltf-binary' });
    progressLabel.value = 'Uploading to Model Library convert pipeline…';
    logActivity('Uploading to Model Library convert pipeline…', 'progress');
    const res = await modelsApi.import(file, {
      name: name.value.trim() || undefined,
      category: category.value || undefined,
      tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      sourceUnits: sourceUnits.value,
    });
    if (res.importStatus === 'converting' || res.jobId) {
      progressLabel.value = 'Converting via PRISM pipeline (assimp → Rhino → Orbit)…';
      logActivity('Converting via PRISM pipeline (assimp → Rhino → Orbit)…', 'progress');
      await pollImport(res.model.id);
    }
    logActivity('Imported — opening model editor', 'success');
    void router.push({ name: 'model-editor', params: { id: res.model.id } });
  } catch (err) {
    // Keep the mesh transferable after a failed import attempt.
    phase.value = glbUrl.value
      ? (previewTaskId.value && sourceTaskId.value === previewTaskId.value ? 'preview_ready' : 'ready')
      : 'failed';
    error.value = (err as ApiError).message ?? (err instanceof Error ? err.message : 'Transfer to library failed');
    progressLabel.value = null;
    logActivity(error.value, 'error');
  } finally {
    stopPolling();
  }
}

onMounted(async () => {
  void loadModelCategories().then((opts) => { categoryOptions.value = opts; });
  try {
    const s = await meshyApi.status();
    configured.value = s.configured;
    if (!s.configured) logActivity('Meshy API key missing — configure it in Settings.', 'error');
    else logActivity('Meshy connected. Describe a model or drop an image to generate.', 'info');
  } catch {
    configured.value = false;
    logActivity('Could not reach Meshy status endpoint.', 'error');
  }
});

onUnmounted(() => {
  stopPolling();
  revokeViewerUrl();
  if (imagePreviewUrl.value) URL.revokeObjectURL(imagePreviewUrl.value);
});
</script>

<template>
  <div class="create-page">
    <div class="h-row create-top">
      <RouterLink :to="{ name: 'models' }" class="muted back-link">
        <Icon name="arrow_back" :size="14" /> Model library
      </RouterLink>
      <h1 class="flex-1">Create model</h1>
      <span class="pill phase-pill" :class="{ online: phase === 'ready' || phase === 'preview_ready' }">
        {{ phaseLabel }}
      </span>
    </div>

    <div v-if="configured === false" class="error-box mt">
      Meshy API key is not configured.
      <RouterLink :to="{ name: 'settings' }">Open Settings → Meshy</RouterLink>
      to add your key, then return here.
    </div>

    <div class="create-shell" :class="{ 'has-mesh': !!viewerUrl || busy }">
      <aside class="create-sidebar">
        <div class="mode-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            :class="{ active: mode === 'text' }"
            :disabled="busy"
            @click="onModeChange('text')"
          >
            <Icon name="edit_note" :size="16" /> Text to 3D
          </button>
          <button
            type="button"
            role="tab"
            :class="{ active: mode === 'image' }"
            :disabled="busy"
            @click="onModeChange('image')"
          >
            <Icon name="image" :size="16" /> Image to 3D
          </button>
        </div>

        <section class="panel">
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
        </section>

        <section v-if="mode === 'text'" class="panel">
          <h3 class="section-label">Prompt</h3>
          <label class="field field--wide">
            <span class="field-label">Describe the model</span>
            <textarea
              v-model="prompt"
              rows="4"
              maxlength="600"
              placeholder="e.g. a koi fish with scales in the style of a Fabergé egg"
              :disabled="busy"
            />
          </label>
          <div class="options-row">
            <label class="check">
              <input v-model="autoRefine" type="checkbox" :disabled="busy" />
              Auto-refine after preview
            </label>
            <label class="check">
              <input v-model="enablePbr" type="checkbox" :disabled="busy" />
              PBR maps
            </label>
          </div>
        </section>

        <section v-else class="panel">
          <h3 class="section-label">Source image</h3>
          <div
            class="dropzone"
            :class="{ 'has-file': imageFile }"
            @click="!busy && imageInput?.click()"
          >
            <input
              ref="imageInput"
              type="file"
              accept=".jpg,.jpeg,.png,image/jpeg,image/png"
              style="display: none"
              :disabled="busy"
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
            <input v-model="enablePbr" type="checkbox" :disabled="busy" />
            Enable PBR maps
          </label>
        </section>

        <div class="create-actions">
          <button class="primary" :disabled="!canGenerate" @click="startGenerate">
            <Icon name="auto_awesome" :size="16" />
            {{ busy && phase !== 'transferring' ? 'Working…' : 'Generate with Meshy' }}
          </button>
        </div>

        <section v-if="sourceTaskId" class="panel edit-panel">
          <h3 class="section-label">Edit mesh</h3>
          <p class="muted small edit-hint">
            Change textures or topology on the current Meshy task, then transfer when you’re happy.
          </p>
          <label class="field field--wide">
            <span class="field-label">Texture / style prompt</span>
            <textarea
              v-model="texturePrompt"
              rows="3"
              maxlength="600"
              placeholder="e.g. enamelled gold Fabergé scales, jewel tones, polished metal"
              :disabled="busy"
            />
          </label>
          <div class="edit-actions">
            <button
              v-if="previewTaskId"
              :disabled="!canEdit"
              @click="startRefine"
            >
              <Icon name="brush" :size="16" /> Refine (texture)
            </button>
            <button
              :disabled="!canEdit || !texturePrompt.trim()"
              @click="startRetexture"
            >
              <Icon name="palette" :size="16" /> Retexture
            </button>
          </div>
          <div class="remesh-row">
            <label class="field">
              <span class="field-label">Topology</span>
              <select v-model="remeshTopology" :disabled="busy">
                <option value="triangle">Triangle</option>
                <option value="quad">Quad</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">Target polys</span>
              <input
                v-model.number="remeshPolycount"
                type="number"
                min="100"
                max="300000"
                step="1000"
                :disabled="busy"
              />
            </label>
            <button class="remesh-btn" :disabled="!canEdit" @click="startRemesh">
              <Icon name="tune" :size="16" /> Remesh
            </button>
          </div>
        </section>

        <section class="panel activity-panel">
          <h3 class="section-label">Activity</h3>
          <div ref="activityListEl" class="activity-list" aria-live="polite">
            <div
              v-for="item in activity"
              :key="item.id"
              class="activity-item"
              :class="item.tone"
            >
              <Icon
                :name="item.tone === 'error' ? 'error'
                  : item.tone === 'success' ? 'check_circle'
                    : item.tone === 'progress' ? 'hourglass_empty'
                      : 'info'"
                :size="14"
              />
              <span>{{ item.text }}</span>
            </div>
            <p v-if="!activity.length" class="muted small">Steps will appear here as Meshy works.</p>
          </div>
          <div v-if="progressLabel && busy" class="progress-bar-wrap">
            <div class="progress-bar" :style="{ width: `${Math.min(100, Math.max(4, progressPct))}%` }" />
            <span class="progress-caption">{{ progressLabel }} · {{ progressPct }}%</span>
          </div>
        </section>

        <div v-if="canTransfer" class="transfer-block">
          <button
            class="primary transfer-btn"
            :disabled="phase === 'transferring'"
            @click="transferToLibrary"
          >
            <Icon name="download" :size="16" />
            {{ phase === 'transferring' ? 'Transferring…' : 'Transfer to Model Library' }}
          </button>
          <p class="muted small transfer-hint">
            Downloads the GLB, runs the PRISM convert pipeline, and publishes into the Orbit Model Library project.
          </p>
        </div>

        <div v-if="error" class="error-box">{{ error }}</div>
      </aside>

      <main class="viewer-pane">
        <div v-if="viewerUrl" class="viewer-stage">
          <ModelViewer
            :url="viewerUrl"
            :source-units="sourceUnits"
            :editable="false"
            :interactive="true"
            :fill="true"
            light-background
          />
          <div v-if="viewerLoading" class="viewer-overlay">
            <Icon name="hourglass_empty" :size="18" />
            Loading mesh…
          </div>
          <div class="viewer-badge">
            <span class="pill" :class="{ online: !!glbUrl && !busy }">
              {{ task?.status ?? 'VIEWING' }}
            </span>
            <span v-if="taskId" class="muted small task-id">{{ taskId }}</span>
          </div>
        </div>
        <div v-else class="viewer-empty">
          <div class="viewer-empty-inner">
            <Icon name="view_in_ar" :size="40" class="viewer-empty-icon" />
            <h2>3D preview</h2>
            <p class="muted">
              Generate a mesh to inspect it here — orbit to rotate.
              Refine, retexture, or remesh before transferring to the library.
            </p>
            <div v-if="busy" class="viewer-empty-progress">
              <div class="progress-bar-wrap">
                <div class="progress-bar" :style="{ width: `${Math.min(100, Math.max(8, progressPct || 12))}%` }" />
              </div>
              <span class="muted small">{{ progressLabel || 'Working…' }}</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.create-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: calc(100vh - 120px);
}

.create-top {
  align-items: center;
}

.phase-pill {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 11px;
}

.create-shell {
  display: grid;
  grid-template-columns: minmax(320px, 400px) minmax(0, 1fr);
  gap: 16px;
  flex: 1;
  min-height: 560px;
  align-items: stretch;
}

.create-sidebar {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  max-height: calc(100vh - 160px);
  overflow: auto;
  padding-right: 4px;
}

.viewer-pane {
  min-width: 0;
  min-height: 480px;
  border: 1px solid var(--color-border, #2a2a32);
  border-radius: 12px;
  overflow: hidden;
  background:
    radial-gradient(ellipse at 30% 20%, color-mix(in srgb, var(--color-accent, #6ea8fe) 10%, transparent), transparent 55%),
    linear-gradient(160deg, #eef1f5 0%, #d9dee6 100%);
  position: relative;
}

.viewer-stage,
.viewer-empty {
  position: absolute;
  inset: 0;
}

.viewer-stage {
  display: flex;
}

.viewer-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: color-mix(in srgb, #fff 55%, transparent);
  color: #222;
  font-size: 13px;
  pointer-events: none;
  z-index: 2;
}

.viewer-badge {
  position: absolute;
  top: 12px;
  left: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 2;
  max-width: calc(100% - 24px);
}

.task-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: color-mix(in srgb, #fff 75%, transparent);
  padding: 2px 8px;
  border-radius: 999px;
}

.viewer-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}

.viewer-empty-inner {
  max-width: 360px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.viewer-empty-inner h2 {
  margin: 0;
  font-size: 1.25rem;
}

.viewer-empty-inner p {
  margin: 0;
}

.viewer-empty-icon {
  opacity: 0.45;
}

.viewer-empty-progress {
  width: 100%;
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mode-tabs {
  display: flex;
  gap: 8px;
}

.mode-tabs button {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.mode-tabs button.active {
  border-color: var(--color-accent, #6ea8fe);
  background: color-mix(in srgb, var(--color-accent, #6ea8fe) 12%, transparent);
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--color-border, #2a2a32);
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-bg, #111) 92%, #1a1a22);
}

.section-label {
  margin: 0;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.7;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
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
  min-height: 88px;
  font: inherit;
}

.options-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
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
  padding: 22px 14px;
  text-align: center;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.dropzone.has-file {
  padding: 10px;
}

.dropzone-icon {
  opacity: 0.55;
}

.image-preview {
  max-height: 160px;
  max-width: 100%;
  object-fit: contain;
  border-radius: 6px;
}

.create-actions,
.edit-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.create-actions .primary {
  width: 100%;
  justify-content: center;
}

.edit-hint {
  margin: 0;
}

.remesh-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 8px;
  align-items: end;
}

.remesh-btn {
  white-space: nowrap;
}

.activity-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 180px;
  overflow: auto;
  padding-right: 2px;
}

.activity-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.35;
  opacity: 0.92;
}

.activity-item.success { color: color-mix(in srgb, #3dd68c 80%, currentColor); }
.activity-item.error { color: color-mix(in srgb, #ff6b6b 85%, currentColor); }
.activity-item.progress { opacity: 1; }

.progress-bar-wrap {
  position: relative;
  height: 22px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-border, #2a2a32) 70%, transparent);
  overflow: hidden;
}

.progress-bar {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, #d9773a, #e8a35a);
  transition: width 0.35s ease;
}

.progress-caption {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  padding: 0 8px;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  z-index: 1;
}

.transfer-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 8px;
}

.transfer-btn {
  width: 100%;
  justify-content: center;
}

.transfer-hint {
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

@media (max-width: 960px) {
  .create-shell {
    grid-template-columns: 1fr;
    min-height: 0;
  }

  .create-sidebar {
    max-height: none;
  }

  .viewer-pane {
    min-height: 420px;
    order: -1;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }

  .remesh-row {
    grid-template-columns: 1fr 1fr;
  }

  .remesh-btn {
    grid-column: 1 / -1;
  }
}
</style>
