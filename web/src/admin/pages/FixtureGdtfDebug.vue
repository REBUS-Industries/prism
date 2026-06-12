<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import FixtureViewer from '../components/FixtureViewer.vue';
import Icon from '../../shared/Icon.vue';
import {
  fixturesApi,
  type ApiError,
  type FixtureDetail,
  type FixturePart,
  type MotionAxis,
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

const dimmer = ref(0.5);
const showBeam = ref(true);
const selectedPartId = ref<string | null>(null);
/** Per-motion-axis TARGET angle (slider value, motionAxisId → degrees). */
const motionAngles = ref<Record<string, number>>({});
/** Animated angle actually sent to the viewer — eases to the target over RealFade. */
const appliedAngles = ref<Record<string, number>>({});
/** Animate moves over the GDTF fade/acceleration time (vs. snapping instantly). */
const liveFade = ref(true);

const previewUrl = computed(() =>
  fixture.value?.hasPreview ? fixturesApi.previewUrl(fixture.value.id) : null,
);

const info = computed(() => fixture.value?.definition.fixtureInformation);

// ---- DMX mode selection ---------------------------------------------------
interface DebugMode { modeId: string; name: string; geometry?: string }
const modes = computed<DebugMode[]>(() => {
  const raw = (fixture.value?.definition?.dmxMapping as { modes?: unknown })?.modes;
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>).map((m) => ({
    modeId: String(m.modeId ?? m.name ?? ''),
    name: String(m.name ?? m.modeId ?? 'Mode'),
    geometry: typeof m.geometry === 'string' ? m.geometry : undefined,
  }));
});
const hasModeGeometries = computed(() =>
  new Set(modes.value.map((m) => m.geometry).filter(Boolean)).size > 1,
);
const selectedModeId = ref<string | null>(null);
const selectedModeGeometry = computed<string | null>(() => {
  if (!hasModeGeometries.value) return null;
  const mode = modes.value.find((m) => m.modeId === selectedModeId.value) ?? modes.value[0];
  return mode?.geometry ?? null;
});

/** Part ids reachable from the selected mode's root geometry (incl. references). */
const visiblePartIds = computed<Set<string> | null>(() => {
  const geo = selectedModeGeometry.value;
  const def = fixture.value?.definition;
  if (!geo || !def) return null;
  const byId = new Map(def.parts.map((p) => [p.partId, p]));
  const byGeom = new Map<string, FixturePart>();
  for (const p of def.parts) if (p.sourceGdtfGeometryId) byGeom.set(p.sourceGdtfGeometryId, p);
  const out = new Set<string>();
  const add = (partId: string): void => {
    if (out.has(partId)) return;
    out.add(partId);
    const p = byId.get(partId);
    if (!p) return;
    for (const c of p.childPartIds) add(c);
    const ref = (p.metadata as { referencedGeometryId?: unknown }).referencedGeometryId;
    if (typeof ref === 'string') { const t = byGeom.get(ref); if (t) add(t.partId); }
  };
  const root = byGeom.get(geo);
  if (root) add(root.partId);
  return out.size ? out : null;
});

const assembly = computed(() => {
  const def = fixture.value?.definition;
  const id = fixture.value?.id;
  if (!def || !id || !def.parts?.length) return null;
  return {
    fixtureId: id,
    parts: def.parts,
    models: def.models ?? [],
    motionAxes: correctedAxes.value,
    selectedModeGeometryId: selectedModeGeometry.value,
  };
});

const partName = (id: string | null | undefined): string => {
  if (!id) return '';
  return fixture.value?.definition.parts.find((p) => p.partId === id)?.name ?? id;
};
const partTag = (id: string | null | undefined): string | undefined =>
  id ? fixture.value?.definition.parts.find((p) => p.partId === id)?.tag : undefined;

/**
 * Effective axis type. Stored axisType can be OTHER (older imports / unnamed
 * axes), so fall back to the controlled part's tag — YOKE→PAN, HEAD→TILT —
 * matching the assembly's motion-node resolution. Used for labels and rotation.
 */
function effectiveAxisType(a: MotionAxis): MotionAxis['axisType'] {
  if (a.axisType === 'PAN' || a.axisType === 'TILT') return a.axisType;
  const tag = partTag(a.controlledPartId);
  const name = (a.sourceGdtfGeometryId ?? '').toLowerCase();
  if (tag === 'YOKE' || name.includes('pan')) return 'PAN';
  if (tag === 'HEAD' || name.includes('tilt')) return 'TILT';
  return a.axisType;
}

