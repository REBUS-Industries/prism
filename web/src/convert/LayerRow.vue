<script setup lang="ts">
import { computed } from 'vue';
import type { LayerNode } from '../shared/api';

const props = defineProps<{
  node: LayerNode;
  expanded: Set<string>;
  tristate: (n: LayerNode) => 'checked' | 'mixed' | 'unchecked';
  busy?: boolean;
}>();

defineEmits<{
  (e: 'toggle', node: LayerNode): void;
  (e: 'toggle-expanded', node: LayerNode): void;
}>();

const path = computed(() => props.node.fullPath ?? props.node.name);
const isOpen = computed(() => props.expanded.has(path.value));
const hasKids = computed(() => !!(props.node.children && props.node.children.length));
const state = computed(() => props.tristate(props.node));
</script>

<template>
  <div class="row">
    <div class="row-head">
      <button
        v-if="hasKids"
        class="expander"
        type="button"
        :aria-expanded="isOpen"
        @click="$emit('toggle-expanded', node)">{{ isOpen ? '▾' : '▸' }}</button>
      <span v-else class="expander placeholder">·</span>

      <label class="layer-label" :class="{ dim: node.visible === false }">
        <input
          type="checkbox"
          :checked="state === 'checked'"
          :indeterminate.prop="state === 'mixed'"
          :disabled="busy"
          @change="$emit('toggle', node)" />
        <span class="swatch" v-if="node.color" :style="{ backgroundColor: node.color }"></span>
        <span class="name">{{ node.name }}</span>
      </label>
    </div>
    <div v-if="isOpen && hasKids" class="children">
      <LayerRow
        v-for="child in node.children"
        :key="child.fullPath ?? child.name"
        :node="child"
        :expanded="expanded"
        :tristate="tristate"
        :busy="busy"
        @toggle="(n) => $emit('toggle', n)"
        @toggle-expanded="(n) => $emit('toggle-expanded', n)" />
    </div>
  </div>
</template>

<style scoped>
.children { padding-left: 18px; border-left: 1px solid var(--color-border); margin-left: 4px; }
.row-head { display: flex; align-items: center; gap: 4px; padding: 2px 0; }
.expander {
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
}
.expander.placeholder { color: var(--color-text-muted); cursor: default; }
.layer-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}
.layer-label.dim { opacity: 0.55; }
.swatch {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 2px;
  border: 1px solid var(--color-border);
}
</style>
