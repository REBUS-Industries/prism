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

const props = defineProps<{ fixture: FixtureDetail }>();
const fixture = toRef(props, 'fixture');

const dimmer = ref(0.5);
const showBeam = ref(true);
/** 0 = wide beam, 1 = narrow beam (fixture zoom range). */
const zoomT = ref(0);
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

/** Zoom range from fixture beams (wide = max angle, narrow = min angle). */
const zoomRange = computed(() => {
  const def = fixture.value.definition;
  for (const b of def.beams ?? []) {
    const min = b.zoomMinAngle;
    const max = b.zoomMaxAngle;
    if (min != null && max != null && max > min) return { wide: max, narrow: min };
  }
  return null;
});

const hasZoomRange = computed(() => zoomRange.value != null);

const zoomBeamAngle = computed(() => {
  const r = zoomRange.value;
  if (!r) return null;
  return r.wide + (r.narrow - r.wide) * zoomT.value;
});

const beamSpecs = computed(() => {
  const def = fixture.value.definition;
  const vis = visiblePartIds.value;
  const inMode = (id: string | null | undefined): boolean => !vis || (id ? vis.has(id) : true);

  const primary = def.beams?.[0];
  const fallbackAngle = primary?.beamAngle ?? primary?.fieldAngle ?? 20;
  const zoomed = zoomBeamAngle.value;

  const diameter = (partId: string | null | undefined): number => {
    const part = def.parts.find((p) => p.partId === partId);
    const model = part?.modelId ? def.models.find((m) => m.modelId === part.modelId) : undefined;
    const meta = (model?.metadata ?? {}) as Record<string, unknown>;
    const len = typeof meta.length === 'number' ? meta.length : 0;
    const wid = typeof meta.width === 'number' ? meta.width : 0;
    return Math.max(len, wid) || 0.08;
  };

  const angleFor = (base: number | undefined): number =>
    zoomed ?? base ?? fallbackAngle;

  const emitters = def.parts.filter(
    (p) => (p.tag === 'LENS' || p.tag === 'CELL') && p.modelId && inMode(p.partId),
  );
  if (emitters.length) {
    return emitters.map((p) => ({
      parentPartId: p.partId,
      lensDiameter: diameter(p.partId),
      beamAngle: angleFor(fallbackAngle),
    }));
  }

  return (def.beams ?? [])
    .filter((b) => inMode(b.parentPartId))
    .map((b) => ({
      parentPartId: b.parentPartId ?? null,
      lensDiameter: diameter(b.parentPartId),
      beamAngle: angleFor(b.beamAngle ?? b.fieldAngle),
    }));
});

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
      </aside>

      <section class="fg-control-viewer">
        <div class="fg-control-viewer-canvas">
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
  grid-template-columns: minmax(260px, 300px) minmax(0, 1fr);
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
