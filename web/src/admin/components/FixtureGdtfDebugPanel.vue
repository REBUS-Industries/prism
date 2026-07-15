<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from 'vue';
import FixtureViewer from './FixtureViewer.vue';
import ParamSlider from './ParamSlider.vue';
import {
  fixturesApi,
  type FixtureDetail,
  type FixturePart,
  type MotionAxis,
} from '../../shared/api';
import { fixtureZOffsetM, readClampPlacement } from '../utils/fixturePlacement';
import { buildFixtureBeamSpecs } from '../utils/fixtureBeamSpecs';
import { ensureTransform, metresToMm, mmToMetres } from '../utils/fixtureTransform';
import { setPartPivotPosition } from '../utils/fixturePivot';

const props = defineProps<{
  fixture: FixtureDetail;
  /** Bump from parent after external assembly rebuilds. */
  assemblyRevision?: number;
  transformRevision?: number;
}>();
const emit = defineEmits<{
  change: [kind?: 'transform' | 'structure'];
}>();

const fixture = toRef(props, 'fixture');

const dimmer = ref(0.5);
const showBeam = ref(true);
/** 0 = wide beam, 1 = narrow beam (fixture zoom range). */
const zoomT = ref(0);
const motionAngles = ref<Record<string, number>>({});
const appliedAngles = ref<Record<string, number>>({});
const liveFade = ref(true);
const selectedAxisId = ref<string | null>(null);
const selectedPartId = ref<string | null>(null);

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

/** Zoom range from any beam that carries DMX zoom angles (prefer non-CELL emission). */
const zoomRange = computed(() => {
  const def = fixture.value.definition;
  const parts = def.parts ?? [];
  const isCell = (partId: string | null | undefined): boolean => {
    if (!partId) return false;
    const p = parts.find((x) => x.partId === partId);
    return p?.tag === 'CELL' || (p?.metadata as { isGeometryReference?: boolean })?.isGeometryReference === true;
  };
  let cell: { wide: number; narrow: number } | null = null;
  for (const b of def.beams ?? []) {
    const min = b.zoomMinAngle;
    const max = b.zoomMaxAngle;
    if (min == null || max == null || max <= min) continue;
    const range = { wide: max, narrow: min };
    if (!isCell(b.parentPartId)) return range;
    cell ??= range;
  }
  return cell;
});

const hasZoomRange = computed(() => zoomRange.value != null);

const zoomBeamAngle = computed(() => {
  const r = zoomRange.value;
  if (!r) return null;
  return r.wide + (r.narrow - r.wide) * zoomT.value;
});

const beamSpecs = computed(() =>
  buildFixtureBeamSpecs(fixture.value.definition, {
    visiblePartIds: visiblePartIds.value,
    zoomBeamAngle: zoomBeamAngle.value,
  }),
);

watch(modes, (m) => {
  if (!m.some((x) => x.modeId === selectedModeId.value)) selectedModeId.value = m[0]?.modeId ?? null;
}, { immediate: true });

watch(motionControls, (controls) => {
  const next: Record<string, number> = {};
  for (const c of controls) next[c.axis.motionAxisId] = motionAngles.value[c.axis.motionAxisId] ?? c.axis.defaultValue ?? 0;
  motionAngles.value = next;
  appliedAngles.value = { ...next };
  if (!controls.some((c) => c.axis.motionAxisId === selectedAxisId.value)) {
    selectedAxisId.value = controls[0]?.axis.motionAxisId ?? null;
  }
}, { immediate: true });

const selectedAxis = computed(() =>
  motionControls.value.find((c) => c.axis.motionAxisId === selectedAxisId.value)?.axis ?? null,
);

const selectedControlledPart = computed<FixturePart | null>(() => {
  const id = selectedAxis.value?.controlledPartId;
  if (!id) return null;
  return fixture.value.definition.parts.find((p) => p.partId === id) ?? null;
});

watch(selectedAxis, (axis) => {
  selectedPartId.value = axis?.controlledPartId ?? null;
}, { immediate: true });

/** Pivot = controlled part localTransform origin (parent-space mm). */
function pivotMm(axis: 'x' | 'y' | 'z'): number {
  const part = selectedControlledPart.value;
  if (!part) return 0;
  return metresToMm(ensureTransform(part.localTransform).position[axis]);
}

function setPivotMm(axis: 'x' | 'y' | 'z', mm: number): void {
  const part = selectedControlledPart.value;
  if (!part) return;
  const t = ensureTransform(part.localTransform);
  const next = {
    x: t.position.x,
    y: t.position.y,
    z: t.position.z,
    [axis]: mmToMetres(mm),
  };
  if (!setPartPivotPosition(fixture.value.definition, part.partId, next)) return;
  emit('change', 'transform');
}

function selectAxis(axisId: string): void {
  selectedAxisId.value = axisId;
}

function onSelectPart(partId: string): void {
  selectedPartId.value = partId;
  const match = motionControls.value.find((c) => c.axis.controlledPartId === partId);
  if (match) selectedAxisId.value = match.axis.motionAxisId;
}

/** Part ids that have a motion axis — show pivot markers at group origins. */
const pivotPartIds = computed(() =>
  motionControls.value
    .map((c) => c.axis.controlledPartId)
    .filter((id): id is string => !!id),
);

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
</script>

