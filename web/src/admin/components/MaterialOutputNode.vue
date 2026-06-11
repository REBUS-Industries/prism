<script setup lang="ts">
/**
 * Central PBR material node in the two-column layout.
 *
 * Left handles (Position.Left) accept wires from the left texture column:
 *   albedo, roughness, ao, opacity
 * Right handles (Position.Right) accept wires from the right texture column:
 *   normal, metallic, emissive, displacement
 *
 * The param handle (right side) accepts the UV/parameter node wire.
 */
import { Handle, Position } from '@vue-flow/core';
import { LEFT_MATERIAL_SLOTS, RIGHT_MATERIAL_SLOTS, SLOT_LABELS, type MaterialSlot } from '../../shared/api';

defineProps<{ filled: Partial<Record<MaterialSlot, boolean>> }>();
</script>

<template>
  <div class="output-node">
    <div class="on-head node-drag-handle">PBR Material</div>
    <div class="on-rows nodrag nopan">
      <div v-for="(_, i) in 4" :key="i" class="on-row">
        <!-- Left column slot -->
        <div class="on-half on-left">
          <Handle
            :id="LEFT_MATERIAL_SLOTS[i]!"
            type="target"
            :position="Position.Left"
            :connectable="false"
          />
          <span class="dot" :class="{ filled: filled[LEFT_MATERIAL_SLOTS[i]!] }" />
          <span class="on-label">{{ SLOT_LABELS[LEFT_MATERIAL_SLOTS[i]!] }}</span>
        </div>
        <!-- Right column slot -->
        <div class="on-half on-right">
          <span class="on-label on-label-right">{{ SLOT_LABELS[RIGHT_MATERIAL_SLOTS[i]!] }}</span>
          <span class="dot" :class="{ filled: filled[RIGHT_MATERIAL_SLOTS[i]!] }" />
          <Handle
            :id="RIGHT_MATERIAL_SLOTS[i]!"
            type="target"
            :position="Position.Right"
            :connectable="false"
          />
        </div>
      </div>
    </div>
    <!-- UV / param handle on the bottom -->
    <Handle id="param" type="target" :position="Position.Bottom" :connectable="false" />
  </div>
</template>

<style scoped>
.output-node {
  width: 280px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--orbit-primary);
  border-radius: var(--radius);
  box-shadow: var(--shadow-2);
  overflow: hidden;
  cursor: default;
}
.on-head {
  padding: 11px 14px;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #fff;
  background: var(--orbit-primary);
  text-align: center;
}
.on-rows { padding: 6px 0; }
.on-row {
  display: flex;
  align-items: center;
  padding: 2px 0;
}
.on-half {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  position: relative;
}
.on-left { padding: 6px 10px 6px 16px; }
.on-right { padding: 6px 16px 6px 10px; justify-content: flex-end; }
.dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--color-border-strong);
  flex: none;
}
.dot.filled { background: var(--color-success); }
.on-label {
  font-size: 12px;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.on-label-right { text-align: right; }
</style>
