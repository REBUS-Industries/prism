<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  modelsApi,
  materialsApi,
  settingsApi,
  orbitApi,
  type ModelDetail,
  type ModelMaterialSlot,
  type ModelTransform,
  type MaterialListItem,
  type ApiError,
} from '../../shared/api';
import ModelViewer from '../components/ModelViewer.vue';
import OrbitQuadPreview from '../components/OrbitQuadPreview.vue';
import ModelTransformPanel from '../components/ModelTransformPanel.vue';
import Icon from '../../shared/Icon.vue';
import { cloneModelTransform, ensureModelTransform } from '../utils/modelTransform';
import {
  modelCategoryLabel,
  modelCategorySelectOptions,
  normalizeModelCategory,
} from '../utils/modelCategories';
import {
  DEFAULT_MODEL_SOURCE_UNITS,
  MODEL_LENGTH_UNITS,
  ensureModelSourceUnits,
  type ModelLengthUnit,
} from '../utils/modelUnits';
import {
  buildOrbitModelViewerUrl,
  orbitServerBaseUrl,
  readModelOrbitRef,
} from '../utils/orbitViewerUrl';
import {
  fetchOrbitMaterialSlots,
  fetchOrbitSourceMaterialSlots,
  mergeMaterialSlots,
  buildOrbitMaterialSwapAssignments,
} from '../utils/orbitModelMeshSlots';
import {
  discoverGlbSlotNames,
  mergeMaterialSlotsWithKind,
  mergePersistedMaterialSlots,
  meshNamesFromDefinition,
  namesToMaterialSlots,
  splitPersistedMaterialSlots,
} from '../utils/modelMaterialAssignment';

const props = defineProps<{ id: string }>();
const router = useRouter();

const model = ref<ModelDetail | null>(null);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const activeTab = ref<'overview' | 'metadata' | 'materials' | 'versions'>('overview');

const name = ref('');
const category = ref('');
const tags = ref('');
const description = ref('');
const status = ref<'draft' | 'published'>('draft');

/** Editable mesh-object and source-material slot lists (merged on Save). */
const meshSlots = ref<ModelMaterialSlot[]>([]);
const sourceMaterialSlots = ref<ModelMaterialSlot[]>([]);
const materialAssignMode = ref<'mesh' | 'sourceMaterial'>('mesh');
const materials = ref<MaterialListItem[]>([]);
const slotsLoading = ref(false);
const slotsHydrated = ref(false);
const orbitSyncing = ref(false);
const orbitSyncMessage = ref<string | null>(null);
/** Root transform for preview + persistence on Save. */
const modelTransform = ref<ModelTransform>(ensureModelTransform(null));
/** Mesh vertex units (GLB coordinate space); preview scales to metres. */
const sourceUnits = ref<ModelLengthUnit>(DEFAULT_MODEL_SOURCE_UNITS);

const gizmoMode = ref<'translate' | 'rotate' | 'scale'>('translate');
const gizmoSpace = ref<'world' | 'local'>('local');

const previewUrl = computed(() => (model.value?.hasPreview ? modelsApi.previewUrl(props.id) : null));
const categoryOptions = computed(() => modelCategorySelectOptions(category.value));

const orbitSettings = ref<Record<string, string>>({});
const modelOrbitRef = computed(() => readModelOrbitRef(model.value?.definition));
const orbitViewerUrl = computed(() => {
  const ref = modelOrbitRef.value;
  if (!ref) return null;
  const serverUrl = orbitServerBaseUrl(orbitSettings.value, ref.target);
  return buildOrbitModelViewerUrl(serverUrl, ref);
});
const useOrbitViewer = computed(() => Boolean(modelOrbitRef.value));
const showLocalPreview = computed(() => !useOrbitViewer.value && Boolean(previewUrl.value));

const materialSlots = computed(() =>
  mergePersistedMaterialSlots(meshSlots.value, sourceMaterialSlots.value),
);

const activeMaterialSlots = computed(() =>
  materialAssignMode.value === 'mesh' ? meshSlots.value : sourceMaterialSlots.value,
);

const assignedMaterialCount = computed(() =>
  materialSlots.value.filter((s) => s.materialId).length,
);

const canSyncOrbitMaterials = computed(() =>
  useOrbitViewer.value && assignedMaterialCount.value > 0 && !orbitSyncing.value,
);

