<script setup lang="ts">
/**
 * Portal-style Vue Flow pin board for the permissions policy graph.
 * Supports pan / lasso-select modes, multi-select, and group drag.
 */
import { computed, onMounted, ref, useSlots, watch } from 'vue';
import {
  VueFlow,
  Panel,
  MarkerType,
  SelectionMode,
  useVueFlow,
  type Connection,
  type EdgeMouseEvent,
  type NodeMouseEvent,
  type GraphNode,
} from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import Icon from '../../../shared/Icon.vue';
import PolicyNode from './PolicyNode.vue';
import type { PolicyFlowEdge, PolicyFlowNode } from '../../utils/policyGraphLayout';
import type { PolicyNodeType } from '../../../shared/api';

type ColumnLabel = { type: PolicyNodeType; label: string; key?: string };

const DEFAULT_COLUMN_LABELS: ColumnLabel[] = [
  { type: 'role', label: 'Roles' },
  { type: 'user', label: 'Users' },
  { type: 'project', label: 'Projects' },
  { type: 'function', label: 'Functions' },
];

const INSPECTOR_WIDTH_KEY = 'prism.permissions.inspectorWidth';
const INSPECTOR_MIN = 240;
const INSPECTOR_MAX = 640;
const INSPECTOR_DEFAULT = 300;

const props = withDefaults(defineProps<{
  nodes: PolicyFlowNode[];
  edges: PolicyFlowEdge[];
  /** Primary / last-selected node (backward compatible). */
  selectedNodeId?: string | null;
  /** Full multi-selection (lasso / ctrl-click). */
  selectedNodeIds?: string[];
  readonly?: boolean;
  legendTitle?: string;
  columnLabels?: ColumnLabel[];
}>(), {
  readonly: false,
  legendTitle: 'Policy graph',
  selectedNodeIds: () => [],
});

const emit = defineEmits<{
  'update:nodes': [PolicyFlowNode[]];
  'update:edges': [PolicyFlowEdge[]];
  connect: [Connection];
  'update:selectedNodeId': [string | null];
  'update:selectedNodeIds': [string[]];
  'node-contextmenu': [payload: { nodeId: string; event: MouseEvent }];
  'edge-delete': [edgeId: string];
}>();

const slots = useSlots();
const { fitView, getSelectedNodes } = useVueFlow();
const boardEl = ref<HTMLElement | null>(null);
const interactionMode = ref<'pan' | 'select'>('pan');

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(INSPECTOR_WIDTH_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, n));
  } catch {
    /* ignore */
  }
  return INSPECTOR_DEFAULT;
}

const inspectorWidth = ref(readStoredWidth());
const resizing = ref(false);

function clampInspectorWidth(px: number): number {
  const boardW = boardEl.value?.clientWidth ?? 1200;
  const maxForBoard = Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, boardW - 320));
  return Math.min(maxForBoard, Math.max(INSPECTOR_MIN, Math.round(px)));
}

function onResizePointerDown(evt: PointerEvent): void {
  if (evt.button !== 0) return;
  evt.preventDefault();
  resizing.value = true;
  const startX = evt.clientX;
  const startW = inspectorWidth.value;
  const target = evt.currentTarget as HTMLElement;
  target.setPointerCapture(evt.pointerId);

  function onMove(e: PointerEvent): void {
    inspectorWidth.value = clampInspectorWidth(startW + (startX - e.clientX));
  }
  function onUp(e: PointerEvent): void {
    resizing.value = false;
    target.releasePointerCapture(e.pointerId);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    try {
      localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth.value));
    } catch {
      /* ignore */
    }
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

const legendColumns = computed(() => props.columnLabels ?? DEFAULT_COLUMN_LABELS);
const hasInspector = computed(() => !!slots.inspector);

function doFit(): void {
  requestAnimationFrame(() => {
    try {
      fitView({ padding: 0.18 });
    } catch {
      /* viewport not ready */
    }
  });
}

onMounted(() => {
  setTimeout(doFit, 60);
});

function onNodesInitialized(): void {
  doFit();
}

function onConnect(conn: Connection): void {
  emit('connect', conn);
}

function emitSelection(ids: string[]): void {
  emit('update:selectedNodeIds', ids);
  emit('update:selectedNodeId', ids.length ? ids[ids.length - 1]! : null);
}

function onSelectionChange(payload: { nodes: GraphNode[] }): void {
  emitSelection(payload.nodes.map((n) => n.id));
}

