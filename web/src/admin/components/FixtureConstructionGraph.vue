<script setup lang="ts">
/**
 * Construction graph: visualises how a parsed GDTF maps onto the internal REBUS
 * fixture structure.
 *
 *   GDTF source ─▶ Fixture ─▶ {Fixture Information, Clamp[], Origin, Parts[],
 *                              Models[], MotionRig[], Cells[], Beams[],
 *                              DMX Mapping} ─▶ individual items
 *
 * Every node expands to show its parameters/values; Model nodes also render a
 * small 3D preview. Dashed edges show cross-references (a Part uses a Model, a
 * Beam/Motion axis attaches to a Part).
 */
import { computed, onMounted, ref } from 'vue';
import {
  VueFlow,
  Panel,
  MarkerType,
  Position,
  useVueFlow,
  type Edge,
  type Node,
  type NodeMouseEvent,
} from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import Icon from '../../shared/Icon.vue';
import FixtureViewer from './FixtureViewer.vue';
import FixtureGraphNode, { type FixtureGraphNodeData } from './FixtureGraphNode.vue';
import type {
  FixtureDefinition,
  FixturePart,
  FixtureModel,
  FixtureBeam,
  MotionAxis,
  Vec3,
} from '../../shared/api';

const props = defineProps<{
  fixtureId: string;
  definition: FixtureDefinition;
}>();

// ---------------------------------------------------------------------------
// Layout + formatting helpers
// ---------------------------------------------------------------------------
const COL_W = 320;
const ROW = 66;
const SIB_GAP = 14;

/** The standard REBUS fixture part tags every GDTF geometry is normalised into. */
const STANDARD_TAGS = ['ORIGIN', 'CLAMP', 'BASE', 'YOKE', 'HEAD', 'LENS', 'BEAM', 'CELL'] as const;
const TAG_META: Record<(typeof STANDARD_TAGS)[number], { icon: string; accent: string }> = {
  ORIGIN: { icon: 'my_location', accent: '#14b8a6' },
  CLAMP: { icon: 'precision_manufacturing', accent: '#64748b' },
  BASE: { icon: 'deployed_code', accent: '#22c55e' },
  YOKE: { icon: 'sync', accent: '#3b82f6' },
  HEAD: { icon: 'visibility', accent: '#a855f7' },
  LENS: { icon: 'lens_blur', accent: '#f59e0b' },
  BEAM: { icon: 'flare', accent: '#eab308' },
  CELL: { icon: 'grid_on', accent: '#8b5cf6' },
};

function fmtNum(n: number | undefined | null, digits = 3): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/\.?0+$/, '');
}
function mm(metres: number | undefined): string {
  if (metres === undefined || metres === null) return '—';
  return `${fmtNum(metres * 1000, 1)} mm`;
}
function vec(v: Vec3 | undefined, unit = ''): string {
  if (!v) return '—';
  return `${fmtNum(v.x)}, ${fmtNum(v.y)}, ${fmtNum(v.z)}${unit}`;
}
function str(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  return String(v);
}
function metaNum(meta: Record<string, unknown>, key: string): number | undefined {
  const v = meta?.[key];
  return typeof v === 'number' ? v : undefined;
}

const ACCENT = {
  gdtf: '#a855f7',
  fixture: 'var(--orbit-primary)',
  info: '#0ea5e9',
  clamp: '#64748b',
  origin: '#14b8a6',
  parts: '#22c55e',
  models: '#f59e0b',
  motion: '#ef4444',
  cells: '#8b5cf6',
  beams: '#eab308',
  dmx: '#ec4899',
} as const;

// ---------------------------------------------------------------------------
// Derived collections
// ---------------------------------------------------------------------------
const def = computed(() => props.definition);
const parts = computed<FixturePart[]>(() => def.value.parts ?? []);
const models = computed<FixtureModel[]>(() => def.value.models ?? []);
const beams = computed<FixtureBeam[]>(() => def.value.beams ?? []);
const motion = computed<MotionAxis[]>(() => def.value.motionRig ?? []);
const modes = computed<Array<Record<string, unknown>>>(() => {
  const raw = (def.value.dmxMapping as { modes?: unknown })?.modes;
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
});
const partById = computed(() => new Map(parts.value.map((p) => [p.partId, p])));

