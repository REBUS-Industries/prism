<script setup lang="ts">
/**
 * Vue Flow wrapper for the PBR material editor. Lays the eight slot
 * TextureNodes out in a vertical column on the left, pre-wires each to the
 * single MaterialOutputNode on the right, and animates an edge whenever its
 * slot is filled. Slot assignments come in via `slots` (the material detail's
 * slot list); assign / unassign bubble out so the parent can persist them and
 * refresh the live preview.
 */
import { computed, ref } from 'vue';
import {
  VueFlow,
  Panel,
  Handle,
  MarkerType,
  Position,
  SelectionMode,
  type Edge,
  type Node,
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

const props = defineProps<{ slots: MaterialSlotAssignment[]; parameters: MaterialParameters }>();
const emit = defineEmits<{
  assign: [slot: MaterialSlot, texture: Texture];
  unassign: [slot: MaterialSlot];
  'param-change': [change: { key: keyof MaterialParameters; value: number | string | boolean }];
}>();

const interactionMode = ref<'pan' | 'select'>('pan');

// Nodes carry their slot's PBR controls now, so their height varies with the
// slot (number of controls) and whether a texture is assigned (preview vs the
// shorter empty state). Lay them out by cumulative estimated height + a gap so
// the column never overlaps regardless of state. Estimates are biased slightly
// high; fit-view zooms the column to frame, so a little slack is harmless.
const OUTPUT_X = 440;
const NODE_GAP = 44;
const HEADER_H = 36;
const TEX_AREA_FILLED = 200;
const TEX_AREA_EMPTY = 90;
const OUTPUT_H = 250;
const PARAM_H: Record<MaterialSlot, number> = {
  albedo: 70,
  roughness: 70,
  metallic: 70,
  ao: 70,
  opacity: 70,
  normal: 104,
  emissive: 130,
  displacement: 130,
};

function nodeHeight(slot: MaterialSlot, isFilled: boolean): number {
  return HEADER_H + (isFilled ? TEX_AREA_FILLED : TEX_AREA_EMPTY) + PARAM_H[slot];
}

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

const nodes = computed<Node[]>(() => {
  const texNodes: Node[] = MATERIAL_SLOTS.map((slot, i) => ({
    id: `slot-${slot}`,
    type: 'texture',
    position: { x: 0, y: layout.value.ys[i]! },
    data: { slot, texture: lookup.value[slot] ?? null },
    draggable: false,
    sourcePosition: Position.Right,
  }));
  const outputNode: Node = {
    id: 'material',
    type: 'materialOutput',
    position: { x: OUTPUT_X, y: Math.max(0, (layout.value.total - OUTPUT_H) / 2) },
    data: { filled: filled.value },
    draggable: false,
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
function onParamChange(change: { key: keyof MaterialParameters; value: number | string | boolean }): void {
  emit('param-change', change);
}
</script>

<template>
  <div class="graph-wrap" :class="{ 'select-mode': interactionMode === 'select' }">
    <VueFlow
      :nodes="nodes"
      :edges="edges"
      :fit-view-on-init="true"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :elements-selectable="true"
      :pan-on-drag="interactionMode === 'pan'"
      :selection-key-code="interactionMode === 'select' ? true : 'Shift'"
      :selection-mode="SelectionMode.Partial"
      :delete-key-code="null"
      :zoom-on-double-click="false"
      :min-zoom="0.2"
      :max-zoom="1.5"
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
.vue-flow__handle {
  width: 9px;
  height: 9px;
  background: var(--orbit-primary);
  border: 1.5px solid var(--color-bg-elevated);
}
</style>
