<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import FixtureViewer from '../components/FixtureViewer.vue';
import {
  fixturesApi,
  type ApiError,
  type FixtureDetail,
  type FixturePart,
} from '../../shared/api';
import {
  buildDebugBundle,
  buildFullMeshesJson,
  buildSummaryJson,
  downloadJson,
  meshVertexCount,
} from '../utils/gdtfDebugExport';

const props = defineProps<{ id: string }>();

const fixture = ref<FixtureDetail | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const activeTab = ref<'preview' | 'raw'>('preview');
const rawJson = ref('');

const panDeg = ref(0);
const tiltDeg = ref(0);
const dimmer = ref(0.5);
const showBeam = ref(true);
const selectedPartId = ref<string | null>(null);

const previewUrl = computed(() =>
  fixture.value?.hasPreview ? fixturesApi.previewUrl(fixture.value.id) : null,
);

const info = computed(() => fixture.value?.definition.fixtureInformation);

const panAxis = computed(() =>
  fixture.value?.definition.motionRig.find((a) => a.axisType === 'PAN') ?? null,
);
const tiltAxis = computed(() =>
  fixture.value?.definition.motionRig.find((a) => a.axisType === 'TILT') ?? null,
);

const meshRecords = computed(() => {
  if (!fixture.value) return [];
  const def = fixture.value.definition;
  return def.parts.map((part, idx) => {
    const model = def.models.find((m) => m.modelId === part.modelId);
    const vtx = meshVertexCount(part.metadata) ?? (model ? meshVertexCount(model.metadata) : null);
    return { idx, part, model, vtx };
  });
});

const totalVtx = computed(() =>
  meshRecords.value.reduce((sum, r) => sum + (r.vtx ?? 0), 0),
);

const geometryHierarchy = computed(() => {
  if (!fixture.value) return [];
  const parts = fixture.value.definition.parts;
  const roots = parts.filter((p) => !p.parentPartId);
  function branch(part: FixturePart, depth: number): Array<{ part: FixturePart; depth: number }> {
    const kids = parts.filter((p) => p.parentPartId === part.partId);
    return [
      { part, depth },
      ...kids.flatMap((k) => branch(k, depth + 1)),
    ];
  }
  return roots.flatMap((r) => branch(r, 0));
});

const sourceFiles = computed(() => {
  if (!fixture.value) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of fixture.value.definition.models) {
    const f = m.sourceFile ?? m.sourceGdtfModel;
    if (f && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
});

const selectedPart = computed(() =>
  fixture.value?.definition.parts.find((p) => p.partId === selectedPartId.value) ?? null,
);

const exportSlug = computed(() =>
  (fixture.value?.name ?? 'fixture').replace(/[^\w.-]+/g, '_'),
);

function refreshRawJson(): void {
  if (!fixture.value) return;
  rawJson.value = JSON.stringify(buildDebugBundle(fixture.value), null, 2);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await fixturesApi.get(props.id);
    fixture.value = res.fixture;
    selectedPartId.value = res.fixture.definition.parts[0]?.partId ?? null;
    refreshRawJson();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Failed to load fixture';
    fixture.value = null;
  } finally {
    loading.value = false;
  }
}

function exportSummary(): void {
  if (!fixture.value) return;
  downloadJson(buildSummaryJson(fixture.value), `${exportSlug.value}-summary.json`);
}

function exportMeshes(): void {
  if (!fixture.value) return;
  downloadJson(buildFullMeshesJson(fixture.value), `${exportSlug.value}-meshes.json`);
}

function exportBundle(): void {
  if (!fixture.value) return;
  downloadJson(buildDebugBundle(fixture.value), `${exportSlug.value}-debug-bundle.json`);
}

onMounted(() => void load());
</script>