function partLabel(id: string | null | undefined): string {
  if (!id) return '—';
  return partById.value.get(id)?.name ?? id;
}

// ---------------------------------------------------------------------------
// DMX mode filter — declutter multi-mode fixtures (one geometry tree per mode)
// ---------------------------------------------------------------------------
const modeOptions = computed(() =>
  modes.value.map((m) => ({ id: String(m.modeId ?? m.name ?? ''), name: String(m.name ?? m.modeId ?? 'Mode') })),
);
const showModeFilter = computed(() => modeOptions.value.length > 1);
const modeFilter = ref<string>('all');

const selectedModeGeometry = computed<string | null>(() => {
  if (modeFilter.value === 'all') return null;
  const m = modes.value.find((mm) => String(mm.modeId ?? mm.name ?? '') === modeFilter.value);
  return typeof m?.geometry === 'string' ? m.geometry : null;
});

/** Part ids reachable from the selected mode's root geometry (incl. references). */
const visiblePartIds = computed<Set<string> | null>(() => {
  const geo = selectedModeGeometry.value;
  if (!geo) return null;
  const byGeom = new Map<string, FixturePart>();
  for (const p of parts.value) if (p.sourceGdtfGeometryId) byGeom.set(p.sourceGdtfGeometryId, p);
  const out = new Set<string>();
  const add = (partId: string): void => {
    if (out.has(partId)) return;
    out.add(partId);
    const p = partById.value.get(partId);
    if (!p) return;
    for (const c of p.childPartIds) add(c);
    const ref = (p.metadata as { referencedGeometryId?: unknown }).referencedGeometryId;
    if (typeof ref === 'string') { const t = byGeom.get(ref); if (t) add(t.partId); }
  };
  const root = byGeom.get(geo);
  if (root) add(root.partId);
  return out.size ? out : null;
});

// ---------------------------------------------------------------------------
// Node + edge construction
// ---------------------------------------------------------------------------
interface Built { nodes: Node[]; edges: Edge[] }

