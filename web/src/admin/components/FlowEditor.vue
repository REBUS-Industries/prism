<script setup lang="ts">
/**
 * Wraps @vue-flow/core to render a PipelineTopology with three live
 * overlays:
 *   - workstation pool nodes attached to the `workstation` stage
 *   - in-flight job particles travelling along edges
 *   - stage tooltips from the server-side `description` strings
 *
 * Read-only by default. Pass `editable` if we ever want drag-to-rearrange
 * (positions aren't currently persisted server-side, so dropping that to
 * a Phase 7+ follow-up).
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { VueFlow, MarkerType, type Edge, type Node, Position } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import type { JobSummary, PipelineTopology, Workstation } from '../../shared/api';

const props = defineProps<{
  topology: PipelineTopology;
  workstations?: Workstation[];
  jobs?: JobSummary[];
}>();

// Stage horizontal layout — x increases left -> right.
const stagePositions = computed(() => {
  const pos: Record<string, { x: number; y: number }> = {};
  const widthPer = 200;
  props.topology.nodes.forEach((n, i) => {
    pos[n.id] = { x: 40 + i * widthPer, y: 80 };
  });
  return pos;
});

const nodes = computed<Node[]>(() => {
  const stageNodes: Node[] = props.topology.nodes.map((n) => ({
    id: n.id,
    type: 'default',
    position: stagePositions.value[n.id] ?? { x: 0, y: 0 },
    data: { label: n.label, description: n.description, optional: n.optional, kind: n.kind },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    class: `stage stage-${n.kind}${n.optional ? ' optional' : ''}`,
    draggable: false,
  }));

  // Workstation overlay nodes — clustered around the `workstation` stage.
  const wsStage = props.topology.nodes.find((n) => n.kind === 'workstation');
  const wsNodes: Node[] = wsStage && props.workstations
    ? props.workstations.map((w, i) => {
        const base = stagePositions.value[wsStage.id] ?? { x: 0, y: 0 };
        return {
          id: `ws-${w.id}`,
          type: 'default',
          position: { x: base.x - 10, y: base.y + 90 + i * 70 },
          data: {
            label: w.nodeName,
            sub: `${w.slotsBusy ?? 0}/${w.slotsTotal} slots`,
            isWs: true,
          },
          class: `ws ws-${w.online ? 'online' : 'offline'}${(w.slotsBusy ?? 0) > 0 ? ' busy' : ''}`,
          draggable: false,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        };
      })
    : [];

  return [...stageNodes, ...wsNodes];
});

const edges = computed<Edge[]>(() => {
  const stageEdges: Edge[] = props.topology.edges.map((e) => ({
    id: `${e.from}->${e.to}`,
    source: e.from,
    target: e.to,
    label: e.label,
    type: 'smoothstep',
    animated: hasActiveJobOnEdge(e.from, e.to),
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--orbit-primary)' },
    style: { stroke: 'var(--color-border-strong)', strokeWidth: 2 },
  }));

  const wsStage = props.topology.nodes.find((n) => n.kind === 'workstation');
  const wsEdges: Edge[] = wsStage && props.workstations
    ? props.workstations.map((w) => ({
        id: `ws-edge-${w.id}`,
        source: wsStage.id,
        target: `ws-${w.id}`,
        type: 'smoothstep',
        animated: (w.slotsBusy ?? 0) > 0,
        style: { stroke: w.online ? 'var(--orbit-primary)' : 'var(--color-border-strong)', strokeDasharray: '4 4', strokeWidth: 1 },
      }))
    : [];

  return [...stageEdges, ...wsEdges];
});

function hasActiveJobOnEdge(from: string, to: string): boolean {
  if (!props.jobs?.length) return false;
  const stageOrder = props.topology.nodes.map((n) => n.id);
  const fromIdx = stageOrder.indexOf(from);
  const toIdx = stageOrder.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return false;
  return props.jobs.some((j) => {
    if (j.status === 'complete' || j.status === 'failed' || j.status === 'cancelled') return false;
    const cur = currentStageIndex(j, stageOrder);
    return cur >= 0 && cur >= fromIdx && cur <= toIdx;
  });
}

function currentStageIndex(j: JobSummary, stageOrder: string[]): number {
  // Map job.status + currentStage onto the topology.
  if (j.currentStage && stageOrder.includes(j.currentStage)) return stageOrder.indexOf(j.currentStage);
  switch (j.status) {
    case 'queued':     return stageOrder.indexOf('queue');
    case 'dispatched': return stageOrder.indexOf('dispatch');
    case 'processing': return stageOrder.indexOf('workstation');
    default:           return -1;
  }
}

// Re-emit nodes/edges when props change so VueFlow picks them up.
const flowKey = ref(0);
watch(() => [props.topology, props.workstations, props.jobs], () => { flowKey.value++; }, { deep: true });

let tickTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  // Animation refresh — bump the key every 2s so 'animated' recomputes.
  tickTimer = setInterval(() => { flowKey.value++; }, 2_000);
});
onUnmounted(() => { if (tickTimer) clearInterval(tickTimer); });
</script>

<template>
  <div class="flow-wrap">
    <VueFlow
      :key="flowKey"
      :nodes="nodes"
      :edges="edges"
      :fit-view-on-init="true"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :elements-selectable="false"
      :zoom-on-double-click="false"
    >
      <Background pattern-color="var(--color-border)" :gap="20" />
      <Controls />
    </VueFlow>

    <div class="legend">
      <span class="dot online"></span> online
      <span class="dot busy"></span> busy
      <span class="dot offline"></span> offline
    </div>
  </div>
</template>

<style scoped>
.flow-wrap {
  position: relative;
  width: 100%;
  height: 600px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg);
}
.legend {
  position: absolute; bottom: 10px; right: 10px; z-index: 10;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 6px 10px;
  font-size: 11px;
  display: flex; gap: 12px; align-items: center;
  color: var(--color-text-muted);
}
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
.dot.online  { background: var(--color-success); }
.dot.busy    { background: var(--orbit-primary); }
.dot.offline { background: var(--color-text-subtle); }
</style>

<style>
/* Global VueFlow node styles — must be unscoped so they apply to the
   nodes rendered inside the VueFlow shadow tree. */
.vue-flow__node.stage {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 500;
  min-width: 120px;
  text-align: center;
  color: var(--color-text);
  box-shadow: var(--shadow-1);
}
.vue-flow__node.stage.optional { opacity: 0.7; border-style: dashed; }
.vue-flow__node.stage.stage-workstation { background: var(--orbit-primary-fade); border-color: var(--orbit-primary); color: var(--orbit-primary); }
.vue-flow__node.ws {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 6px 10px;
  font-size: 11px;
  min-width: 110px;
  color: var(--color-text-muted);
}
.vue-flow__node.ws.ws-online { border-color: var(--color-success); color: var(--color-success); }
.vue-flow__node.ws.ws-online.busy { background: var(--orbit-primary-fade); border-color: var(--orbit-primary); color: var(--orbit-primary); }
.vue-flow__node.ws.ws-offline { border-color: var(--color-border); color: var(--color-text-subtle); opacity: 0.7; }
</style>
