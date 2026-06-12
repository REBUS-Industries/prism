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
  type FabSearchDiagnostics,
} from '../../shared/api';
import Icon from '../../shared/Icon.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; imported: [materialId: string] }>();

const PAGE = 36;
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
const providerErrors = ref<Partial<Record<ExternalMaterialSource, string>>>({});
const fabDiagnostics = ref<FabSearchDiagnostics | null>(null);

const selected = ref<ExternalMaterialSummary | null>(null);
const detail = ref<ExternalMaterialDetail | null>(null);
const detailLoading = ref(false);
const importing = ref(false);
const importError = ref<string | null>(null);
const selectedResolution = ref<string | null>(null);

let searchTimer: ReturnType<typeof setTimeout> | null = null;

const sourcesParam = computed(() =>
  sourceFilter.value === 'all' ? undefined : sourceFilter.value,
);

const fabImportConfigured = computed(() => {
  if (!detail.value || detail.value.source !== 'fab') return true;
  return detail.value.metadata?.importConfigured !== false;
});

const fabImportBlockedReason = computed(() => {
  if (fabImportConfigured.value) return '';
  return 'Fab import needs an Epic refresh token (Admin → Settings → External materials). Search and preview still work.';
});

const importDisabled = computed(() =>
  importing.value || detailLoading.value || !selected.value || !fabImportConfigured.value,
);

const detailMaps = computed(() => detail.value?.maps ?? []);

const resolutionOptions = computed(() => detail.value?.resolutions ?? []);

const showResolutionPicker = computed(() =>
  resolutionOptions.value.length > 1 && selected.value?.source !== 'fab',
);

const detailPreviewUrl = computed(() => {
  if (!detail.value) return null;
  const res = selectedResolution.value;
  if (res && detail.value.previewUrlByResolution?.[res]) {
    return detail.value.previewUrlByResolution[res];
  }
  return detail.value.previewUrl;
});

function applyDetailDefaults(d: ExternalMaterialDetail): void {
  selectedResolution.value = d.defaultResolution
    ?? d.resolutions?.[0]
    ?? null;
}

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
    providerErrors.value = res.providerErrors ?? {};
    fabDiagnostics.value = res.fabDiagnostics ?? null;
    items.value = reset ? res.items : [...items.value, ...res.items];
    nextCursor.value = res.nextCursor;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'search failed';
  } finally {
    loading.value = false;
  }
}

async function loadDetail(
  item: ExternalMaterialSummary,
  resolution?: string | null,
): Promise<void> {
  detailLoading.value = true;
  importError.value = null;
  try {
    const loaded = await externalMaterialsApi.get(item.source, item.sourceId, {
      resolution: resolution ?? undefined,
    });
    detail.value = loaded;
    if (!resolution) applyDetailDefaults(loaded);
  } catch (err) {
    importError.value = (err as ApiError).message ?? 'failed to load detail';
  } finally {
    detailLoading.value = false;
  }
}

async function selectItem(item: ExternalMaterialSummary): Promise<void> {
  selected.value = item;
  detail.value = null;
  selectedResolution.value = null;
  await loadDetail(item);
}

async function onResolutionSelect(res: string): Promise<void> {
  if (!selected.value || selectedResolution.value === res) return;
  selectedResolution.value = res;
  await loadDetail(selected.value, res);
}

async function importSelected(): Promise<void> {
  if (!selected.value || !fabImportConfigured.value) return;
  importing.value = true;
  importError.value = null;
  try {
    const res = await externalMaterialsApi.import(selected.value.source, selected.value.sourceId, {
      resolution: selectedResolution.value ?? undefined,
    });
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
  selectedResolution.value = null;
  nextCursor.value = null;
  importError.value = null;
  void load(true);
});

onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });
</script>