function applyPersistedMaterialSlots(slots: ModelMaterialSlot[]): void {
  const split = splitPersistedMaterialSlots(slots);
  meshSlots.value = split.mesh;
  sourceMaterialSlots.value = split.sourceMaterial;
  slotsHydrated.value = split.mesh.length > 0 || split.sourceMaterial.length > 0;
}

function logViewerMode(reason: string): void {
  const mode = useOrbitViewer.value ? 'orbit' : (showLocalPreview.value ? 'glb' : 'none');
  console.log('[OrbitViewer] ModelEditor viewer mode', {
    reason,
    mode,
    orbitRef: modelOrbitRef.value,
    hasPreview: Boolean(previewUrl.value),
  });
}

watch([modelOrbitRef, useOrbitViewer, showLocalPreview], () => logViewerMode('watch'));

watch(activeTab, (tab) => {
  if (tab === 'materials') void hydrateMaterialSlots();
});

async function loadMaterials(): Promise<void> {
  try {
    const res = await materialsApi.list({ limit: 500 });
    materials.value = res.materials;
  } catch {
    // Non-fatal: the picker just shows no options.
  }
}

async function hydrateMaterialSlots(): Promise<void> {
  if (slotsLoading.value) return;

  const needMesh = meshSlots.value.length === 0;
  const needSource = sourceMaterialSlots.value.length === 0;
  if (!needMesh && !needSource) {
    slotsHydrated.value = true;
    return;
  }

  const ref = modelOrbitRef.value;
  const glbUrl = previewUrl.value;
  if (!ref && !glbUrl) return;

  slotsLoading.value = true;
  try {
    if (ref) {
      const [meshDiscovered, sourceDiscovered] = await Promise.all([
        needMesh ? fetchOrbitMaterialSlots(ref) : Promise.resolve([]),
        needSource ? fetchOrbitSourceMaterialSlots(ref) : Promise.resolve([]),
      ]);
      if (needMesh && meshDiscovered.length) {
        meshSlots.value = mergeMaterialSlots(meshSlots.value, meshDiscovered);
      }
      if (needSource && sourceDiscovered.length) {
        sourceMaterialSlots.value = mergeMaterialSlots(sourceMaterialSlots.value, sourceDiscovered);
      }
    } else if (glbUrl) {
      const { meshNames, sourceMaterialNames } = await discoverGlbSlotNames(glbUrl);
      const defMeshNames = meshNamesFromDefinition(model.value?.definition);
      const mergedMeshNames = [...new Set([...defMeshNames, ...meshNames])];
      if (needMesh && mergedMeshNames.length) {
        meshSlots.value = mergeMaterialSlotsWithKind(
          meshSlots.value,
          namesToMaterialSlots(mergedMeshNames, 'mesh'),
          'mesh',
        );
      }
      if (needSource && sourceMaterialNames.length) {
        sourceMaterialSlots.value = mergeMaterialSlotsWithKind(
          sourceMaterialSlots.value,
          namesToMaterialSlots(sourceMaterialNames, 'sourceMaterial'),
          'sourceMaterial',
        );
      }
    }
  } catch {
    // Non-fatal — Materials tab keeps the empty-state message.
  } finally {
    slotsLoading.value = false;
    slotsHydrated.value = true;
  }
}

async function reload(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await modelsApi.get(props.id);
    model.value = res.model;
    name.value = res.model.name;
    category.value = normalizeModelCategory(res.model.category);
    tags.value = res.model.tags.join(', ');
    description.value = res.model.description ?? '';
    status.value = res.model.status;
    applyPersistedMaterialSlots(res.model.definition.materialSlots ?? []);
    modelTransform.value = ensureModelTransform(res.model.definition.transform);
    sourceUnits.value = ensureModelSourceUnits(res.model.definition.sourceUnits);
    logViewerMode('reload');
    if (
      (meshSlots.value.length === 0 || sourceMaterialSlots.value.length === 0)
      && (modelOrbitRef.value || previewUrl.value)
    ) {
      void hydrateMaterialSlots();
    }
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load model';
  } finally {
    loading.value = false;
  }
}

function onTransformChange(next: ModelTransform): void {
  modelTransform.value = cloneModelTransform(next);
}

