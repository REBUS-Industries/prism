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
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import TextureNode from './TextureNode.vue';
import MaterialOutputNode from './MaterialOutputNode.vue';
import {
  MATERIAL_SLOTS,
  type MaterialSlot,
  type MaterialSlotAssignment,
  type MaterialSlotTexture,
  type Texture,
} from '../../shared/api';

const props = defineProps<{ slots: MaterialSlotAssignment[] }>();
const emit = defineEmits<{ assign: [slot: MaterialSlot, texture: Texture]; unassign: [slot: MaterialSlot] }>();

const interactionMode = ref<'pan' | 'select'>('pan');

const ROW_GAP = 240;
const OUTPUT_X = 440;
const OUTPUT_Y = ((MATERIAL_SLOTS.length - 1) * ROW_GAP) / 2;

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

const nodes = computed<Node[]>(() => {
  const texNodes: Node[] = MATERIAL_SLOTS.map((slot, i) => ({
    id: `slot-${slot}`,
    type: 'texture',
    position: { x: 0, y: i * ROW_GAP },
    data: { slot, texture: lookup.value[slot] ?? null },
    draggable: false,
    selectable: false,
    sourcePosition: Position.Right,
  }));
  const outputNode: Node = {
    id: 'material',
    type: 'materialOutput',
    position: { x: OUTPUT_X, y: OUTPUT_Y },
    data: { filled: filled.value },
    draggable: false,
    selectable: false,
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
</script>

<template>
  <div class="graph-wrap" :class="{ 'select-mode': interactionMode === 'select' }">
    <VueFlow
      :nodes="nodes"
      :edges="edges"
      :fit-view-on-init="true"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :elements-selectable="interactionMode === 'select'"
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
          @assign="onAssign"
          @remove="onUnassign"
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
            <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
            <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
            <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
          </svg>
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />
          </svg>
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
