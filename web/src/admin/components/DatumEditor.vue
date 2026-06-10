<script setup lang="ts">
import type { FixturePart, Vec3 } from '../../shared/api';

const props = defineProps<{
  part: FixturePart | null;
}>();

const emit = defineEmits<{ update: [pivot: Vec3] }>();

function num(field: keyof Vec3, ev: Event): void {
  if (!props.part?.pivot) return;
  const v = parseFloat((ev.target as HTMLInputElement).value);
  if (Number.isNaN(v)) return;
  emit('update', { ...props.part.pivot, [field]: v });
}
</script>

<template>
  <div v-if="!part" class="muted">Select a part to edit its datum pivot.</div>
  <div v-else class="datum-editor">
    <h3>{{ part.name }} <span class="pill tag">{{ part.tag }}</span></h3>
    <p class="muted small">Adjust pivot (local space). Drag markers in the 3D view for coarse placement.</p>
    <div class="axis-row" v-if="part.pivot">
      <label>X <input type="number" step="0.001" :value="part.pivot.x" @change="num('x', $event)" /></label>
      <label>Y <input type="number" step="0.001" :value="part.pivot.y" @change="num('y', $event)" /></label>
      <label>Z <input type="number" step="0.001" :value="part.pivot.z" @change="num('z', $event)" /></label>
    </div>
    <div v-else class="muted">No pivot on this part yet.</div>
  </div>
</template>

<style scoped>
.axis-row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
.axis-row label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.axis-row input { width: 88px; }
</style>
