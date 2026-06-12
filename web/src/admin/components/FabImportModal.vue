<script setup lang="ts">
/**
 * Fab marketplace import modal — search, preview, and import into the PRISM
 * materials library. All Fab API calls go through /api/fab (server-side proxy).
 */
import { onBeforeUnmount, ref, watch } from 'vue';
import {
  fabApi,
  type ApiError,
  type FabAssetDetail,
  type FabAssetSummary,
} from '../../shared/api';
import Icon from '../../shared/Icon.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  close: [];
  imported: [materialId: string, skipped: string[]];
}>();

const PAGE = 24;

const results = ref<FabAssetSummary[]>([]);
const selected = ref<FabAssetDetail | null>(null);
const loading = ref(false);
const detailLoading = ref(false);
const importing = ref(false);
const error = ref<string | null>(null);
const importError = ref<string | null>(null);
const nextCursor = ref<string | null>(null);

const search = ref('');
let searchTimer: ReturnType<typeof setTimeout> | null = null;

async function loadSearch(reset = true): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await fabApi.search({
      q: search.value || undefined,
      limit: PAGE,
      cursor: reset ? undefined : nextCursor.value ?? undefined,
    });
    results.value = reset ? res.items : [...results.value, ...res.items];
    nextCursor.value = res.nextCursor;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Fab search failed';
  } finally {
    loading.value = false;
  }
}

function onSearchInput(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadSearch(true), 350);
}

async function selectItem(item: FabAssetSummary): Promise<void> {
  detailLoading.value = true;
  importError.value = null;
  selected.value = null;
  try {
    selected.value = await fabApi.getAsset(item.id);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Failed to load preview';
  } finally {
    detailLoading.value = false;
  }
}

async function importSelected(): Promise<void> {
  if (!selected.value || importing.value) return;
  importing.value = true;
  importError.value = null;
  try {
    const res = await fabApi.importAsset(selected.value.id, { name: selected.value.title });
    emit('imported', res.id, res.skipped);
    emit('close');
  } catch (err) {
    const apiErr = err as ApiError;
    importError.value = apiErr.message ?? 'Import failed';
    if (apiErr.body && typeof apiErr.body === 'object' && 'code' in apiErr.body) {
      const code = (apiErr.body as { code?: string }).code;
      if (code === 'fab_not_configured') {
        importError.value = 'Fab import is not configured on the server (FAB_EPIC_REFRESH_TOKEN). Search and preview still work.';
      }
    }
  } finally {
    importing.value = false;
  }
}

function formatPrice(item: FabAssetSummary): string {
  if (item.isFree) return 'Free';
  if (item.price != null) return `$${item.price.toFixed(2)}`;
  return '';
}

watch(() => props.open, (o) => {
  if (!o) return;
  search.value = '';
  results.value = [];
  selected.value = null;
  nextCursor.value = null;
  error.value = null;
  importError.value = null;
  void loadSearch(true);
});

onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });
</script>