<template>
  <Teleport to="body">
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
        <div v-if="providerErrors.fab" class="warn-banner">
          <p>Fab search unavailable: {{ providerErrors.fab }}</p>
          <p v-if="fabDiagnostics" class="fab-diag muted small">
            Token: {{ fabDiagnostics.tokenConfigured ? 'configured' : 'missing' }}
            (source: {{ fabDiagnostics.tokenSource }}, auth: {{ fabDiagnostics.authPath }}).
            <template v-if="fabDiagnostics.tokenConfigured && fabDiagnostics.authPath === 'public'">
              Token was not applied — redeploy prism-materials or check settings reload.
            </template>
            <template v-else-if="!fabDiagnostics.tokenConfigured">
              Add an Epic refresh token under Admin → Settings → External materials.
            </template>
            <template v-else-if="fabDiagnostics.authPath === 'bearer' && providerErrors.fab.toLowerCase().includes('oauth')">
              Token refresh failed — re-save a valid Epic refresh token in Settings.
            </template>
            <template v-else-if="fabDiagnostics.authPath === 'bearer' && providerErrors.fab.toLowerCase().includes('cloudflare')">
              Bearer auth does not bypass Cloudflare —
              <template v-if="!fabDiagnostics.httpProxyConfigured">set an HTTP proxy in Admin → Settings → External materials.</template>
              <template v-else>check the configured HTTP proxy is reachable from the server.</template>
            </template>
          </p>
        </div>

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
              <div v-if="detailPreviewUrl" class="preview preview-media">
                <img :key="detailPreviewUrl" :src="detailPreviewUrl" :alt="detail.title" />
              </div>
              <p v-if="detail.description" class="desc">{{ detail.description }}</p>
              <p v-if="detail.downloadSize" class="muted small">Download ~{{ formatBytes(detail.downloadSize) }}</p>
              <div v-if="detail.tags.length" class="tags">
                <span v-for="tag in detail.tags.slice(0, 12)" :key="tag" class="pill tag">{{ tag }}</span>
              </div>
              <div v-if="detailMaps.length" class="maps-row">
                <span class="maps-label muted small">Includes</span>
                <div class="maps-list">
                  <span v-for="map in detailMaps" :key="map" class="pill map-pill">{{ map }}</span>
                </div>
              </div>
              <div v-if="showResolutionPicker" class="resolution-row">
                <span class="maps-label muted small">Resolution</span>
                <div class="resolution-options">
                  <button
                    v-for="res in resolutionOptions"
                    :key="res"
                    class="res-pill"
                    :class="{ active: selectedResolution === res }"
                    type="button"
                    @click="onResolutionSelect(res)"
                  >{{ res }}</button>
                </div>
              </div>
              <p v-else-if="selected?.source === 'fab'" class="muted small">Resolution: provider default (Fab)</p>
              <p v-if="!fabImportConfigured" class="warn small">
                Fab import is not configured.
                Set an Epic refresh token under
                <strong>Admin → Settings → External materials</strong>
                (or <code>FAB_EPIC_REFRESH_TOKEN</code> in the server environment).
                Search and preview still work.
              </p>
            </template>
            <div v-if="importError" class="error-box mt-sm">{{ importError }}</div>
            <button
              class="primary import-btn"
              type="button"
              :disabled="importDisabled"
              :title="fabImportBlockedReason || undefined"
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
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed; inset: 0; z-index: 210;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
  padding: 2vh 2vw;
}
.panel {
  width: 90vw; height: 90vh; max-width: none; max-height: none;
  display: flex; flex-direction: column; gap: 12px;
  background: var(--color-bg-elevated);
  overflow: hidden;
}
.panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex: none; }
.panel-head h2 { margin: 0; font-size: 18px; }
.small { font-size: 12px; }
.toolbar { display: flex; gap: 8px; flex: none; }
.source-row { display: flex; flex-wrap: wrap; gap: 6px; flex: none; }
.source-pill {
  padding: 4px 12px; font-size: 12px; border-radius: 999px;
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg-input); color: var(--color-text-muted);
}
.source-pill.active {
  background: var(--orbit-primary); border-color: var(--orbit-primary); color: #fff;
}
.body {
  display: grid; grid-template-columns: 1fr minmax(320px, 34vw); gap: 16px;
  flex: 1; min-height: 0; overflow: hidden;
}
.results { overflow: auto; min-height: 0; }
.pad { padding: 32px; text-align: center; }
.grid {
  display: grid; gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
}
.result-card {
  display: flex; flex-direction: column; gap: 4px; padding: 8px;
  border: 1px solid var(--color-border); border-radius: var(--radius);
  background: var(--color-bg-input); text-align: left; cursor: pointer;
}
.result-card:hover, .result-card.selected { border-color: var(--orbit-primary); }
.thumb {
  aspect-ratio: 1; border-radius: var(--radius-sm); overflow: hidden;
  background-color: var(--color-bg-input);
  background-image:
    linear-gradient(45deg, color-mix(in srgb, var(--color-border) 55%, transparent) 25%, transparent 25%),
    linear-gradient(-45deg, color-mix(in srgb, var(--color-border) 55%, transparent) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--color-border) 55%, transparent) 75%),
    linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--color-border) 55%, transparent) 75%);
  background-size: 10px 10px;
  background-position: 0 0, 0 5px, 5px -5px, -5px 0;
  display: flex; align-items: center; justify-content: center;
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
  background: var(--orbit-primary); color: #fff;
}
.source-badge.lg { font-size: 11px; margin-top: 4px; }
.detail {
  border-left: 1px solid var(--color-border);
  padding-left: 16px; display: flex; flex-direction: column; gap: 10px;
  overflow: auto; min-height: 0;
}
.detail-empty { justify-content: center; text-align: center; font-size: 13px; }
.detail h3 { margin: 0; font-size: 16px; }
.preview { border-radius: var(--radius-sm); overflow: hidden; }
.preview-media {
  background-color: var(--color-bg-input);
  background-image:
    linear-gradient(45deg, color-mix(in srgb, var(--color-border) 55%, transparent) 25%, transparent 25%),
    linear-gradient(-45deg, color-mix(in srgb, var(--color-border) 55%, transparent) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--color-border) 55%, transparent) 75%),
    linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--color-border) 55%, transparent) 75%);
  background-size: 12px 12px;
  background-position: 0 0, 0 6px, 6px -6px, -6px 0;
}
.preview img { width: 100%; display: block; max-height: 42vh; object-fit: contain; }
.maps-row, .resolution-row { display: flex; flex-direction: column; gap: 6px; }
.maps-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.maps-list, .resolution-options { display: flex; flex-wrap: wrap; gap: 4px; }
.pill.map-pill {
  font-size: 10px; text-transform: none; letter-spacing: normal;
  background: var(--color-bg-input); color: var(--color-text-muted);
  border: 1px solid var(--color-border);
}
.res-pill {
  padding: 3px 10px; font-size: 11px; border-radius: 999px;
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg-input); color: var(--color-text-muted);
  cursor: pointer;
}
.res-pill.active {
  border-color: var(--color-text-muted);
  background: var(--color-bg-elevated);
  color: var(--color-text);
}
.desc { font-size: 12px; margin: 0; color: var(--color-text-muted); line-height: 1.45; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.pill.tag { font-size: 10px; text-transform: none; letter-spacing: normal; }
.warn { color: var(--color-warning, #c90); margin: 0; line-height: 1.45; }
.warn-banner {
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.45;
  border-radius: var(--radius-sm);
  border: 1px solid color-mix(in srgb, var(--color-warning, #c90) 45%, var(--color-border));
  background: color-mix(in srgb, var(--color-warning, #c90) 12%, var(--color-bg-input));
  color: var(--color-text);
}
.warn-banner p { margin: 0 0 4px; }
.warn-banner p:last-child { margin-bottom: 0; }
.fab-diag { margin-top: 4px; }
.import-btn { margin-top: auto; flex: none; }
.import-btn:disabled { cursor: not-allowed; opacity: 0.55; }
.load-more { display: flex; justify-content: center; padding: 8px 0; }
@media (max-width: 900px) {
  .panel { width: 96vw; height: 96vh; }
  .body { grid-template-columns: 1fr; }
  .detail { border-left: none; border-top: 1px solid var(--color-border); padding-left: 0; padding-top: 12px; }
}
</style>