const graph = computed<Built>(() => {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const info = def.value.fixtureInformation;

  // Apply the DMX mode filter (null = show everything).
  const vis = visiblePartIds.value;
  const fParts = vis ? parts.value.filter((p) => vis.has(p.partId)) : parts.value;
  const visModelIds = new Set(fParts.map((p) => p.modelId).filter((id): id is string => !!id));
  const fModels = vis
    ? models.value.filter((m) => (m.assignedPartIds ?? []).some((id) => vis.has(id)) || visModelIds.has(m.modelId))
    : models.value;
  const fBeams = vis ? beams.value.filter((b) => !!b.parentPartId && vis.has(b.parentPartId)) : beams.value;
  const fMotion = vis ? motion.value.filter((a) => !!a.controlledPartId && vis.has(a.controlledPartId)) : motion.value;
  const fModes = modeFilter.value === 'all'
    ? modes.value
    : modes.value.filter((m) => String(m.modeId ?? m.name ?? '') === modeFilter.value);

  const node = (id: string, x: number, y: number, data: FixtureGraphNodeData): void => {
    nodes.push({ id, type: 'fixtureNode', position: { x, y }, data, draggable: true,
      width: 252, sourcePosition: Position.Right, targetPosition: Position.Left });
  };
  const arrow = (accent: string): Partial<Edge> => ({
    style: { stroke: accent, strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: accent },
  });
  const edge = (source: string, target: string, accent: string): void => {
    edges.push({
      id: `e:${source}->${target}`,
      source,
      target,
      type: 'smoothstep',
      ...arrow(accent),
    });
  };

  // ---- linked-element index: each part owns its model + motion + beams ------
  const modelById = new Map(fModels.map((m) => [m.modelId, m]));
  const motionByPart = new Map<string, MotionAxis[]>();
  for (const a of fMotion) {
    if (!a.controlledPartId) continue;
    (motionByPart.get(a.controlledPartId) ?? motionByPart.set(a.controlledPartId, []).get(a.controlledPartId)!).push(a);
  }
  const beamsByPart = new Map<string, FixtureBeam[]>();
  for (const b of fBeams) {
    if (!b.parentPartId) continue;
    (beamsByPart.get(b.parentPartId) ?? beamsByPart.set(b.parentPartId, []).get(b.parentPartId)!).push(b);
  }

  interface TNode { id: string; data: FixtureGraphNodeData; children: TNode[] }

  const modelChild = (m: FixtureModel, partId: string): TNode => ({
    id: `model:${m.modelId}@${partId}`,
    children: [],
    data: {
      kind: 'model', title: m.modelId, subtitle: m.sourceFile, icon: 'deployed_code', accent: ACCENT.models,
      modelPreview: { fixtureId: props.fixtureId, parts: [previewPart(m)], models: [m] },
      params: [
        { label: 'Source file', value: str(m.sourceFile) },
        { label: 'Part tag', value: str(m.partTag) },
        { label: 'Assigned to', value: String(m.assignedPartIds?.length ?? 0) },
        { label: 'Length', value: mm(metaNum(m.metadata, 'length')) },
        { label: 'Width', value: mm(metaNum(m.metadata, 'width')) },
        { label: 'Height', value: mm(metaNum(m.metadata, 'height')) },
        { label: 'Mesh entry', value: str(m.metadata?.modelEntry) },
        { label: 'Media id', value: str(m.metadata?.mediaId) },
      ],
    },
  });

  const motionChild = (a: MotionAxis): TNode => ({
    id: `motion:${a.motionAxisId}`,
    children: [],
    data: {
      kind: 'motion', title: a.axisType, subtitle: 'motion axis', icon: 'rotate_right', accent: ACCENT.motion,
      params: [
        { label: 'Axis type', value: str(a.axisType) },
        { label: 'Controls', value: partLabel(a.controlledPartId) },
        { label: 'Axis vector', value: vec(a.axisVector) },
        { label: 'Pivot', value: vec(a.pivot, ' m') },
        { label: 'Min', value: fmtNum(a.minValue) },
        { label: 'Max', value: fmtNum(a.maxValue) },
        { label: 'Default', value: fmtNum(a.defaultValue) },
      ],
    },
  });

  const beamChild = (b: FixtureBeam): TNode => ({
    id: `beam:${b.beamId}`,
    children: [],
    data: {
      kind: 'beam', title: b.beamType || 'Beam', subtitle: 'REBUS beam', icon: 'wb_incandescent', accent: ACCENT.beams,
      params: [
        { label: 'Type', value: str(b.beamType) },
        { label: 'Beam angle', value: b.beamAngle !== undefined ? `${fmtNum(b.beamAngle)}°` : '—' },
        { label: 'Field angle', value: b.fieldAngle !== undefined ? `${fmtNum(b.fieldAngle)}°` : '—' },
        { label: 'Lum. flux', value: b.luminousFlux !== undefined ? `${fmtNum(b.luminousFlux)} lm` : '—' },
        { label: 'Colour temp', value: b.colourTemperature !== undefined ? `${fmtNum(b.colourTemperature)} K` : '—' },
        { label: 'IES profile', value: b.iesAssetId ? 'attached' : '—' },
      ],
    },
  });

  const partNode = (p: FixturePart): TNode => {
    const children: TNode[] = [];
    if (p.modelId && modelById.has(p.modelId)) children.push(modelChild(modelById.get(p.modelId)!, p.partId));
    for (const a of motionByPart.get(p.partId) ?? []) children.push(motionChild(a));
    for (const b of beamsByPart.get(p.partId) ?? []) children.push(beamChild(b));
    return {
      id: `part:${p.partId}`,
      children,
      data: {
        kind: 'part', title: p.name, subtitle: p.tag, icon: 'category', accent: TAG_META[p.tag]?.accent ?? ACCENT.parts,
        params: [
          { label: 'Tag', value: str(p.tag) },
          { label: 'GDTF geom', value: str(p.sourceGdtfGeometryId) },
          { label: 'Parent', value: partLabel(p.parentPartId) },
          { label: 'Model', value: p.modelId ? str(p.modelId) : '—' },
          { label: 'Children', value: String(p.childPartIds?.length ?? 0) },
          { label: 'Position', value: vec({ x: p.localTransform.position.x, y: p.localTransform.position.y, z: p.localTransform.position.z }, ' m') },
          { label: 'Rotation', value: vec(p.localTransform.rotation, '°') },
          { label: 'Pivot', value: vec(p.pivot, ' m') },
        ],
      },
    };
  };

  // ---- tree: GDTF → Fixture → {Information, REBUS tags…, DMX Mapping} -------
  const tagNodes: TNode[] = STANDARD_TAGS.map((tag) => {
    const ps = fParts.filter((p) => p.tag === tag);
    return {
      id: `tag:${tag}`,
      children: ps.map(partNode),
      data: {
        kind: 'category', title: tag, subtitle: 'REBUS part tag', icon: TAG_META[tag].icon,
        accent: TAG_META[tag].accent, badge: ps.length,
      },
    };
  });

  const infoNode: TNode = {
    id: 'cat:info', children: [],
    data: {
      kind: 'info', title: 'Fixture Information', icon: 'info', accent: ACCENT.info,
      params: [
        { label: 'Manufacturer', value: str(info.manufacturer) },
        { label: 'Name', value: str(info.fixtureName) },
        { label: 'Revision', value: str(info.revision) },
        { label: 'Long name', value: str(info.longName) },
        { label: 'GDTF type id', value: str(info.fixtureTypeId) },
        { label: 'Description', value: str(info.description) },
      ],
    },
  };

  const dmxNode: TNode = {
    id: 'cat:dmx',
    data: { kind: 'category', title: 'DMX Mapping', icon: 'tune', accent: ACCENT.dmx, badge: fModes.length },
    children: fModes.map((m, i) => {
      const channels = Array.isArray(m.channels) ? (m.channels as unknown[]).length : 0;
      return {
        id: `mode:${i}`, children: [],
        data: {
          kind: 'dmxmode', title: str(m.name), subtitle: `${str(m.footprint)} ch`, icon: 'settings_input_component', accent: ACCENT.dmx,
          params: [
            { label: 'Name', value: str(m.name) },
            { label: 'Footprint', value: str(m.footprint) },
            { label: 'Root geom', value: str(m.geometry) },
            { label: 'Channels', value: String(channels) },
          ],
        },
      };
    }),
  };

  const fixtureNode: TNode = {
    id: 'fixture',
    children: [infoNode, ...tagNodes, dmxNode],
    data: {
      kind: 'fixture', title: info.fixtureName || 'Fixture', subtitle: info.manufacturer, icon: 'lightbulb', accent: ACCENT.fixture,
      params: [
        { label: 'Parts', value: String(parts.value.length) },
        { label: 'Models', value: String(models.value.length) },
        { label: 'Beams', value: String(beams.value.length) },
        { label: 'Motion axes', value: String(motion.value.length) },
        { label: 'DMX modes', value: String(modes.value.length) },
      ],
    },
  };

  const gdtfNode: TNode = {
    id: 'gdtf',
    children: [fixtureNode],
    data: {
      kind: 'gdtf', title: 'GDTF Source', subtitle: info.fixtureTypeId, icon: 'folder_zip', accent: ACCENT.gdtf, noTarget: true,
      params: [
        { label: 'Manufacturer', value: str(info.manufacturer) },
        { label: 'Fixture', value: str(info.fixtureName) },
        { label: 'Revision', value: str(info.revision) },
        { label: 'Parser', value: str(def.value.metadata?.parserVersion) },
        { label: 'Pkg entries', value: str(def.value.metadata?.packageEntryCount) },
        { label: 'Qualities', value: arr(def.value.metadata?.availableModelQualities) },
        { label: 'Formats', value: arr(def.value.metadata?.availableModelFormats) },
      ],
    },
  };

  // ---- layered layout: x = depth, y = leaf cursor; parents centre on kids --
  let cursor = 0;
  const place = (n: TNode, depth: number): number => {
    const x = depth * COL_W;
    let yPos: number;
    if (!n.children.length) {
      yPos = cursor;
      cursor += ROW;
    } else {
      const ys: number[] = [];
      n.children.forEach((c, i) => {
        ys.push(place(c, depth + 1));
        if (i < n.children.length - 1) cursor += SIB_GAP;
      });
      yPos = (ys[0]! + ys[ys.length - 1]!) / 2;
    }
    node(n.id, x, yPos, n.data);
    for (const c of n.children) edge(n.id, c.id, c.data.accent ?? 'var(--color-border-strong)');
    return yPos;
  };
  place(gdtfNode, 0);

  return { nodes, edges };
});

