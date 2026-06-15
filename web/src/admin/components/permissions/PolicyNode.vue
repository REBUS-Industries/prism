<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core';

defineProps<{
  label: string;
  nodeType: string;
  refValue?: string | null;
}>();
</script>

<template>
  <div :class="['perm-node', `perm-node--${nodeType}`]">
    <Handle type="target" :position="Position.Left" />
    <div class="perm-node__type">{{ nodeType }}</div>
    <div class="perm-node__label">{{ label }}</div>
    <div v-if="refValue" class="perm-node__ref">{{ refValue }}</div>
    <Handle type="source" :position="Position.Right" />
  </div>
</template>

<style scoped>
.perm-node {
  min-width: 140px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 12px;
}
.perm-node__type {
  text-transform: uppercase;
  font-size: 10px;
  opacity: 0.7;
  letter-spacing: 0.04em;
}
.perm-node__label {
  font-weight: 600;
  margin-top: 2px;
}
.perm-node__ref {
  margin-top: 4px;
  font-family: var(--mono, monospace);
  font-size: 10px;
  opacity: 0.85;
  word-break: break-all;
}
.perm-node--role { border-color: #6366f1; }
.perm-node--user { border-color: #22c55e; }
.perm-node--project { border-color: #f59e0b; }
.perm-node--function { border-color: #ec4899; }
</style>
