<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  modelsApi,
  materialsApi,
  type ModelDetail,
  type ModelMaterialSlot,
  type MaterialListItem,
  type ApiError,
} from '../../shared/api';
import FixtureViewer from '../components/FixtureViewer.vue';
import Icon from '../../shared/Icon.vue';

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

/** Editable copy of the model's material slots (drives the preview + Save). */
const materialSlots = ref<ModelMaterialSlot[]>([]);
const materials = ref<MaterialListItem[]>([]);

const previewUrl = computed(() => (model.value?.hasPreview ? modelsApi.previewUrl(props.id) : null));

async function loadMaterials(): Promise<void> {
  try {
    const res = await materialsApi.list({ limit: 500 });
    materials.value = res.materials;
  } catch {
    // Non-fatal: the picker just shows no options.
  }
}

async function reload(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await modelsApi.get(props.id);
    model.value = res.model;
    name.value = res.model.name;
    category.value = res.model.category ?? '';
    tags.value = res.model.tags.join(', ');
    description.value = res.model.description ?? '';
    status.value = res.model.status;
    materialSlots.value = (res.model.definition.materialSlots ?? []).map((s) => ({
      name: s.name,
      materialId: s.materialId ?? null,
    }));
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load model';
  } finally {
    loading.value = false;
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
      definition: { ...model.value.definition, materialSlots: materialSlots.value },
    });
    model.value = res.model;
    materialSlots.value = (res.model.definition.materialSlots ?? []).map((s) => ({
      name: s.name,
      materialId: s.materialId ?? null,
    }));
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

onMounted(() => {
  void reload();
  void loadMaterials();
});
</script>

<template>
  <div v-if="loading" class="muted">Loading…</div>
  <div v-else-if="error && !model" class="error-box">{{ error }}</div>
  <template v-else-if="model">
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

    <div v-if="activeTab === 'overview'" class="overview">
      <div class="viewer-wrap">
        <FixtureViewer v-if="previewUrl" :url="previewUrl" :model-material-slots="materialSlots" view-preset="iso" interactive light-background fill />
        <div v-else class="muted no-preview">No 3D preview — import a mesh for this model.</div>
      </div>
      <aside class="facts card">
        <h3>Details</h3>
        <dl>
          <dt>Status</dt><dd>{{ model.status }}</dd>
          <dt>Origin</dt><dd>{{ model.origin }}</dd>
          <dt>Category</dt><dd>{{ model.category ?? '—' }}</dd>
          <dt>Tags</dt><dd>{{ model.tags.length ? model.tags.join(', ') : '—' }}</dd>
          <dt>Meshes</dt><dd>{{ model.definition.meshes.length }}</dd>
          <dt v-if="dims">Size (m)</dt>
          <dd v-if="dims">{{ dims.length }} × {{ dims.width }} × {{ dims.height }}</dd>
        </dl>
      </aside>
    </div>

    <section v-else-if="activeTab === 'metadata'" class="card mt">
      <label class="muted small">Name</label>
      <input v-model="name" />
      <label class="muted small mt-sm">Category</label>
      <input v-model="category" placeholder="e.g. Truss, Speaker, Prop" />
      <label class="muted small mt-sm">Tags (comma-separated)</label>
      <input v-model="tags" />
      <label class="muted small mt-sm">Description</label>
      <textarea v-model="description" rows="4" />
      <label class="muted small mt-sm">Status</label>
      <select v-model="status">
        <option value="draft">draft</option>
        <option value="published">published</option>
      </select>
    </section>

    <section v-else-if="activeTab === 'materials'" class="card mt">
      <h3>Materials</h3>
      <p class="muted small intro">
        Assign a PRISM material to each slot detected in the mesh. Assignments render in the
        preview and persist on <strong>Save</strong>.
      </p>
      <div v-if="materialSlots.length" class="slot-list">
        <div v-for="(slot, i) in materialSlots" :key="slot.name + i" class="slot-row">
          <div class="slot-meta">
            <span class="slot-name">{{ slot.name }}</span>
          </div>
          <select v-model="slot.materialId" class="mat-select">
            <option :value="null">— No material —</option>
            <option v-for="m in materials" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
        </div>
      </div>
      <p v-else class="muted small">
        No material slots — re-import this model to detect slots from the mesh.
      </p>
      <p v-if="materialSlots.length && !materials.length" class="muted small">
        No materials yet — create some in <RouterLink :to="{ name: 'materials' }">Materials</RouterLink>.
      </p>
    </section>

    <section v-else class="card mt">
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
  </template>
</template>

<style scoped>
.editor-head { margin-bottom: 12px; }
.back { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; }
.head-main { display: flex; align-items: center; gap: 16px; margin-top: 6px; }
.head-main h1 { flex: 1; margin: 0; }
.head-actions { display: flex; gap: 8px; }
.tab-bar { display: flex; gap: 4px; border-bottom: 1px solid var(--color-border, #2a2a32); margin-bottom: 12px; }
.tab-bar button { background: none; border: none; padding: 8px 14px; cursor: pointer; color: inherit; border-bottom: 2px solid transparent; }
.tab-bar button.active { border-bottom-color: var(--accent, #ff8800); font-weight: 600; }
.overview { display: grid; grid-template-columns: 1fr 280px; gap: 16px; }
.viewer-wrap { height: 60vh; min-height: 360px; border-radius: 10px; overflow: hidden; background: var(--surface-2, #1a1a1f); }
.no-preview { display: flex; align-items: center; justify-content: center; height: 100%; }
.facts dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; }
.facts dt { color: var(--color-text-muted, #888); }
.version-list { list-style: none; padding: 0; margin: 0; }
.version-list li { display: flex; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--color-border, #2a2a32); }
.intro { margin: 4px 0 12px; max-width: 640px; line-height: 1.5; }
.slot-list { display: flex; flex-direction: column; gap: 4px; }
.slot-row { display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-bottom: 1px solid var(--color-border, #2a2a32); }
.slot-row:last-child { border-bottom: none; }
.slot-meta { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.slot-name { font-weight: 600; font-size: 13px; word-break: break-word; }
.mat-select { min-width: 240px; padding: 8px 10px; border: 1px solid var(--color-border, #2a2a32); border-radius: 6px; background: var(--color-bg-input, #16161a); color: inherit; font-size: 13px; }
.small { font-size: 12px; }
.mono { font-family: monospace; }
.pill.online { background: #1f3a23; color: #7fd18c; padding: 1px 6px; border-radius: 999px; font-size: 10px; }
</style>
