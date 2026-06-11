<script setup lang="ts">
/**
 * Unified external materials browser — Fab, Poly Haven, ambientCG via
 * /api/external-materials (server-side proxy; credentials never reach browser).
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  externalMaterialsApi,
  type ApiError,
  type ExternalMaterialDetail,
  type ExternalMaterialSource,
  type ExternalMaterialSummary,
} from '../../shared/api';
import Icon from '../../shared/Icon.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; imported: [materialId: string] }>();

const PAGE = 24;
type SourceFilter = 'all' | ExternalMaterialSource;

const SOURCE_FILTERS: Array<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'fab', label: 'Fab' },
  { id: 'polyhaven', label: 'Poly Haven' },
  { id: 'ambientcg', label: 'ambientCG' },
];

const sourceFilter = ref<SourceFilter>('all');
const search = ref('');
const items = ref<ExternalMaterialSummary[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const providerLabels = ref<Record<string, string>>({});

const selected = ref<ExternalMaterialSummary | null>(null);
const detail = ref<ExternalMaterialDetail | null>(null);
const detailLoading = ref(false);
const importing = ref(false);
const importError = ref<string | null>(null);

let searchTimer: ReturnType<typeof setTimeout> | null = null;

const sourcesParam = computed(() =>
  sourceFilter.value === 'all' ? undefined : sourceFilter.value,
);

function sourceLabel(source: ExternalMaterialSource): string {
  return providerLabels.value[source] ?? source;
}

function formatBytes(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function load(reset = true): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await externalMaterialsApi.search({
      q: search.value || undefined,
      sources: sourcesParam.value,
      limit: PAGE,
      cursor: reset ? undefined : nextCursor.value,
    });
    providerLabels.value = res.providerLabels ?? {};
    items.value = reset ? res.items : [...items.value, ...res.items];
    nextCursor.value = res.nextCursor;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'search failed';
  } finally {
    loading.value = false;
  }
}

async function selectItem(item: ExternalMaterialSummary): Promise<void> {
  selected.value = item;
  detail.value = null;
  detailLoading.value = true;
  importError.value = null;
  try {
    detail.value = await externalMaterialsApi.get(item.source, item.sourceId);
  } catch (err) {
    importError.value = (err as ApiError).message ?? 'failed to load detail';
  } finally {
    detailLoading.value = false;
  }
}

async function importSelected(): Promise<void> {
  if (!selected.value) return;
  importing.value = true;
  importError.value = null;
  try {
    const res = await externalMaterialsApi.import(selected.value.source, selected.value.sourceId);
    emit('imported', res.id);
    emit('close');
  } catch (err) {
    importError.value = (err as ApiError).message ?? 'import failed';
  } finally {
    importing.value = false;
  }
}

function onSearchInput(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void load(true), 350);
}

function setSourceFilter(id: SourceFilter): void {
  sourceFilter.value = id;
  selected.value = null;
  detail.value = null;
  void load(true);
}

watch(() => props.open, (o) => {
  if (!o) return;
  search.value = '';
  sourceFilter.value = 'all';
  selected.value = null;
  detail.value = null;
  nextCursor.value = null;
  importError.value = null;
  void load(true);
});

onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div class="panel card">
      <header class="panel-head">
        <div>
          <h2>Browse external materials</h2>
          <p class="muted small">Search Fab, Poly Haven, and ambientCG; import into your library.</p>
        </div>
        <button class="icon-btn" type="button" aria-label="Close" @click="emit('close')">
          <Icon name="close" :size="18" />
        </button>
      </header>

      <div class="toolbar">
        <input
          v-model="search"
          class="flex-1"
          type="search"
          placeholder="Search e.g. concrete, brick, wood…"
          @input="onSearchInput"
        />
      </div>

      <div class="source-row">
        <button
          v-for="opt in SOURCE_FILTERS"
          :key="opt.id"
          class="source-pill"
          :class="{ active: sourceFilter === opt.id }"
          type="button"
          @click="setSourceFilter(opt.id)"
        >{{ opt.label }}</button>
      </div>

      <div v-if="error" class="error-box">{{ error }}</div>

      <div class="body">
        <section class="results">
          <div v-if="loading && !items.length" class="muted pad">Searching…</div>
          <div v-else-if="!items.length" class="muted pad">No results. Try another term or source.</div>
          <div v-else class="grid">
            <button
              v-for="item in items"
              :key="`${item.source}:${item.sourceId}`"
              class="result-card"
              :class="{ selected: selected?.source === item.source && selected?.sourceId === item.sourceId }"
              type="button"
              @click="selectItem(item)"
            >
              <span class="thumb">
                <img v-if="item.thumbnailUrl" :src="item.thumbnailUrl" :alt="item.title" loading="lazy" />
                <span v-else class="thumb-empty subtle">No preview</span>
              </span>
              <span class="result-title">{{ item.title }}</span>
              <span class="source-badge">{{ sourceLabel(item.source) }}</span>
            </button>
          </div>
          <div v-if="nextCursor" class="load-more">
            <button type="button" :disabled="loading" @click="load(false)">
              {{ loading ? 'Loading…' : 'Load more' }}
            </button>
          </div>
        </section>

        <aside v-if="selected" class="detail">
          <h3>{{ selected.title }}</h3>
          <span class="source-badge lg">{{ sourceLabel(selected.source) }}</span>
          <div v-if="detailLoading" class="muted small">Loading preview…</div>
          <template v-else-if="detail">
            <div v-if="detail.previewUrl" class="preview">
              <img :src="detail.previewUrl" :alt="detail.title" />
            </div>
            <p v-if="detail.description" class="desc">{{ detail.description }}</p>
            <p v-if="detail.downloadSize" class="muted small">Download ~{{ formatBytes(detail.downloadSize) }}</p>
            <div v-if="detail.tags.length" class="tags">
              <span v-for="tag in detail.tags.slice(0, 8)" :key="tag" class="pill tag">{{ tag }}</span>
            </div>
            <p
              v-if="detail.source === 'fab' && detail.metadata?.importConfigured === false"
              class="warn small"
            >
              Fab import needs <code>FAB_EPIC_REFRESH_TOKEN</code> on the server.
            </p>
          </template>
          <div v-if="importError" class="error-box mt-sm">{{ importError }}</div>
          <button
            class="primary import-btn"
            type="button"
            :disabled="importing || detailLoading"
            @click="importSelected"
          >
            {{ importing ? 'Importing…' : 'Import to library' }}
          </button>
        </aside>
        <aside v-else class="detail detail-empty muted">
          Select a material to preview and import.
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed; inset: 0; z-index: 210;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
}
.panel {
  width: 960px; max-width: 100%; max-height: 90vh;
  display: flex; flex-direction: column; gap: 12px;
  background: var(--color-bg-elevated);
}
.panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.panel-head h2 { margin: 0; font-size: 18px; }
.small { font-size: 12px; }
.toolbar { display: flex; gap: 8px; }
.source-row { display: flex; flex-wrap: wrap; gap: 6px; }
.source-pill {
  padding: 4px 12px; font-size: 12px; border-radius: 999px;
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg-input); color: var(--color-text-muted);
}
.source-pill.active {
  background: var(--orbit-primary); border-color: var(--orbit-primary); color: #fff;
}
.body {
  display: grid; grid-template-columns: 1fr 280px; gap: 12px;
  min-height: 360px; overflow: hidden;
}
.results { overflow: auto; min-height: 0; }
.pad { padding: 32px; text-align: center; }
.grid {
  display: grid; gap: 10px;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
}
.result-card {
  display: flex; flex-direction: column; gap: 4px; padding: 8px;
  border: 1px solid var(--color-border); border-radius: var(--radius);
  background: var(--color-bg-input); text-align: left; cursor: pointer;
}
.result-card:hover, .result-card.selected { border-color: var(--orbit-primary); }
.thumb {
  aspect-ratio: 1; border-radius: var(--radius-sm); overflow: hidden;
  background: var(--color-bg-hover); display: flex; align-items: center; justify-content: center;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb-empty { font-size: 11px; }
.result-title {
  font-size: 12px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.source-badge {
  align-self: flex-start;
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
  padding: 1px 6px; border-radius: 4px;
  background: var(--color-bg-hover); color: var(--color-text-muted);
}
.source-badge.lg { font-size: 11px; margin-top: 4px; }
.detail {
  border-left: 1px solid var(--color-border);
  padding-left: 12px; display: flex; flex-direction: column; gap: 8px;
  overflow: auto;
}
.detail-empty { justify-content: center; text-align: center; font-size: 13px; }
.detail h3 { margin: 0; font-size: 15px; }
.preview { border-radius: var(--radius-sm); overflow: hidden; background: var(--color-bg-hover); }
.preview img { width: 100%; display: block; }
.desc { font-size: 12px; margin: 0; color: var(--color-text-muted); }
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.pill.tag { font-size: 10px; text-transform: none; letter-spacing: normal; }
.warn { color: var(--color-warning, #c90); margin: 0; }
.import-btn { margin-top: auto; }
.load-more { display: flex; justify-content: center; padding: 8px 0; }
@media (max-width: 760px) {
  .body { grid-template-columns: 1fr; }
  .detail { border-left: none; border-top: 1px solid var(--color-border); padding-left: 0; padding-top: 12px; }
}
</style>