/**
 * Pan/Tilt angular range (degrees) from the stored DMX mapping — the Pan/Tilt
 * channel functions' physical range. This is captured at import for every
 * fixture, so it gives the real range without re-importing (the motionRig's own
 * min/max may still be the ±270 parser default on older imports).
 */
function dmxRangeFor(type: 'PAN' | 'TILT'): { min: number; max: number } | null {
  const attr = type === 'PAN' ? 'pan' : 'tilt';
  const modes = (fixture.value?.definition.dmxMapping as { modes?: unknown })?.modes;
  if (!Array.isArray(modes)) return null;
  for (const mode of modes as Array<Record<string, unknown>>) {
    const channels = Array.isArray(mode.channels) ? mode.channels as Array<Record<string, unknown>> : [];
    for (const ch of channels) {
      const lcs = Array.isArray(ch.logicalChannels) ? ch.logicalChannels as Array<Record<string, unknown>> : [];
      for (const lc of lcs) {
        const fns = Array.isArray(lc.functions) ? lc.functions as Array<Record<string, unknown>> : [];
        for (const fn of fns) {
          const a = String(fn.attribute ?? lc.attribute ?? '').toLowerCase();
          if (a !== attr) continue;
          const pf = parseFloat(String(fn.physicalFrom ?? ''));
          const pt = parseFloat(String(fn.physicalTo ?? ''));
          if (!Number.isNaN(pf) && !Number.isNaN(pt) && Math.abs(pt - pf) > 1) {
            return { min: Math.min(pf, pt), max: Math.max(pf, pt) };
          }
        }
      }
    }
  }
  return null;
}

/** Motion rig with axis types normalised + real range from the DMX mapping. */
const correctedAxes = computed<MotionAxis[]>(() =>
  (fixture.value?.definition.motionRig ?? []).map((a) => {
    const axisType = effectiveAxisType(a);
    const range = (axisType === 'PAN' || axisType === 'TILT') ? dmxRangeFor(axisType) : null;
    return { ...a, axisType, ...(range ? { minValue: range.min, maxValue: range.max } : {}) };
  }),
);

/** Motion axes to expose as sliders — scoped to the selected mode. */
const motionControls = computed(() => {
  const vis = visiblePartIds.value;
  return correctedAxes.value
    .filter((a) => !vis || (a.controlledPartId ? vis.has(a.controlledPartId) : true))
    .map((a) => ({
      axis: a,
      label: `${a.axisType}${a.controlledPartId ? ` · ${partName(a.controlledPartId)}` : ''}`,
    }));
});

/** Beam-sim cone: lens diameter (start) + beam angle / zoom range. */
const beamSpec = computed(() => {
  const def = fixture.value?.definition;
  const beam = def?.beams?.[0];
  if (!def || !beam) return null;
  const parent = def.parts.find((p) => p.partId === beam.parentPartId);
  const model = parent?.modelId ? def.models.find((m) => m.modelId === parent.modelId) : undefined;
  const meta = (model?.metadata ?? {}) as Record<string, unknown>;
  const len = typeof meta.length === 'number' ? meta.length : 0;
  const wid = typeof meta.width === 'number' ? meta.width : 0;
  const lensDiameter = Math.max(len, wid) || 0.08;
  return {
    lensDiameter,
    beamAngle: beam.beamAngle ?? beam.fieldAngle ?? 20,
    zoomMin: beam.zoomMinAngle,
    zoomMax: beam.zoomMaxAngle,
  };
});