function onNodeClick(evt: NodeMouseEvent): void {
  // Ctrl/Meta/Shift multi-select is handled by Vue Flow; selection-change emits.
  // Plain click still fires selection-change with a single node.
  const native = evt.event;
  if (native instanceof MouseEvent && (native.metaKey || native.ctrlKey || native.shiftKey)) {
    return;
  }
  // Ensure single-click selects even if selection-change is delayed.
  emitSelection([evt.node.id]);
}

function onNodeContextMenu(evt: NodeMouseEvent): void {
  const native = evt.event;
  if (native instanceof MouseEvent) {
    native.preventDefault();
    emit('node-contextmenu', { nodeId: evt.node.id, event: native });
  }
}

function onPaneClick(): void {
  emitSelection([]);
}

function onEdgeDoubleClick(evt: EdgeMouseEvent): void {
  if (props.readonly) return;
  emit('edge-delete', evt.edge.id);
}

/** Apply parent-driven selection onto node.selected flags for Vue Flow. */
watch(
  () => [
    (props.selectedNodeIds ?? []).join('\0'),
    props.selectedNodeId ?? '',
  ] as const,
  () => {
    const want = new Set(
      props.selectedNodeIds?.length
        ? props.selectedNodeIds
        : (props.selectedNodeId ? [props.selectedNodeId] : []),
    );
    let dirty = false;
    const next = props.nodes.map((n) => {
      const selected = want.has(n.id);
      if (!!n.selected === selected) return n;
      dirty = true;
      return { ...n, selected };
    });
    if (dirty) emit('update:nodes', next);
  },
);

/** Keep parent in sync if Vue Flow selection drifts (e.g. group drag). */
function syncSelectionFromFlow(): void {
  try {
    const ids = getSelectedNodes.value.map((n) => n.id);
    const current = props.selectedNodeIds ?? [];
    if (ids.length === current.length && ids.every((id, i) => id === current[i])) return;
    emitSelection(ids);
  } catch {
    /* flow not ready */
  }
}
</script>

<template>
  <div
    ref="boardEl"
    class="policy-board"
    :class="{
      'policy-board--resizing': resizing,
      'policy-board--select': interactionMode === 'select',
    }"
  >
    <div class="policy-board__canvas">
      <VueFlow
        :nodes="props.nodes"
        :edges="props.edges"
        :nodes-draggable="true"
        drag-handle=".node-drag-handle"
        :nodes-connectable="!props.readonly"
        :edges-updatable="!props.readonly"
        :elements-selectable="true"
        :pan-on-drag="interactionMode === 'pan'"
        :selection-key-code="interactionMode === 'select' ? true : 'Shift'"
        :selection-mode="SelectionMode.Partial"
        :zoom-on-double-click="false"
        :min-zoom="0.25"
        :max-zoom="1.5"
        :default-edge-options="{ markerEnd: MarkerType.ArrowClosed, animated: true }"
        @update:nodes="emit('update:nodes', $event as PolicyFlowNode[])"
        @update:edges="emit('update:edges', $event as PolicyFlowEdge[])"
        @connect="onConnect"
        @node-click="onNodeClick"
        @node-contextmenu="onNodeContextMenu"
        @edge-double-click="onEdgeDoubleClick"
        @pane-click="onPaneClick"
        @nodes-initialized="onNodesInitialized"
        @selection-change="onSelectionChange"
        @node-drag-stop="syncSelectionFromFlow"
      >
        <template #node-policy="nodeProps">
          <PolicyNode :data="nodeProps.data as PolicyFlowNode['data']" />
        </template>

        <Background pattern-color="var(--color-border)" :gap="22" />
        <Controls :show-interactive="false" />

        <Panel position="top-left" class="policy-board__legend">
          <span class="policy-board__legend-title">
            <Icon name="account_tree" :size="14" /> {{ props.legendTitle }}
          </span>
          <span
            v-for="col in legendColumns"
            :key="col.key ?? `${col.type}-${col.label}`"
            class="policy-board__legend-chip"
          >
            {{ col.label }}
          </span>
          <span class="policy-board__mode-toggle" role="group" aria-label="Canvas interaction">
            <button
              type="button"
              class="policy-board__mode-btn"
              :class="{ active: interactionMode === 'pan' }"
              :aria-pressed="interactionMode === 'pan'"
              title="Pan — drag the canvas to move"
              aria-label="Pan mode"
              @click="interactionMode = 'pan'"
            >
              <Icon name="pan_tool" :size="15" />
            </button>
            <button
              type="button"
              class="policy-board__mode-btn"
              :class="{ active: interactionMode === 'select' }"
              :aria-pressed="interactionMode === 'select'"
              title="Select — drag to lasso nodes (Shift+drag also works in pan mode)"
              aria-label="Select mode"
              @click="interactionMode = 'select'"
            >
              <Icon name="arrow_selector_tool" :size="15" />
            </button>
          </span>
          <button type="button" class="policy-board__fit" title="Re-fit view" @click="doFit">
            <Icon name="fit_screen" :size="15" />
          </button>
        </Panel>
      </VueFlow>
    </div>

    <template v-if="hasInspector">
      <div
        class="policy-board__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector"
        title="Drag to resize"
        @pointerdown="onResizePointerDown"
      />
      <div class="policy-board__inspector" :style="{ width: `${inspectorWidth}px` }">
        <slot name="inspector" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.policy-board {
  display: flex;
  gap: 0;
  flex: 1;
  min-height: 480px;
}
.policy-board--resizing {
  cursor: col-resize;
  user-select: none;
}
.policy-board--resizing :deep(*) {
  cursor: col-resize !important;
}

