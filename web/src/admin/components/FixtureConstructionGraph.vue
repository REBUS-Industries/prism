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
import { computed, ref } from 'vue';
import {
  VueFlow,
  Panel,
  MarkerType,
  Position,
  useVueFlow,
  type Edge,
  type Node,
} from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import Icon from '../../shared/Icon.vue';
import FixtureGraphNode, { type FixtureGraphNodeData, type GraphParam } from './FixtureGraphNode.vue';
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
const X = { gdtf: 0, fixture: 300, category: 600, item: 920 } as const;
const ROW = 70;
const CAT_GAP = 30;
const NODE_H = 44;

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
const cells = computed<FixturePart[]>(() => parts.value.filter((p) => p.tag === 'CELL'));
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
// Node + edge construction
// ---------------------------------------------------------------------------
interface Built { nodes: Node[]; edges: Edge[] }

const graph = computed<Built>(() => {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const info = def.value.fixtureInformation;

  const node = (id: string, x: number, y: number, data: FixtureGraphNodeData): void => {
    nodes.push({ id, type: 'fixtureNode', position: { x, y }, data, draggable: true,
      sourcePosition: Position.Right, targetPosition: Position.Left });
  };
  const edge = (source: string, target: string, opts: Partial<Edge> = {}): void => {
    edges.push({
      id: `e:${source}->${target}`,
      source,
      target,
      type: 'smoothstep',
      style: { stroke: 'var(--color-border-strong)', strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--color-border-strong)' },
      ...opts,
    });
  };
  const xref = (source: string, target: string): void => {
    edges.push({
      id: `x:${source}->${target}`,
      source,
      target,
      type: 'smoothstep',
      animated: true,
      style: { stroke: 'var(--accent, #94a3b8)', strokeWidth: 1.25, strokeDasharray: '4 4', opacity: 0.7 },
    });
  };

  // ---- column 3: items, grouped by category, single vertical cursor --------
  let y = 0;

  interface Cat {
    id: string;
    title: string;
    icon: string;
    accent: string;
    items: Array<{ id: string; data: FixtureGraphNodeData; xrefs?: string[] }>;
    /** Category-level params when it carries data directly (Info/Origin). */
    selfParams?: GraphParam[];
    selfNote?: string;
  }

  const cats: Cat[] = [
    {
      id: 'cat:info', title: 'Fixture Information', icon: 'info', accent: ACCENT.info, items: [],
      selfParams: [
        { label: 'Manufacturer', value: str(info.manufacturer) },
        { label: 'Name', value: str(info.fixtureName) },
        { label: 'Revision', value: str(info.revision) },
        { label: 'Long name', value: str(info.longName) },
        { label: 'GDTF type id', value: str(info.fixtureTypeId) },
        { label: 'Description', value: str(info.description) },
      ],
    },
    {
      id: 'cat:clamp', title: 'Clamp', icon: 'precision_manufacturing', accent: ACCENT.clamp, items: [],
      selfNote: 'Not populated by the GDTF importer yet.',
    },
    {
      id: 'cat:origin', title: 'Origin', icon: 'my_location', accent: ACCENT.origin, items: [],
      selfParams: [
        { label: 'Position', value: '0, 0, 0 m' },
        { label: 'Reference', value: 'Fixture base (implicit)' },
      ],
    },
    {
      id: 'cat:parts', title: 'Parts', icon: 'account_tree', accent: ACCENT.parts,
      items: parts.value.map((p) => ({
        id: `part:${p.partId}`,
        xrefs: p.modelId ? [`model:${p.modelId}`] : [],
        data: {
          kind: 'part', title: p.name, subtitle: p.tag, icon: 'category', accent: ACCENT.parts,
          params: [
            { label: 'Tag', value: str(p.tag) },
            { label: 'GDTF geom', value: str(p.sourceGdtfGeometryId) },
            { label: 'Parent', value: partLabel(p.parentPartId) },
            { label: 'Model', value: p.modelId ? str(p.modelId) : '—' },
            { label: 'Children', value: String(p.childPartIds?.length ?? 0) },
            { label: 'Motion axis', value: str(p.motionAxisId) },
            { label: 'Position', value: vec({ x: p.localTransform.position.x, y: p.localTransform.position.y, z: p.localTransform.position.z }, ' m') },
            { label: 'Rotation', value: vec(p.localTransform.rotation, '°') },
            { label: 'Pivot', value: vec(p.pivot, ' m') },
          ],
        },
      })),
    },
    {
      id: 'cat:models', title: 'Models', icon: 'view_in_ar', accent: ACCENT.models,
      items: models.value.map((m) => ({
        id: `model:${m.modelId}`,
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
      })),
    },
    {
      id: 'cat:motion', title: 'MotionRig', icon: 'sync', accent: ACCENT.motion,
      items: motion.value.map((a) => ({
        id: `motion:${a.motionAxisId}`,
        xrefs: a.controlledPartId ? [`part:${a.controlledPartId}`] : [],
        data: {
          kind: 'motion', title: a.axisType, subtitle: partLabel(a.controlledPartId), icon: 'rotate_right', accent: ACCENT.motion,
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
      })),
    },
    {
      id: 'cat:cells', title: 'Cells', icon: 'grid_on', accent: ACCENT.cells,
      items: cells.value.map((p) => ({
        id: `cell:${p.partId}`,
        xrefs: [`part:${p.partId}`],
        data: {
          kind: 'cell', title: p.name, subtitle: 'Cell', icon: 'apps', accent: ACCENT.cells,
          params: [
            { label: 'Part', value: str(p.name) },
            { label: 'GDTF geom', value: str(p.sourceGdtfGeometryId) },
            { label: 'Model', value: str(p.modelId) },
          ],
        },
      })),
      selfNote: cells.value.length ? undefined : 'No cell geometries in this fixture.',
    },
    {
      id: 'cat:beams', title: 'Beams', icon: 'flare', accent: ACCENT.beams,
      items: beams.value.map((b, i) => ({
        id: `beam:${b.beamId}`,
        xrefs: b.parentPartId ? [`part:${b.parentPartId}`] : [],
        data: {
          kind: 'beam', title: b.beamType || `Beam ${i + 1}`, subtitle: partLabel(b.parentPartId), icon: 'wb_incandescent', accent: ACCENT.beams,
          params: [
            { label: 'Type', value: str(b.beamType) },
            { label: 'Parent', value: partLabel(b.parentPartId) },
            { label: 'Beam angle', value: b.beamAngle !== undefined ? `${fmtNum(b.beamAngle)}°` : '—' },
            { label: 'Field angle', value: b.fieldAngle !== undefined ? `${fmtNum(b.fieldAngle)}°` : '—' },
            { label: 'Lum. flux', value: b.luminousFlux !== undefined ? `${fmtNum(b.luminousFlux)} lm` : '—' },
            { label: 'Colour temp', value: b.colourTemperature !== undefined ? `${fmtNum(b.colourTemperature)} K` : '—' },
            { label: 'IES', value: b.iesAssetId ? 'attached' : '—' },
          ],
        },
      })),
    },
    {
      id: 'cat:dmx', title: 'DMX Mapping', icon: 'tune', accent: ACCENT.dmx,
      items: modes.value.map((m, i) => {
        const channels = Array.isArray(m.channels) ? (m.channels as unknown[]).length : 0;
        return {
          id: `mode:${i}`,
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
    },
  ];

  // ---- place categories + their items --------------------------------------
  for (const cat of cats) {
    const startY = y;
    if (cat.items.length === 0) {
      // Leaf category: it carries its own params/note and reserves one row.
      const params = cat.selfParams ?? (cat.selfNote ? [{ label: 'Status', value: cat.selfNote }] : []);
      node(cat.id, X.category, y, {
        kind: 'category', title: cat.title, icon: cat.icon, accent: cat.accent,
        badge: cat.selfParams ? undefined : 0,
        params,
        defaultExpanded: !!cat.selfParams,
      });
      y += ROW;
    } else {
      for (const it of cat.items) {
        node(it.id, X.item, y, it.data);
        edge(cat.id, it.id, { style: { stroke: cat.accent, strokeWidth: 1.5 }, markerEnd: { type: MarkerType.ArrowClosed, color: cat.accent } });
        for (const target of it.xrefs ?? []) xref(it.id, target);
        y += ROW;
      }
      const midY = startY + ((cat.items.length - 1) * ROW) / 2;
      node(cat.id, X.category, midY, {
        kind: 'category', title: cat.title, icon: cat.icon, accent: cat.accent, badge: cat.items.length,
      });
    }
    edge('fixture', cat.id, { style: { stroke: cat.accent, strokeWidth: 1.5 }, markerEnd: { type: MarkerType.ArrowClosed, color: cat.accent } });
    y += CAT_GAP;
  }

  const totalH = Math.max(0, y - CAT_GAP);
  const centreY = totalH / 2 - NODE_H / 2;

  // ---- column 1: Fixture root ----------------------------------------------
  node('fixture', X.fixture, centreY, {
    kind: 'fixture', title: info.fixtureName || 'Fixture', subtitle: info.manufacturer, icon: 'lightbulb',
    accent: ACCENT.fixture, defaultExpanded: false,
    params: [
      { label: 'Parts', value: String(parts.value.length) },
      { label: 'Models', value: String(models.value.length) },
      { label: 'Beams', value: String(beams.value.length) },
      { label: 'Motion axes', value: String(motion.value.length) },
      { label: 'DMX modes', value: String(modes.value.length) },
    ],
  });

  // ---- column 0: GDTF source -----------------------------------------------
  node('gdtf', X.gdtf, centreY, {
    kind: 'gdtf', title: 'GDTF Source', subtitle: info.fixtureTypeId, icon: 'folder_zip',
    accent: ACCENT.gdtf, noTarget: true, defaultExpanded: false,
    params: [
      { label: 'Manufacturer', value: str(info.manufacturer) },
      { label: 'Fixture', value: str(info.fixtureName) },
      { label: 'Revision', value: str(info.revision) },
      { label: 'Parser', value: str(def.value.metadata?.parserVersion) },
      { label: 'Pkg entries', value: str(def.value.metadata?.packageEntryCount) },
      { label: 'Qualities', value: arr(def.value.metadata?.availableModelQualities) },
      { label: 'Formats', value: arr(def.value.metadata?.availableModelFormats) },
    ],
  });
  edge('gdtf', 'fixture', { style: { stroke: ACCENT.gdtf, strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color: ACCENT.gdtf }, animated: true });

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

// Custom nodes have no measured size at init, so `fit-view-on-init` fits to an
// empty bound and the canvas looks blank. Re-fit once nodes are measured.
function onNodesInitialized(): void {
  void Promise.resolve().then(() => fitView({ padding: 0.2 }));
}

function fitReset(): void {
  fitView({ padding: 0.2 });
}
</script>

<template>
  <div class="cg-wrap">
    <VueFlow
      :nodes="graph.nodes"
      :edges="graph.edges"
      :fit-view-on-init="true"
      :nodes-draggable="true"
      drag-handle=".node-drag-handle"
      :nodes-connectable="false"
      :elements-selectable="true"
      :zoom-on-double-click="false"
      :min-zoom="0.1"
      :max-zoom="2"
      @nodes-initialized="onNodesInitialized"
    >
      <template #node-fixtureNode="nodeProps">
        <FixtureGraphNode :data="nodeProps.data" />
      </template>

      <Background pattern-color="var(--color-border)" :gap="22" />
      <Controls :show-interactive="false" />

      <Panel position="top-left" class="cg-legend">
        <span class="cg-legend-title"><Icon name="schema" :size="14" /> GDTF → REBUS</span>
        <button type="button" class="cg-reset" title="Re-fit view" @click="fitReset">
          <Icon name="fit_screen" :size="15" />
        </button>
      </Panel>
    </VueFlow>
  </div>
</template>

<style scoped>
.cg-wrap {
  width: 100%;
  height: 100%;
  min-height: 480px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg);
  overflow: hidden;
}
.cg-wrap :deep(.vue-flow__node) { pointer-events: all !important; }

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
