<script setup lang="ts">
/**
 * <OrbitPicker> — combobox-style selector for a project + model.
 *
 * Loads projects from /api/orbit/projects when the parent supplies a target
 * (`prod` | `dev`); when a project is chosen, loads its models. If the
 * stored ORBIT credentials are missing or rejected, gracefully falls back
 * to free-text Project ID / Model ID inputs so the convert flow still
 * works (matching the legacy 3DConvert behaviour).
 *
 * Emits the selected IDs via v-model:projectId / v-model:modelId / v-model:modelName.
 */
import { computed, ref, watch } from 'vue';
import { orbitApi, type ApiError, type OrbitModel, type OrbitProject } from './api';

const props = defineProps<{
  target:        'prod' | 'dev';
  projectId:     string;
  modelId:       string;
  modelName?:    string;
}>();

const emit = defineEmits<{
  (e: 'update:projectId', v: string): void;
  (e: 'update:modelId',   v: string): void;
  (e: 'update:modelName', v: string): void;
}>();

const projects = ref<OrbitProject[]>([]);
const models   = ref<OrbitModel[]>([]);
const loadingProjects = ref(false);
const loadingModels   = ref(false);
const projectsError   = ref<string | null>(null);
const modelsError     = ref<string | null>(null);

const manual = ref(false);   // user clicked "enter manually"
const projectFilter = ref('');
const modelFilter   = ref('');
const projectFocused = ref(false);
const modelFocused   = ref(false);

const selectedProject = computed(() => projects.value.find((p) => p.id === props.projectId));
const selectedModel   = computed(() => models.value.find((m) => m.id === props.modelId));

