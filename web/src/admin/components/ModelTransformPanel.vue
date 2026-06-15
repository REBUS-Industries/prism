<script setup lang="ts">
import { computed } from 'vue';
import ParamSlider from './ParamSlider.vue';
import type { ModelTransform } from '../../shared/api';
import { ensureModelTransform } from '../utils/modelTransform';
import {
  metresToUnit,
  positionSliderRange,
  unitToMetres,
  type ModelLengthUnit,
} from '../utils/modelUnits';

const transform = defineModel<ModelTransform>({ required: true });

const props = withDefaults(defineProps<{
  /** Display unit for position sliders (canonical storage remains metres). */
  displayUnits?: ModelLengthUnit;
}>(), {
  displayUnits: 'mm',
});

const posRange = computed(() => positionSliderRange(props.displayUnits));

function t(): ModelTransform {
  return ensureModelTransform(transform.value);
}

function posDisplay(axis: 'x' | 'y' | 'z', value: number): void {
  const next = t();
  next.position[axis] = unitToMetres(value, props.displayUnits);
  transform.value = next;
}

function rotDeg(axis: 'x' | 'y' | 'z', deg: number): void {
  const next = t();
  next.rotation[axis] = deg;
  transform.value = next;
}

function scaleVal(axis: 'x' | 'y' | 'z', v: number): void {
  const next = t();
  next.scale[axis] = Math.max(0.001, v);
  transform.value = next;
}

function posDisplayValue(axis: 'x' | 'y' | 'z'): number {
  return metresToUnit(t().position[axis], props.displayUnits);
}

function rotDegValue(axis: 'x' | 'y' | 'z'): number {
  return t().rotation[axis];
}

function scaleValue(axis: 'x' | 'y' | 'z'): number {
  return t().scale[axis];
}

function resetTransform(): void {
  transform.value = ensureModelTransform(null);
}
</script>

<template>
  <div class="model-transform">
    <header class="panel-head">
      <h3>Transform</h3>
      <button type="button" class="reset-btn muted" title="Reset to identity" @click="resetTransform">Reset</button>
    </header>

    <fieldset class="field-group">
      <legend>Position <span class="unit">{{ displayUnits }}</span></legend>
      <ParamSlider label="X" :min="posRange.min" :max="posRange.max" :step="posRange.step" :model-value="posDisplayValue('x')" @update:model-value="posDisplay('x', $event)" />
      <ParamSlider label="Y" :min="posRange.min" :max="posRange.max" :step="posRange.step" :model-value="posDisplayValue('y')" @update:model-value="posDisplay('y', $event)" />
      <ParamSlider label="Z" :min="posRange.min" :max="posRange.max" :step="posRange.step" :model-value="posDisplayValue('z')" @update:model-value="posDisplay('z', $event)" />
    </fieldset>

    <fieldset class="field-group">
      <legend>Rotation <span class="unit">°</span></legend>
      <ParamSlider label="X" :min="-360" :max="360" :step="0.1" :model-value="rotDegValue('x')" @update:model-value="rotDeg('x', $event)" />
      <ParamSlider label="Y" :min="-360" :max="360" :step="0.1" :model-value="rotDegValue('y')" @update:model-value="rotDeg('y', $event)" />
      <ParamSlider label="Z" :min="-360" :max="360" :step="0.1" :model-value="rotDegValue('z')" @update:model-value="rotDeg('z', $event)" />
    </fieldset>

    <fieldset class="field-group">
      <legend>Scale</legend>
      <ParamSlider label="X" :min="0.001" :max="10" :step="0.01" :model-value="scaleValue('x')" @update:model-value="scaleVal('x', $event)" />
      <ParamSlider label="Y" :min="0.001" :max="10" :step="0.01" :model-value="scaleValue('y')" @update:model-value="scaleVal('y', $event)" />
      <ParamSlider label="Z" :min="0.001" :max="10" :step="0.01" :model-value="scaleValue('z')" @update:model-value="scaleVal('z', $event)" />
    </fieldset>
  </div>
</template>

<style scoped>
.model-transform { display: flex; flex-direction: column; gap: 8px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.panel-head h3 { margin: 0; font-size: 14px; }
.reset-btn { background: none; border: none; font-size: 11px; cursor: pointer; text-decoration: underline; padding: 0; }
.field-group { border: none; margin: 0; padding: 0; }
.field-group legend { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-muted, #888); margin-bottom: 4px; }
.unit { font-weight: 400; text-transform: none; letter-spacing: 0; opacity: 0.8; }
</style>