function arr(v: unknown): string {
  return Array.isArray(v) && v.length ? v.join(', ') : '—';
}

function previewPart(m: FixtureModel): FixturePart {
  return {
    partId: `preview:${m.modelId}`,
    name: m.modelId,
    tag: m.partTag ?? 'BASE',
    childPartIds: [],
    modelId: m.modelId,
    localTransform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      matrix4x4: [],
    },
    metadata: {},
  };
}

const { fitView } = useVueFlow();

function doFit(): void {
  // Defer so the DOM/measure pass has run; guard against transient errors.
  requestAnimationFrame(() => {
    try { fitView({ padding: 0.2 }); } catch { /* viewport not ready */ }
  });
}

// Custom nodes have no measured size at init, so fitting too early produces an
// empty bound and a blank canvas. Fit once nodes are measured, plus a fallback.
function onNodesInitialized(): void { doFit(); }

onMounted(() => { setTimeout(doFit, 60); });

function fitReset(): void { doFit(); }

// ---------------------------------------------------------------------------
// Selection → inspector panel
// ---------------------------------------------------------------------------
const selectedId = ref<string | null>(null);
const selected = computed<FixtureGraphNodeData | null>(() => {
  if (!selectedId.value) return null;
  const n = graph.value.nodes.find((nn) => nn.id === selectedId.value);
  return (n?.data as FixtureGraphNodeData) ?? null;
});

