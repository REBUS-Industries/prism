<script setup lang="ts">
/**
 * Portal-style Vue Flow pin board for the permissions policy graph.
 * Matches the React Flow layout used in portal-app PeopleManagementClient.
 */
import { onMounted } from 'vue';
import {
  VueFlow,
  Panel,
  MarkerType,
  useVueFlow,
  type Connection,
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

const COLUMN_LABELS: { type: PolicyNodeType; label: string }[] = [
  { type: 'role', label: 'Roles' },
  { type: 'user', label: 'Users' },
  { type: 'project', label: 'Projects' },
  { type: 'function', label: 'Functions' },
];

const props = defineProps<{
  nodes: PolicyFlowNode[];
  edges: PolicyFlowEdge[];
  selectedNodeId?: string | null;
}>();

const emit = defineEmits<{
  'update:nodes': [PolicyFlowNode[]];
  'update:edges': [PolicyFlowEdge[]];
  connect: [Connection];
  'update:selectedNodeId': [string | null];
}>();

const { fitView } = useVueFlow();

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

function onPaneClick(): void {
  emit('update:selectedNodeId', null);
}
</script>

<template>
  <div class="policy-board">
    <div class="policy-board__canvas">
      <VueFlow
        :nodes="props.nodes"
        :edges="props.edges"
        :nodes-draggable="true"
        drag-handle=".node-drag-handle"
        :nodes-connectable="true"
        :elements-selectable="true"
        :zoom-on-double-click="false"
        :min-zoom="0.25"
        :max-zoom="1.5"
        :default-edge-options="{ markerEnd: MarkerType.ArrowClosed, animated: true }"
        @update:nodes="emit('update:nodes', $event as PolicyFlowNode[])"
        @update:edges="emit('update:edges', $event as PolicyFlowEdge[])"
        @connect="onConnect"
        @node-click="onNodeClick"
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
            <Icon name="account_tree" :size="14" /> Policy graph
          </span>
          <span
            v-for="col in COLUMN_LABELS"
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

    <slot name="inspector" />
  </div>
</template>

<style scoped>
.policy-board {
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 480px;
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