<template>
  <div class="fg-control">
    <div class="fg-control-split">
      <aside class="fg-control-sidebar">
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
          <div v-if="hasZoomRange" class="slider-row">
            <span>Zoom</span>
            <input v-model.number="zoomT" type="range" min="0" max="1" step="0.01" class="range-orange" />
            <span class="mono">{{ (zoomBeamAngle ?? 0).toFixed(1) }}°</span>
          </div>
          <p v-if="hasZoomRange" class="muted small zoom-note">
            {{ zoomRange!.wide.toFixed(1) }}° wide → {{ zoomRange!.narrow.toFixed(1) }}° narrow
          </p>
          <p v-if="!motionControls.length" class="muted small">No motion axes in this mode.</p>
          <p v-if="fixture.definition.beams.length" class="muted small ies-note">
            IES: {{ fixture.definition.beams[0].beamType ?? 'beam' }}
            <span v-if="fixture.definition.beams[0].luminousFlux">
              · {{ fixture.definition.beams[0].luminousFlux }} lm
            </span>
          </p>
        </section>

        <section v-if="motionControls.length" class="ctrl-block">
          <h3>Axis pivot</h3>
          <p class="muted small pivot-intro">
            Click a mesh in the viewer or pick an axis. The pivot is where pan/tilt
            rotates — moving it keeps the mesh in place. Save the fixture to persist.
          </p>
          <div class="axis-pick-list">
            <button
              v-for="c in motionControls"
              :key="c.axis.motionAxisId"
              type="button"
              class="axis-pick"
              :class="{ active: selectedAxisId === c.axis.motionAxisId }"
              @click="selectAxis(c.axis.motionAxisId)"
            >
              <strong>{{ c.axis.axisType }}</strong>
              <span class="muted">{{ c.axis.controlledPartId ? partName(c.axis.controlledPartId) : '—' }}</span>
            </button>
          </div>
          <template v-if="selectedControlledPart">
            <p class="muted small pivot-part">
              Mesh · {{ selectedControlledPart.name }}
              <span class="pill">{{ selectedControlledPart.tag }}</span>
            </p>
            <ParamSlider
              label="Pivot X"
              sublabel="mm"
              :min="-2000"
              :max="2000"
              :step="1"
              :model-value="pivotMm('x')"
              @update:model-value="(v) => setPivotMm('x', v)"
            />
            <ParamSlider
              label="Pivot Y"
              sublabel="mm"
              :min="-2000"
              :max="2000"
              :step="1"
              :model-value="pivotMm('y')"
              @update:model-value="(v) => setPivotMm('y', v)"
            />
            <ParamSlider
              label="Pivot Z"
              sublabel="mm"
              :min="-2000"
              :max="2000"
              :step="1"
              :model-value="pivotMm('z')"
              @update:model-value="(v) => setPivotMm('z', v)"
            />
          </template>
          <p v-else class="muted small">Select a motion axis that controls a part.</p>
        </section>
      </aside>

      <section class="fg-control-viewer">
        <div class="fg-control-viewer-canvas">
          <FixtureViewer
            v-if="previewUrl || assembly"
            :url="previewUrl"
            :assembly="assembly"
            :assembly-revision="assemblyRevision ?? 0"
            :transform-revision="transformRevision ?? 0"
            :motion-angles="appliedAngles"
            :dimmer="dimmer"
            :show-beam="showBeam"
            :beams="beamSpecs"
            :pivot-part-ids="pivotPartIds"
            :editable="!!assembly"
            :show-gizmo="false"
            :selected-part-id="selectedPartId"
            fill
            light-background
            @select-part="onSelectPart"
            @select-datum="onSelectPart"
          />
          <p v-else class="muted no-preview">No GLB preview available.</p>
        </div>
        <p class="muted small viewer-hint">Orange / cyan markers show axis pivots · click a mesh to select its axis</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.fg-control {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.fg-control-split {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(280px, 320px) minmax(0, 1fr);
  gap: 0;
  overflow: hidden;
}

.fg-control-sidebar {
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 12px 0 0;
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.fg-control-viewer {
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding-left: 12px;
}

.fg-control-viewer-canvas {
  flex: 1;
  min-height: 0;
  position: relative;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: #e8eaed;
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
.zoom-note { margin: 0 0 4px; }
.pivot-intro { margin: 0 0 10px; line-height: 1.4; }
.pivot-part {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 10px;
}
.pivot-part .pill {
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.axis-pick-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}
.axis-pick {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.axis-pick:hover { border-color: var(--orbit-primary); }
.axis-pick.active {
  border-color: var(--orbit-primary);
  background: color-mix(in srgb, var(--orbit-primary) 12%, transparent);
}
.axis-pick strong { font-size: 12px; }
.viewer-hint { margin: 8px 0 0; }

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
  .fg-control-split {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(200px, 35%) minmax(0, 1fr);
  }
  .fg-control-sidebar {
    border-right: none;
    border-bottom: 1px solid var(--color-border);
    padding: 0 0 10px;
  }
  .fg-control-viewer { padding-left: 0; padding-top: 10px; }
}
</style>