function onNodeClick(e: NodeMouseEvent): void {
  selectedId.value = e.node.id;
}
</script>

<template>
  <div class="cg-layout">
    <div class="cg-wrap">
      <VueFlow
        :nodes="graph.nodes"
        :edges="graph.edges"
        :nodes-draggable="true"
        drag-handle=".node-drag-handle"
        :nodes-connectable="false"
        :elements-selectable="true"
        :zoom-on-double-click="false"
        :min-zoom="0.1"
        :max-zoom="2"
        @nodes-initialized="onNodesInitialized"
        @node-click="onNodeClick"
      >
        <template #node-fixtureNode="nodeProps">
          <FixtureGraphNode :data="nodeProps.data" />
        </template>

        <Background pattern-color="var(--color-border)" :gap="22" />
        <Controls :show-interactive="false" />

        <Panel position="top-left" class="cg-legend">
          <span class="cg-legend-title"><Icon name="schema" :size="14" /> GDTF → REBUS</span>
          <label v-if="showModeFilter" class="cg-mode">
            <span>Mode</span>
            <select v-model="modeFilter">
              <option value="all">All modes</option>
              <option v-for="m in modeOptions" :key="m.id" :value="m.id">{{ m.name }}</option>
            </select>
          </label>
          <button type="button" class="cg-reset" title="Re-fit view" @click="fitReset">
            <Icon name="fit_screen" :size="15" />
          </button>
        </Panel>
      </VueFlow>
    </div>

    <aside class="cg-inspector">
      <div v-if="!selected" class="cg-empty">
        <Icon name="ads_click" :size="22" />
        <p>Select a node to see its properties.</p>
      </div>

      <template v-else>
        <header class="cg-insp-head" :style="{ '--accent': selected.accent ?? 'var(--orbit-primary)' }">
          <span class="cg-insp-icon"><Icon :name="selected.icon" :size="18" /></span>
          <div class="cg-insp-titles">
            <h3>{{ selected.title }}</h3>
            <span v-if="selected.subtitle" class="cg-insp-sub">{{ selected.subtitle }}</span>
          </div>
          <span class="cg-insp-kind">{{ selected.kind }}</span>
        </header>

        <div v-if="selected.modelPreview" class="cg-insp-preview">
          <FixtureViewer
            :assembly="{ fixtureId: selected.modelPreview.fixtureId, parts: selected.modelPreview.parts, models: selected.modelPreview.models }"
            :interactive="true"
            light-background
            fill
          />
        </div>

        <dl v-if="selected.params?.length" class="cg-insp-params">
          <div v-for="(p, i) in selected.params" :key="i" class="cg-insp-row">
            <dt :title="p.label">{{ p.label }}</dt>
            <dd :title="p.value">{{ p.value }}</dd>
          </div>
        </dl>
        <p v-else-if="!selected.modelPreview" class="cg-empty-small">No parameters.</p>
      </template>
    </aside>
  </div>
