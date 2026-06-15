<script setup lang="ts">
import ParamSlider from './ParamSlider.vue';
import type { ModelTransform } from '../../shared/api';
import { ensureModelTransform } from '../utils/modelTransform';
import { metresToMm, mmToMetres } from '../utils/fixtureTransform';

const transform = defineModel<ModelTransform>({ required: true });

function t(): ModelTransform {
  return ensureModelTransform(transform.value);
}

function posMm(axis: 'x' | 'y' | 'z', mm: number): void {
  const next = t();
  next.position[axis] = mmToMetres(mm);
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

function posMmValue(axis: 'x' | 'y' | 'z'): number {
  return metresToMm(t().position[axis]);
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
      <legend>Position <span class="unit">mm</span></legend>
      <ParamSlider label="X" :min="-5000" :max="5000" :step="1" :model-value="posMmValue('x')" @update:model-value="posMm('x', $event)" />
      <ParamSlider label="Y" :min="-5000" :max="5000" :step="1" :model-value="posMmValue('y')" @update:model-value="posMm('y', $event)" />
      <ParamSlider label="Z" :min="-5000" :max="5000" :step="1" :model-value="posMmValue('z')" @update:model-value="posMm('z', $event)" />
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
