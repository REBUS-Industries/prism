<script setup lang="ts">
/**
 * Custom Vue Flow node for one PBR slot. Empty slots offer "Upload New"
 * (direct multipart POST) and "Pick from Library" (opens TexturePickerModal);
 * filled slots show a thumbnail with "Change" / "Remove". Assignments bubble
 * up to PbrNodeGraph via `assign` / `remove` so it can persist + drive the
 * live viewer. The output Handle on the right wires this slot to the material.
 *
 * The picker is Teleported to <body>: a position:fixed overlay rendered inside
 * Vue Flow's CSS-transformed pane would otherwise be mis-positioned + scaled.
 */
import { computed, ref } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import Icon from '../../shared/Icon.vue';
import TexturePickerModal from './TexturePickerModal.vue';
import ParamSlider from './ParamSlider.vue';
import ParamColor from './ParamColor.vue';
import {
  SLOT_PARAMETER_KEYS,
  parametersGroupDiffers,
} from '../../shared/materialParameterGroups';
import {
  SLOT_LABELS,
  texturesApi,
  type ApiError,
  type MaterialParameters,
  type MaterialSlot,
  type MaterialSlotTexture,
  type Texture,
} from '../../shared/api';

const props = defineProps<{
  slot: MaterialSlot;
  texture: MaterialSlotTexture | null;
  params: MaterialParameters;
  baseline: MaterialParameters;
  /** Which side the source handle appears on. Defaults to 'right' (left column). */
  handleSide?: 'left' | 'right';
}>();

const handlePosition = () => props.handleSide === 'left' ? Position.Left : Position.Right;
const emit = defineEmits<{
  assign: [slot: MaterialSlot, texture: Texture];
  remove: [slot: MaterialSlot];
  'param-change': [change: { key: keyof MaterialParameters; value: number | string | boolean | string[] }];
  'reset-keys': [keys: Array<keyof MaterialParameters>];
}>();

const slotKeys = computed(() => SLOT_PARAMETER_KEYS[props.slot]);
const canReset = computed(() =>
  parametersGroupDiffers(props.params, props.baseline, slotKeys.value),
);

function resetSlotParams(): void {
  emit('reset-keys', [...slotKeys.value]);
}

function onParam<K extends keyof MaterialParameters>(key: K, value: MaterialParameters[K] | string[]): void {
  emit('param-change', { key, value: value as number | string | boolean | string[] });
}

const pickerOpen = ref(false);
const uploading = ref(false);
const error = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

async function onFileChosen(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (input) input.value = '';
  if (!file) return;
  uploading.value = true;
  error.value = null;
  try {
    const tex = await texturesApi.upload(file, { displayName: file.name });
    emit('assign', props.slot, tex);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'upload failed';
  } finally {
    uploading.value = false;
  }
}

function onPicked(tex: Texture): void {
  emit('assign', props.slot, tex);
}
</script>

