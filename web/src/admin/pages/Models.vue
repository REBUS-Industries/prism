<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { modelsApi, settingsApi, type ModelListItem, type ModelCategoryOption, type ApiError } from '../../shared/api';
import Icon from '../../shared/Icon.vue';
import ModelCardPreview from '../components/ModelCardPreview.vue';
import {
  loadModelCategories,
  modelCategoryFilterOptions,
  modelCategoryLabel,
} from '../utils/modelCategories';

const router = useRouter();
const models = ref<ModelListItem[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const search = ref('');
const categoryFilter = ref('');
const categoryOptions = ref<ModelCategoryOption[]>([]);
const nextCursor = ref<string | null>(null);
const orbitSettings = ref<Record<string, string>>({});
const PAGE = 36;

let searchTimer: ReturnType<typeof setTimeout> | null = null;

async function load(reset = true): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await modelsApi.list({
      q: search.value.trim() || undefined,
      category: categoryFilter.value || undefined,
      limit: PAGE,
      cursor: reset ? null : nextCursor.value,
    });
    models.value = reset ? res.models : [...models.value, ...res.models];
    nextCursor.value = res.nextCursor;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load models';
  } finally {
    loading.value = false;
  }
}

function onSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void load(true), 300);
}

function onCategoryFilter(): void {
  void load(true);
}

function displayCategory(m: ModelListItem): string {
  return m.categoryLabel ?? modelCategoryLabel(m.category) ?? m.category ?? '';
}

async function createBlank(): Promise<void> {
  try {
    const res = await modelsApi.create({ name: 'Untitled model' });
    void router.push({ name: 'model-editor', params: { id: res.model.id } });
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to create model';
  }
}

const isEmpty = computed(() => !loading.value && models.value.length === 0);

async function loadOrbitSettings(): Promise<void> {
  try {
    orbitSettings.value = (await settingsApi.list()).settings;
  } catch {
    // Non-fatal — OrbitModelViewer falls back to default server URLs.
  }
}

onMounted(() => {
  void loadModelCategories().then(() => {
    categoryOptions.value = modelCategoryFilterOptions();
  });
  void load(true);
  void loadOrbitSettings();
});
</script>

<template>
  <div class="h-row">
    <h1 class="flex-1">Model Library</h1>
    <RouterLink :to="{ name: 'model-import' }" class="btn-link">
      <Icon name="upload_file" :size="16" />Import model
    </RouterLink>
    <button class="primary" @click="createBlank"><Icon name="add" :size="16" />New model</button>
  </div>

  <section class="card mt">
    <div class="toolbar">
      <div class="search-box">
        <Icon name="search" :size="16" class="search-icon" />
        <input v-model="search" placeholder="Search models…" @input="onSearch" />
      </div>
      <select v-model="categoryFilter" class="category-filter" @change="onCategoryFilter">
        <option value="">All categories</option>
        <option v-for="opt in categoryOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
      <button :disabled="loading" @click="load(true)"><Icon name="refresh" :size="16" />Refresh</button>
    </div>
  </section>

  <div v-if="error" class="error-box mt">{{ error }}</div>

  <p v-if="isEmpty" class="muted mt">No models yet. Import a mesh or create a blank record to get started.</p>

  <div class="model-grid mt">
    <RouterLink
      v-for="m in models"
      :key="m.id"
      :to="{ name: 'model-editor', params: { id: m.id } }"
      class="model-card"
    >
      <div class="thumb">
        <ModelCardPreview
          :model-id="m.id"
          :has-preview="m.hasPreview"
          :has-thumbnail="!!m.hasThumbnail"
          :alt="m.name"
          :orbit-settings="orbitSettings"
        />
      </div>
      <div class="meta">
        <div class="name" :title="m.name">{{ m.name }}</div>
        <div class="sub muted small">
          <span v-if="m.category">{{ displayCategory(m) }}</span>
          <span class="pill" :class="m.status">{{ m.status }}</span>
        </div>
      </div>
    </RouterLink>
  </div>

  <div v-if="nextCursor" class="center mt">
    <button :disabled="loading" @click="load(false)">{{ loading ? 'Loading…' : 'Load more' }}</button>
  </div>
</template>

<style scoped>
.toolbar { display: flex; gap: 12px; align-items: center; }
.search-box { position: relative; flex: 1; }
.search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); opacity: 0.5; }
.search-box input { width: 100%; padding-left: 32px; }
.category-filter { min-width: 160px; }
.model-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 14px;
}
.model-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border, #2a2a32);
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface-2, #1a1a1f);
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s, transform 0.15s;
}
.model-card:hover { border-color: var(--color-border-strong, #3a3a44); transform: translateY(-2px); }
.thumb {
  aspect-ratio: 1 / 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--orbit-viewer-canvas-bg, #e8eaed);
}
[data-theme="dark"] .thumb {
  --orbit-viewer-canvas-bg: #1a1a1f;
}
.thumb img { width: 100%; height: 100%; object-fit: contain; }
.meta { padding: 8px 10px; }
.name { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { display: flex; gap: 8px; align-items: center; margin-top: 2px; }
.pill { padding: 1px 6px; border-radius: 999px; font-size: 10px; text-transform: uppercase; background: var(--surface-3, #14141a); }
.pill.published { background: #1f3a23; color: #7fd18c; }
.center { display: flex; justify-content: center; }
.btn-link { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 8px; text-decoration: none; color: inherit; border: 1px solid var(--color-border, #2a2a32); }
</style>
