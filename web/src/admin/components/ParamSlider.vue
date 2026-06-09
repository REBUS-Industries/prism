<script setup lang="ts">
/**
 * Compact labelled slider with a paired numeric input, styled to match common
 * PBR texture editors. Two-way binds a single number via `v-model`; the range
 * drives live edits while the number box gives a precise, clamped readout.
 * Carries `nodrag nopan` so dragging it inside a Vue Flow node never pans or
 * drags the graph.
 */
const props = defineProps<{
  label: string;
  min: number;
  max: number;
  step: number;
  sublabel?: string | null;
}>();

const model = defineModel<number>({ required: true });

function clamp(v: number): number {
  return Math.min(props.max, Math.max(props.min, v));
}

function onRange(ev: Event): void {
  model.value = parseFloat((ev.target as HTMLInputElement).value);
}

function onNumber(ev: Event): void {
  const v = parseFloat((ev.target as HTMLInputElement).value);
  if (Number.isNaN(v)) return;
  model.value = clamp(v);
}
</script>

<template>
  <div class="param-field nodrag nopan">
    <div class="pf-label">
      <span class="pf-name">{{ label }}</span>
      <span v-if="sublabel" class="pf-sub">{{ sublabel }}</span>
    </div>
    <div class="pf-row">
      <input
        class="pf-range nodrag nopan"
        type="range"
        :min="min"
        :max="max"
        :step="step"
        :value="model"
        @input="onRange"
      />
      <input
        class="pf-num nodrag nopan"
        type="number"
        :min="min"
        :max="max"
        :step="step"
        :value="model"
        @change="onNumber"
      />
    </div>
  </div>
</template>

<style scoped>
.param-field { display: flex; flex-direction: column; gap: 4px; }
.pf-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}
.pf-name { font-size: 11px; font-weight: 600; color: var(--color-text); }
.pf-sub {
  font-size: 10px;
  color: var(--color-text-subtle);
  text-transform: lowercase;
  letter-spacing: 0.01em;
}
.pf-row { display: flex; align-items: center; gap: 8px; }
.pf-range {
  flex: 1;
  min-width: 0;
  height: 4px;
  padding: 0;
  margin: 6px 0;
  appearance: none;
  -webkit-appearance: none;
  background: var(--color-border-strong);
  border: none;
  border-radius: 999px;
  cursor: pointer;
}
.pf-range:focus { outline: none; }
.pf-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--orbit-primary);
  border: 2px solid var(--color-bg-elevated);
  box-shadow: var(--shadow-1);
  cursor: pointer;
}
.pf-range::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--orbit-primary);
  border: 2px solid var(--color-bg-elevated);
  box-shadow: var(--shadow-1);
  cursor: pointer;
}
.pf-num {
  width: 58px;
  flex: none;
  padding: 3px 6px;
  font-size: 11px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pf-num::-webkit-outer-spin-button,
.pf-num::-webkit-inner-spin-button { margin: 0; }
</style>