<template>
  <div class="texture-node">
    <div class="tn-head">
      <span class="tn-title node-drag-handle">{{ SLOT_LABELS[slot] }}</span>
      <button
        type="button"
        class="tn-reset nodrag nopan"
        :disabled="!canReset"
        title="Reset slot parameters"
        aria-label="Reset slot parameters"
        @click="resetSlotParams"
      >
        <Icon name="restart_alt" :size="14" />
      </button>
    </div>

    <div v-if="texture" class="tn-assigned nodrag nopan">
      <span class="tn-thumb">
        <img :src="texturesApi.downloadUrl(texture.id)" :alt="texture.displayName" />
      </span>
      <div class="tn-name" :title="texture.displayName">{{ texture.displayName }}</div>
      <div class="tn-actions">
        <button type="button" @click="pickerOpen = true">Change</button>
        <button type="button" class="danger" @click="emit('remove', slot)">Remove</button>
      </div>
    </div>

    <div v-else class="tn-empty nodrag nopan">
      <button type="button" class="primary" :disabled="uploading" @click="fileInput?.click()">
        {{ uploading ? 'Uploading…' : 'Upload New' }}
      </button>
      <button type="button" @click="pickerOpen = true">Pick from Library</button>
    </div>

    <div v-if="error" class="tn-error">{{ error }}</div>

    <div class="tn-params nodrag nopan">
      <ParamColor
        v-if="slot === 'albedo'"
        label="Base Color"
        :sublabel="texture ? 'tints the map' : 'flat color'"
        :model-value="params.baseColor"
        @update:model-value="(v) => onParam('baseColor', v)"
      />

      <ParamSlider
        v-else-if="slot === 'roughness'"
        label="Roughness"
        :sublabel="texture ? 'map multiplier' : 'flat value'"
        :min="0"
        :max="1"
        :step="0.01"
        :model-value="params.roughness"
        @update:model-value="(v) => onParam('roughness', v)"
      />

      <ParamSlider
        v-else-if="slot === 'metallic'"
        label="Metallic"
        :sublabel="texture ? 'map multiplier' : 'flat value'"
        :min="0"
        :max="1"
        :step="0.01"
        :model-value="params.metallic"
        @update:model-value="(v) => onParam('metallic', v)"
      />

      <template v-else-if="slot === 'emissive'">
        <ParamColor
          label="Emissive"
          sublabel="emission color"
          :model-value="params.emissiveColor"
          @update:model-value="(v) => onParam('emissiveColor', v)"
        />
        <ParamSlider
          label="Intensity"
          :sublabel="texture ? 'map intensity' : null"
          :min="0"
          :max="5"
          :step="0.1"
          :model-value="params.emissiveIntensity"
          @update:model-value="(v) => onParam('emissiveIntensity', v)"
        />
      </template>

      <ParamSlider
        v-else-if="slot === 'opacity'"
        label="Opacity"
        :sublabel="texture ? 'map multiplier' : 'flat value'"
        :min="0"
        :max="1"
        :step="0.01"
        :model-value="params.opacity"
        @update:model-value="(v) => onParam('opacity', v)"
      />

      <template v-else-if="slot === 'normal'">
        <ParamSlider
          label="Normal Strength"
          :sublabel="texture ? null : 'needs a normal map'"
          :min="0"
          :max="2"
          :step="0.01"
          :model-value="params.normalScale"
          @update:model-value="(v) => onParam('normalScale', v)"
        />
        <label class="tn-check">
          <input
            type="checkbox"
            class="nodrag nopan"
            :checked="params.flipNormalY"
            @change="onParam('flipNormalY', ($event.target as HTMLInputElement).checked)"
          />
          Flip Y (green channel)
        </label>
      </template>

      <ParamSlider
        v-else-if="slot === 'ao'"
        label="AO Intensity"
        :sublabel="texture ? 'map intensity' : 'needs an AO map'"
        :min="0"
        :max="1"
        :step="0.01"
        :model-value="params.aoIntensity"
        @update:model-value="(v) => onParam('aoIntensity', v)"
      />

      <template v-else-if="slot === 'displacement'">
        <ParamSlider
          label="Bump strength"
          :sublabel="texture ? 'height → shading only' : 'needs a height map'"
          :min="0"
          :max="0.5"
          :step="0.005"
          :model-value="params.displacementScale"
          @update:model-value="(v) => onParam('displacementScale', v)"
        />
        <p class="tn-hint muted">
          Preview uses bump mapping so mesh edges stay fixed. True vertex
          displacement is not applied in the editor (it tears hard-edged meshes).
        </p>
      </template>
    </div>

    <input
      ref="fileInput"
      type="file"
      accept="image/*,.tga,.exr,.hdr,.tif,.tiff"
      style="display: none;"
      @change="onFileChosen"
    />

    <Teleport to="body">
      <TexturePickerModal :open="pickerOpen" :slot="slot" @select="onPicked" @close="pickerOpen = false" />
    </Teleport>

    <Handle type="source" :position="handlePosition()" :connectable="false" />
  </div>
</template>

<style scoped>
.texture-node {
  width: 300px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  overflow: hidden;
  text-align: left;
  cursor: default;
}
.tn-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px 7px 14px;
  background: var(--color-bg-input);
  border-bottom: 1px solid var(--color-border);
}
.tn-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--color-text);
}
.tn-reset {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.tn-reset:hover:not(:disabled) {
  color: var(--color-text);
  border-color: var(--color-border);
}
.tn-reset:disabled {
  opacity: 0.35;
  cursor: default;
}
.tn-assigned { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.tn-thumb {
  display: block; width: 100%; aspect-ratio: 4 / 3; border-radius: var(--radius-sm);
  overflow: hidden; background: var(--color-bg-hover);
}
.tn-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tn-name {
  font-size: 12px; color: var(--color-text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tn-actions { display: flex; gap: 8px; }
.tn-actions button { flex: 1; padding: 6px 10px; font-size: 13px; }
.tn-empty { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.tn-empty button { width: 100%; padding: 8px 10px; font-size: 13px; }
.tn-error {
  margin: 0 12px 12px; font-size: 12px;
  color: var(--color-error);
}
.tn-params {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-input);
}
.tn-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-muted);
  cursor: pointer;
}
.tn-check input { width: 14px; height: 14px; cursor: pointer; }
.tn-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-muted);
}
button.danger { color: var(--color-error); }
button.danger:hover { border-color: var(--color-error); }
</style>
