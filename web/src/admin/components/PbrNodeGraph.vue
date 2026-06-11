<script setup lang="ts">
/**
 * Vue Flow wrapper for the PBR material editor. Lays the eight slot
 * TextureNodes out in a vertical column on the left, pre-wires each to the
 * single MaterialOutputNode on the right, and animates an edge whenever its
 * slot is filled.
 *
 * ### Drag & layout persistence
 * Node positions are stateful: on first load the layout algorithm positions
 * nodes in a spaced column so they never overlap; once the user drags any
 * node the new position is saved to `localStorage` keyed by material ID. A
 * "Reset layout" button clears the saved positions and re-runs the algorithm.
 *
 * ### Overlap fix
 * The height estimates were biased slightly low on filled nodes (thumbnail
 * aspect-ratio 16:9 on 212 px inner-width = ~119 px actual vs the 200 px
 * constant that tried to cover the full .tn-assigned block). Estimates are
 * now bumped conservatively (+20 % on the filled texture area, +50 % on the
 * gap) so the default layout is always non-overlapping regardless of state.
 * Users can drag to any arrangement they prefer; positions persist.
 */
import { computed, ref, watch } from 'vue';
import {
  VueFlow,
  Panel,
  MarkerType,
  Position,
  SelectionMode,
  type Edge,
  type Node,
  type NodeDragEvent,
} from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import Icon from '../../shared/Icon.vue';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import TextureNode from './TextureNode.vue';
import MaterialOutputNode from './MaterialOutputNode.vue';
import {
  MATERIAL_SLOTS,
  type MaterialParameters,
  type MaterialSlot,
  type MaterialSlotAssignment,
  type MaterialSlotTexture,
  type Texture,
} from '../../shared/api';

const props = defineProps<{
  materialId: string;
  slots: MaterialSlotAssignment[];
  parameters: MaterialParameters;
}>();
const emit = defineEmits<{
  assign: [slot: MaterialSlot, texture: Texture];
  unassign: [slot: MaterialSlot];
  'param-change': [change: { key: keyof MaterialParameters; value: number | string | boolean | string[] }];
}>();

const interactionMode = ref<'pan' | 'select'>('pan');

// ---------------------------------------------------------------------------
// Layout constants — generously over-estimated so nodes never overlap on
// first render. Heights are in canvas-pixels (1:1 with screen pixels at
// zoom 1). The thumbnail is `aspect-ratio: 16/9` on a 212 px inner-width
// cell (232 px node − 10px × 2 padding) → ~119 px, plus name + actions.
// Adding ~25 % headroom keeps everything clear across fonts + zoom levels.
// ---------------------------------------------------------------------------
const OUTPUT_X = 480;
const NODE_GAP = 60;        // raised from 44 → ensures no overlap after estimates
const HEADER_H = 38;
const TEX_AREA_FILLED = 240; // raised from 200 → thumbnail 119 + name + actions + gaps
const TEX_AREA_EMPTY = 110;  // raised from 90
const OUTPUT_H = 264;        // 8 rows × ~33 px/row

const PARAM_H: Record<MaterialSlot, number> = {
  albedo:       72,
  roughness:    72,
  metallic:     72,
  ao:           72,
  opacity:      72,
  normal:       110,  // slider + checkbox
  emissive:     140,  // color + slider
  displacement: 140,  // two sliders
};

function nodeHeight(slot: MaterialSlot, isFilled: boolean): number {
  return HEADER_H + (isFilled ? TEX_AREA_FILLED : TEX_AREA_EMPTY) + PARAM_H[slot];
}

// ---------------------------------------------------------------------------
// Position persistence (localStorage, keyed by material ID)
// ---------------------------------------------------------------------------
type PositionMap = Record<string, { x: number; y: number }>;

/** Retired node ids — stripped on load/reset so layout reset never resurrects them. */
const LEGACY_NODE_IDS = ['param-base', 'param-displacement'] as const;

function storageKey(id: string): string {
  return `prism-node-layout-${id}`;
}

function stripLegacyPositions(map: PositionMap): PositionMap {
  const next = { ...map };
  for (const id of LEGACY_NODE_IDS) delete next[id];
  return next;
}

