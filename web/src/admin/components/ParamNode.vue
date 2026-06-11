<script setup lang="ts">
/**
 * Vue Flow node for a PBR parameter block. Renders controls for a single
 * paramType (displacement, textureUv, alpha, or any glTF extension like
 * clearCoat, transmission, etc.). Lives on the graph canvas to the right of
 * the MaterialOutputNode, connected by a smoothstep edge.
 */
import { Handle, Position } from '@vue-flow/core';
import ParamSlider from './ParamSlider.vue';
import ParamColor from './ParamColor.vue';
import type { MaterialParameters } from '../../shared/api';

const PARAM_LABELS: Record<string, string> = {
  base:               'Base Properties',
  displacement:     'Displacement',
  textureUv:        'Texture UV',
  alpha:            'Alpha',
  clearCoat:        'Clear Coat',
  transmission:     'Transmission',
  ior:              'IOR',
  specular:         'Specular',
  sheen:            'Sheen',
  volume:           'Volume',
  anisotropy:       'Anisotropy',
  iridescence:      'Iridescence',
  emissiveStrength: 'Emissive Strength',
  dispersion:       'Dispersion',
  unlit:            'Unlit',
};

const props = defineProps<{
  data: {
    paramType: string;
    parameters: MaterialParameters;
    onParamChange: (change: { key: keyof MaterialParameters; value: number | string | boolean | string[] }) => void;
    onRemove?: () => void;
  };
}>();

function onParam<K extends keyof MaterialParameters>(
  key: K,
  value: MaterialParameters[K],
): void {
  props.data.onParamChange({ key, value: value as number | string | boolean | string[] });
}
</script>