const meshRecords = computed(() => {
  if (!fixture.value) return [];
  const def = fixture.value.definition;
  const vis = visiblePartIds.value;
  return def.parts
    .map((part, idx) => {
      const model = def.models.find((m) => m.modelId === part.modelId);
      const vtx = meshVertexCount(part.metadata) ?? (model ? meshVertexCount(model.metadata) : null);
      return { idx, part, model, vtx };
    })
    .filter((r) => !vis || vis.has(r.part.partId));
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

// Default the selected mode, and (re)seed motion-axis angles to their defaults.
watch(modes, (m) => {
  if (!m.some((x) => x.modeId === selectedModeId.value)) selectedModeId.value = m[0]?.modeId ?? null;
}, { immediate: true });

watch(motionControls, (controls) => {
  const next: Record<string, number> = {};
  for (const c of controls) next[c.axis.motionAxisId] = motionAngles.value[c.axis.motionAxisId] ?? c.axis.defaultValue ?? 0;
  motionAngles.value = next;
  appliedAngles.value = { ...next };
}, { immediate: true });

// ---- Pan/Tilt fade animation: ease applied angle to target over RealFade ----
const axisById = computed(() => new Map(correctedAxes.value.map((a) => [a.motionAxisId, a])));
interface Tween { from: number; to: number; t0: number; dur: number }
const tweens = new Map<string, Tween>();
let motionRaf: number | null = null;

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function motionTick(): void {
  const now = performance.now();
  let active = false;
  const next = { ...appliedAngles.value };
  for (const [id, tw] of [...tweens.entries()]) {
    const p = tw.dur > 0 ? Math.min((now - tw.t0) / tw.dur, 1) : 1;
    next[id] = tw.from + (tw.to - tw.from) * easeInOut(p);
    if (p >= 1) { next[id] = tw.to; tweens.delete(id); } else active = true;
  }
  appliedAngles.value = next;
  motionRaf = active ? requestAnimationFrame(motionTick) : null;
}

function startTween(id: string, to: number): void {
  const from = appliedAngles.value[id] ?? to;
  if (!liveFade.value) { appliedAngles.value = { ...appliedAngles.value, [id]: to }; return; }
  const a = axisById.value.get(id);
  const range = a ? Math.max(Math.abs((a.maxValue ?? 270) - (a.minValue ?? -270)), 1) : 360;
  // RealFade is the seconds for a full-range move; scale by the move's fraction.
  const fadeSec = typeof a?.realFade === 'number' && a.realFade > 0 ? a.realFade : 0.6;
  const dur = Math.max((fadeSec * Math.abs(to - from)) / range * 1000, 60);
  tweens.set(id, { from, to, t0: performance.now(), dur });
  if (motionRaf == null) motionRaf = requestAnimationFrame(motionTick);
}

watch(motionAngles, (target) => {
  for (const [id, v] of Object.entries(target)) {
    if (appliedAngles.value[id] === undefined) {
      appliedAngles.value = { ...appliedAngles.value, [id]: v };
    } else if (v !== (tweens.get(id)?.to ?? appliedAngles.value[id])) {
      startTween(id, v);
    }
  }
}, { deep: true });

onBeforeUnmount(() => { if (motionRaf != null) cancelAnimationFrame(motionRaf); });

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
        <Icon name="arrow_back" :size="14" /> Back to editor
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
          <div v-if="modes.length" class="slider-row mode-row">
            <span>Mode</span>
            <select v-model="selectedModeId" class="mode-select">
              <option v-for="m in modes" :key="m.modeId" :value="m.modeId">{{ m.name }}</option>
            </select>
          </div>
          <label class="check-row">
            <input v-model="showBeam" type="checkbox" />
            Light beam origin + direction
          </label>
          <label v-if="motionControls.length" class="check-row">
            <input v-model="liveFade" type="checkbox" />
            Animate movement (speed/fade)
          </label>
          <div class="slider-row">
            <span>Dimmer</span>
            <input v-model.number="dimmer" type="range" min="0" max="1" step="0.01" class="range-orange" />
            <span class="mono">{{ Math.round(dimmer * 100) }}%</span>
          </div>
          <div v-for="c in motionControls" :key="c.axis.motionAxisId" class="slider-row">
            <span :title="c.label">{{ c.label }}</span>
            <input
              v-model.number="motionAngles[c.axis.motionAxisId]"
              type="range"
              :min="c.axis.minValue ?? -270"
              :max="c.axis.maxValue ?? 270"
              step="1"
              class="range-orange"
            />
            <span class="mono">{{ motionAngles[c.axis.motionAxisId] ?? 0 }}°</span>
          </div>
          <p v-if="!motionControls.length" class="muted small">No motion axes in this mode.</p>
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
              v-if="previewUrl || assembly"
              :url="previewUrl"
              :assembly="assembly"
              :motion-angles="appliedAngles"
              :dimmer="dimmer"
              :show-beam="showBeam"
              :beam-spec="beamSpec"
              fill
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
            v-if="previewUrl || assembly"
            :url="previewUrl"
            :assembly="assembly"
            :motion-angles="appliedAngles"
            :dimmer="dimmer"
            :show-beam="showBeam"
            :beam-spec="beamSpec"
            fill
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
.mode-row { margin-bottom: 10px; }
.mode-select {
  grid-column: 2 / 4;
  width: 100%;
  padding: 5px 8px;
  font-size: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-input);
  color: var(--color-text);
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
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  contain: strict;
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
