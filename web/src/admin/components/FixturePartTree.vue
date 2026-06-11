<script setup lang="ts">
import { computed } from 'vue';
import type { FixturePart } from '../../shared/api';

const props = defineProps<{
  parts: FixturePart[];
  selectedId?: string | null;
}>();

const emit = defineEmits<{ select: [partId: string] }>();

interface TreeRow {
  part: FixturePart;
  depth: number;
}

const rows = computed<TreeRow[]>(() => {
  const roots = props.parts.filter((p) => !p.parentPartId);
  function branch(part: FixturePart, depth: number): TreeRow[] {
    const kids = props.parts.filter((p) => p.parentPartId === part.partId);
    return [
      { part, depth },
      ...kids.flatMap((k) => branch(k, depth + 1)),
    ];
  }
  if (roots.length) return roots.flatMap((r) => branch(r, 0));
  return props.parts.map((part) => ({ part, depth: 0 }));
});
</script>

<template>
  <ul class="part-tree">
    <li
      v-for="row in rows"
      :key="row.part.partId"
      class="part-row"
      :class="{ active: row.part.partId === selectedId }"
      :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
      @click="emit('select', row.part.partId)"
    >
      <span v-if="row.depth" class="branch muted" aria-hidden="true">└</span>
      <span class="tag pill">{{ row.part.tag }}</span>
      <span class="name">{{ row.part.name || row.part.partId }}</span>
    </li>
  </ul>
</template>

<style scoped>
.part-tree {
  list-style: none;
  padding: 0;
  margin: 0;
}
.part-row {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
}
.part-row:hover,
.part-row.active {
  background: var(--orbit-primary-fade);
}
.part-row.active {
  outline: 1px solid var(--orbit-primary);
}
.branch {
  font-size: 10px;
  flex: none;
  width: 10px;
}
.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pill {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  flex: none;
}
</style>
