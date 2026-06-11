<script setup lang="ts">
import { computed, watch } from 'vue';
import {
  GDTF_MODEL_QUALITIES,
  GDTF_MODEL_QUALITY_LABELS,
  coerceModelQuality,
  modelFormatSummary,
  type GdtfModelQuality,
  type GdtfModelFormat,
} from '../utils/fixtureModelQuality';

const props = withDefaults(defineProps<{
  modelValue: GdtfModelQuality;
  available?: readonly GdtfModelQuality[] | null;
  formats?: readonly GdtfModelFormat[] | null;
  label?: string;
  disabled?: boolean;
  loading?: boolean;
}>(), {
  available: null,
  formats: null,
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

// A package that ships a single mesh (very common — e.g. GLP fixtures with one
// 3DS folder) has nothing to choose between. Show an honest note instead of a
// picker that implies resolutions the GDTF does not contain.
const singleMesh = computed(() => !props.loading && !!props.available && props.available.length === 1);

const formatNote = computed(() => modelFormatSummary(props.formats));

const singleMeshMessage = computed(() => {
  const quality = props.available?.[0];
  const qualityLabel = quality ? GDTF_MODEL_QUALITY_LABELS[quality] : 'a single mesh';
  const base = `This GDTF ships one mesh (${qualityLabel}). It does not include high or low resolution variants`;
  const fmt = formatNote.value ? ` — ${formatNote.value}` : '';
  return `${base}${fmt}. GDTF-Share's “3D Low/High Resolution” modes are viewer render settings, not separate meshes.`;
});

const hint = computed(() => {
  if (props.loading) return 'Reading mesh options from GDTF package…';
  if (props.available && props.available.length > 1) {
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
  <div class="quality-field">
    <span class="quality-label">{{ label }}</span>

    <p v-if="available && available.length === 0 && !loading" class="muted small quality-hint">
      No 3D mesh found in this GDTF package.
    </p>

    <p v-else-if="singleMesh" class="muted small quality-hint single-mesh">
      {{ singleMeshMessage }}
    </p>

    <template v-else>
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
      <p class="muted small quality-hint">{{ hint }}</p>
    </template>
  </div>
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
