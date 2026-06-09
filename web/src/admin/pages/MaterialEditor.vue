<script setup lang="ts">
/**
 * Material editor (route /materials/:id). Loads the full material detail and
 * lays out a node-graph editor (left ~60%) beside a live three.js PBR preview
 * + metadata form (right ~40%). Slot assignments from the graph are persisted
 * via PUT/DELETE …/slots/:slot and applied optimistically so the preview and
 * the graph update instantly; name / description / tags save via PUT. Export
 * downloads the material ZIP; delete soft-deletes and returns to the library.
 */
import { computed, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import PbrNodeGraph from '../components/PbrNodeGraph.vue';
import GlbViewer from '../components/GlbViewer.vue';
import {
  materialsApi,
  texturesApi,
  MATERIAL_SLOTS,
  type ApiError,
  type MaterialDetail,
  type MaterialSlot,
  type MaterialSlotAssignment,
  type Texture,
} from '../../shared/api';

const props = defineProps<{ id: string }>();
const router = useRouter();

const material = ref<MaterialDetail | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const name = ref('');
const description = ref('');
const tags = ref('');
const saving = ref(false);
const saveError = ref<string | null>(null);
const slotError = ref<string | null>(null);

const sources = computed<Partial<Record<MaterialSlot, string>>>(() => {
  const map: Partial<Record<MaterialSlot, string>> = {};
  if (material.value) {
    for (const s of material.value.slots) map[s.slot] = texturesApi.downloadUrl(s.textureId);
  }
  return map;
});

function syncForm(m: MaterialDetail): void {
  name.value = m.name;
  description.value = m.description ?? '';
  tags.value = m.tags.join(', ');
}

function tagsArray(): string[] {
  return tags.value.split(',').map((s) => s.trim()).filter(Boolean);
}

async function reload(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const m = await materialsApi.get(props.id);
    material.value = m;
    syncForm(m);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load material';
    material.value = null;
  } finally {
    loading.value = false;
  }
}

function patchSlotLocal(slot: MaterialSlot, texture: Texture): void {
  if (!material.value) return;
  const assignment: MaterialSlotAssignment = {
    slot,
    textureId: texture.id,
    assignedAt: new Date().toISOString(),
    texture: {
      id: texture.id,
      displayName: texture.displayName,
      originalFilename: texture.originalFilename,
      contentType: texture.contentType,
      sizeBytes: texture.sizeBytes,
    },
  };
  const slots = [...material.value.slots.filter((s) => s.slot !== slot), assignment]
    .sort((a, b) => MATERIAL_SLOTS.indexOf(a.slot) - MATERIAL_SLOTS.indexOf(b.slot));
  material.value = { ...material.value, slots, slotsFilled: slots.length };
}

function removeSlotLocal(slot: MaterialSlot): void {
  if (!material.value) return;
  const slots = material.value.slots.filter((s) => s.slot !== slot);
  material.value = { ...material.value, slots, slotsFilled: slots.length };
}

async function onAssign(slot: MaterialSlot, texture: Texture): Promise<void> {
  if (!material.value) return;
  const id = material.value.id;
  slotError.value = null;
  patchSlotLocal(slot, texture);
  try {
    material.value = await materialsApi.assignSlot(id, slot, texture.id);
  } catch (err) {
    slotError.value = (err as ApiError).message ?? 'failed to assign texture';
    await reload();
  }
}

async function onUnassign(slot: MaterialSlot): Promise<void> {
  if (!material.value) return;
  const id = material.value.id;
  slotError.value = null;
  removeSlotLocal(slot);
  try {
    material.value = await materialsApi.unassignSlot(id, slot);
  } catch (err) {
    slotError.value = (err as ApiError).message ?? 'failed to clear slot';
    await reload();
  }
}

