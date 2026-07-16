<script setup lang="ts">
/**
 * Portal-style Vue Flow pin board for the permissions policy graph.
 * Matches the React Flow layout used in portal-app PeopleManagementClient.
 */
import { computed, onMounted, ref, useSlots } from 'vue';
import {
  VueFlow,
  Panel,
  MarkerType,
  useVueFlow,
  type Connection,
  type EdgeMouseEvent,
  type NodeMouseEvent,
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

const DEFAULT_COLUMN_LABELS: { type: PolicyNodeType; label: string }[] = [
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
  selectedNodeId?: string | null;
  readonly?: boolean;
  legendTitle?: string;
  columnLabels?: { type: PolicyNodeType; label: string }[];
}>(), {
  readonly: false,
  legendTitle: 'Policy graph',
});

const emit = defineEmits<{
  'update:nodes': [PolicyFlowNode[]];
  'update:edges': [PolicyFlowEdge[]];
  connect: [Connection];
  'update:selectedNodeId': [string | null];
  'node-contextmenu': [payload: { nodeId: string; event: MouseEvent }];
  'edge-delete': [edgeId: string];
}>();

const slots = useSlots();
const { fitView } = useVueFlow();
const boardEl = ref<HTMLElement | null>(null);

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
    // Dragging left increases inspector width.
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

function onNodeClick(evt: NodeMouseEvent): void {
  emit('update:selectedNodeId', evt.node.id);
}

function onNodeContextMenu(evt: NodeMouseEvent): void {
  const native = evt.event;
  if (native instanceof MouseEvent) {
    native.preventDefault();
    emit('node-contextmenu', { nodeId: evt.node.id, event: native });
  }
}

function onPaneClick(): void {
  emit('update:selectedNodeId', null);
}

function onEdgeDoubleClick(evt: EdgeMouseEvent): void {
  if (props.readonly) return;
  emit('edge-delete', evt.edge.id);
}
</script>

<template>
  <div ref="boardEl" class="policy-board" :class="{ 'policy-board--resizing': resizing }">
    <div class="policy-board__canvas">
      <VueFlow
        :nodes="props.nodes"
        :edges="props.edges"
        :nodes-draggable="true"
        drag-handle=".node-drag-handle"
        :nodes-connectable="!props.readonly"
        :edges-updatable="!props.readonly"
        :elements-selectable="true"
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
            :key="col.type"
            class="policy-board__legend-chip"
          >
            {{ col.label }}
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
