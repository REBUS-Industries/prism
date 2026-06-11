<script setup lang="ts">
import {
  DEFAULT_GDTF_MODEL_QUALITY,
  GDTF_MODEL_QUALITIES,
  GDTF_MODEL_QUALITY_LABELS,
  type GdtfModelQuality,
} from '../utils/fixtureModelQuality';

withDefaults(defineProps<{
  modelValue: GdtfModelQuality;
  label?: string;
  disabled?: boolean;
}>(), {
  label: '3D model quality',
  disabled: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: GdtfModelQuality];
}>();
</script>

<template>
  <label class="quality-field">
    <span class="quality-label">{{ label }}</span>
    <select
      :value="modelValue"
      :disabled="disabled"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value as GdtfModelQuality)"
    >
      <option
        v-for="q in GDTF_MODEL_QUALITIES"
        :key="q"
        :value="q"
      >
        {{ GDTF_MODEL_QUALITY_LABELS[q] }}
      </option>
    </select>
    <p class="muted small quality-hint">
      GDTF packages may ship high, default, and low glTF meshes. Pick which LOD to import; you can change this later in the fixture editor.
    </p>
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