async function save(): Promise<void> {
  if (!material.value || !name.value.trim()) return;
  saving.value = true;
  saveError.value = null;
  try {
    const updated = await materialsApi.update(material.value.id, {
      name: name.value.trim(),
      description: description.value.trim() || null,
      tags: tagsArray(),
    });
    material.value = updated;
    syncForm(updated);
  } catch (err) {
    saveError.value = (err as ApiError).message ?? 'save failed';
  } finally {
    saving.value = false;
  }
}

function exportZip(): void {
  if (!material.value) return;
  const a = document.createElement('a');
  a.href = materialsApi.downloadUrl(material.value.id);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function remove(): Promise<void> {
  if (!material.value) return;
  if (!confirm(`Delete material "${material.value.name}"? This soft-deletes it; textures are kept.`)) return;
  try {
    await materialsApi.remove(material.value.id);
    void router.push({ name: 'materials' });
  } catch (err) {
    error.value = (err as ApiError).message ?? 'delete failed';
  }
}

watch(() => props.id, () => void reload(), { immediate: true });
</script>

<template>
  <section class="editor">
    <div v-if="loading" class="muted">Loading material…</div>

    <div v-else-if="error" class="error-box">
      {{ error }}
      <div class="mt-sm"><RouterLink :to="{ name: 'materials' }">← Back to materials</RouterLink></div>
    </div>

    <template v-else-if="material">
      <header class="topbar">
        <RouterLink :to="{ name: 'materials' }" class="back" title="Back to materials">←</RouterLink>
        <input v-model="name" class="title-input flex-1" placeholder="Material name" @keyup.enter="save" />
        <button class="primary" :disabled="saving || !name.trim()" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
        <button @click="exportZip">Export ZIP</button>
        <button class="danger" @click="remove">Delete</button>
      </header>

      <div v-if="saveError" class="error-box">{{ saveError }}</div>
      <div v-if="slotError" class="error-box">{{ slotError }}</div>

      <div class="body">
        <div class="graph-pane">
          <PbrNodeGraph :slots="material.slots" @assign="onAssign" @unassign="onUnassign" />
        </div>

        <div class="side-pane">
          <div class="viewer-pane">
            <GlbViewer :sources="sources" />
          </div>

          <div class="card meta">
            <label class="field">
              <span class="muted small">Name</span>
              <input v-model="name" placeholder="Material name" />
            </label>
            <label class="field">
              <span class="muted small">Description</span>
              <textarea v-model="description" rows="3" placeholder="Optional notes about this material" />
            </label>
            <label class="field">
              <span class="muted small">Tags <span class="subtle">(comma separated)</span></span>
              <input v-model="tags" placeholder="brick, exterior, 4k" />
            </label>
            <div class="meta-foot">
              <span class="muted small">{{ material.slotsFilled }}/{{ material.slotsTotal }} slots filled</span>
              <button class="primary" :disabled="saving || !name.trim()" @click="save">
                {{ saving ? 'Saving…' : 'Save' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: calc(100vh - 48px);
}
.topbar { display: flex; align-items: center; gap: 8px; }
.back {
  font-size: 18px; line-height: 1; padding: 6px 10px;
  border: 1px solid var(--color-border-strong); border-radius: var(--radius);
  color: var(--color-text); text-decoration: none;
}
.back:hover { border-color: var(--orbit-primary); text-decoration: none; }
.title-input {
  font-size: 18px; font-weight: 700; padding: 7px 12px;
}
button.danger { color: var(--color-error); }
button.danger:hover { border-color: var(--color-error); }

.body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 6fr 4fr;
  gap: 16px;
}
.graph-pane { min-height: 0; min-width: 0; }
.side-pane {
  display: flex; flex-direction: column; gap: 12px;
  min-height: 0; overflow: auto;
}
.viewer-pane { flex: 1 1 auto; min-height: 300px; }
.meta { display: flex; flex-direction: column; gap: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field textarea { resize: vertical; font-family: inherit; }
.small { font-size: 12px; }
.meta-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }

@media (max-width: 1100px) {
  .body { grid-template-columns: 1fr; }
  .editor { height: auto; }
  .graph-pane { min-height: 480px; }
}
</style>