<template>
  <div v-if="open" class="fab-backdrop" @click.self="emit('close')">
    <div class="fab-modal card">
      <header class="fab-head">
        <h2>Import from Fab</h2>
        <button class="icon-btn" type="button" aria-label="Close" @click="emit('close')">
          <Icon name="close" :size="18" />
        </button>
      </header>

      <div class="fab-body">
        <section class="fab-search-panel">
          <input
            v-model="search"
            type="search"
            placeholder="Search Fab materials…"
            @input="onSearchInput"
          />
          <div v-if="error" class="error-box">{{ error }}</div>
          <div v-if="loading && !results.length" class="muted">Searching…</div>
          <div v-else-if="!results.length" class="muted">No materials found.</div>
          <div v-else class="fab-grid">
            <button
              v-for="item in results"
              :key="item.id"
              type="button"
              class="fab-tile"
              :class="{ active: selected?.id === item.id }"
              @click="selectItem(item)"
            >
              <span class="fab-thumb">
                <img v-if="item.thumbnailUrl" :src="item.thumbnailUrl" :alt="item.title" loading="lazy" />
                <span v-else class="subtle">No preview</span>
              </span>
              <span class="fab-title">{{ item.title }}</span>
              <span v-if="formatPrice(item)" class="fab-price subtle">{{ formatPrice(item) }}</span>
            </button>
          </div>
          <div v-if="nextCursor" class="load-more">
            <button :disabled="loading" @click="loadSearch(false)">
              {{ loading ? 'Loading…' : 'Load more' }}
            </button>
          </div>
        </section>

        <section class="fab-preview-panel">
          <div v-if="detailLoading" class="muted">Loading preview…</div>
          <div v-else-if="!selected" class="muted preview-empty">
            Select a material to preview details and import.
          </div>
          <template v-else>
            <div v-if="selected.previewUrl" class="preview-hero">
              <img :src="selected.previewUrl" :alt="selected.title" />
            </div>
            <h3>{{ selected.title }}</h3>
            <p v-if="selected.seller" class="subtle">by {{ selected.seller }}</p>
            <p v-if="selected.description" class="desc">{{ selected.description }}</p>
            <dl class="meta">
              <template v-if="selected.category">
                <dt>Category</dt><dd>{{ selected.category }}</dd>
              </template>
              <template v-if="selected.formats.length">
                <dt>Formats</dt><dd>{{ selected.formats.join(', ') }}</dd>
              </template>
              <template v-if="selected.ratingAverage != null">
                <dt>Rating</dt><dd>{{ selected.ratingAverage }} / 5</dd>
              </template>
            </dl>
            <div v-if="selected.tags.length" class="tags">
              <span v-for="tag in selected.tags" :key="tag" class="pill tag">{{ tag }}</span>
            </div>
            <p v-if="selected.importConfigured === false" class="warn-box">
              Import requires <code>FAB_EPIC_REFRESH_TOKEN</code> on the server. You can browse here; ask an admin to configure Epic OAuth for downloads.
            </p>
            <div v-if="importError" class="error-box">{{ importError }}</div>
            <div class="fab-actions">
              <button :disabled="importing" @click="emit('close')">Cancel</button>
              <button class="primary" :disabled="importing" @click="importSelected">
                {{ importing ? 'Importing…' : 'Import to library' }}
              </button>
            </div>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fab-backdrop {
  position: fixed; inset: 0; z-index: 210;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.fab-modal {
  width: min(960px, 100%); max-height: calc(100vh - 40px);
  display: flex; flex-direction: column; overflow: hidden;
}
.fab-head {
  display: flex; align-items: center; justify-content: space-between;
  padding-bottom: 8px; border-bottom: 1px solid var(--color-border);
}
.fab-head h2 { margin: 0; font-size: 16px; }
.fab-body { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; min-height: 420px; margin-top: 12px; overflow: hidden; }
@media (max-width: 760px) { .fab-body { grid-template-columns: 1fr; } }
.fab-search-panel { overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.fab-preview-panel { overflow: auto; display: flex; flex-direction: column; gap: 8px; border-left: 1px solid var(--color-border); padding-left: 16px; }
@media (max-width: 760px) { .fab-preview-panel { border-left: none; padding-left: 0; border-top: 1px solid var(--color-border); padding-top: 12px; } }
.fab-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.fab-tile {
  display: flex; flex-direction: column; gap: 4px; padding: 6px; text-align: left;
  border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg-input);
  cursor: pointer;
}
.fab-tile:hover, .fab-tile.active { border-color: var(--orbit-primary); box-shadow: var(--shadow-2); }
.fab-thumb {
  aspect-ratio: 1; border-radius: var(--radius-sm); overflow: hidden;
  background: var(--color-bg-hover); display: flex; align-items: center; justify-content: center;
}
.fab-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fab-title { font-size: 12px; font-weight: 600; line-height: 1.2; }
.fab-price { font-size: 11px; }
.preview-hero { border-radius: var(--radius-sm); overflow: hidden; background: var(--color-bg-hover); }
.preview-hero img { width: 100%; display: block; max-height: 220px; object-fit: cover; }
.preview-empty { margin-top: 24px; text-align: center; }
.desc { font-size: 13px; line-height: 1.45; margin: 0; white-space: pre-wrap; }
.meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 12px; margin: 0; }
.meta dt { color: var(--color-text-muted); }
.meta dd { margin: 0; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.pill.tag { text-transform: none; letter-spacing: normal; font-weight: 500; background: var(--color-bg-hover); color: var(--color-text-muted); }
.fab-actions { margin-top: auto; display: flex; justify-content: flex-end; gap: 8px; padding-top: 8px; }
.load-more { display: flex; justify-content: center; }
.warn-box {
  font-size: 12px; padding: 8px 10px; border-radius: var(--radius-sm);
  background: var(--color-bg-elevated); border: 1px solid var(--color-border-strong);
}
</style>