.policy-board__canvas {
  flex: 1;
  min-width: 0;
  min-height: 480px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg);
  overflow: hidden;
}

.policy-board--select :deep(.vue-flow__pane) {
  cursor: crosshair;
}

.policy-board__resizer {
  flex: 0 0 8px;
  margin: 0 2px;
  border-radius: 4px;
  cursor: col-resize;
  background: transparent;
  position: relative;
  touch-action: none;
}
.policy-board__resizer::after {
  content: '';
  position: absolute;
  top: 12%;
  bottom: 12%;
  left: 3px;
  width: 2px;
  border-radius: 1px;
  background: var(--color-border, #ccc);
  opacity: 0.85;
}
.policy-board__resizer:hover::after,
.policy-board--resizing .policy-board__resizer::after {
  background: var(--orbit-primary, #f97316);
  opacity: 1;
}

.policy-board__inspector {
  flex: 0 0 auto;
  min-width: 0;
  align-self: stretch;
  display: flex;
  flex-direction: column;
}
.policy-board__inspector > :deep(*) {
  flex: 1;
  min-height: 0;
  width: 100%;
}

.policy-board__canvas :deep(.vue-flow__node) {
  pointer-events: all !important;
}

.policy-board__canvas :deep(.vue-flow__node.selected) .policy-node {
  border-color: var(--accent, var(--orbit-primary));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--orbit-primary) 45%, transparent);
}

.policy-board__canvas :deep(.vue-flow__selection) {
  background: color-mix(in srgb, var(--orbit-primary) 12%, transparent);
  border: 1px solid var(--orbit-primary);
}

.policy-board__canvas :deep(.vue-flow__nodesselection-rect) {
  background: color-mix(in srgb, var(--orbit-primary) 8%, transparent);
  border: 1px dashed var(--orbit-primary);
}

.policy-board__legend {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 8px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
}

.policy-board__legend-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text);
  margin-right: 4px;
}

.policy-board__legend-chip {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 2px 8px;
}

.policy-board__mode-toggle {
  display: inline-flex;
  gap: 2px;
  margin-left: 4px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
}

.policy-board__mode-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  text-transform: none;
  letter-spacing: normal;
  min-height: 0;
}
.policy-board__mode-btn:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}
.policy-board__mode-btn.active,
.policy-board__mode-btn.active:hover {
  background: var(--orbit-primary);
  border-color: var(--orbit-primary);
  color: #fff;
}

.policy-board__fit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-left: 2px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text-muted);
  cursor: pointer;
}

.policy-board__fit:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}
</style>

<style>
/* Unscoped: Vue Flow node wrapper + handle styling */
.vue-flow__node-policy {
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 0;
  box-shadow: none;
  width: auto;
}

.policy-board .vue-flow__handle {
  width: 9px;
  height: 9px;
  background: var(--orbit-primary);
  border: 1.5px solid var(--color-bg-elevated);
}

.policy-board .vue-flow__edge-path {
  stroke: var(--orbit-primary);
  stroke-width: 1.5;
}
</style>
