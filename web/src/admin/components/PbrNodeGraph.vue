<script setup lang="ts">
/**
 * Vue Flow wrapper for the PBR material editor. Lays the eight slot
 * TextureNodes out in a vertical column on the left, pre-wires each to the
 * single MaterialOutputNode on the right, and animates an edge whenever its
 * slot is filled. Slot assignments come in via `slots` (the material detail's
 * slot list); assign / unassign bubble out so the parent can persist them and
 * refresh the live preview.
 */
import { computed } from 'vue';
import {
  VueFlow,
  Handle,
  MarkerType,
  Position,
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
  <div class="graph-wrap">
    <VueFlow
      :nodes="nodes"
      :edges="edges"
      :fit-view-on-init="true"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :elements-selectable="false"
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
