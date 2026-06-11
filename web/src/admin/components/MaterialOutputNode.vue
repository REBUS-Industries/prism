<script setup lang="ts">
/**
 * Custom Vue Flow node representing the assembled PBR material. One labelled
 * input Handle per slot sits on the left edge; a status dot is green when the
 * slot is filled and grey when empty, driven by the `filled` map the graph
 * feeds in. Handles are nested inside position:relative rows so each lines up
 * with its label — Vue Flow measures the real DOM position when routing edges.
 */
import { Handle, Position } from '@vue-flow/core';
import { MATERIAL_SLOTS, SLOT_LABELS, type MaterialSlot } from '../../shared/api';

defineProps<{ filled: Partial<Record<MaterialSlot, boolean>> }>();
</script>

<template>
  <div class="output-node">
    <div class="on-head node-drag-handle">PBR Material</div>
    <div class="on-rows nodrag nopan">
      <div v-for="slot in MATERIAL_SLOTS" :key="slot" class="on-row">
        <Handle :id="slot" type="target" :position="Position.Left" :connectable="false" />
        <span class="dot" :class="{ filled: filled[slot] }" />
        <span class="on-label">{{ SLOT_LABELS[slot] }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.output-node {
  width: 196px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--orbit-primary);
  border-radius: var(--radius);
  box-shadow: var(--shadow-2);
  overflow: hidden;
  cursor: default;
}
.on-head {
  padding: 9px 12px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #fff;
  background: var(--orbit-primary);
  text-align: center;
}
.on-rows { padding: 4px 0; }
.on-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
}
.dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--color-border-strong);
  flex: none;
}
.dot.filled { background: var(--color-success); }
.on-label { font-size: 12px; color: var(--color-text-muted); white-space: nowrap; }
</style>