async function syncOrbitMaterials(): Promise<void> {
  const ref = modelOrbitRef.value;
  if (!model.value || !ref) return;

  orbitSyncing.value = true;
  orbitSyncMessage.value = null;
  error.value = null;

  try {
    const [meshResult, sourceResult] = await Promise.all([
      buildOrbitMaterialSwapAssignments(ref, meshSlots.value, 'mesh'),
      buildOrbitMaterialSwapAssignments(ref, sourceMaterialSlots.value, 'sourceMaterial'),
    ]);
    const merged = new Map<string, typeof meshResult.assignments[0]>();
    for (const a of [...meshResult.assignments, ...sourceResult.assignments]) {
      merged.set(a.objectId, a);
    }
    const assignments = [...merged.values()];
    const unresolved = [...new Set([...meshResult.unresolved, ...sourceResult.unresolved])];

    if (unresolved.length) {
      error.value = `Could not resolve ORBIT meshes for: ${unresolved.join(', ')}`;
      return;
    }
    if (!assignments.length) {
      error.value = 'No material assignments to sync — assign PRISM materials first.';
      return;
    }

    const result = await orbitApi.materialSwapBatch({
      projectId: ref.projectId,
      modelId: ref.modelId,
      versionId: ref.versionId,
      orbitTarget: ref.target,
      message: `Model library: ${model.value.name}`,
      assignments,
    });

    const orbitMeta = {
      ...(typeof model.value.definition.metadata?.orbit === 'object'
        ? model.value.definition.metadata.orbit as Record<string, unknown>
        : {}),
      target: ref.target,
      projectId: ref.projectId,
      modelId: ref.modelId,
      versionId: result.newVersionId,
    };

    const res = await modelsApi.update(props.id, {
      definition: {
        ...model.value.definition,
        materialSlots: materialSlots.value,
        metadata: {
          ...model.value.definition.metadata,
          orbit: orbitMeta,
        },
      },
    });

    model.value = res.model;
    applyPersistedMaterialSlots(res.model.definition.materialSlots ?? []);
    orbitSyncMessage.value = `Synced ${result.appliedCount} mesh${result.appliedCount === 1 ? '' : 'es'} to ORBIT (version ${result.newVersionId.slice(0, 8)}…).`;
    await reload();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'ORBIT material sync failed';
  } finally {
    orbitSyncing.value = false;
  }
}

async function save(): Promise<void> {
  if (!model.value) return;
  saving.value = true;
  error.value = null;
  try {
    const res = await modelsApi.update(props.id, {
      name: name.value.trim(),
      category: category.value.trim() || null,
      tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      description: description.value.trim() || null,
      status: status.value,
      definition: {
        ...model.value.definition,
        materialSlots: materialSlots.value,
        transform: cloneModelTransform(modelTransform.value),
        sourceUnits: sourceUnits.value,
      },
    });
    model.value = res.model;
    applyPersistedMaterialSlots(res.model.definition.materialSlots ?? []);
    modelTransform.value = ensureModelTransform(res.model.definition.transform);
    sourceUnits.value = ensureModelSourceUnits(res.model.definition.sourceUnits);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'save failed';
  } finally {
    saving.value = false;
  }
}

async function removeModel(): Promise<void> {
  if (!model.value) return;
  if (!confirm(`Delete "${model.value.name}"?`)) return;
  try {
    await modelsApi.remove(props.id);
    void router.push({ name: 'models' });
  } catch (err) {
    error.value = (err as ApiError).message ?? 'delete failed';
  }
}

const dims = computed(() => model.value?.dimensions ?? null);

async function loadOrbitSettings(): Promise<void> {
  try {
    orbitSettings.value = (await settingsApi.list()).settings;
  } catch {
    // Non-fatal: fall back to default Orbit hostnames.
  }
}

onMounted(() => {
  void reload();
  void loadMaterials();
  void loadOrbitSettings();
});
</script>