</template>

<style scoped>
.cg-layout {
  display: flex;
  gap: 12px;
  width: 100%;
  height: 100%;
  min-height: 480px;
}
.cg-wrap {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg);
  overflow: hidden;
}
.cg-wrap :deep(.vue-flow__node) { pointer-events: all !important; }
.cg-wrap :deep(.vue-flow__node.selected) .fg-node {
  border-color: var(--accent, var(--orbit-primary));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--orbit-primary) 45%, transparent);
}

.cg-inspector {
  flex: 0 0 320px;
  width: 320px;
  height: 100%;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-elevated);
}
.cg-empty,
.cg-empty-small {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--color-text-muted);
  text-align: center;
}
.cg-empty { height: 100%; justify-content: center; padding: 24px; }
.cg-empty-small { padding: 14px; font-size: 12px; }

.cg-insp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px;
  border-bottom: 1px solid var(--color-border);
  border-left: 3px solid var(--accent);
}
.cg-insp-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent);
  flex: 0 0 auto;
}
.cg-insp-titles { min-width: 0; flex: 1; }
.cg-insp-titles h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text);
  word-break: break-word;
}
.cg-insp-sub { font-size: 12px; color: var(--color-text-muted); }
.cg-insp-kind {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  padding: 2px 7px;
  border-radius: 9px;
}

.cg-insp-preview {
  height: 200px;
  margin: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--color-bg);
}

.cg-insp-params { margin: 0; padding: 8px 14px 16px; display: flex; flex-direction: column; gap: 2px; }
.cg-insp-row {
  display: grid;
  grid-template-columns: 108px 1fr;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--color-border);
}
.cg-insp-row:last-child { border-bottom: none; }
.cg-insp-row dt { margin: 0; color: var(--color-text-muted); font-size: 12px; }
.cg-insp-row dd {
  margin: 0;
  color: var(--color-text);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  word-break: break-word;
}

@media (max-width: 1100px) {
  .cg-layout { flex-direction: column; }
  .cg-inspector { flex: 0 0 auto; width: 100%; height: 280px; }
}

.cg-legend {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
}
.cg-legend-title { display: inline-flex; align-items: center; gap: 6px; }
.cg-mode { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; }
.cg-mode > span { color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.cg-mode select {
  font-size: 12px;
  padding: 3px 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-input);
  color: var(--color-text);
  max-width: 200px;
}
.cg-reset {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.cg-reset:hover { background: var(--color-bg-hover); color: var(--color-text); }
</style>

<style>
.vue-flow__node-fixtureNode {
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 0;
  box-shadow: none;
  width: auto;
}
.vue-flow__node-fixtureNode .node-drag-handle { cursor: grab; }
.vue-flow__node-fixtureNode .node-drag-handle:active { cursor: grabbing; }
.vue-flow__node-fixtureNode .vue-flow__handle {
  width: 8px;
  height: 8px;
  background: var(--color-border-strong);
  border: 1.5px solid var(--color-bg-elevated);
}
</style>