function loadPositions(id: string): PositionMap | null {
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null) return stripLegacyPositions(parsed as PositionMap);
  } catch {
    // ignore parse errors
  }
  return null;
}

function savePositions(id: string, map: PositionMap): void {
  try {
    localStorage.setItem(storageKey(id), JSON.stringify(map));
  } catch {
    // quota exceeded etc. — non-fatal
  }
}

const customPositions = ref<PositionMap>(loadPositions(props.materialId) ?? {});

/** Bumped on reset so Vue Flow remounts and drops any stale internal node state. */
const layoutEpoch = ref(0);

// Re-load when material changes (navigating between materials in same session)
watch(
  () => props.materialId,
  (id) => {
    customPositions.value = loadPositions(id) ?? {};
  },
);

function onNodeDragStop(ev: NodeDragEvent): void {
  const { node } = ev;
  if (LEGACY_NODE_IDS.includes(node.id as (typeof LEGACY_NODE_IDS)[number])) return;
  customPositions.value = { ...customPositions.value, [node.id]: node.position };
  savePositions(props.materialId, customPositions.value);
}

function resetLayout(): void {
  customPositions.value = {};
  layoutEpoch.value += 1;
  try {
    localStorage.removeItem(storageKey(props.materialId));
  } catch {
    // non-fatal
  }
}

// ---------------------------------------------------------------------------
// Slot lookup helpers
// ---------------------------------------------------------------------------
const lookup = computed<Partial<Record<MaterialSlot, MaterialSlotTexture>>>(() => {
  const m: Partial<Record<MaterialSlot, MaterialSlotTexture>> = {};
  for (const s of props.slots) m[s.slot] = s.texture;
  return m;
});

const filled = computed<Partial<Record<MaterialSlot, boolean>>>(() => {
  const m: Partial<Record<MaterialSlot, boolean>> = {};
  for (const slot of MATERIAL_SLOTS) m[slot] = !!lookup.value[slot];
  return m;
});

const layout = computed<{ ys: number[]; total: number }>(() => {
  const ys: number[] = [];
  let y = 0;
  for (const slot of MATERIAL_SLOTS) {
    ys.push(y);
    y += nodeHeight(slot, !!lookup.value[slot]) + NODE_GAP;
  }
  return { ys, total: Math.max(0, y - NODE_GAP) };
});

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------
const nodes = computed<Node[]>(() => {
  const texNodes: Node[] = MATERIAL_SLOTS.map((slot, i) => {
    const nodeId = `slot-${slot}`;
    const defaultPos = { x: 0, y: layout.value.ys[i]! };
    return {
      id: nodeId,
      type: 'texture',
      // Use saved position if present, otherwise fall back to algorithm
      position: customPositions.value[nodeId] ?? defaultPos,
      data: { slot, texture: lookup.value[slot] ?? null },
      draggable: true,
      sourcePosition: Position.Right,
    } satisfies Node;
  });

  const outputNodeId = 'material';
  const defaultOutputPos = { x: OUTPUT_X, y: Math.max(0, (layout.value.total - OUTPUT_H) / 2) };
  const outputNode: Node = {
    id: outputNodeId,
    type: 'materialOutput',
    position: customPositions.value[outputNodeId] ?? defaultOutputPos,
    data: { filled: filled.value },
    draggable: true,
    targetPosition: Position.Left,
  };

  return [...texNodes, outputNode];
});

const edges = computed<Edge[]>(() =>
  MATERIAL_SLOTS.map((slot) => {
    const on = !!lookup.value[slot];
    return {
      id: `e-${slot}`,
      source: `slot-${slot}`,
      target: 'material',
      targetHandle: slot,
      type: 'smoothstep',
      animated: on,
      style: {
        stroke: on ? 'var(--orbit-primary)' : 'var(--color-border-strong)',
        strokeWidth: on ? 2 : 1.5,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: on ? 'var(--orbit-primary)' : 'var(--color-border-strong)',
      },
    } satisfies Edge;
  }),
);

function onAssign(slot: MaterialSlot, texture: Texture): void {
  emit('assign', slot, texture);
}
function onUnassign(slot: MaterialSlot): void {
  emit('unassign', slot);
}
function onParamChange(change: { key: keyof MaterialParameters; value: number | string | boolean | string[] }): void {
  emit('param-change', change);
}
</script>

