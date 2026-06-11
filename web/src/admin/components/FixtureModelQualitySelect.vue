<script setup lang="ts">
import { computed, watch } from 'vue';
import {
  GDTF_MODEL_QUALITIES,
  GDTF_MODEL_QUALITY_LABELS,
  coerceModelQuality,
  type GdtfModelQuality,
} from '../utils/fixtureModelQuality';

const props = withDefaults(defineProps<{
  modelValue: GdtfModelQuality;
  available?: readonly GdtfModelQuality[] | null;
  label?: string;
  disabled?: boolean;
  loading?: boolean;
}>(), {
  label: '3D model quality',
  disabled: false,
  loading: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: GdtfModelQuality];
}>();

const options = computed(() => {
  if (props.available?.length) return [...props.available];
  return [...GDTF_MODEL_QUALITIES];
});

const hint = computed(() => {
  if (props.loading) return 'Reading mesh options from GDTF package…';
  if (props.available?.length) {
    return 'Options are based on mesh LOD folders shipped in this GDTF file (gltf_high, gltf, gltf_low).';
  }
  return 'GDTF packages may ship high, default, and low glTF meshes. Pick which LOD to import.';
});

watch(
  () => props.available,
  (available) => {
    if (!available?.length) return;
    const next = coerceModelQuality(props.modelValue, available);
    if (next !== props.modelValue) emit('update:modelValue', next);
  },
  { immediate: true },
);

function onChange(ev: Event): void {
  const value = (ev.target as HTMLSelectElement).value as GdtfModelQuality;
  emit('update:modelValue', coerceModelQuality(value, props.available));
}
</script>

<template>
  <label class="quality-field">
    <span class="quality-label">{{ label }}</span>
    <select
      :value="modelValue"
      :disabled="disabled || loading || options.length === 0"
      @change="onChange"
    >
      <option
        v-for="q in options"
        :key="q"
        :value="q"
      >
        {{ GDTF_MODEL_QUALITY_LABELS[q] }}
      </option>
    </select>
    <p v-if="options.length === 0 && !loading" class="muted small quality-hint">
      No 3D mesh LOD folders found in this GDTF package.
    </p>
    <p v-else class="muted small quality-hint">{{ hint }}</p>
  </label>
</template>

<style scoped>
.quality-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.quality-label {
  font-size: 13px;
  font-weight: 600;
}

.quality-field select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-input);
  font-size: 13px;
}

.quality-hint {
  margin: 0;
  line-height: 1.4;
}

.small { font-size: 12px; }
</style>
