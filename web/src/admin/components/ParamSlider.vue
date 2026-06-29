<script setup lang="ts">
/**
 * Compact labelled slider with a paired numeric input, styled to match common
 * PBR texture editors. Two-way binds a single number via `v-model`; the range
 * drives live edits while the number box gives a precise, clamped readout.
 * The number box accepts simple arithmetic (+ - * /) on commit.
 * Carries `nodrag nopan` so dragging it inside a Vue Flow node never pans or
 * drags the graph.
 */
import { ref, watch } from 'vue';
import { evalNumericInput } from '../utils/evalNumericInput';

const props = defineProps<{
  label: string;
  min: number;
  max: number;
  step: number;
  sublabel?: string | null;
}>();

const model = defineModel<number>({ required: true });

const editing = ref(false);
const draft = ref('');

function clamp(v: number): number {
  return Math.min(props.max, Math.max(props.min, v));
}

function formatValue(v: number): string {
  return String(v);
}

function onRange(ev: Event): void {
  model.value = parseFloat((ev.target as HTMLInputElement).value);
}

function onNumFocus(): void {
  editing.value = true;
  draft.value = formatValue(model.value);
}

function onNumInput(ev: Event): void {
  draft.value = (ev.target as HTMLInputElement).value;
}

function commitNumber(): void {
  if (!editing.value) return;
  editing.value = false;

  const parsed = evalNumericInput(draft.value);
  if (parsed === null) {
    draft.value = formatValue(model.value);
    return;
  }

  model.value = clamp(parsed);
  draft.value = formatValue(model.value);
}

function onNumKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    commitNumber();
    (ev.target as HTMLInputElement).blur();
    return;
  }
  if (ev.key === 'Escape') {
    draft.value = formatValue(model.value);
    editing.value = false;
    (ev.target as HTMLInputElement).blur();
  }
}

watch(model, (v) => {
  if (!editing.value) draft.value = formatValue(v);
});
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
        type="text"
        inputmode="decimal"
        spellcheck="false"
        :value="editing ? draft : formatValue(model)"
        title="Enter a number or expression (+ - * /)"
        @focus="onNumFocus"
        @input="onNumInput"
        @change="commitNumber"
        @blur="commitNumber"
        @keydown="onNumKeydown"
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
</style>