<template>
  <div class="graph-wrap" :class="{ 'select-mode': interactionMode === 'select' }">
    <VueFlow
      :key="layoutEpoch"
      :nodes="nodes"
      :edges="edges"
      :fit-view-on-init="true"
      :nodes-draggable="true"
      drag-handle=".node-drag-handle"
      :nodes-connectable="false"
      :elements-selectable="true"
      :pan-on-drag="interactionMode === 'pan'"
      :selection-key-code="interactionMode === 'select' ? true : 'Shift'"
      :selection-mode="SelectionMode.Partial"
      :delete-key-code="null"
      :zoom-on-double-click="false"
      :min-zoom="0.2"
      :max-zoom="1.5"
      @node-drag-stop="onNodeDragStop"
    >
      <template #node-texture="nodeProps">
        <TextureNode
          :slot="nodeProps.data.slot"
          :texture="nodeProps.data.texture"
          :params="parameters"
          @assign="onAssign"
          @remove="onUnassign"
          @param-change="onParamChange"
        />
      </template>

      <template #node-materialOutput="nodeProps">
        <MaterialOutputNode :filled="nodeProps.data.filled" />
      </template>

      <Background pattern-color="var(--color-border)" :gap="22" />
      <Controls :show-interactive="false" />

      <Panel position="top-left" class="mode-toggle">
        <button
          type="button"
          class="mode-btn"
          :class="{ active: interactionMode === 'pan' }"
          :aria-pressed="interactionMode === 'pan'"
          title="Pan — drag the canvas to move"
          aria-label="Pan mode"
          @click="interactionMode = 'pan'"
        >
          <Icon name="pan_tool" :size="16" />
        </button>
        <button
          type="button"
          class="mode-btn"
          :class="{ active: interactionMode === 'select' }"
          :aria-pressed="interactionMode === 'select'"
          title="Select — drag the canvas to box-select"
          aria-label="Select mode"
          @click="interactionMode = 'select'"
        >
          <Icon name="arrow_selector_tool" :size="16" />
        </button>
        <button
          type="button"
          class="mode-btn reset-btn"
          title="Reset node positions to default layout"
          aria-label="Reset layout"
          @click="resetLayout"
        >
          <Icon name="grid_view" :size="16" />
        </button>
      </Panel>
    </VueFlow>
  </div>
</template>

<style scoped>
.graph-wrap {
  width: 100%;
  height: 100%;
  min-height: 320px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg);
  overflow: hidden;
}

/* Vue Flow writes an inline pointer-events onto each node wrapper, derived from
   its selectable/draggable state; force it back on so node controls stay
   clickable in every interaction mode. !important is required to beat the
   inline style. */
.graph-wrap :deep(.vue-flow__node) {
  pointer-events: all !important;
}

/* Select mode neutralises Vue Flow's grab/pointer pane cursors so left-drag
   reads as a selection gesture rather than a pan. */
.graph-wrap.select-mode :deep(.vue-flow__pane) {
  cursor: default;
}

.mode-toggle {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
}
.mode-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.mode-btn:hover {
  background: var(--color-bg-hover);
  border-color: transparent;
  color: var(--color-text);
}
.mode-btn.active,
.mode-btn.active:hover {
  background: var(--orbit-primary);
  border-color: var(--orbit-primary);
  color: #fff;
}
.mode-btn svg {
  width: 16px;
  height: 16px;
  display: block;
}
/* Reset button gets a subtle separator from the mode pair */
.reset-btn {
  margin-left: 2px;
  border-left: 1px solid var(--color-border);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

</style>

<style>
/* Unscoped: applies inside Vue Flow's node tree. Custom node types carry no
   default theme chrome, so we only neutralise the wrapper + brand the handles. */
.vue-flow__node-texture,
.vue-flow__node-materialOutput {
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 0;
  box-shadow: none;
  width: auto;
  cursor: default;
}
.node-drag-handle {
  cursor: grab;
}
.node-drag-handle:active {
  cursor: grabbing;
}
.vue-flow__handle {
  width: 9px;
  height: 9px;
  background: var(--orbit-primary);
  border: 1.5px solid var(--color-bg-elevated);
}
</style>
