<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from 'vue';
import FixtureViewer from './FixtureViewer.vue';
import {
  fixturesApi,
  type FixtureDetail,
  type FixturePart,
  type MotionAxis,
} from '../../shared/api';
import { fixtureZOffsetM, readClampPlacement } from '../utils/fixturePlacement';
import {
  buildDebugBundle,
  buildFullMeshesJson,
  buildSummaryJson,
  downloadJson,
  meshVertexCount,
} from '../utils/gdtfDebugExport';

const props = defineProps<{ fixture: FixtureDetail }>();
const fixture = toRef(props, 'fixture');

const viewTab = ref<'preview' | 'raw'>('preview');
const rawJson = ref('');

const dimmer = ref(0.5);
const showBeam = ref(true);
const selectedPartId = ref<string | null>(null);
const motionAngles = ref<Record<string, number>>({});
const appliedAngles = ref<Record<string, number>>({});
const liveFade = ref(true);

const previewUrl = computed(() =>
  fixture.value.hasPreview ? fixturesApi.previewUrl(fixture.value.id) : null,
);

interface DebugMode { modeId: string; name: string; geometry?: string }
const modes = computed<DebugMode[]>(() => {
  const raw = (fixture.value.definition?.dmxMapping as { modes?: unknown })?.modes;
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

const visiblePartIds = computed<Set<string> | null>(() => {
  const geo = selectedModeGeometry.value;
  const def = fixture.value.definition;
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
  const def = fixture.value.definition;
  if (!def.parts?.length) return null;
  return {
    fixtureId: fixture.value.id,
    parts: def.parts,
    models: def.models ?? [],
    motionAxes: correctedAxes.value,
    selectedModeGeometryId: selectedModeGeometry.value,
    fixtureZOffsetM: fixtureZOffsetM(def.metadata),
    clampPlacement: readClampPlacement(def.metadata),
  };
});

const partName = (id: string | null | undefined): string => {
  if (!id) return '';
  return fixture.value.definition.parts.find((p) => p.partId === id)?.name ?? id;
};
const partTag = (id: string | null | undefined): string | undefined =>
  id ? fixture.value.definition.parts.find((p) => p.partId === id)?.tag : undefined;

function effectiveAxisType(a: MotionAxis): MotionAxis['axisType'] {
  if (a.axisType === 'PAN' || a.axisType === 'TILT') return a.axisType;
  const tag = partTag(a.controlledPartId);
  const name = (a.sourceGdtfGeometryId ?? '').toLowerCase();
  if (tag === 'YOKE' || name.includes('pan')) return 'PAN';
  if (tag === 'HEAD' || name.includes('tilt')) return 'TILT';
  return a.axisType;
}

function dmxRangeFor(type: 'PAN' | 'TILT'): { min: number; max: number } | null {
  const attr = type === 'PAN' ? 'pan' : 'tilt';
  const modeList = (fixture.value.definition.dmxMapping as { modes?: unknown })?.modes;
  if (!Array.isArray(modeList)) return null;
  for (const mode of modeList as Array<Record<string, unknown>>) {
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

const correctedAxes = computed<MotionAxis[]>(() =>
  (fixture.value.definition.motionRig ?? []).map((a) => {
    const axisType = effectiveAxisType(a);
    const range = (axisType === 'PAN' || axisType === 'TILT') ? dmxRangeFor(axisType) : null;
    return { ...a, axisType, ...(range ? { minValue: range.min, maxValue: range.max } : {}) };
  }),
);

const motionControls = computed(() => {
  const vis = visiblePartIds.value;
  return correctedAxes.value
    .filter((a) => !vis || (a.controlledPartId ? vis.has(a.controlledPartId) : true))
    .map((a) => ({
      axis: a,
      label: `${a.axisType}${a.controlledPartId ? ` · ${partName(a.controlledPartId)}` : ''}`,
    }));
});

const beamSpecs = computed(() => {
  const def = fixture.value.definition;
  const vis = visiblePartIds.value;
  const inMode = (id: string | null | undefined): boolean => !vis || (id ? vis.has(id) : true);

  const primary = def.beams?.[0];
  const angle = primary?.beamAngle ?? primary?.fieldAngle ?? 20;
  const zoomMin = primary?.zoomMinAngle;
  const zoomMax = primary?.zoomMaxAngle;

  const diameter = (partId: string | null | undefined): number => {
    const part = def.parts.find((p) => p.partId === partId);
    const model = part?.modelId ? def.models.find((m) => m.modelId === part.modelId) : undefined;
    const meta = (model?.metadata ?? {}) as Record<string, unknown>;
    const len = typeof meta.length === 'number' ? meta.length : 0;
    const wid = typeof meta.width === 'number' ? meta.width : 0;
    return Math.max(len, wid) || 0.08;
  };

  const emitters = def.parts.filter(
    (p) => (p.tag === 'LENS' || p.tag === 'CELL') && p.modelId && inMode(p.partId),
  );
  if (emitters.length) {
    return emitters.map((p) => ({
      parentPartId: p.partId, lensDiameter: diameter(p.partId), beamAngle: angle, zoomMin, zoomMax,
    }));
  }

  return (def.beams ?? [])
    .filter((b) => inMode(b.parentPartId))
    .map((b) => ({
      parentPartId: b.parentPartId ?? null,
      lensDiameter: diameter(b.parentPartId),
      beamAngle: b.beamAngle ?? b.fieldAngle ?? angle,
      zoomMin: b.zoomMinAngle ?? zoomMin,
      zoomMax: b.zoomMaxAngle ?? zoomMax,
    }));
});

const meshRecords = computed(() => {
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
  fixture.value.definition.parts.find((p) => p.partId === selectedPartId.value) ?? null,
);

const exportSlug = computed(() =>
  (fixture.value.name ?? 'fixture').replace(/[^\w.-]+/g, '_'),
);

function refreshRawJson(): void {
  rawJson.value = JSON.stringify(buildDebugBundle(fixture.value), null, 2);
}

watch(() => fixture.value.id, () => {
  selectedPartId.value = fixture.value.definition.parts[0]?.partId ?? null;
  refreshRawJson();
}, { immediate: true });

watch(modes, (m) => {
  if (!m.some((x) => x.modeId === selectedModeId.value)) selectedModeId.value = m[0]?.modeId ?? null;
}, { immediate: true });

watch(motionControls, (controls) => {
  const next: Record<string, number> = {};
  for (const c of controls) next[c.axis.motionAxisId] = motionAngles.value[c.axis.motionAxisId] ?? c.axis.defaultValue ?? 0;
  motionAngles.value = next;
  appliedAngles.value = { ...next };
}, { immediate: true });

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

function exportSummary(): void {
  downloadJson(buildSummaryJson(fixture.value), `${exportSlug.value}-summary.json`);
}

function exportMeshes(): void {
  downloadJson(buildFullMeshesJson(fixture.value), `${exportSlug.value}-meshes.json`);
}

function exportBundle(): void {
  downloadJson(buildDebugBundle(fixture.value), `${exportSlug.value}-debug-bundle.json`);
}
</script>

<template>
  <div class="fg-debug">
    <header class="fg-debug-toolbar">
      <nav class="fg-debug-tabs">
        <button
          type="button"
          class="fg-debug-tab"
          :class="{ active: viewTab === 'preview' }"
          @click="viewTab = 'preview'"
        >3D preview</button>
        <button
          type="button"
          class="fg-debug-tab"
          :class="{ active: viewTab === 'raw' }"
          @click="viewTab = 'raw'; refreshRawJson()"
        >Raw JSON</button>
      </nav>
      <div class="fg-debug-exports">
        <button type="button" class="btn-outline" @click="exportSummary">Summary JSON</button>
        <button type="button" class="btn-outline" @click="exportMeshes">Full Meshes JSON</button>
        <button type="button" class="btn-primary" @click="exportBundle">Full Debug Bundle</button>
      </div>
    </header>

    <div v-if="viewTab === 'raw'" class="fg-debug-raw">
      <pre class="fg-debug-raw-text mono">{{ rawJson }}</pre>
    </div>

    <div v-else class="fg-debug-split">
      <aside class="fg-debug-controls">
        <section class="ctrl-block">
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
            IES: {{ fixture.definition.beams[0].beamType ?? 'beam' }}
            <span v-if="fixture.definition.beams[0].luminousFlux">
              · {{ fixture.definition.beams[0].luminousFlux }} lm
            </span>
          </p>
        </section>

        <section class="ctrl-block">
          <h3>Assembly</h3>
          <p class="ctrl-meta muted">{{ meshRecords.length }} mesh records<span v-if="totalVtx"> · {{ totalVtx }} vtx</span></p>
        </section>

        <section class="ctrl-block">
          <h3>Mesh records</h3>
          <ul class="ctrl-list selectable">
            <li
              v-for="rec in meshRecords"
              :key="rec.part.partId"
              class="ctrl-item clickable"
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

        <section class="ctrl-block">
          <h3>GDTF models</h3>
          <ul class="ctrl-list">
            <li v-for="m in fixture.definition.models" :key="m.modelId" class="ctrl-item">
              <span class="tag-pill">{{ m.partTag }}</span>
              <span>{{ m.modelId }}</span>
            </li>
          </ul>
        </section>

        <details v-if="sourceFiles.length" class="ctrl-block collapsible">
          <summary>Source files</summary>
          <ul class="ctrl-list mono small">
            <li v-for="f in sourceFiles" :key="f">{{ f }}</li>
          </ul>
        </details>

        <details class="ctrl-block collapsible">
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
      </aside>

      <section class="fg-debug-viewer">
        <div class="fg-debug-viewer-head">
          <h3>3D assembly</h3>
          <span v-if="selectedPart" class="muted small">{{ selectedPart.name }} ({{ selectedPart.tag }})</span>
        </div>
        <div class="fg-debug-viewer-canvas">
          <FixtureViewer
            v-if="previewUrl || assembly"
            :url="previewUrl"
            :assembly="assembly"
            :motion-angles="appliedAngles"
            :dimmer="dimmer"
            :show-beam="showBeam"
            :beams="beamSpecs"
            fill
            light-background
          />
          <p v-else class="muted no-preview">No GLB preview available.</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* Full-height shell inside the editor tab — controls left, viewer right. */
.fg-debug {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.fg-debug-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-shrink: 0;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--color-border);
}

.fg-debug-tabs { display: flex; gap: 6px; }
.fg-debug-tab {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.fg-debug-tab.active {
  color: var(--orbit-primary);
  border-color: var(--orbit-primary);
  background: var(--orbit-primary-fade);
}

.fg-debug-exports { display: flex; flex-wrap: wrap; gap: 8px; }
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

/* Main split: left controls | right viewer — fills all space below toolbar. */
.fg-debug-split {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(260px, 300px) minmax(0, 1fr);
  gap: 0;
  overflow: hidden;
}

.fg-debug-controls {
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px 12px 10px 0;
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.fg-debug-viewer {
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 10px 0 0 12px;
}

.fg-debug-viewer-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  margin-bottom: 8px;
}

.fg-debug-viewer-head h3 {
  margin: 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

.fg-debug-viewer-canvas {
  flex: 1;
  min-height: 0;
  position: relative;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: #e8eaed;
}

.fg-debug-raw {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-elevated);
}
.fg-debug-raw-text {
  margin: 0;
  padding: 16px;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.ctrl-block {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 10px;
  background: var(--color-bg-elevated);
  flex-shrink: 0;
}
.ctrl-block h3 {
  margin: 0 0 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.ctrl-meta { margin: 0; font-size: 11px; }

.ctrl-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ctrl-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.ctrl-item.clickable {
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.ctrl-item.clickable:hover { background: var(--color-bg-hover); }
.ctrl-item.selected {
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

.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 8px;
}
.slider-row {
  display: grid;
  grid-template-columns: 72px 1fr 48px;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 11px;
}
.range-orange { accent-color: var(--orbit-primary); width: 100%; }
.mode-row { margin-bottom: 8px; }
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
.ies-note { margin: 4px 0 0; }

.no-preview {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mono { font-family: var(--font-mono); }
.small { font-size: 11px; }

@media (max-width: 900px) {
  .fg-debug-split {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(200px, 35%) minmax(0, 1fr);
  }
  .fg-debug-controls {
    border-right: none;
    border-bottom: 1px solid var(--color-border);
    padding: 10px 0;
  }
  .fg-debug-viewer { padding: 10px 0 0; }
}
</style>
