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
import { ref } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import TexturePickerModal from './TexturePickerModal.vue';
import {
  SLOT_LABELS,
  texturesApi,
  type ApiError,
  type MaterialSlot,
  type MaterialSlotTexture,
  type Texture,
} from '../../shared/api';

const props = defineProps<{ slot: MaterialSlot; texture: MaterialSlotTexture | null }>();
const emit = defineEmits<{ assign: [slot: MaterialSlot, texture: Texture]; remove: [slot: MaterialSlot] }>();

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
    <div class="tn-head">{{ SLOT_LABELS[slot] }}</div>

    <div v-if="texture" class="tn-assigned">
      <span class="tn-thumb">
        <img :src="texturesApi.downloadUrl(texture.id)" :alt="texture.displayName" />
      </span>
      <div class="tn-name" :title="texture.displayName">{{ texture.displayName }}</div>
      <div class="tn-actions">
        <button type="button" @click="pickerOpen = true">Change</button>
        <button type="button" class="danger" @click="emit('remove', slot)">Remove</button>
      </div>
    </div>

    <div v-else class="tn-empty">
      <button type="button" class="primary" :disabled="uploading" @click="fileInput?.click()">
        {{ uploading ? 'Uploading…' : 'Upload New' }}
      </button>
      <button type="button" @click="pickerOpen = true">Pick from Library</button>
    </div>

    <div v-if="error" class="tn-error">{{ error }}</div>

    <input
      ref="fileInput"
      type="file"
      accept="image/*,.tga,.exr,.hdr,.tif,.tiff"
      style="display: none;"
      @change="onFileChosen"
    />

    <Teleport to="body">
      <TexturePickerModal :open="pickerOpen" @select="onPicked" @close="pickerOpen = false" />
    </Teleport>

    <Handle type="source" :position="Position.Right" :connectable="false" />
  </div>
</template>

<style scoped>
.texture-node {
  width: 232px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  overflow: hidden;
  text-align: left;
  cursor: default;
}
.tn-head {
  padding: 7px 12px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--color-text);
  background: var(--color-bg-input);
  border-bottom: 1px solid var(--color-border);
}
.tn-assigned { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.tn-thumb {
  display: block; width: 100%; aspect-ratio: 16 / 9; border-radius: var(--radius-sm);
  overflow: hidden; background: var(--color-bg-hover);
}
.tn-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tn-name {
  font-size: 12px; color: var(--color-text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tn-actions { display: flex; gap: 6px; }
.tn-actions button { flex: 1; padding: 4px 8px; font-size: 12px; }
.tn-empty { padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.tn-empty button { width: 100%; padding: 6px 8px; font-size: 12px; }
.tn-error {
  margin: 0 10px 10px; font-size: 11px;
  color: var(--color-error);
}
button.danger { color: var(--color-error); }
button.danger:hover { border-color: var(--color-error); }
</style>