<template>
  <div v-if="loading" class="muted">Loading…</div>
  <div v-else-if="error && !model" class="error-box">{{ error }}</div>
  <template v-else-if="model">
    <div class="page-fill model-editor">
    <header class="editor-head">
      <RouterLink :to="{ name: 'models' }" class="back muted"><Icon name="arrow_back" :size="14" /> Model library</RouterLink>
      <div class="head-main">
        <h1>{{ model.name }}</h1>
        <div class="head-actions">
          <button :disabled="saving" class="primary" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button>
          <button class="danger" @click="removeModel">Delete</button>
        </div>
      </div>
    </header>

    <nav class="tab-bar">
      <button :class="{ active: activeTab === 'overview' }" @click="activeTab = 'overview'">Overview</button>
      <button :class="{ active: activeTab === 'metadata' }" @click="activeTab = 'metadata'">Metadata</button>
      <button :class="{ active: activeTab === 'materials' }" @click="activeTab = 'materials'">Materials</button>
      <button :class="{ active: activeTab === 'versions' }" @click="activeTab = 'versions'">Versions</button>
    </nav>

    <div v-if="error" class="error-box mt">{{ error }}</div>

    <div v-if="activeTab === 'overview'" class="overview page-fill__body">
      <div class="viewer-col">
        <div v-if="showLocalPreview" class="gizmo-toolbar">
          <button type="button" class="gizmo-btn" :class="{ active: gizmoMode === 'translate' }" title="Move" @click="gizmoMode = 'translate'"><Icon name="open_with" :size="16" /></button>
          <button type="button" class="gizmo-btn" :class="{ active: gizmoMode === 'rotate' }" title="Rotate" @click="gizmoMode = 'rotate'"><Icon name="3d_rotation" :size="16" /></button>
          <button type="button" class="gizmo-btn" :class="{ active: gizmoMode === 'scale' }" title="Scale" @click="gizmoMode = 'scale'"><Icon name="zoom_out_map" :size="16" /></button>
          <span class="gizmo-sep" aria-hidden="true" />
          <button type="button" class="gizmo-btn space" :title="`Gizmo space: ${gizmoSpace}`" @click="gizmoSpace = gizmoSpace === 'local' ? 'world' : 'local'">{{ gizmoSpace === 'local' ? 'LOCAL' : 'WORLD' }}</button>
        </div>
        <div class="viewer-wrap">
          <OrbitQuadPreview
            v-if="useOrbitViewer && modelOrbitRef"
            :orbit-ref="modelOrbitRef"
            :settings="orbitSettings"
          />
          <ModelViewer
            v-else-if="showLocalPreview && previewUrl"
            :url="previewUrl"
            :model-material-slots="materialSlots"
            :transform="modelTransform"
            :source-units="sourceUnits"
            view-preset="iso"
            interactive
            light-background
            fill
            editable
            :gizmo-mode="gizmoMode"
            :gizmo-space="gizmoSpace"
            @transform-change="onTransformChange"
          />
          <div v-else class="muted no-preview">No 3D preview — import a mesh for this model.</div>
        </div>
        <p v-if="useOrbitViewer" class="muted small gizmo-hint">
          Top / Front / Side / Iso quad view — drag to orbit in the ISO pane · Shift+drag to pan · Scroll to zoom.
          Configure ORBIT URL + token in Settings if loading fails.
        </p>
        <p v-else-if="showLocalPreview" class="muted small gizmo-hint">Drag the gizmo to move / rotate / scale · numeric edits in the panel · persist with <strong>Save</strong>.</p>
      </div>
      <aside class="side-panels">
        <div class="card">
          <ModelTransformPanel v-model="modelTransform" :display-units="sourceUnits" />
        </div>
        <div class="facts card">
          <h3>Details</h3>
          <dl>
            <dt>Status</dt><dd>{{ model.status }}</dd>
            <dt>Origin</dt><dd>{{ model.origin }}</dd>
            <dt>Category</dt><dd>{{ modelCategoryLabel(model.category) }}</dd>
            <dt>Tags</dt><dd>{{ model.tags.length ? model.tags.join(', ') : '—' }}</dd>
            <dt>Meshes</dt><dd>{{ model.definition.meshes.length }}</dd>
            <dt v-if="dims">Size (m)</dt>
            <dd v-if="dims">{{ dims.length }} × {{ dims.width }} × {{ dims.height }}</dd>
            <dt>Mesh units</dt>
            <dd>{{ sourceUnits }}</dd>
            <template v-if="modelOrbitRef">
              <dt>Orbit</dt>
              <dd>
                <span class="mono">{{ modelOrbitRef.projectId }}/{{ modelOrbitRef.modelId }}</span>
                <span v-if="orbitViewerUrl">
                  · <a :href="orbitViewerUrl" target="_blank" rel="noopener noreferrer">Open</a>
                </span>
              </dd>
            </template>
          </dl>
        </div>
      </aside>
    </div>

    <section v-else-if="activeTab === 'metadata'" class="card mt page-fill__scroll">
      <label class="muted small">Name</label>
      <input v-model="name" />
      <label class="muted small mt-sm">Category</label>
      <select v-model="category">
        <option
          v-for="opt in categoryOptions"
          :key="opt.value || '__none__'"
          :value="opt.value"
        >
          {{ opt.label }}
        </option>
      </select>
      <label class="muted small mt-sm">Tags (comma-separated)</label>
      <input v-model="tags" />
      <label class="muted small mt-sm">Description</label>
      <textarea v-model="description" rows="4" />
      <label class="muted small mt-sm">Status</label>
      <select v-model="status">
        <option value="draft">draft</option>
        <option value="published">published</option>
      </select>
      <label class="muted small mt-sm">Mesh units</label>
      <select v-model="sourceUnits">
        <option v-for="u in MODEL_LENGTH_UNITS" :key="u" :value="u">{{ u }}</option>
      </select>
      <p class="muted small unit-hint">
        Units of the imported mesh vertices. The preview scales to metres for correct real-world size.
        Changing this does not alter the stored transform.
      </p>
    </section>

    <section v-else-if="activeTab === 'materials'" class="card mt page-fill__scroll">
      <h3>Materials</h3>
      <p class="muted small intro">
        Assign PRISM library materials by mesh object or by the model's existing material
        definitions. Assignments render in the GLB preview and persist on <strong>Save</strong>.
        For ORBIT-linked models, use <strong>Sync to ORBIT</strong> to upload materials and
        commit a new ORBIT version visible in the viewer.
      </p>

      <div class="orbit-sync-bar">
        <button
          type="button"
          class="primary"
          :disabled="!canSyncOrbitMaterials"
          @click="syncOrbitMaterials"
        >
          {{ orbitSyncing ? 'Syncing to ORBIT…' : 'Sync to ORBIT' }}
        </button>
        <span v-if="useOrbitViewer && assignedMaterialCount" class="muted small">
          {{ assignedMaterialCount }} assignment{{ assignedMaterialCount === 1 ? '' : 's' }} — commits one new ORBIT version
        </span>
        <span v-else-if="useOrbitViewer" class="muted small">
          Assign PRISM materials below, then sync to commit a new ORBIT version.
        </span>
        <span v-else class="muted small">
          No ORBIT link on this model — geometry is GLB preview only.
          <RouterLink :to="{ name: 'model-import' }">Re-import the file</RouterLink>
          to upload to ORBIT and enable sync.
        </span>
      </div>
      <p v-if="orbitSyncMessage" class="muted small sync-ok">{{ orbitSyncMessage }}</p>

      <nav class="assign-mode-bar">
        <button
          type="button"
          :class="{ active: materialAssignMode === 'mesh' }"
          @click="materialAssignMode = 'mesh'"
        >
          By mesh / object
        </button>
        <button
          type="button"
          :class="{ active: materialAssignMode === 'sourceMaterial' }"
          @click="materialAssignMode = 'sourceMaterial'"
        >
          By model material
        </button>
      </nav>

      <p v-if="materialAssignMode === 'mesh'" class="muted small mode-hint">
        One row per mesh part or object name. Applies to that object only.
      </p>
      <p v-else class="muted small mode-hint">
        One row per glTF or ORBIT material name. Replaces that material on every mesh that uses it.
      </p>

      <div v-if="activeMaterialSlots.length" class="slot-list">
        <div v-for="(slot, i) in activeMaterialSlots" :key="slot.name + i" class="slot-row">
          <div class="slot-meta">
            <span class="slot-name">{{ slot.name }}</span>
          </div>
          <select v-model="slot.materialId" class="mat-select">
            <option :value="null">— No material —</option>
            <option v-for="m in materials" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
        </div>
      </div>
      <p v-else-if="slotsLoading" class="muted small">
        {{ useOrbitViewer ? 'Loading from ORBIT…' : 'Scanning preview mesh…' }}
      </p>
      <p v-else-if="materialAssignMode === 'mesh' && useOrbitViewer" class="muted small">
        No assignable mesh parts found in this ORBIT model.
      </p>
      <p v-else-if="materialAssignMode === 'sourceMaterial' && useOrbitViewer" class="muted small">
        No ORBIT renderMaterial names found in this model.
      </p>
      <p v-else-if="materialAssignMode === 'mesh'" class="muted small">
        No mesh parts detected — re-import this model or open the Materials tab with a preview GLB.
      </p>
      <p v-else class="muted small">
        No model materials detected — re-import this model to capture glTF material names.
      </p>
      <p v-if="activeMaterialSlots.length && !materials.length" class="muted small">
        No materials yet — create some in <RouterLink :to="{ name: 'materials' }">Materials</RouterLink>.
      </p>
    </section>

    <section v-else class="card mt page-fill__scroll">
      <h3>Versions</h3>
      <ul class="version-list">
        <li v-for="v in model.versions" :key="v.id">
          <span class="mono">{{ v.id.slice(0, 8) }}</span>
          <span class="muted small">{{ new Date(v.createdAt).toLocaleString() }}</span>
          <span v-if="v.isActive" class="pill online">active</span>
        </li>
        <li v-if="!model.versions.length" class="muted">No versions.</li>
      </ul>
    </section>
    </div>
  </template>