<template>
  <div v-if="loading" class="debug-page muted">Loading fixture…</div>
  <div v-else-if="error && !fixture" class="debug-page error-box">{{ error }}</div>

  <div v-else-if="fixture" class="debug-page">
    <header class="debug-head">
      <RouterLink :to="{ name: 'fixture-editor', params: { id: fixture.id } }" class="back muted">
        ← Back to editor
      </RouterLink>
      <div class="head-row">
        <h1>Debug GDTF 3D — {{ fixture.name }}</h1>
        <div class="export-row">
          <button type="button" class="btn-outline" @click="exportSummary">Summary JSON</button>
          <button type="button" class="btn-outline" @click="exportMeshes">Full Meshes JSON</button>
          <button type="button" class="btn-primary" @click="exportBundle">Full Debug Bundle</button>
        </div>
      </div>
      <nav class="debug-tabs">
        <button
          type="button"
          class="debug-tab"
          :class="{ active: activeTab === 'preview' }"
          @click="activeTab = 'preview'"
        >Preview</button>
        <button
          type="button"
          class="debug-tab"
          :class="{ active: activeTab === 'raw' }"
          @click="activeTab = 'raw'; refreshRawJson()"
        >Raw JSON</button>
      </nav>
    </header>

    <div v-if="activeTab === 'raw'" class="raw-panel">
      <pre class="raw-json mono">{{ rawJson }}</pre>
    </div>

    <div v-else class="debug-grid">
      <aside class="debug-sidebar">
        <section class="side-block">
          <h3>Assembly</h3>
          <p class="side-meta muted">All mesh records ({{ meshRecords.length }})</p>
        </section>

        <section class="side-block">
          <h3>GDTF models</h3>
          <ul class="side-list">
            <li
              v-for="m in fixture.definition.models"
              :key="m.modelId"
              class="side-item"
            >
              <span class="tag-pill">{{ m.partTag }}</span>
              <span>{{ m.modelId }}</span>
              <span class="muted small">{{ m.assignedPartIds.length }} part(s)</span>
            </li>
          </ul>
        </section>

        <section v-if="sourceFiles.length" class="side-block">
          <h3>Source files</h3>
          <ul class="side-list mono small">
            <li v-for="f in sourceFiles" :key="f">{{ f }}</li>
          </ul>
        </section>

        <section class="side-block">
          <h3>Mesh records</h3>
          <ul class="side-list selectable">
            <li
              v-for="rec in meshRecords"
              :key="rec.part.partId"
              class="side-item clickable"
              :class="{ selected: selectedPartId === rec.part.partId }"
              @click="selectedPartId = rec.part.partId"
            >
              <span class="mono">#{{ rec.idx }}</span>
              <span>{{ rec.part.name }}</span>
              <span class="tag-pill">{{ rec.part.tag }}</span>
              <span v-if="rec.vtx" class="muted">{{ rec.vtx }} vtx</span>
            </li>
          </ul>
        </section>

        <details class="side-block collapsible">
          <summary>Geometry hierarchy</summary>
          <ul class="hier-list">
            <li
              v-for="row in geometryHierarchy"
              :key="row.part.partId"
              :style="{ paddingLeft: `${8 + row.depth * 12}px` }"
              class="hier-item"
            >
              {{ row.part.name }} <span class="muted">({{ row.part.tag }})</span>
            </li>
          </ul>
        </details>

        <details class="side-block collapsible">
          <summary>Flat geometry refs</summary>
          <ul class="side-list mono small">
            <li v-for="p in fixture.definition.parts" :key="p.partId">
              {{ p.sourceGdtfGeometryId ?? p.name }}
            </li>
          </ul>
        </details>

        <details class="side-block collapsible">
          <summary>Model bounds vs mesh union</summary>
          <p class="muted small side-meta">
            {{ fixture.definition.models.length }} models · {{ totalVtx || '—' }} total vtx (where reported)
          </p>
        </details>
      </aside>

      <main class="debug-center">
        <section class="motion-card">
          <h3>Fixture motion</h3>
          <label class="check-row">
            <input v-model="showBeam" type="checkbox" />
            Light beam origin + direction
          </label>
          <div class="slider-row">
            <span>Dimmer</span>
            <input v-model.number="dimmer" type="range" min="0" max="1" step="0.01" class="range-orange" />
            <span class="mono">{{ Math.round(dimmer * 100) }}%</span>
          </div>
          <div class="slider-row">
            <span>Pan{{ panAxis ? `: ${panAxis.controlledPartId ? 'Yoke' : ''}` : '' }}</span>
            <input
              v-model.number="panDeg"
              type="range"
              :min="panAxis?.minValue ?? -270"
              :max="panAxis?.maxValue ?? 270"
              step="1"
              class="range-orange"
            />
            <span class="mono">{{ panDeg }}°</span>
          </div>
          <div class="slider-row">
            <span>Tilt{{ tiltAxis ? `: Head` : '' }}</span>
            <input
              v-model.number="tiltDeg"
              type="range"
              :min="tiltAxis?.minValue ?? -135"
              :max="tiltAxis?.maxValue ?? 135"
              step="1"
              class="range-orange"
            />
            <span class="mono">{{ tiltDeg }}°</span>
          </div>
          <p v-if="fixture.definition.beams.length" class="muted small ies-note">
            IES photometric profile: {{ fixture.definition.beams[0].beamType ?? 'beam' }}
            <span v-if="fixture.definition.beams[0].luminousFlux">
              · {{ fixture.definition.beams[0].luminousFlux }} lm
            </span>
          </p>
        </section>

        <section class="selection-preview">
          <div class="preview-head">
            <h3>Selection preview</h3>
            <span v-if="selectedPart" class="muted small">{{ selectedPart.name }} ({{ selectedPart.tag }})</span>
          </div>
          <div class="preview-viewport">
            <FixtureViewer
              v-if="previewUrl"
              :url="previewUrl"
              :pan-deg="panDeg"
              :tilt-deg="tiltDeg"
              :dimmer="dimmer"
              :show-beam="showBeam"
              light-background
            />
            <p v-else class="muted no-preview">No GLB preview available.</p>
          </div>
        </section>
      </main>

      <aside class="debug-assembly">
        <div class="assembly-head">
          <h3>Full assembly</h3>
          <span class="muted small">
            {{ meshRecords.length }} records
            <span v-if="totalVtx"> · {{ totalVtx }} vtx</span>
          </span>
        </div>
        <div class="assembly-viewport">
          <FixtureViewer
            v-if="previewUrl"
            :url="previewUrl"
            :pan-deg="panDeg"
            :tilt-deg="tiltDeg"
            :dimmer="dimmer"
            :show-beam="showBeam"
            light-background
          />
          <p v-else class="muted no-preview">No GLB preview available.</p>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.debug-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: calc(100vh - 80px);
  padding-bottom: 24px;
}
.back {
  font-size: 12px;
  text-decoration: none;
}
.head-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.head-row h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}
.export-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.btn-outline {
  padding: 6px 12px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.btn-outline:hover { border-color: var(--orbit-primary); }
.btn-primary {
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--orbit-primary);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.btn-primary:hover { background: var(--orbit-primary-hover); }

.debug-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--color-border);
}
.debug-tab {
  padding: 8px 14px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.debug-tab.active {
  color: var(--orbit-primary);
  border-bottom-color: var(--orbit-primary);
}

.debug-grid {
  display: grid;
  grid-template-columns: 240px 1fr 1.2fr;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
@media (max-width: 1100px) {
  .debug-grid { grid-template-columns: 1fr; }
}

.debug-sidebar,
.debug-center,
.debug-assembly {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.debug-sidebar {
  overflow-y: auto;
  max-height: calc(100vh - 180px);
  padding-right: 4px;
}

.side-block {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 10px;
  background: var(--color-bg-elevated);
}
.side-block h3 {
  margin: 0 0 6px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.side-meta { margin: 0; font-size: 11px; }
.side-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.side-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.side-item.clickable {
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.side-item.clickable:hover { background: var(--color-bg-hover); }
.side-item.selected {
  background: var(--orbit-primary-fade);
  outline: 1px solid var(--orbit-primary);
}
.tag-pill {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--color-bg-hover);
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
}
.collapsible summary {
  cursor: pointer;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.hier-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  font-size: 11px;
}
.hier-item { padding: 2px 0; }

.motion-card,
.selection-preview,
.debug-assembly {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-elevated);
  padding: 12px;
}
.motion-card h3,
.selection-preview h3,
.assembly-head h3 {
  margin: 0 0 10px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 10px;
}
.slider-row {
  display: grid;
  grid-template-columns: 72px 1fr 48px;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 11px;
}
.range-orange {
  accent-color: var(--orbit-primary);
  width: 100%;
}
.ies-note { margin: 8px 0 0; }

.preview-head,
.assembly-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.preview-viewport,
.assembly-viewport {
  flex: 1;
  min-height: 280px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.preview-viewport :deep(.fixture-viewer),
.assembly-viewport :deep(.fixture-viewer) {
  min-height: 280px;
  height: 100%;
}
.debug-assembly {
  min-height: 400px;
}
.assembly-viewport {
  flex: 1;
  min-height: 360px;
}

.raw-panel {
  flex: 1;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  overflow: auto;
  max-height: calc(100vh - 160px);
  background: var(--color-bg-elevated);
}
.raw-json {
  margin: 0;
  padding: 16px;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
.no-preview {
  padding: 24px;
  text-align: center;
}
.mono { font-family: var(--font-mono); }
.small { font-size: 11px; }
.error-box {
  padding: 16px;
  color: var(--color-error);
  background: var(--color-error-bg);
  border-radius: var(--radius);
}
</style>