const filteredProjects = computed(() => {
  const q = projectFilter.value.trim().toLowerCase();
  if (!q) return projects.value;
  return projects.value.filter((p) =>
    p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
});

const filteredModels = computed(() => {
  const q = modelFilter.value.trim().toLowerCase();
  if (!q) return models.value;
  return models.value.filter((m) =>
    m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
});

async function loadProjects() {
  loadingProjects.value = true;
  projectsError.value = null;
  projects.value = [];
  try {
    const r = await orbitApi.projects(props.target);
    projects.value = r.items;
    if (!r.items.length) projectsError.value = 'no projects visible to this token';
  } catch (err) {
    const e = err as ApiError;
    projectsError.value = e.message ?? 'failed to load projects';
    if (e.status === 412) projectsError.value = `ORBIT ${props.target} not configured — set URL + token in admin Settings.`;
  } finally {
    loadingProjects.value = false;
  }
}

async function loadModels(projectId: string) {
  if (!projectId) { models.value = []; return; }
  loadingModels.value = true;
  modelsError.value = null;
  models.value = [];
  try {
    const r = await orbitApi.models(props.target, projectId);
    models.value = r.items;
  } catch (err) {
    modelsError.value = (err as ApiError).message ?? 'failed to load models';
  } finally {
    loadingModels.value = false;
  }
}

function pickProject(p: OrbitProject) {
  emit('update:projectId', p.id);
  emit('update:modelId',   '');     // reset model selection
  emit('update:modelName', '');
  projectFilter.value = '';
  projectFocused.value = false;
}

function pickModel(m: OrbitModel) {
  emit('update:modelId',   m.id);
  emit('update:modelName', m.name);
  modelFilter.value = '';
  modelFocused.value = false;
}

// Reload projects whenever target flips (or on mount).
watch(() => props.target, () => { void loadProjects(); }, { immediate: true });

// Reload models whenever the selected project changes.
watch(() => props.projectId, (id) => { void loadModels(id); });

// If picker fails entirely, expose a "enter manually" escape hatch.
const fallbackAvailable = computed(() => !!projectsError.value && projects.value.length === 0);

// Vue templates can't resolve the global `setTimeout`, so wrap it here.
function defocusProjectSoon() { window.setTimeout(() => { projectFocused.value = false; }, 150); }
function defocusModelSoon()   { window.setTimeout(() => { modelFocused.value   = false; }, 150); }
</script>

<template>
  <div class="picker">
    <!-- ----- Project ----- -->
    <label class="field">
      <div class="lbl-row">
        <span>Project</span>
        <button v-if="!manual && projects.length" type="button" class="link" @click="manual = true">
          enter ID manually
        </button>
        <button v-else-if="manual" type="button" class="link" @click="manual = false">
          back to project list
        </button>
      </div>

      <!-- Combobox mode -->
      <template v-if="!manual">
        <div class="combo">
          <input
            type="text"
            :placeholder="loadingProjects ? 'loading projects…' : (selectedProject ? selectedProject.name : 'search projects…')"
            :value="projectFocused ? projectFilter : (selectedProject?.name ?? '')"
            @focus="projectFocused = true; projectFilter = ''"
            @blur="defocusProjectSoon()"
            @input="(e) => projectFilter = (e.target as HTMLInputElement).value"
            :disabled="loadingProjects"
          />
          <div v-if="projectFocused && filteredProjects.length" class="dropdown">
            <div v-for="p in filteredProjects.slice(0, 50)" :key="p.id"
                 class="item"
                 @mousedown.prevent="pickProject(p)">
              <div class="item-main">{{ p.name }}</div>
              <div class="item-sub">
                <code>{{ p.id }}</code>
                <span v-if="p.role" class="muted-role">· {{ p.role }}</span>
              </div>
            </div>
          </div>
        </div>
        <div v-if="projectsError" class="hint-bad">
          {{ projectsError }}
          <button v-if="fallbackAvailable" type="button" class="link" @click="manual = true">
            enter manually instead
          </button>
        </div>
      </template>

      <!-- Manual ID mode -->
      <template v-else>
        <input
          type="text"
          :value="projectId"
          @input="emit('update:projectId', ($event.target as HTMLInputElement).value)"
          placeholder="paste an ORBIT project id (e.g. cf900606f5)" />
      </template>
    </label>

    <!-- ----- Model ----- -->
    <label class="field">
      <div class="lbl-row">
        <span>Model</span>
        <span v-if="!manual && selectedProject && !models.length && !loadingModels && !modelsError" class="muted-role">
          no models in this project yet
        </span>
      </div>

      <template v-if="!manual">
        <div class="combo">
          <input
            type="text"
            :placeholder="!projectId ? 'select a project first' : (loadingModels ? 'loading models…' : (selectedModel ? selectedModel.name : 'search models…'))"
            :value="modelFocused ? modelFilter : (selectedModel?.name ?? '')"
            @focus="modelFocused = true; modelFilter = ''"
            @blur="defocusModelSoon()"
            @input="(e) => modelFilter = (e.target as HTMLInputElement).value"
            :disabled="!projectId || loadingModels"
          />
          <div v-if="modelFocused && filteredModels.length" class="dropdown">
            <div v-for="m in filteredModels.slice(0, 50)" :key="m.id"
                 class="item"
                 @mousedown.prevent="pickModel(m)">
              <div class="item-main">{{ m.name }}</div>
              <div class="item-sub"><code>{{ m.id }}</code></div>
            </div>
          </div>
        </div>
        <div v-if="modelsError" class="hint-bad">{{ modelsError }}</div>
      </template>

      <template v-else>
        <input
          type="text"
          :value="modelId"
          @input="emit('update:modelId', ($event.target as HTMLInputElement).value)"
          placeholder="paste an ORBIT model id (e.g. be45d33eb1)" />
        <input
          type="text"
          :value="modelName ?? ''"
          @input="emit('update:modelName', ($event.target as HTMLInputElement).value)"
          placeholder="optional display name (e.g. main)" />
      </template>
    </label>
  </div>
</template>

<style scoped>
.picker { display: flex; flex-direction: column; gap: 12px; }
.field  { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--color-text-muted); }
.lbl-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }

.combo { position: relative; }
.dropdown {
  position: absolute; top: calc(100% + 2px); left: 0; right: 0; z-index: 10;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  max-height: 280px; overflow: auto;
  box-shadow: var(--shadow-md, 0 6px 16px rgba(0,0,0,0.12));
}
.item { padding: 8px 10px; cursor: pointer; }
.item:hover { background: var(--orbit-primary-fade); }
.item-main { font-weight: 500; color: var(--color-text); font-size: 13px; }
.item-sub  { display: flex; gap: 6px; align-items: baseline; font-size: 11px; color: var(--color-text-muted); }
.item-sub code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

.link {
  background: none; border: none; padding: 0;
  color: var(--orbit-primary); cursor: pointer;
  font-size: 11px; text-decoration: underline;
}
.muted-role { color: var(--color-text-muted); font-size: 11px; }
.hint-bad   { color: var(--color-danger, #c62828); font-size: 11px; margin-top: 4px; }
</style>
