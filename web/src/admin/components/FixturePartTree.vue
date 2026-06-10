<script setup lang="ts">
import type { FixturePart } from '../../shared/api';

defineProps<{
  parts: FixturePart[];
  selectedId?: string | null;
}>();

const emit = defineEmits<{ select: [partId: string] }>();
</script>

<template>
  <ul class="part-tree">
    <li
      v-for="p in parts"
      :key="p.partId"
      :class="{ active: p.partId === selectedId }"
      @click="emit('select', p.partId)"
    >
      <span class="tag pill">{{ p.tag }}</span>
      <span class="name">{{ p.name || p.partId }}</span>
    </li>
  </ul>
</template>

<style scoped>
.part-tree { list-style: none; padding: 0; margin: 0; }
.part-tree li {
  display: flex; gap: 8px; align-items: center;
  padding: 6px 8px; border-radius: 6px; cursor: pointer;
}
.part-tree li:hover, .part-tree li.active { background: var(--surface-2, #2a2a32); }
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