<template>
  <div class="param-node">
    <div class="pn-head node-drag-handle">
      <span class="pn-label">{{ PARAM_LABELS[data.paramType] ?? data.paramType }}</span>
      <button
        v-if="data.onRemove"
        type="button"
        class="pn-remove nodrag nopan"
        title="Remove block"
        @click="data.onRemove()"
      >×</button>
    </div>

    <div class="pn-body nodrag nopan">

      <!-- base (always-on consolidated PBR scalars) -->
      <template v-if="data.paramType === 'base'">
        <ParamColor
          label="Base Color"
          :model-value="data.parameters.baseColor"
          @update:model-value="(v) => onParam('baseColor', v)"
        />
        <ParamSlider
          label="Metallic" :min="0" :max="1" :step="0.01"
          :model-value="data.parameters.metallic"
          @update:model-value="(v) => onParam('metallic', v)"
        />
        <ParamSlider
          label="Roughness" :min="0" :max="1" :step="0.01"
          :model-value="data.parameters.roughness"
          @update:model-value="(v) => onParam('roughness', v)"
        />
        <ParamColor
          label="Emissive"
          :model-value="data.parameters.emissiveColor"
          @update:model-value="(v) => onParam('emissiveColor', v)"
        />
        <ParamSlider
          label="Emissive Intensity" :min="0" :max="10" :step="0.1"
          :model-value="data.parameters.emissiveIntensity"
          @update:model-value="(v) => onParam('emissiveIntensity', v)"
        />
        <ParamSlider
          label="Normal Scale" :min="0" :max="2" :step="0.01"
          :model-value="data.parameters.normalScale"
          @update:model-value="(v) => onParam('normalScale', v)"
        />
        <ParamSlider
          label="Occlusion" sublabel="AO intensity" :min="0" :max="1" :step="0.01"
          :model-value="data.parameters.aoIntensity"
          @update:model-value="(v) => onParam('aoIntensity', v)"
        />
      </template>

      <!-- displacement -->
      <template v-if="data.paramType === 'displacement'">
        <ParamSlider
          label="Scale" :min="0" :max="0.5" :step="0.005"
          :model-value="data.parameters.displacementScale"
          @update:model-value="(v) => onParam('displacementScale', v)"
        />
        <ParamSlider
          label="Bias" :min="-0.5" :max="0.5" :step="0.005"
          :model-value="data.parameters.displacementBias"
          @update:model-value="(v) => onParam('displacementBias', v)"
        />
      </template>

      <!-- textureUv -->
      <template v-else-if="data.paramType === 'textureUv'">
        <div class="pn-grid-2">
          <ParamSlider
            label="Tiling X" :min="0.1" :max="16" :step="0.1"
            :model-value="data.parameters.tilingX"
            @update:model-value="(v) => onParam('tilingX', v)"
          />
          <ParamSlider
            label="Tiling Y" :min="0.1" :max="16" :step="0.1"
            :model-value="data.parameters.tilingY"
            @update:model-value="(v) => onParam('tilingY', v)"
          />
          <ParamSlider
            label="Offset X" :min="-2" :max="2" :step="0.01"
            :model-value="data.parameters.offsetX"
            @update:model-value="(v) => onParam('offsetX', v)"
          />
          <ParamSlider
            label="Offset Y" :min="-2" :max="2" :step="0.01"
            :model-value="data.parameters.offsetY"
            @update:model-value="(v) => onParam('offsetY', v)"
          />
        </div>
      </template>

      <!-- alpha -->
      <template v-else-if="data.paramType === 'alpha'">
        <label class="pn-field">
          <span class="pn-field-label">Alpha Mode</span>
          <select
            class="pn-select nodrag nopan"
            :value="data.parameters.alphaMode"
            @change="onParam('alphaMode', ($event.target as HTMLSelectElement).value as 'opaque' | 'blend' | 'mask')"
          >
            <option value="opaque">Opaque</option>
            <option value="blend">Blend</option>
            <option value="mask">Mask</option>
          </select>
        </label>
        <ParamSlider
          v-if="data.parameters.alphaMode === 'mask'"
          label="Alpha Cutoff" :min="0" :max="1" :step="0.01"
          :model-value="data.parameters.alphaCutoff"
          @update:model-value="(v) => onParam('alphaCutoff', v)"
        />
        <label class="pn-toggle nodrag nopan">
          <input
            type="checkbox"
            class="nodrag nopan"
            :checked="data.parameters.doubleSided"
            @change="onParam('doubleSided', ($event.target as HTMLInputElement).checked)"
          />
          Double Sided
        </label>
        <label class="pn-toggle nodrag nopan">
          <input
            type="checkbox"
            class="nodrag nopan"
            :checked="data.parameters.flipNormalY"
            @change="onParam('flipNormalY', ($event.target as HTMLInputElement).checked)"
          />
          Flip Normal Y
        </label>
      </template>

      <!-- clearCoat -->
      <template v-else-if="data.paramType === 'clearCoat'">
        <ParamSlider
          label="Factor" :min="0" :max="1" :step="0.01"
          :model-value="data.parameters.clearCoatFactor"
          @update:model-value="(v) => onParam('clearCoatFactor', v)"
        />
        <ParamSlider
          label="Roughness" :min="0" :max="1" :step="0.01"
          :model-value="data.parameters.clearCoatRoughness"
          @update:model-value="(v) => onParam('clearCoatRoughness', v)"
        />
      </template>

      <!-- transmission -->
      <template v-else-if="data.paramType === 'transmission'">
        <ParamSlider
          label="Factor" :min="0" :max="1" :step="0.01"
          :model-value="data.parameters.transmissionFactor"
          @update:model-value="(v) => onParam('transmissionFactor', v)"
        />
      </template>

      <!-- ior -->
      <template v-else-if="data.paramType === 'ior'">
        <ParamSlider
          label="IOR" :min="1" :max="2.5" :step="0.01"
          :model-value="data.parameters.ior"
          @update:model-value="(v) => onParam('ior', v)"
        />
      </template>

      <!-- specular -->
      <template v-else-if="data.paramType === 'specular'">
        <ParamSlider
          label="Factor" :min="0" :max="1" :step="0.01"
          :model-value="data.parameters.specularFactor"
          @update:model-value="(v) => onParam('specularFactor', v)"
        />
        <ParamColor
          label="Color"
          :model-value="data.parameters.specularColor"
          @update:model-value="(v) => onParam('specularColor', v)"
        />
      </template>

      <!-- sheen -->
      <template v-else-if="data.paramType === 'sheen'">
        <ParamColor
          label="Color"
          :model-value="data.parameters.sheenColor"
          @update:model-value="(v) => onParam('sheenColor', v)"
        />
        <ParamSlider
          label="Roughness" :min="0" :max="1" :step="0.01"
          :model-value="data.parameters.sheenRoughness"
          @update:model-value="(v) => onParam('sheenRoughness', v)"
        />
      </template>

      <!-- volume -->
      <template v-else-if="data.paramType === 'volume'">
        <ParamSlider
          label="Thickness Factor" :min="0" :max="10" :step="0.1"
          :model-value="data.parameters.volumeThicknessFactor"
          @update:model-value="(v) => onParam('volumeThicknessFactor', v)"
        />
        <label class="pn-field">
          <span class="pn-field-label">Attenuation Distance</span>
          <input
            class="pn-number nodrag nopan"
            type="number" min="0" step="1"
            :value="data.parameters.volumeAttenuationDistance"
            @change="onParam('volumeAttenuationDistance', Math.max(0, parseFloat(($event.target as HTMLInputElement).value) || 1000))"
          />
        </label>
        <ParamColor
          label="Attenuation Color"
          :model-value="data.parameters.volumeAttenuationColor"
          @update:model-value="(v) => onParam('volumeAttenuationColor', v)"
        />
      </template>

      <!-- anisotropy -->
      <template v-else-if="data.paramType === 'anisotropy'">
        <ParamSlider
          label="Strength" :min="0" :max="1" :step="0.01"
          :model-value="data.parameters.anisotropyStrength"
          @update:model-value="(v) => onParam('anisotropyStrength', v)"
        />
        <ParamSlider
          label="Rotation (rad)" :min="0" :max="6.2832" :step="0.01"
          :model-value="data.parameters.anisotropyRotation"
          @update:model-value="(v) => onParam('anisotropyRotation', v)"
        />
      </template>

      <!-- iridescence -->
      <template v-else-if="data.paramType === 'iridescence'">
        <ParamSlider
          label="Factor" :min="0" :max="1" :step="0.01"
          :model-value="data.parameters.iridescenceFactor"
          @update:model-value="(v) => onParam('iridescenceFactor', v)"
        />
        <ParamSlider
          label="IOR" :min="1" :max="2.5" :step="0.01"
          :model-value="data.parameters.iridescenceIor"
          @update:model-value="(v) => onParam('iridescenceIor', v)"
        />
        <div class="pn-grid-2">
          <label class="pn-field">
            <span class="pn-field-label">Thickness Min</span>
            <input
              class="pn-number nodrag nopan"
              type="number" min="0" step="10"
              :value="data.parameters.iridescenceThicknessMin"
              @change="onParam('iridescenceThicknessMin', Math.max(0, parseFloat(($event.target as HTMLInputElement).value) || 0))"
            />
          </label>
          <label class="pn-field">
            <span class="pn-field-label">Thickness Max</span>
            <input
              class="pn-number nodrag nopan"
              type="number" min="0" step="10"
              :value="data.parameters.iridescenceThicknessMax"
              @change="onParam('iridescenceThicknessMax', Math.max(0, parseFloat(($event.target as HTMLInputElement).value) || 0))"
            />
          </label>
        </div>
      </template>

      <!-- emissiveStrength -->
      <template v-else-if="data.paramType === 'emissiveStrength'">
        <label class="pn-field">
          <span class="pn-field-label">Strength</span>
          <input
            class="pn-number nodrag nopan"
            type="number" min="0" step="0.1"
            :value="data.parameters.emissiveStrength"
            @change="onParam('emissiveStrength', Math.max(0, parseFloat(($event.target as HTMLInputElement).value) || 1))"
          />
        </label>
      </template>

      <!-- dispersion -->
      <template v-else-if="data.paramType === 'dispersion'">
        <ParamSlider
          label="Factor" :min="0" :max="1" :step="0.01"
          :model-value="data.parameters.dispersionFactor"
          @update:model-value="(v) => onParam('dispersionFactor', v)"
        />
      </template>

      <!-- unlit -->
      <template v-else-if="data.paramType === 'unlit'">
        <label class="pn-toggle nodrag nopan">
          <input
            type="checkbox"
            class="nodrag nopan"
            :checked="data.parameters.unlit"
            @change="onParam('unlit', ($event.target as HTMLInputElement).checked)"
          />
          Unlit (disable lighting calculations)
        </label>
      </template>

    </div>

    <Handle type="source" :position="Position.Left" :connectable="false" />
  </div>
</template>

<style scoped>
.param-node {
  min-width: 220px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  overflow: hidden;
  cursor: default;
}
.pn-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 7px 12px;
  background: var(--color-bg-input);
  border-bottom: 1px solid var(--color-border);
}
.pn-label {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--color-text);
}
.pn-remove {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-size: 15px;
  line-height: 1;
  background: transparent;
  border: none;
  color: var(--color-text-subtle);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.pn-remove:hover { color: var(--color-error); background: transparent; border-color: transparent; }
.pn-body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pn-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 8px;
}
.pn-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pn-field-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text);
}
.pn-select {
  width: 100%;
  padding: 5px 8px;
  font-size: 12px;
  background: var(--color-bg-input);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  cursor: pointer;
}
.pn-number {
  width: 100%;
  padding: 4px 8px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.pn-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-muted);
  cursor: pointer;
}
.pn-toggle input { width: 14px; height: 14px; cursor: pointer; }
</style>