</template>

<style scoped>
.model-editor { gap: 12px; }
.editor-head { margin-bottom: 0; flex-shrink: 0; }
.back { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; }
.head-main { display: flex; align-items: center; gap: 16px; margin-top: 6px; }
.head-main h1 { flex: 1; margin: 0; }
.head-actions { display: flex; gap: 8px; }
.tab-bar { display: flex; gap: 4px; border-bottom: 1px solid var(--color-border, #2a2a32); margin-bottom: 0; flex-shrink: 0; }
.tab-bar button { background: none; border: none; padding: 8px 14px; cursor: pointer; color: inherit; border-bottom: 2px solid transparent; }
.tab-bar button.active { border-bottom-color: var(--accent, #ff8800); font-weight: 600; }
.overview { display: grid; grid-template-columns: 1fr 300px; gap: 16px; min-height: 0; }
.viewer-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.viewer-wrap { flex: 1; min-height: 0; border-radius: 10px; overflow: hidden; background: var(--surface-2, #1a1a1f); }
.no-preview { display: flex; align-items: center; justify-content: center; height: 100%; }
.side-panels { display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow-y: auto; }
.facts dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; }
.facts dt { color: var(--color-text-muted, #888); }
.facts h3 { margin: 0 0 8px; font-size: 14px; }
.gizmo-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--surface-2, #1a1a1f);
  border: 1px solid var(--color-border, #2a2a32);
}
.gizmo-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-muted, #9aa0a6);
  cursor: pointer;
}
.gizmo-btn:hover { background: var(--color-bg-hover, #2a2a32); color: inherit; }
.gizmo-btn.active { background: var(--orbit-primary, #ff8800); color: #fff; }
.gizmo-btn.space { font-family: var(--font-mono, monospace); min-width: 52px; width: auto; padding: 0 8px; font-size: 11px; }
.gizmo-sep { width: 1px; height: 18px; background: var(--color-border, #2a2a32); margin: 0 2px; }
.gizmo-hint { margin: 8px 0 0; }
.version-list { list-style: none; padding: 0; margin: 0; }
.version-list li { display: flex; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--color-border, #2a2a32); }
.intro { margin: 4px 0 12px; max-width: 640px; line-height: 1.5; }
.orbit-sync-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}
.sync-ok { margin: 0 0 12px; color: var(--color-text-muted, #9aa0a6); }
.assign-mode-bar {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--color-border, #2a2a32);
}
.assign-mode-bar button {
  background: none;
  border: none;
  padding: 8px 12px;
  cursor: pointer;
  color: inherit;
  border-bottom: 2px solid transparent;
  font-size: 13px;
}
.assign-mode-bar button.active {
  border-bottom-color: var(--accent, #ff8800);
  font-weight: 600;
}
.mode-hint { margin: 0 0 12px; max-width: 640px; line-height: 1.45; }
.slot-list { display: flex; flex-direction: column; gap: 4px; }
.slot-row { display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-bottom: 1px solid var(--color-border, #2a2a32); }
.slot-row:last-child { border-bottom: none; }
.slot-meta { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.slot-name { font-weight: 600; font-size: 13px; word-break: break-word; }
.mat-select { min-width: 240px; padding: 8px 10px; border: 1px solid var(--color-border, #2a2a32); border-radius: 6px; background: var(--color-bg-input, #16161a); color: inherit; font-size: 13px; }
.unit-hint { margin: 6px 0 0; max-width: 480px; line-height: 1.45; }
.small { font-size: 12px; }
.mono { font-family: monospace; }
.pill.online { background: #1f3a23; color: #7fd18c; padding: 1px 6px; border-radius: 999px; font-size: 10px; }
</style>
